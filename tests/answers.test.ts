import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, capture, origin } from './helpers.js';
import { modelCaller } from '../src/server/model.js';
import {
  guardMismatches,
  matchChoice,
  normalizeQuestion,
} from '../src/server/answers/normalize.js';
import {
  advanceFieldSession,
  resolveAnswerTicket,
  resolveField,
  startFieldSession,
  type AnswerDeps,
} from '../src/server/answers/session.js';
import { upsertAnswer } from '../src/server/answers/bank.js';
import { fakeLunaTransport } from './fixtures/answers/fake-luna.js';

type F = Awaited<ReturnType<typeof fixture>>;
const yesNo = ['Yes', 'No'];
const FUTURE =
  'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?';

async function job(f: F, employerId: string | null, owner = f.alice) {
  const id = randomUUID();
  await f.db.query(
    `INSERT INTO jobs (id,applicant_id,client_capture_id,canonical_employer_id,title,employer,discovery_url,application_url,posting_text,source,status,application_host,supported_host)
     VALUES ($1,$2,$3,$4,'Software Engineer','Example Employer','https://example.com/d','https://boards.greenhouse.io/example/jobs/1','text','manual','ready','boards.greenhouse.io',true)`,
    [id, owner, randomUUID(), employerId],
  );
  return id;
}
async function employer(f: F, name: string, owner = f.alice) {
  const id = randomUUID();
  await f.db.query(
    'INSERT INTO employers (id,applicant_id,name) VALUES ($1,$2,$3)',
    [id, owner, name],
  );
  return id;
}
async function global(f: F, question: string, answer: string, choices = yesNo) {
  return upsertAnswer(f.db, f.alice, {
    scope: 'global',
    question,
    choices,
    answer,
    source: 'dashboard',
  });
}
function luna(f: F, override?: Parameters<typeof fakeLunaTransport>[0]) {
  const fake = fakeLunaTransport(override);
  const deps: AnswerDeps = {
    callModel: modelCaller(
      f.db,
      { apiKey: 'test-key', solModel: 'sol', lunaModel: 'luna' },
      fake.transport,
    ),
    threshold: 0.6,
  };
  return { deps, calls: fake.calls };
}
const field = (question: string, choices = yesNo, required = true) => ({
  fieldId: randomUUID(),
  question,
  choices,
  required,
});
const ctx = (f: F, jobId: string, employerId: string | null) => ({
  applicantId: f.alice,
  jobId,
  employerId,
});

test('normalization and deterministic guards catch polarity, time horizon, location, numbers and choice mismatches', () => {
  assert.equal(
    normalizeQuestion('  Are you legally authorized to work in the U.S.? * '),
    'are you legally authorized to work in the u s',
  );
  assert.deepEqual(
    guardMismatches(
      'Do you require sponsorship to work in the US?',
      'Can you work in the US without requiring sponsorship?',
    ),
    ['polarity'],
  );
  assert.deepEqual(
    guardMismatches(
      'Do you currently require visa sponsorship?',
      'Will you require visa sponsorship in the future?',
    ),
    ['time_horizon'],
  );
  assert.ok(
    guardMismatches(
      'Will you in the future require sponsorship?',
      'Will you now or in the future require sponsorship?',
    ).includes('time_horizon'),
  );
  assert.deepEqual(
    guardMismatches(
      'Are you authorized to work in the United States?',
      'Are you authorized to work in Canada?',
    ),
    ['location'],
  );
  assert.deepEqual(
    guardMismatches('Can you work onsite 3 days a week?', 'Onsite five days?'),
    ['numbers'],
  );
  // "Tell us"/"about us" is a pronoun, not a location; number words normalize.
  assert.deepEqual(
    guardMismatches(
      'How did you hear about this position?',
      'How did you hear about us?',
    ),
    [],
  );
  assert.deepEqual(
    guardMismatches('Onsite 3 days a week?', 'Onsite three days a week?'),
    [],
  );
  assert.equal(matchChoice('yes', ['Yes', 'No']), 'Yes');
  assert.equal(
    matchChoice('No', ['Yes, I will require sponsorship', 'No, I will not']),
    'No, I will not',
  );
  assert.equal(matchChoice('Maybe', ['Yes', 'No']), null);
  assert.equal(matchChoice('Free text', []), 'Free text');
});

test('scoped exact matches prefer one-time over employer over global and respect choices', async () => {
  const f = await fixture();
  try {
    const acme = await employer(f, 'Acme'),
      globex = await employer(f, 'Globex');
    const acmeJob = await job(f, acme),
      acmeJob2 = await job(f, acme),
      globexJob = await job(f, globex);
    const q = 'Are you willing to relocate?';
    await global(f, q, 'Yes');
    await upsertAnswer(f.db, f.alice, {
      scope: 'employer',
      canonicalEmployerId: acme,
      question: q,
      choices: yesNo,
      answer: 'No',
      source: 'dashboard',
    });
    await upsertAnswer(f.db, f.alice, {
      scope: 'job',
      jobId: acmeJob2,
      question: q,
      choices: yesNo,
      answer: 'Yes',
      source: 'ticket',
    });
    const deps: AnswerDeps = {};
    const value = async (jobId: string, emp: string, choices = yesNo) => {
      const r = await resolveField(f.db, deps, ctx(f, jobId, emp), {
        ...field('Are you willing to relocate ?', choices),
      });
      return r.status === 'answered' ? r.answer : r.reason;
    };
    assert.deepEqual(await value(acmeJob, acme), {
      value: 'No',
      tier: 'exact',
      answerId: (
        await f.db.query("SELECT id FROM answers WHERE scope='employer'")
      ).rows[0].id,
    });
    assert.equal(((await value(acmeJob2, acme)) as any).value, 'Yes');
    assert.equal(((await value(globexJob, globex)) as any).value, 'Yes');
    // A saved answer that is not one of this form's choices pauses instead of guessing.
    assert.equal(
      await value(globexJob, globex, ['Willing', 'Not willing']),
      'choices_incompatible',
    );
  } finally {
    await f.close();
  }
});

test('Luna equivalence reuses a guarded match, proposes an alias, and an approved alias skips Luna', async () => {
  const f = await fixture();
  try {
    const acme = await employer(f, 'Acme');
    const first = await job(f, acme),
      second = await job(f, acme);
    await global(f, FUTURE, 'Yes');
    await global(f, 'What are your salary expectations?', '$150,000', []);
    const { deps, calls } = luna(f);
    const asked = field(
      'Will you now, or at any point in the future, require visa sponsorship (e.g., H-1B)?',
      ['Yes', 'No'],
    );
    const result = await resolveField(f.db, deps, ctx(f, first, acme), asked);
    assert.equal(result.status, 'answered');
    assert.equal((result as any).answer.tier, 'luna');
    assert.equal((result as any).answer.value, 'Yes');
    assert.equal(calls.length, 1);
    // Only questions are sent to the model, never saved answers.
    assert.ok(!JSON.stringify(calls).includes('$150,000'));
    const provenance = (await f.db.query('SELECT * FROM model_calls')).rows;
    assert.equal(provenance.length, 1);
    assert.equal(provenance[0].prompt_version, 'answer-equivalence-v1');
    assert.equal(provenance[0].model, 'fake-luna');

    const listed = (
      await f.app.inject({ url: '/api/answers', headers: { cookie: f.cookie } })
    ).json();
    assert.equal(listed.aliases.length, 1);
    assert.equal(listed.aliases[0].status, 'proposed');
    const approve = await f.app.inject({
      method: 'POST',
      url: `/api/answers/aliases/${listed.aliases[0].id}/decision`,
      headers: { origin, cookie: f.cookie },
      payload: { status: 'approved' },
    });
    assert.equal(approve.statusCode, 200, approve.body);
    const again = await resolveField(f.db, deps, ctx(f, second, acme), asked);
    assert.equal((again as any).answer.tier, 'alias');
    assert.equal((again as any).answer.value, 'Yes');
    assert.equal(calls.length, 1, 'approved alias needs no model call');
  } finally {
    await f.close();
  }
});

test('ambiguity pauses despite a high score: future sponsorship never reuses a current-authorization or current-sponsorship answer', async () => {
  const f = await fixture();
  try {
    const jobId = await job(f, null);
    await global(
      f,
      'Are you currently authorized to work in the United States?',
      'Yes',
    );
    await global(
      f,
      'Do you currently require visa sponsorship to work in the United States?',
      'No',
    );
    // A model that wrongly claims everything is equivalent with near-certainty.
    const { deps } = luna(f, () => ({ equivalent: true, score: 0.99 }));
    const result = await resolveField(
      f.db,
      deps,
      ctx(f, jobId, null),
      field(
        'Will you require visa sponsorship to work in the United States in the future?',
      ),
    );
    assert.equal(result.status, 'needs_answer');
    assert.equal((result as any).reason, 'qualifier_mismatch');
    assert.ok((result as any).suggestion.blockedBy.includes('time_horizon'));

    // Polarity flip with a perfect score is also refused.
    await global(f, FUTURE, 'Yes');
    const flipped = await resolveField(
      f.db,
      deps,
      ctx(f, jobId, null),
      field(
        'Are you able to work in the United States now and in the future without sponsorship?',
      ),
    );
    assert.equal(flipped.status, 'needs_answer');

    // Luna's own ambiguity flag blocks an otherwise clean, high-scoring paraphrase.
    const unsure = luna(f, () => ({ ambiguous: true, score: 0.95 }));
    const ambiguous = await resolveField(
      f.db,
      unsure.deps,
      ctx(f, jobId, null),
      field(
        'Will you now, or at any point in the future, require visa sponsorship (e.g., H-1B)?',
      ),
    );
    assert.equal(ambiguous.status, 'needs_answer');
    assert.deepEqual((ambiguous as any).suggestion.blockedBy, ['ambiguous']);
  } finally {
    await f.close();
  }
});

test('missing or failing Luna pauses the field without guessing', async () => {
  const f = await fixture();
  try {
    const jobId = await job(f, null);
    await global(f, FUTURE, 'Yes');
    const asked = field('Will you need sponsorship for a visa in the future?');
    const missing = await resolveField(f.db, {}, ctx(f, jobId, null), asked);
    assert.equal((missing as any).reason, 'luna_not_configured');
    assert.equal(
      (await f.db.query('SELECT * FROM model_calls')).rows.length,
      0,
    );
    const failing: AnswerDeps = {
      callModel: modelCaller(
        f.db,
        { apiKey: 'k', solModel: 's', lunaModel: 'l' },
        (async () => new Response('limit', { status: 429 })) as typeof fetch,
      ),
    };
    const failed = await resolveField(
      f.db,
      failing,
      ctx(f, jobId, null),
      asked,
    );
    assert.equal((failed as any).reason, 'luna_failed');
    const calls = (await f.db.query('SELECT status FROM model_calls')).rows;
    assert.deepEqual(calls, [{ status: 'failed' }]);
  } finally {
    await f.close();
  }
});

test('a field session pauses at the unanswered field and resolving its ticket yields the answer for exactly that field', async () => {
  const f = await fixture();
  try {
    const acme = await employer(f, 'Acme');
    const jobId = await job(f, acme);
    await global(
      f,
      'Are you legally authorized to work in the United States?',
      'Yes',
    );
    await global(f, 'Desired salary', '$150,000', []);
    const fields = [
      {
        fieldId: 'auth',
        question: 'Are you legally authorized to work in the United States?',
        choices: yesNo,
      },
      {
        fieldId: 'future',
        question:
          'Will you in the future require sponsorship for employment visa status?',
        choices: yesNo,
      },
      {
        fieldId: 'pronouns',
        question: 'Pronouns',
        choices: [],
        required: false,
      },
      { fieldId: 'salary', question: 'Desired salary', choices: [] },
    ];
    const { deps } = luna(f);
    const started = await startFieldSession(f.db, f.alice, jobId, fields);
    const paused = await advanceFieldSession(
      f.db,
      deps,
      f.alice,
      started.sessionId,
    );
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pausedFieldId, 'future');
    assert.equal(paused.resumeIndex, 1);
    assert.deepEqual(Object.keys(paused.answers), ['auth']);
    // Restart-safe: advancing again while paused changes nothing and opens no second ticket.
    assert.deepEqual(
      await advanceFieldSession(f.db, deps, f.alice, started.sessionId),
      paused,
    );
    assert.equal(
      (await f.db.query('SELECT status FROM jobs WHERE id=$1', [jobId])).rows[0]
        .status,
      'paused',
    );

    const pending = (
      await f.app.inject({
        url: '/api/answers/questions',
        headers: { cookie: f.cookie },
      })
    ).json().questions;
    assert.equal(pending.length, 1);
    assert.deepEqual(
      {
        ticketId: pending[0].ticketId,
        fieldId: pending[0].fieldId,
        question: pending[0].question,
        choices: pending[0].choices,
        employer: pending[0].employer,
        role: pending[0].role,
      },
      {
        ticketId: paused.ticketId,
        fieldId: 'future',
        question: fields[1]!.question,
        choices: yesNo,
        employer: 'Example Employer',
        role: 'Software Engineer',
      },
    );
    const resolve = (payload: object, cookie = f.cookie) =>
      f.app.inject({
        method: 'POST',
        url: `/api/answers/questions/${paused.ticketId}/resolve`,
        headers: { origin, cookie },
        payload,
      });
    assert.equal(
      (await resolve({ action: 'answer_employer', answer: 'Maybe' }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await resolve(
          { action: 'answer_employer', answer: 'Yes' },
          await f.login('bob@example.com'),
        )
      ).statusCode,
      404,
    );
    const ok = await resolve({ action: 'answer_employer', answer: 'yes' });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().fieldId, 'future');
    assert.equal(ok.json().value, 'Yes');
    assert.equal(
      (await resolve({ action: 'answer_employer', answer: 'Yes' })).statusCode,
      409,
    );
    const events = (
      await f.db.query(
        "SELECT name,payload FROM ledger_events WHERE job_id=$1 AND name LIKE 'pause.%' ORDER BY occurred_at",
        [jobId],
      )
    ).rows;
    assert.deepEqual(
      events.map((e) => e.name),
      ['pause.opened', 'pause.closed'],
    );
    assert.equal(events[1].payload.outcome, 'approved');
    assert.equal(events[1].payload.cause, 'unanswered_question');
    assert.equal(
      (await f.db.query('SELECT status FROM jobs WHERE id=$1', [jobId])).rows[0]
        .status,
      'ready',
    );

    const done = await advanceFieldSession(
      f.db,
      deps,
      f.alice,
      started.sessionId,
    );
    assert.equal(done.status, 'completed');
    assert.equal(done.resumeIndex, 4);
    assert.equal(done.answers.auth!.tier, 'exact');
    assert.deepEqual(done.answers.future, {
      value: 'Yes',
      tier: 'ticket',
      answerId: ok.json().answerId,
      ticketId: paused.ticketId,
    });
    assert.equal(done.answers.pronouns!.tier, 'skipped');
    assert.equal(done.answers.salary!.value, '$150,000');
    const fromTicket = Object.entries(done.answers).filter(
      ([, a]) => a.tier === 'ticket',
    );
    assert.deepEqual(
      fromTicket.map(([id]) => id),
      ['future'],
    );
    const saved = (
      await f.db.query(
        'SELECT scope,canonical_employer_id FROM answers WHERE id=$1',
        [ok.json().answerId],
      )
    ).rows[0];
    assert.deepEqual(saved, { scope: 'employer', canonical_employer_id: acme });
  } finally {
    await f.close();
  }
});

test('one-time, employer and global saves reach exactly their scopes', async () => {
  const f = await fixture();
  try {
    const acme = await employer(f, 'Acme'),
      globex = await employer(f, 'Globex');
    const q = 'Do you have experience with distributed systems?';
    const pauseAndAnswer = async (jobId: string, action: string) => {
      const s = await startFieldSession(f.db, f.alice, jobId, [
        { fieldId: 'x', question: q, choices: yesNo },
      ]);
      const paused = await advanceFieldSession(f.db, {}, f.alice, s.sessionId);
      assert.equal(paused.status, 'paused');
      await resolveAnswerTicket(f.db, f.alice, paused.ticketId!, {
        action: action as any,
        answer: 'Yes',
      });
      return (await advanceFieldSession(f.db, {}, f.alice, s.sessionId)).answers
        .x!.value;
    };
    const resolves = async (jobId: string, emp: string | null) =>
      (await resolveField(f.db, {}, ctx(f, jobId, emp), field(q))).status;
    const once = await job(f, acme);
    assert.equal(await pauseAndAnswer(once, 'answer_once'), 'Yes');
    assert.equal(await resolves(once, acme), 'answered');
    assert.equal(await resolves(await job(f, acme), acme), 'needs_answer');

    const emp = await job(f, acme);
    await f.db.query('DELETE FROM answers');
    assert.equal(await pauseAndAnswer(emp, 'answer_employer'), 'Yes');
    assert.equal(await resolves(await job(f, acme), acme), 'answered');
    assert.equal(await resolves(await job(f, globex), globex), 'needs_answer');

    // Unresolved employer identity cannot take an employer-scoped save.
    const unknown = await job(f, null);
    const s = await startFieldSession(f.db, f.alice, unknown, [
      { fieldId: 'y', question: 'Unique question?', choices: [] },
    ]);
    const p = await advanceFieldSession(f.db, {}, f.alice, s.sessionId);
    await assert.rejects(
      () =>
        resolveAnswerTicket(f.db, f.alice, p.ticketId!, {
          action: 'answer_employer',
          answer: 'A',
        }),
      /Employer identity is unresolved/,
    );
    await resolveAnswerTicket(f.db, f.alice, p.ticketId!, {
      action: 'answer_global',
      answer: 'A',
    });
    const elsewhere = await job(f, globex);
    const r = await resolveField(
      f.db,
      {},
      ctx(f, elsewhere, globex),
      field('Unique question?', []),
    );
    assert.equal((r as any).answer.value, 'A');
  } finally {
    await f.close();
  }
});

test('defer closes the pause and defers the position and session', async () => {
  const f = await fixture();
  try {
    const jobId = await job(f, null);
    const s = await startFieldSession(f.db, f.alice, jobId, [
      { fieldId: 'x', question: 'Anything?', choices: [] },
    ]);
    const p = await advanceFieldSession(f.db, {}, f.alice, s.sessionId);
    await resolveAnswerTicket(f.db, f.alice, p.ticketId!, { action: 'defer' });
    const after = await advanceFieldSession(f.db, {}, f.alice, s.sessionId);
    assert.equal(after.status, 'deferred');
    assert.equal(
      (await f.db.query('SELECT status FROM jobs WHERE id=$1', [jobId])).rows[0]
        .status,
      'deferred',
    );
    assert.equal(
      (await f.db.query('SELECT count(*)::int AS n FROM answers')).rows[0].n,
      0,
    );
    const closed = (
      await f.db.query(
        "SELECT payload FROM ledger_events WHERE name='pause.closed'",
      )
    ).rows;
    assert.equal(closed[0].payload.outcome, 'deferred');
  } finally {
    await f.close();
  }
});

test('dashboard lists, seeds, edits and reviews answers with owner isolation and origin checks', async () => {
  const f = await fixture();
  try {
    const seed = await f.app.inject({
      method: 'POST',
      url: '/api/answers/seed',
      headers: { origin, cookie: f.cookie },
      payload: {},
    });
    assert.equal(seed.statusCode, 200, seed.body);
    const reseed = await f.app.inject({
      method: 'POST',
      url: '/api/answers/seed',
      headers: { origin, cookie: f.cookie },
      payload: {},
    });
    assert.equal(reseed.json().inserted, 0);
    const list = async (cookie = f.cookie) =>
      (await f.app.inject({ url: '/api/answers', headers: { cookie } })).json()
        .answers;
    const answers = await list();
    assert.equal(answers.length, seed.json().inserted);
    assert.ok(answers.every((a: any) => a.needsReview && a.scope === 'global'));
    const future = answers.find((a: any) => a.question === FUTURE);
    assert.equal(future.answer, 'Yes');
    const current = answers.find((a: any) =>
      /currently require visa/.test(a.question),
    );
    assert.equal(current.answer, 'No');

    const bobCookie = await f.login('bob@example.com');
    assert.equal((await list(bobCookie)).length, 0);
    const patch = (payload: object, headers: Record<string, string>) =>
      f.app.inject({
        method: 'PATCH',
        url: `/api/answers/${future.id}`,
        headers,
        payload,
      });
    assert.equal(
      (await patch({ reviewed: true }, { cookie: f.cookie })).statusCode,
      403,
    );
    assert.equal(
      (await patch({ reviewed: true }, { origin, cookie: bobCookie }))
        .statusCode,
      404,
    );
    assert.equal(
      (await patch({ reviewed: true }, { origin, cookie: f.cookie }))
        .statusCode,
      200,
    );
    assert.equal(
      (await patch({ answer: 'No' }, { origin, cookie: f.cookie })).statusCode,
      200,
    );
    const edited = (await list()).find((a: any) => a.id === future.id);
    assert.equal(edited.needsReview, false);
    assert.equal(edited.answer, 'No');

    const acme = await employer(f, 'Acme');
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/answers',
      headers: { origin, cookie: f.cookie },
      payload: {
        scope: 'employer',
        canonicalEmployerId: acme,
        question: 'Why Acme?',
        answer: 'Mission',
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const bobEmployer = await employer(f, 'Bob Co', f.bob);
    const crossOwner = await f.app.inject({
      method: 'POST',
      url: '/api/answers',
      headers: { origin, cookie: f.cookie },
      payload: {
        scope: 'employer',
        canonicalEmployerId: bobEmployer,
        question: 'Why?',
        answer: 'x',
      },
    });
    assert.equal(crossOwner.statusCode, 404);
    const row = (await list()).find((a: any) => a.question === 'Why Acme?');
    assert.equal(row.employerName, 'Acme');
    const removed = await f.app.inject({
      method: 'DELETE',
      url: `/api/answers/${row.id}`,
      headers: { origin, cookie: f.cookie },
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal((await f.app.inject({ url: '/api/answers' })).statusCode, 401);
  } finally {
    await f.close();
  }
});

test('field sessions are owner-scoped and require unique field IDs', async () => {
  const f = await fixture();
  try {
    const created = (
      await f.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { origin, cookie: f.cookie },
        payload: capture(),
      })
    ).json();
    await assert.rejects(
      () =>
        startFieldSession(f.db, f.bob, created.id, [
          { fieldId: 'a', question: 'Q?' },
        ]),
      /Job not found/,
    );
    await assert.rejects(
      () =>
        startFieldSession(f.db, f.alice, created.id, [
          { fieldId: 'a', question: 'Q?' },
          { fieldId: 'a', question: 'R?' },
        ]),
      /unique/,
    );
  } finally {
    await f.close();
  }
});
