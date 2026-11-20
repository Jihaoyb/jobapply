/**
 * Regression tests for the P2 review findings in lane C (answers): lossless question keys,
 * guards on the exact and alias tiers, no automatic reuse of needs_review answers, and the
 * idempotent re-keying of stored rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, origin } from './helpers.js';
import { modelCaller } from '../src/server/model.js';
import {
  matchChoice,
  normalizeQuestion,
  questionKey,
} from '../src/server/answers/normalize.js';
import {
  resolveField,
  type AnswerDeps,
} from '../src/server/answers/session.js';
import {
  renormalizeAnswerKeys,
  seedProfileAnswers,
  upsertAnswer,
} from '../src/server/answers/bank.js';
import { profileSeedAnswers } from '../src/server/answers/seed.js';
import { fakeLunaTransport } from './fixtures/answers/fake-luna.js';

type F = Awaited<ReturnType<typeof fixture>>;
const yesNo = ['Yes', 'No'];

async function job(f: F) {
  const id = randomUUID();
  await f.db.query(
    `INSERT INTO jobs (id,applicant_id,client_capture_id,title,employer,discovery_url,application_url,posting_text,source,status,application_host,supported_host)
     VALUES ($1,$2,$3,'Software Engineer','Example Employer','https://example.com/d','https://boards.greenhouse.io/example/jobs/1','text','manual','ready','boards.greenhouse.io',true)`,
    [id, f.alice, randomUUID()],
  );
  return id;
}
function luna(f: F) {
  const fake = fakeLunaTransport();
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
const field = (question: string, choices = yesNo) => ({
  fieldId: randomUUID(),
  question,
  choices,
  required: true,
});

test('question keys keep +, #, ., currency symbols and non-Latin text; empty keys are refused', () => {
  const years = (lang: string) =>
    normalizeQuestion(`How many years of experience do you have with ${lang}?`);
  assert.equal(new Set([years('C++'), years('C#'), years('C')]).size, 3);
  assert.notEqual(
    normalizeQuestion('Expected salary (€)?'),
    normalizeQuestion('Expected salary (£)?'),
  );
  assert.notEqual(
    normalizeQuestion('Do you have a .NET background?'),
    normalizeQuestion('Do you have a NET background?'),
  );
  assert.equal(
    normalizeQuestion('Are you over 18?!'),
    normalizeQuestion('Are you over 18?'),
  );
  assert.equal(
    normalizeQuestion('Node.js version 3.5?'),
    'node.js version 3.5',
  );
  for (const text of [
    '您是否需要签证担保？',
    'Требуется ли вам виза?',
    'क्या आपको वीज़ा चाहिए?',
  ])
    assert.ok(normalizeQuestion(text).length > 0, text);
  assert.notEqual(
    normalizeQuestion('您是否需要签证担保？'),
    normalizeQuestion('Требуется ли вам виза?'),
  );
  assert.equal(normalizeQuestion('?!* —'), '');
  assert.throws(() => questionKey('?!*'), /no letters or digits/);
  // Choices use the same key: C++ and C# are distinct options.
  assert.equal(matchChoice('C#', ['C++', 'C#', 'C']), 'C#');
});

test('saving a C# answer never overwrites the C++ answer, and an empty question is rejected', async () => {
  const f = await fixture();
  try {
    const save = (question: string, answer: string) =>
      upsertAnswer(f.db, f.alice, {
        scope: 'global',
        question,
        choices: [],
        answer,
        source: 'dashboard',
      });
    await save('How many years of experience do you have with C++?', '5');
    await save('How many years of experience do you have with C#?', '2');
    await save('How many years of experience do you have with C?', '7');
    const rows = (
      await f.db.query(
        'SELECT question, answer FROM answers WHERE applicant_id=$1 ORDER BY answer',
        [f.alice],
      )
    ).rows;
    assert.deepEqual(
      rows.map((row) => row.answer),
      ['2', '5', '7'],
    );
    const jobId = await job(f);
    const resolved = await resolveField(
      f.db,
      {},
      { applicantId: f.alice, jobId, employerId: null },
      field('How many years of experience do you have with C++?', []),
    );
    assert.equal(resolved.status, 'answered');
    if (resolved.status === 'answered')
      assert.equal(resolved.answer.value, '5');
    await assert.rejects(() => save('???', 'x'), /no letters or digits/);
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/answers',
      headers: { origin, cookie: f.cookie },
      payload: { scope: 'global', question: '?!', choices: [], answer: 'x' },
    });
    assert.equal(created.statusCode, 400, created.body);
    // A form question with no letters or digits never matches anything.
    const blank = await resolveField(
      f.db,
      {},
      { applicantId: f.alice, jobId, employerId: null },
      field('???', []),
    );
    assert.equal(blank.status, 'needs_answer');
  } finally {
    await f.close();
  }
});

test('exact and alias hits pass the deterministic guards on the raw question texts', async () => {
  const f = await fixture();
  try {
    const jobId = await job(f);
    const ctx = { applicantId: f.alice, jobId, employerId: null };
    const answerId = await upsertAnswer(f.db, f.alice, {
      scope: 'global',
      question: 'Do you currently require visa sponsorship?',
      choices: yesNo,
      answer: 'No',
      source: 'dashboard',
    });
    // A stored key that collides with a materially different question (e.g. written by an
    // older, lossier normalization) must not reuse the answer on the exact tier.
    await f.db.query('UPDATE answers SET normalized_question=$2 WHERE id=$1', [
      answerId,
      normalizeQuestion('Do you require visa sponsorship in the future?'),
    ]);
    const exact = await resolveField(
      f.db,
      {},
      ctx,
      field('Do you require visa sponsorship in the future?'),
    );
    assert.equal(exact.status, 'needs_answer');
    if (exact.status === 'needs_answer') {
      assert.equal(exact.reason, 'qualifier_mismatch');
      assert.deepEqual(exact.suggestion?.blockedBy, ['time_horizon']);
    }
    // Same on the alias tier: an approved alias whose raw text differs materially.
    await f.db.query('UPDATE answers SET normalized_question=$2 WHERE id=$1', [
      answerId,
      normalizeQuestion('Do you currently require visa sponsorship?'),
    ]);
    await f.db.query(
      `INSERT INTO answer_aliases (id,applicant_id,answer_id,canonical_employer_id,question,normalized_question,status,score)
       VALUES ($1,$2,$3,NULL,$4,$5,'approved',0.9)`,
      [
        randomUUID(),
        f.alice,
        answerId,
        'Will you require visa sponsorship in the future?',
        normalizeQuestion('Do you need visa sponsorship?'),
      ],
    );
    const alias = await resolveField(
      f.db,
      {},
      ctx,
      field('Do you need visa sponsorship?'),
    );
    assert.equal(alias.status, 'needs_answer');
    if (alias.status === 'needs_answer') {
      assert.equal(alias.reason, 'qualifier_mismatch');
      assert.ok(alias.suggestion?.blockedBy.includes('time_horizon'));
    }
    // The unaltered exact hit still answers.
    const ok = await resolveField(
      f.db,
      {},
      ctx,
      field('Do you currently require visa sponsorship?'),
    );
    assert.equal(ok.status, 'answered');
  } finally {
    await f.close();
  }
});

test('needs_review answers (seeds) are suggested, never reused, until the applicant approves them', async () => {
  const f = await fixture();
  try {
    await seedProfileAnswers(f.db, f.alice);
    const jobId = await job(f);
    const ctx = { applicantId: f.alice, jobId, employerId: null };
    const seed = profileSeedAnswers[0]!;
    const model = luna(f);
    const first = await resolveField(
      f.db,
      model.deps,
      ctx,
      field(seed.question),
    );
    assert.equal(first.status, 'needs_answer');
    if (first.status === 'needs_answer') {
      assert.equal(first.reason, 'needs_review');
      assert.equal(first.suggestion?.answer, seed.answer);
      assert.deepEqual(first.suggestion?.blockedBy, ['needs_review']);
    }
    // A paraphrase is not offered to Luna either: unreviewed answers are not candidates.
    const paraphrase = await resolveField(
      f.db,
      model.deps,
      ctx,
      field('Are you legally permitted to work in the United States?'),
    );
    assert.equal(paraphrase.status, 'needs_answer');
    assert.equal(model.calls.length, 0);
    // The applicant approves it in the dashboard; it is reused from then on.
    const answerId = (
      await f.db.query(
        'SELECT id FROM answers WHERE applicant_id=$1 AND question=$2',
        [f.alice, seed.question],
      )
    ).rows[0].id;
    const approved = await f.app.inject({
      method: 'PATCH',
      url: `/api/answers/${answerId}`,
      headers: { origin, cookie: f.cookie },
      payload: { reviewed: true },
    });
    assert.equal(approved.statusCode, 200, approved.body);
    const after = await resolveField(
      f.db,
      model.deps,
      ctx,
      field(seed.question),
    );
    assert.equal(after.status, 'answered');
    if (after.status === 'answered') {
      assert.equal(after.answer.tier, 'exact');
      assert.equal(after.answer.value, seed.answer);
    }
  } finally {
    await f.close();
  }
});

test('stored keys from the old normalization are re-keyed idempotently and seeding stays idempotent', async () => {
  const f = await fixture();
  try {
    // The pre-fix normalization: ASCII letters, digits and $ only.
    const oldKey = (text: string) =>
      text
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\(required\)|\(optional\)/g, ' ')
        .replace(/[’‘]/g, "'")
        .replace(/[^a-z0-9$'\s]/g, ' ')
        .replace(/'/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    await seedProfileAnswers(f.db, f.alice);
    const count = async () =>
      (
        await f.db.query(
          'SELECT count(*)::int AS n FROM answers WHERE applicant_id=$1',
          [f.alice],
        )
      ).rows[0].n;
    const before = await count();
    // Simulate rows written before the fix.
    await f.db.query(
      'UPDATE answers SET normalized_question=$2 WHERE applicant_id=$1 AND question=$3',
      [
        f.alice,
        oldKey('Are you a U.S. citizen or lawful permanent resident?'),
        'Are you a U.S. citizen or lawful permanent resident?',
      ],
    );
    const stale = (
      await f.db.query(
        'SELECT normalized_question FROM answers WHERE applicant_id=$1 AND question=$2',
        [f.alice, 'Are you a U.S. citizen or lawful permanent resident?'],
      )
    ).rows[0].normalized_question;
    assert.notEqual(
      stale,
      normalizeQuestion('Are you a U.S. citizen or lawful permanent resident?'),
    );
    // Re-seeding re-keys first, so it inserts nothing new.
    assert.equal((await seedProfileAnswers(f.db, f.alice)).inserted, 0);
    assert.equal(await count(), before);
    const rows = (
      await f.db.query(
        'SELECT question, normalized_question FROM answers WHERE applicant_id=$1',
        [f.alice],
      )
    ).rows;
    assert.ok(
      rows.every(
        (row) => row.normalized_question === normalizeQuestion(row.question),
      ),
    );
    // The boot-time pass is a no-op once applied.
    assert.deepEqual(await renormalizeAnswerKeys(f.db), {
      rekeyed: 0,
      flagged: 0,
    });
  } finally {
    await f.close();
  }
});
