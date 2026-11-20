import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, capture, origin } from './helpers.js';
import { modelCaller } from '../src/server/model.js';
import {
  decideEligibility,
  replayGate,
  retryEligibilityTicket,
  resolveEligibilityTicket,
} from '../src/server/eligibility/decide.js';
import {
  evaluateRules,
  sentences,
  verifyQuote,
} from '../src/server/eligibility/rules.js';
import {
  configuredSolModel,
  PROMPT_VERSION,
} from '../src/server/eligibility/sol.js';
import type { Database } from '../src/server/db.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const SOL = configuredSolModel();

function solTransport(reply: unknown, requests: any[] = []) {
  return (async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    return Response.json({
      status: 'completed',
      model: 'served-sol-snapshot',
      usage: { input_tokens: 321, output_tokens: 54 },
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(reply) }],
        },
      ],
    });
  }) as typeof fetch;
}
function sol(db: Database, reply: unknown, requests: any[] = []) {
  return modelCaller(
    db,
    { apiKey: 'test-key', solModel: SOL, lunaModel: 'luna' },
    solTransport(reply, requests),
  );
}
async function newJob(f: Fixture, postingText: string, owner = f.alice) {
  const cookie =
    owner === f.alice ? f.cookie : await f.login('bob@example.com');
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/jobs',
    headers: { origin, cookie },
    payload: { ...capture(), postingText },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { id: string };
}
async function events(f: Fixture, jobId: string) {
  return (
    await f.db.query(
      'SELECT name,payload FROM ledger_events WHERE job_id=$1 ORDER BY occurred_at,id',
      [jobId],
    )
  ).rows;
}
async function status(f: Fixture, jobId: string) {
  return (await f.db.query('SELECT status FROM jobs WHERE id=$1', [jobId]))
    .rows[0].status;
}
async function modelCalls(f: Fixture) {
  return (await f.db.query('SELECT * FROM model_calls')).rows;
}

test('rules: negation, preference, hedge and conflicting clauses never auto-exclude', () => {
  const route = (text: string) => evaluateRules(text).route;
  assert.equal(route('Must be a U.S. citizen.'), 'exclusion_rule');
  assert.equal(
    route('We will not sponsor visas now or in the future.'),
    'exclusion_rule',
  );
  assert.equal(route('No security clearance is required.'), 'sol');
  assert.equal(
    route('This role does not require a security clearance.'),
    'sol',
  );
  assert.equal(route('Active Secret clearance preferred.'), 'sol');
  assert.equal(
    route('U.S. citizenship preferred; must be a U.S. citizen ideally.'),
    'sol',
  );
  assert.equal(route('Some roles may require a security clearance.'), 'sol');
  assert.equal(route('We are unable to sponsor visas at this time.'), 'sol');
  assert.equal(
    route('We do not sponsor TN visas, but H-1B sponsorship is available.'),
    'sol',
  );
  assert.equal(
    route('We do not sponsor visas. OPT candidates are welcome.'),
    'sol',
  );
  // "No sponsorship required" is ambiguous, not the same as "will not sponsor".
  assert.equal(route('No sponsorship required.'), 'sol');
  // "without sponsorship" excludes by rule only when the future is explicit.
  assert.equal(route('Must work without sponsorship.'), 'sol');
  assert.equal(
    route('Must work without sponsorship now or in the future.'),
    'exclusion_rule',
  );
  // Case-sensitive acronyms: "opt in" is not OPT.
  assert.equal(route('Users can opt in to emails.'), 'no_trigger');
  assert.equal(route('No OPT candidates.'), 'exclusion_rule');
  assert.equal(route('Build reliable software.'), 'no_trigger');
  // Broad vocabulary covers inflection and spelling variants.
  for (const text of [
    'Authorisation to work is checked.',
    'H1B holders',
    'work permits',
    'Immigrants',
    'residency',
  ])
    assert.equal(route(text), 'sol', text);
});

test('rules: sentences keep source offsets and abbreviations; quotes verify literally', () => {
  const text = 'Hello team.  Must be a U.S. citizen. e.g. clearance\nNext line';
  const spans = sentences(text);
  for (const span of spans)
    assert.equal(text.slice(span.start, span.end), span.text);
  assert.ok(spans.some((s) => s.text === 'Must be a U.S. citizen.'));
  const rule = evaluateRules(text);
  assert.equal(rule.route, 'exclusion_rule');
  const source = 'Line one.\nWe cannot   file new\nH-1B petitions. End.';
  const verified = verifyQuote(source, 'We cannot file new H-1B petitions.');
  assert.ok(verified);
  assert.equal(source.slice(verified.start, verified.end), verified.text);
  assert.equal(verifyQuote(source, 'We will not sponsor.'), null);
  assert.equal(verifyQuote(source, 'cannot'), null); // too short to be evidence
  assert.equal(verifyQuote(source, null), null);
});

test('rule route excludes with a verbatim quote, no model call, and emits rule provenance', async () => {
  const f = await fixture();
  try {
    const text =
      'Build satellite software.\nActive Secret clearance required.\nHybrid.';
    const job = await newJob(f, text);
    const result = await decideEligibility(
      f.db,
      f.alice,
      job.id,
      text,
      'posting',
      {
        callModel: sol(f.db, { decision: 'passed', quote: null, reason: '' }),
      },
    );
    assert.equal(result.decision, 'excluded');
    assert.equal(result.provenance, 'rule');
    assert.equal(result.route, 'exclusion_rule');
    assert.equal(result.evidence, 'Active Secret clearance required.');
    assert.ok(text.includes(result.evidence!));
    assert.equal(await status(f, job.id), 'eligibility_excluded');
    assert.equal((await modelCalls(f)).length, 0);
    const decided = (await events(f, job.id)).find(
      (e) => e.name === 'eligibility.decided',
    );
    assert.deepEqual(decided?.payload, {
      decision: 'excluded',
      provenance: 'rule',
      evidence: 'Active Secret clearance required.',
    });
    const row = (await f.db.query('SELECT * FROM eligibility_decisions'))
      .rows[0];
    assert.equal(
      text.slice(row.evidence_start, row.evidence_end),
      row.evidence,
    );
    assert.equal(row.rule_id, 'clearance.required');
    // A second run on an excluded job is refused.
    await assert.rejects(
      () => decideEligibility(f.db, f.alice, job.id, text, 'posting'),
      /cannot run/,
    );
  } finally {
    await f.close();
  }
});

test('no trigger passes without a model call and makes the job ready', async () => {
  const f = await fixture();
  try {
    const text = 'Build reliable software. Remote within North America.';
    const job = await newJob(f, text);
    const requests: any[] = [];
    const result = await decideEligibility(
      f.db,
      f.alice,
      job.id,
      text,
      'posting',
      {
        callModel: sol(f.db, {}, requests),
      },
    );
    assert.equal(result.decision, 'passed');
    assert.equal(result.route, 'no_trigger');
    assert.equal(result.provenance, 'rule');
    assert.equal(requests.length, 0);
    assert.equal(await status(f, job.id), 'ready');
  } finally {
    await f.close();
  }
});

test('Sol route uses Responses low reasoning, verifies the quote and persists model, prompt version and tokens', async () => {
  const f = await fixture();
  try {
    const text =
      'Great team. We cannot provide visa assistance for this role. Benefits.';
    const job = await newJob(f, text);
    const requests: any[] = [];
    const result = await decideEligibility(
      f.db,
      f.alice,
      job.id,
      text,
      'posting',
      {
        callModel: sol(
          f.db,
          {
            decision: 'excluded',
            quote: 'We cannot provide visa assistance for this role.',
            reason: 'No visa support.',
          },
          requests,
        ),
      },
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, SOL);
    assert.deepEqual(requests[0].reasoning, { effort: 'low' });
    assert.equal(requests[0].store, false);
    assert.match(requests[0].instructions, /JSON/);
    assert.ok(
      JSON.parse(requests[0].input).passages.join(' ').includes('visa'),
    );
    assert.equal(result.decision, 'excluded');
    assert.equal(result.provenance, 'sol');
    assert.equal(
      result.evidence,
      'We cannot provide visa assistance for this role.',
    );
    const [call] = await modelCalls(f);
    assert.equal(call.model, 'served-sol-snapshot');
    assert.equal(call.prompt_version, PROMPT_VERSION);
    assert.equal(call.input_tokens, 321);
    assert.equal(call.output_tokens, 54);
    const row = (await f.db.query('SELECT * FROM eligibility_decisions'))
      .rows[0];
    assert.equal(row.model_call_id, call.id);
    assert.equal(row.prompt_version, PROMPT_VERSION);
    const names = (await events(f, job.id)).map((e) => e.name);
    assert.deepEqual(names, [
      'job.selected',
      'model.called',
      'eligibility.decided',
    ]);
    // The dashboard shows decision, provenance, quote, model and tokens per job.
    const view = (
      await f.app.inject({
        url: '/api/eligibility',
        headers: { cookie: f.cookie },
      })
    ).json();
    assert.equal(view.decisions.length, 1);
    assert.equal(view.decisions[0].provenance, 'sol');
    assert.equal(view.decisions[0].evidence, result.evidence);
    assert.equal(view.decisions[0].model, 'served-sol-snapshot');
    assert.equal(view.decisions[0].inputTokens, 321);
    assert.equal(view.gate.ok, true);
    const bob = await f.login('bob@example.com');
    const other = (
      await f.app.inject({ url: '/api/eligibility', headers: { cookie: bob } })
    ).json();
    assert.equal(other.decisions.length, 0);
    assert.equal(
      (await f.app.inject({ url: '/api/eligibility' })).statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});

test('an unverifiable Sol quote opens an eligibility_ambiguity ticket instead of excluding', async () => {
  const f = await fixture();
  try {
    const text = 'Tools for citizen developers are a plus. Remote.';
    const job = await newJob(f, text);
    const result = await decideEligibility(
      f.db,
      f.alice,
      job.id,
      text,
      'posting',
      {
        callModel: sol(f.db, {
          decision: 'excluded',
          quote: 'Must be a U.S. citizen.',
          reason: 'Invented.',
        }),
      },
    );
    assert.equal(result.decision, 'review');
    assert.equal(result.reason, 'quote_unverified');
    assert.equal(result.evidence, null);
    const ticket = (await f.db.query('SELECT * FROM tickets')).rows[0];
    assert.equal(ticket.cause, 'eligibility_ambiguity');
    assert.equal(ticket.resolve_action, 'decide_eligibility');
    assert.equal(ticket.id, result.ticketId);
    assert.equal(await status(f, job.id), 'paused');
    const names = (await events(f, job.id)).map((e) => e.name);
    assert.deepEqual(names, [
      'job.selected',
      'model.called',
      'pause.opened',
      'eligibility.decided',
    ]);
    const decided = (await events(f, job.id)).at(-1)!;
    assert.deepEqual(decided.payload, {
      decision: 'review',
      provenance: 'sol',
      evidence: null,
    });
  } finally {
    await f.close();
  }
});

test('user decides an ambiguity ticket through the dashboard with user provenance, once', async () => {
  const f = await fixture();
  try {
    const text = 'We are unable to sponsor visas at this time. Hybrid.';
    const job = await newJob(f, text);
    const result = await decideEligibility(
      f.db,
      f.alice,
      job.id,
      text,
      'posting',
      {
        callModel: sol(f.db, {
          decision: 'unclear',
          quote: 'We are unable to sponsor visas at this time.',
          reason: 'Hedged.',
        }),
      },
    );
    assert.equal(result.decision, 'review');
    assert.equal(
      result.evidence,
      'We are unable to sponsor visas at this time.',
    );
    const url = `/api/eligibility/tickets/${result.ticketId}/decide`;
    const bob = await f.login('bob@example.com');
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: { origin, cookie: bob },
          payload: { decision: 'passed' },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: { cookie: f.cookie },
          payload: { decision: 'passed' },
        })
      ).statusCode,
      403,
    );
    const response = await f.app.inject({
      method: 'POST',
      url,
      headers: { origin, cookie: f.cookie },
      payload: { decision: 'passed', note: 'Recruiter confirmed H-1B later' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().provenance, 'user');
    assert.equal(await status(f, job.id), 'ready');
    const all = await events(f, job.id);
    const closed = all.find((e) => e.name === 'pause.closed')!;
    const opened = all.find((e) => e.name === 'pause.opened')!;
    assert.equal(closed.payload.pauseId, opened.payload.pauseId);
    assert.equal(closed.payload.outcome, 'approved');
    // pause.closed and the user decision share one transaction timestamp.
    const userDecision = all.find(
      (e) =>
        e.name === 'eligibility.decided' && e.payload.provenance === 'user',
    )!;
    assert.deepEqual(userDecision.payload, {
      decision: 'passed',
      provenance: 'user',
      evidence: 'We are unable to sponsor visas at this time.',
    });
    const again = await f.app.inject({
      method: 'POST',
      url,
      headers: { origin, cookie: f.cookie },
      payload: { decision: 'excluded' },
    });
    assert.equal(again.statusCode, 409);
    assert.equal(
      (await events(f, job.id)).filter((e) => e.name === 'pause.closed').length,
      1,
    );
    const view = (
      await f.app.inject({
        url: '/api/eligibility',
        headers: { cookie: f.cookie },
      })
    ).json();
    assert.equal(view.decisions[0].provenance, 'user');
    assert.equal(view.decisions[0].ticketOpen, false);
  } finally {
    await f.close();
  }
});

test('missing OpenAI credentials pause on a provider_limit ticket; retry reruns the same routes', async () => {
  const f = await fixture();
  try {
    const text = 'Visa sponsorship is available for this role.';
    const job = await newJob(f, text);
    const unconfigured = modelCaller(f.db, {
      solModel: SOL,
      lunaModel: 'luna',
    });
    const result = await decideEligibility(
      f.db,
      f.alice,
      job.id,
      text,
      'posting',
      {
        callModel: unconfigured,
      },
    );
    assert.equal(result.decision, 'review');
    assert.equal(result.reason, 'sol_unavailable');
    assert.equal((await modelCalls(f)).length, 0);
    const ticket = (await f.db.query('SELECT * FROM tickets')).rows[0];
    assert.equal(ticket.cause, 'provider_limit');
    assert.equal(ticket.resolve_action, 'retry_provider');
    const retried = await retryEligibilityTicket(f.db, f.alice, ticket.id, {
      callModel: sol(f.db, {
        decision: 'passed',
        quote: 'Visa sponsorship is available for this role.',
        reason: 'Sponsorship offered.',
      }),
    });
    assert.equal(retried.decision, 'passed');
    assert.equal(retried.provenance, 'sol');
    assert.equal(await status(f, job.id), 'ready');
    await assert.rejects(
      () => retryEligibilityTicket(f.db, f.alice, ticket.id),
      /already resolved/,
    );
    // Generic tickets are not eligibility tickets.
    const job2 = await newJob(f, 'Plain posting.');
    const other = await (
      await import('../src/server/ledger.js')
    ).openTicket(f.db, f.alice, job2.id, {
      question: 'Which employer?',
      choices: ['A'],
      employer: 'E',
      role: 'R',
      cause: 'employer_identity',
      resolveAction: 'resolve_employer',
    });
    await assert.rejects(
      () =>
        resolveEligibilityTicket(f.db, f.alice, other.id, {
          decision: 'passed',
        }),
      /Not an eligibility ticket/,
    );
  } finally {
    await f.close();
  }
});

test('form-revealed text reroutes through the same three routes without resetting fill status', async () => {
  const f = await fixture();
  try {
    const job = await newJob(f, 'Build reliable software.');
    assert.equal(
      (
        await decideEligibility(
          f.db,
          f.alice,
          job.id,
          'Build reliable software.',
          'posting',
        )
      ).decision,
      'passed',
    );
    assert.equal(await status(f, job.id), 'ready');
    // Benign form question passes via Sol and leaves the in-progress status alone.
    const question = 'Are you legally authorized to work in the United States?';
    const passed = await decideEligibility(
      f.db,
      f.alice,
      job.id,
      question,
      'form',
      {
        callModel: sol(f.db, {
          decision: 'passed',
          quote: null,
          reason: 'Question.',
        }),
      },
    );
    assert.equal(passed.decision, 'passed');
    assert.equal(passed.route, 'sol');
    assert.equal(await status(f, job.id), 'ready');
    // A newly revealed bar excludes by rule before submit.
    const bar =
      'Work authorization\nNote: We cannot sponsor work visas, now or in the future.';
    const excluded = await decideEligibility(
      f.db,
      f.alice,
      job.id,
      bar,
      'form',
    );
    assert.equal(excluded.decision, 'excluded');
    assert.equal(excluded.provenance, 'rule');
    assert.equal(
      excluded.evidence,
      'Note: We cannot sponsor work visas, now or in the future.',
    );
    assert.equal(await status(f, job.id), 'eligibility_excluded');
    const rows = (
      await f.db.query(
        'SELECT source,decision FROM eligibility_decisions WHERE job_id=$1 ORDER BY created_at',
        [job.id],
      )
    ).rows;
    assert.deepEqual(
      rows.map((r) => `${r.source}:${r.decision}`),
      ['posting:passed', 'form:passed', 'form:excluded'],
    );
  } finally {
    await f.close();
  }
});

test('blocked statuses, owner isolation and the replay gate stop eligibility before any model call', async () => {
  const f = await fixture();
  try {
    const text = 'Visa sponsorship is available.';
    const job = await newJob(f, text);
    const requests: any[] = [];
    await assert.rejects(
      () => decideEligibility(f.db, f.bob, job.id, text, 'posting'),
      /not found/,
    );
    await f.db.query("UPDATE jobs SET status='capped' WHERE id=$1", [job.id]);
    await assert.rejects(
      () =>
        decideEligibility(f.db, f.alice, job.id, text, 'posting', {
          callModel: sol(f.db, {}, requests),
        }),
      /capped/,
    );
    await f.db.query("UPDATE jobs SET status='captured' WHERE id=$1", [job.id]);
    assert.equal(replayGate('unreplayed-model').ok, false);
    const gated = await decideEligibility(
      f.db,
      f.alice,
      job.id,
      text,
      'posting',
      {
        callModel: sol(f.db, {}, requests),
        solModel: 'unreplayed-model',
      },
    );
    assert.equal(requests.length, 0);
    assert.equal(gated.decision, 'review');
    assert.equal(gated.reason, 'replay_gate');
    assert.equal(
      (await f.db.query('SELECT cause FROM tickets')).rows[0].cause,
      'eligibility_ambiguity',
    );
  } finally {
    await f.close();
  }
});
