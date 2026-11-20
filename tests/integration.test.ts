/**
 * P2 cross-lane integration: one open ticket per job, employer merge across lanes, ticket
 * ownership between lanes, generic Defer per lane, and the queue → eligibility hand-off.
 * Synthetic employers and people only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, origin } from './helpers.js';
import { outreachFixture } from './fixtures/outreach/setup.js';
import { capture, csv, jobRow, queueRow } from './fixtures/identity/helpers.js';
import {
  closeTicketTx,
  isOpenTicketConflict,
  openTicket,
} from '../src/server/ledger.js';
import { modelCaller } from '../src/server/model.js';
import type { Database } from '../src/server/db.js';
import {
  handleOutreachEvent,
  sweepOutreach,
} from '../src/server/outreach/worker.js';
import { openOutreachTicket } from '../src/server/outreach/deps.js';
import { mergeEmployers } from '../src/server/identity/employers.js';
import { importHistory } from '../src/server/identity/importer.js';
import { dequeueNext } from '../src/server/identity/queue.js';
import {
  answersInScope,
  listAnswers,
  proposeAlias,
  upsertAnswer,
} from '../src/server/answers/bank.js';
import {
  advanceFieldSession,
  pendingQuestions,
  startFieldSession,
} from '../src/server/answers/session.js';
import { decideEligibility } from '../src/server/eligibility/decide.js';
import { configuredSolModel } from '../src/server/eligibility/sol.js';
import { screenQueuedJob } from '../src/server/screening.js';

const SOL = configuredSolModel();
function sol(db: Database, reply: unknown, requests: unknown[] = []) {
  return modelCaller(
    db,
    { apiKey: 'test-key', solModel: SOL, lunaModel: 'luna' },
    (async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return Response.json({
        status: 'completed',
        model: 'served-sol-snapshot',
        usage: { input_tokens: 10, output_tokens: 5 },
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify(reply) }],
          },
        ],
      });
    }) as typeof fetch,
  );
}
const foreignTicket = {
  question: 'Synthetic blocking ticket from another lane',
  choices: ['passed', 'excluded'],
  employer: 'Northwind Example',
  role: 'Software Engineer',
  cause: 'eligibility_ambiguity' as const,
  resolveAction: 'decide_eligibility' as const,
};
async function ticketRow(db: Database, id: string) {
  return (await db.query('SELECT * FROM tickets WHERE id=$1', [id])).rows[0];
}
async function eventNames(db: Database, jobId: string) {
  return (
    await db.query(
      'SELECT name, payload FROM ledger_events WHERE job_id=$1 ORDER BY occurred_at, id',
      [jobId],
    )
  ).rows;
}

test('one open ticket per job: outreach defers to another lane’s ticket, logs it, and the sweep retries after it closes', async () => {
  const f = await outreachFixture();
  try {
    const { jobId, event } = await f.job();
    // Another lane's pause lands after the job was read as confirmed (race): the job keeps
    // `confirmed` here so the worker gets past its status gate.
    const blocker = await openTicket(f.db, f.alice, jobId, foreignTicket);
    await f.db.query("UPDATE jobs SET status='confirmed' WHERE id=$1", [jobId]);
    assert.equal(
      await handleOutreachEvent(f.deps, event),
      'deferred_open_ticket',
    );
    assert.equal(f.apollo.total, 0, 'no Apollo call while blocked');
    // The tag write path defers too instead of throwing (and leaves no stray tag).
    assert.equal(
      await openOutreachTicket(f.deps, f.alice, jobId, 'provider', {
        ...foreignTicket,
        cause: 'provider_limit',
        resolveAction: 'retry_provider',
      }),
      null,
    );
    const log = (
      await f.db.query(
        'SELECT outcome FROM outreach_worker_log WHERE job_id=$1 ORDER BY created_at',
        [jobId],
      )
    ).rows.map((row) => row.outcome);
    assert.deepEqual(log, ['deferred_open_ticket', 'deferred_open_ticket']);
    assert.equal(
      (await f.db.query('SELECT count(*)::int AS n FROM outreach_tickets'))
        .rows[0].n,
      0,
    );
    // The sweep leaves blocked jobs alone, then picks the job up once the ticket closes.
    assert.deepEqual(await sweepOutreach(f.deps), []);
    const blockerRow = await ticketRow(f.db, blocker.id);
    await f.db.transaction((sql) =>
      closeTicketTx(
        sql,
        f.alice,
        blockerRow,
        { outcome: 'no_change', value: 'cleared' },
        'confirmed',
      ),
    );
    assert.deepEqual(await sweepOutreach(f.deps), ['review_opened']);
    assert.equal(f.apollo.calls.searchPeople, 1);
  } finally {
    await f.close();
  }
});

test('eligibility and answer sessions wait for another lane’s open ticket instead of throwing past it', async () => {
  const f = await fixture();
  try {
    const job = await capture(f.db, f.alice, {
      postingText: 'Visa sponsorship may be discussed later.',
    });
    const blocker = await openTicket(f.db, f.alice, job.id, foreignTicket);
    // Answer session: no Luna call, no second ticket, stays running at the field.
    const session = await startFieldSession(f.db, f.alice, job.id, [
      { fieldId: 'q1', question: 'Favorite synthetic color?', choices: [] },
    ]);
    const lunaCalls: unknown[] = [];
    const advanced = await advanceFieldSession(
      f.db,
      { callModel: sol(f.db, {}, lunaCalls) },
      f.alice,
      session.sessionId,
    );
    assert.equal(advanced.status, 'running');
    assert.equal(advanced.resumeIndex, 0);
    assert.equal(advanced.blockedByTicketId, blocker.id);
    assert.equal(lunaCalls.length, 0);
    // Eligibility racing the pause (status read before it): the review ticket conflicts,
    // nothing is recorded, and the error is the typed 409.
    await f.db.query("UPDATE jobs SET status='captured' WHERE id=$1", [job.id]);
    await assert.rejects(
      decideEligibility(f.db, f.alice, job.id, job.postingText, 'posting', {
        callModel: sol(f.db, {
          decision: 'unclear',
          quote: null,
          reason: 'hedged',
        }),
        solModel: SOL,
      }),
      (error) => isOpenTicketConflict(error),
    );
    assert.equal(
      (
        await f.db.query(
          'SELECT count(*)::int AS n FROM eligibility_decisions WHERE job_id=$1',
          [job.id],
        )
      ).rows[0].n,
      0,
    );
    const open = await f.db.query(
      "SELECT id FROM tickets WHERE job_id=$1 AND status='open'",
      [job.id],
    );
    assert.deepEqual(
      open.rows.map((row) => row.id),
      [blocker.id],
    );
  } finally {
    await f.close();
  }
});

test('employer merge re-points answers and aliases in one transaction; conflicting employer answers both stay for review', async () => {
  const f = await fixture();
  try {
    const employer = async (name: string) => {
      const id = randomUUID();
      await f.db.query(
        'INSERT INTO employers (id,applicant_id,name) VALUES ($1,$2,$3)',
        [id, f.alice, name],
      );
      return id;
    };
    const source = await employer('Contoso Labs Example');
    const target = await employer('Contoso Example');
    const save = (employerId: string, question: string, answer: string) =>
      f.db.transaction((sql) =>
        upsertAnswer(sql, f.alice, {
          scope: 'employer',
          canonicalEmployerId: employerId,
          question,
          choices: ['Yes', 'No'],
          answer,
          source: 'dashboard',
        }),
      );
    const relocateSource = (await save(source, 'Willing to relocate?', 'Yes'))!;
    const relocateTarget = (await save(target, 'Willing to relocate?', 'yes'))!;
    const nonCompeteSource = (await save(
      source,
      'Bound by a non-compete?',
      'No',
    ))!;
    const nonCompeteTarget = (await save(
      target,
      'Bound by a non-compete?',
      'Yes',
    ))!;
    const onlySource = (await save(source, 'Referred by an employee?', 'No'))!;
    const global = (await f.db.transaction((sql) =>
      upsertAnswer(sql, f.alice, {
        scope: 'global',
        question: 'Open to hybrid work?',
        choices: ['Yes', 'No'],
        answer: 'Yes',
        source: 'dashboard',
      }),
    ))!;
    await f.db.transaction(async (sql) => {
      // An employer-specific alias of a global answer, and one per folded/conflicting answer.
      await proposeAlias(sql, f.alice, {
        answerId: global,
        canonicalEmployerId: source,
        question: 'Comfortable with a hybrid schedule?',
        score: 0.9,
      });
      await proposeAlias(sql, f.alice, {
        answerId: relocateSource,
        canonicalEmployerId: source,
        question: 'Open to relocating?',
        score: 0.9,
      });
      await proposeAlias(sql, f.alice, {
        answerId: nonCompeteSource,
        canonicalEmployerId: source,
        question: 'Any non-compete agreement?',
        score: 0.9,
      });
    });
    await f.db.query(
      "UPDATE answer_aliases SET status='approved' WHERE applicant_id=$1",
      [f.alice],
    );
    await f.db.transaction((sql) =>
      mergeEmployers(sql, f.alice, source, target),
    );
    const answers = (
      await f.db.query('SELECT * FROM answers WHERE applicant_id=$1', [f.alice])
    ).rows;
    const byId = new Map<string, any>(answers.map((row) => [row.id, row]));
    // Same answer: folded into the target and deleted.
    assert.ok(!byId.has(relocateSource));
    assert.equal(byId.get(relocateTarget).canonical_employer_id, target);
    // Only on the source: moved.
    assert.equal(byId.get(onlySource).canonical_employer_id, target);
    // Different answers: both kept and flagged; the target's stays in force for matching.
    assert.equal(byId.get(nonCompeteSource).canonical_employer_id, source);
    assert.equal(byId.get(nonCompeteSource).needs_review, true);
    assert.equal(byId.get(nonCompeteTarget).needs_review, true);
    const inScope = await answersInScope(f.db, f.alice, randomUUID(), target);
    assert.deepEqual(
      inScope
        .filter((row) => row.scope === 'employer')
        .map((row) => row.answer)
        .sort(),
      ['No', 'Yes', 'yes'],
    );
    assert.ok(!inScope.some((row) => row.id === nonCompeteSource));
    const listed = await listAnswers(f.db, f.alice);
    assert.ok(listed.answers.some((a) => a.id === nonCompeteSource));
    // Aliases follow the employer; the folded answer's alias moved to the target answer;
    // the conflicting answer's alias stays with it.
    const aliases = (
      await f.db.query('SELECT * FROM answer_aliases WHERE applicant_id=$1', [
        f.alice,
      ])
    ).rows;
    const alias = (q: string) => aliases.find((row) => row.question === q)!;
    assert.equal(
      alias('Comfortable with a hybrid schedule?').canonical_employer_id,
      target,
    );
    assert.equal(alias('Open to relocating?').answer_id, relocateTarget);
    assert.equal(alias('Open to relocating?').canonical_employer_id, target);
    assert.equal(alias('Open to relocating?').status, 'approved');
    assert.equal(
      alias('Any non-compete agreement?').canonical_employer_id,
      source,
    );
    // A failure later in the merge rolls the answer moves back (one transaction).
    const other = await employer('Fabrikam Example');
    const third = (await save(other, 'Willing to travel?', 'Yes'))!;
    await assert.rejects(
      f.db.transaction(async (sql) => {
        await mergeEmployers(sql, f.alice, other, target);
        throw new Error('abort after merge');
      }),
    );
    assert.equal(
      (
        await f.db.query(
          'SELECT canonical_employer_id FROM answers WHERE id=$1',
          [third],
        )
      ).rows[0].canonical_employer_id,
      other,
    );
  } finally {
    await f.close();
  }
});

test('lane handlers only resolve their own tickets: outreach resolve_employer vs identity, answers vs outreach review', async () => {
  const f = await outreachFixture();
  try {
    const inject = f.inject;
    // Outreach domain ticket (employer_identity / resolve_employer, tagged in outreach_tickets).
    const employerId = await f.employer('Contoso Example', null);
    const domainJob = await f.job({
      employerId,
      postingText:
        'Build services. About us: https://www.contoso.example/about',
    });
    assert.equal(
      await handleOutreachEvent(f.deps, domainJob.event),
      'paused_domain',
    );
    const domainTicket = (
      await f.db.query(
        "SELECT * FROM tickets WHERE job_id=$1 AND status='open'",
        [domainJob.jobId],
      )
    ).rows[0];
    assert.equal(domainTicket.resolve_action, 'resolve_employer');
    const identity = await inject(
      'POST',
      `/api/identity/tickets/${domainTicket.id}/resolve`,
      { action: 'assign', employerId },
    );
    assert.equal(identity.statusCode, 409, identity.body);
    const generic = await inject(
      'POST',
      `/api/tickets/${domainTicket.id}/resolve`,
      {
        outcome: 'approved',
        value: 'contoso.example',
      },
    );
    assert.equal(generic.statusCode, 409);
    assert.equal((await ticketRow(f.db, domainTicket.id)).status, 'open');

    // Identity ticket (plausible match at capture) is not an outreach ticket.
    await f.employer('Fabrikam Example', null);
    const captured = await f.app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { origin, cookie: f.cookie },
      payload: {
        clientCaptureId: randomUUID(),
        title: 'Data Engineer',
        employer: 'Fabrikam Example Inc.',
        discoveryUrl: 'https://www.linkedin.com/jobs/view/555',
        applicationUrl: 'https://jobs.lever.co/fabrikam/1',
        postingText: 'Build pipelines. Remote within the United States.',
      },
    });
    const capturedJob = captured.json();
    assert.equal(capturedJob.status, 'paused');
    const identityTicket = (
      await f.db.query(
        "SELECT * FROM tickets WHERE job_id=$1 AND status='open'",
        [capturedJob.id],
      )
    ).rows[0];
    assert.equal(identityTicket.cause, 'employer_identity');
    for (const path of ['domain', 'retry'])
      assert.equal(
        (
          await inject('POST', `/api/outreach/jobs/${capturedJob.id}/${path}`, {
            domain: 'fabrikam.example',
          })
        ).statusCode,
        409,
        path,
      );
    assert.equal((await ticketRow(f.db, identityTicket.id)).status, 'open');

    // Outreach review tickets share cause unanswered_question with answer tickets.
    const review = await f.job();
    assert.equal(
      await handleOutreachEvent(f.deps, review.event),
      'review_opened',
    );
    const reviewTicket = (
      await f.db.query(
        "SELECT * FROM tickets WHERE job_id=$1 AND status='open'",
        [review.jobId],
      )
    ).rows[0];
    assert.equal(reviewTicket.cause, 'unanswered_question');
    const answered = await inject(
      'POST',
      `/api/answers/questions/${reviewTicket.id}/resolve`,
      { action: 'answer_global', answer: reviewTicket.choices[0] },
    );
    assert.equal(answered.statusCode, 409, answered.body);
    assert.equal((await ticketRow(f.db, reviewTicket.id)).status, 'open');
    assert.equal(
      (await f.db.query('SELECT count(*)::int AS n FROM answers')).rows[0].n,
      0,
    );
    assert.deepEqual(await pendingQuestions(f.db, f.alice), []);
  } finally {
    await f.close();
  }
});

test('generic Defer routes to the lane: answer sessions end deferred, outreach records outreach.reviewed and keeps the confirmation', async () => {
  const f = await outreachFixture();
  try {
    // Answers: a required unknown field pauses the session (Luna not configured).
    const captured = await f.app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { origin, cookie: f.cookie },
      payload: {
        clientCaptureId: randomUUID(),
        title: 'Platform Engineer',
        employer: 'Tailspin Example',
        discoveryUrl: 'https://www.linkedin.com/jobs/view/777',
        applicationUrl: 'https://jobs.ashbyhq.com/tailspin/1',
        postingText: 'Run platforms. Remote within the United States.',
      },
    });
    const job = captured.json();
    const session = await startFieldSession(f.db, f.alice, job.id, [
      { fieldId: 'q1', question: 'Synthetic required question?', choices: [] },
    ]);
    const paused = await advanceFieldSession(
      f.db,
      {},
      f.alice,
      session.sessionId,
    );
    assert.equal(paused.status, 'paused');
    const deferred = await f.inject(
      'POST',
      `/api/tickets/${paused.ticketId}/resolve`,
      {
        outcome: 'deferred',
        value: 'Not now',
      },
    );
    assert.equal(deferred.statusCode, 200, deferred.body);
    const sessionRow = (
      await f.db.query('SELECT * FROM answer_sessions WHERE id=$1', [
        session.sessionId,
      ])
    ).rows[0];
    assert.equal(sessionRow.status, 'deferred');
    assert.equal(sessionRow.ticket_id, null);
    assert.equal((await jobRow(f.db, job.id)).status, 'deferred');
    const item = await queueRow(f.db, job.id);
    assert.equal(item.state, 'stopped');
    assert.equal(item.stop_reason, 'deferred');

    // Outreach review: deferred like a skip, but with outcome `deferred`.
    const review = await f.job();
    assert.equal(
      await handleOutreachEvent(f.deps, review.event),
      'review_opened',
    );
    const reviewTicket = (
      await f.db.query(
        "SELECT * FROM tickets WHERE job_id=$1 AND status='open'",
        [review.jobId],
      )
    ).rows[0];
    const reviewDeferred = await f.inject(
      'POST',
      `/api/tickets/${reviewTicket.id}/resolve`,
      { outcome: 'deferred', value: 'Later' },
    );
    assert.equal(reviewDeferred.statusCode, 200, reviewDeferred.body);
    const events = await eventNames(f.db, review.jobId);
    assert.deepEqual(
      events.slice(-2).map((e) => [e.name, e.payload.outcome]),
      [
        ['pause.closed', 'deferred'],
        ['outreach.reviewed', 'deferred'],
      ],
    );
    assert.equal(events.at(-1)!.payload.ticketId, reviewTicket.id);
    assert.equal((await jobRow(f.db, review.jobId)).status, 'confirmed');
    const reviewRow = (
      await f.db.query('SELECT * FROM outreach_reviews WHERE job_id=$1', [
        review.jobId,
      ])
    ).rows[0];
    assert.deepEqual(
      [reviewRow.status, reviewRow.outcome],
      ['skipped', 'deferred'],
    );
    assert.equal(f.smtp.sends.length, 0);
    assert.equal(
      await handleOutreachEvent(f.deps, review.event),
      'skipped_deferred',
    );

    // Outreach domain pause: the position stays confirmed and the sweep does not reopen it.
    const domainJob = await f.job({
      employerId: await f.employer('Wingtip Example', null),
      postingText: 'Build services. About us: https://www.wingtip.example/',
    });
    assert.equal(
      await handleOutreachEvent(f.deps, domainJob.event),
      'paused_domain',
    );
    const domainTicket = (
      await f.db.query(
        "SELECT id FROM tickets WHERE job_id=$1 AND status='open'",
        [domainJob.jobId],
      )
    ).rows[0];
    assert.equal(
      (
        await f.inject('POST', `/api/tickets/${domainTicket.id}/resolve`, {
          outcome: 'deferred',
          value: 'Later',
        })
      ).statusCode,
      200,
    );
    assert.equal((await jobRow(f.db, domainJob.jobId)).status, 'confirmed');
    assert.deepEqual(await sweepOutreach(f.deps), []);
  } finally {
    await f.close();
  }
});

test('queue → eligibility: the gate runs first; status hand-off and queue state stay coherent', async () => {
  const f = await fixture();
  const now = new Date();
  try {
    // Capped after capture: screening refuses before rules or Sol.
    await f.db.query(
      'INSERT INTO cap_settings (applicant_id,cap_limit,window_months) VALUES ($1,1,3)',
      [f.alice],
    );
    const capped = await capture(f.db, f.alice, {
      title: 'Robotics Engineer',
      applicationUrl: 'https://boards.greenhouse.io/acmerobotics/jobs/2001',
      postingText: 'Must be a U.S. citizen.',
    });
    assert.equal(capped.status, 'captured');
    const yesterday = new Date(now.getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    await importHistory(
      f.db,
      f.alice,
      {
        filename: 'history.csv',
        csv: csv(
          `Acme Robotics,Old Role,${yesterday},https://boards.greenhouse.io/acmerobotics/jobs/1`,
        ),
      },
      now,
    );
    const requests: unknown[] = [];
    const deps = {
      callModel: sol(
        f.db,
        { decision: 'passed', quote: null, reason: 'ok' },
        requests,
      ),
      solModel: SOL,
    };
    const gated = await screenQueuedJob(f.db, f.alice, capped.id, deps, now);
    assert.equal(gated.status, 'gated');
    assert.equal((await jobRow(f.db, capped.id)).status, 'capped');
    assert.equal(requests.length, 0);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int AS n FROM ledger_events WHERE job_id=$1 AND name='eligibility.decided'",
          [capped.id],
        )
      ).rows[0].n,
      0,
    );

    // Review: captured → eligibility_pending → paused on the ticket; the queue item pauses.
    const unclear = await capture(f.db, f.alice, {
      employer: 'Northwind Example',
      applicationUrl: 'https://boards.greenhouse.io/northwind/jobs/7',
      postingText: 'Some client roles may need a security clearance.',
    });
    const next = await dequeueNext(f.db, f.alice, now);
    assert.equal(next!.job.id, unclear.id);
    const reviewed = await screenQueuedJob(
      f.db,
      f.alice,
      unclear.id,
      {
        callModel: sol(f.db, {
          decision: 'unclear',
          quote: null,
          reason: 'hedge',
        }),
        solModel: SOL,
      },
      now,
    );
    assert.equal(reviewed.status, 'decided');
    const ticketId =
      reviewed.status === 'decided' ? reviewed.result.ticketId! : '';
    assert.equal(
      (await ticketRow(f.db, ticketId)).resume_status,
      'eligibility_pending',
    );
    assert.equal((await queueRow(f.db, unclear.id)).state, 'paused');
    // The user passes it: ready, back in line; dequeue + screen does not call Sol again.
    const decided = await f.app.inject({
      method: 'POST',
      url: `/api/eligibility/tickets/${ticketId}/decide`,
      headers: { origin, cookie: f.cookie },
      payload: { decision: 'passed' },
    });
    assert.equal(decided.statusCode, 200, decided.body);
    assert.equal((await jobRow(f.db, unclear.id)).status, 'ready');
    assert.equal((await queueRow(f.db, unclear.id)).state, 'queued');
    assert.equal((await dequeueNext(f.db, f.alice, now))!.job.id, unclear.id);
    const again = await screenQueuedJob(f.db, f.alice, unclear.id, deps, now);
    assert.equal(again.status, 'already_screened');
    assert.equal(requests.length, 0);

    // Rule exclusion: eligibility_excluded and the queue item stops.
    const excluded = await capture(f.db, f.alice, {
      employer: 'Tailspin Example',
      applicationUrl: 'https://jobs.lever.co/tailspin/9',
      postingText: 'Must be a U.S. citizen.',
    });
    const result = await screenQueuedJob(f.db, f.alice, excluded.id, deps, now);
    assert.equal(
      result.status === 'decided' && result.result.decision,
      'excluded',
    );
    assert.equal(
      (await jobRow(f.db, excluded.id)).status,
      'eligibility_excluded',
    );
    const item = await queueRow(f.db, excluded.id);
    assert.deepEqual(
      [item.state, item.stop_reason],
      ['stopped', 'eligibility_excluded'],
    );
  } finally {
    await f.close();
  }
});
