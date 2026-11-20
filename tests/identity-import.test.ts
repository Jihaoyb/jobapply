import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, origin } from './helpers.js';
import {
  capture,
  csv,
  events,
  jobRow,
  openTickets,
  queueRow,
} from './fixtures/identity/helpers.js';
import { importHistory } from '../src/server/identity/importer.js';
import { resolveIdentityTicket } from '../src/server/identity/resolve.js';
import { employerCap } from '../src/server/identity/gate.js';
import {
  beginSubmit,
  confirmSubmission,
  dequeueNext,
} from '../src/server/identity/queue.js';

const nov8 = new Date('2026-11-08T20:00:00Z'); // Nov 8, 12:00 PST
const nov9 = new Date('2026-11-09T20:00:00Z');

test('an unmatched employer opens one import ticket; once resolved its rows count on their original local dates', async () => {
  const f = await fixture();
  try {
    const result = await importHistory(
      f.db,
      f.alice,
      {
        filename: 'history.csv',
        csv: csv(
          'Umbrella Labs,Software Engineer,2026-08-09,https://umbrella.example/careers/1',
          'Umbrella Labs,Platform Engineer,2026-10-15,https://umbrella.example/careers/2',
          'Umbrella Labs,Bad Row,2026-13-01,https://umbrella.example/careers/3',
        ),
      },
      nov8,
    );
    assert.equal(result.summary.pending_employer, 2);
    assert.equal(result.summary.errors, 1);
    assert.deepEqual(
      result.errors.map((e) => [e.line, e.column]),
      [[4, 'date']],
    );
    const tickets = await openTickets(f.db, f.alice);
    assert.equal(tickets.length, 1, 'one ticket per unmatched employer');
    assert.equal(tickets[0].cause, 'import_ambiguity');
    assert.equal(tickets[0].resolve_action, 'resolve_import');
    assert.match(tickets[0].question, /Umbrella Labs/);
    // Unresolved rows do not count yet.
    assert.equal(
      (await f.db.query('SELECT * FROM submissions')).rows.length,
      0,
    );
    // Imported history never enters the pilot funnel.
    assert.equal((await events(f.db, f.alice, 'job.selected')).length, 0);
    const resolved = await f.app.inject({
      method: 'POST',
      url: `/api/identity/tickets/${tickets[0].id}/resolve`,
      headers: { origin, cookie: f.cookie },
      payload: { action: 'create' },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.deepEqual(resolved.json().imported, { counted: 2, linked: 0 });
    const employerId = resolved.json().employerId;
    const dates = (
      await f.db.query(
        "SELECT to_char(local_date,'YYYY-MM-DD') AS d, kind, state FROM submissions ORDER BY local_date",
      )
    ).rows;
    assert.deepEqual(
      dates.map((row) => [row.d, row.kind, row.state]),
      [
        ['2026-08-09', 'imported', 'confirmed'],
        ['2026-10-15', 'imported', 'confirmed'],
      ],
    );
    // Aug 9 counts on Nov 8 and has aged out on Nov 9 (open lower boundary).
    assert.equal((await employerCap(f.db, f.alice, employerId, nov8)).count, 2);
    assert.equal((await employerCap(f.db, f.alice, employerId, nov9)).count, 1);
    const host = await jobRow(f.db, tickets[0].job_id);
    assert.equal(host.status, 'confirmed');
    assert.equal(host.canonical_employer_id, employerId);
    const alias = (
      await f.db.query(
        "SELECT * FROM employer_aliases WHERE alias_key='umbrella.example'",
      )
    ).rows[0];
    assert.equal(alias.employer_id, employerId);
    assert.equal(alias.source, 'import');
    const pause = await events(f.db, f.alice, 'pause.closed');
    assert.equal(pause.length, 1);
    assert.equal(pause[0].payload.cause, 'import_ambiguity');
  } finally {
    await f.close();
  }
});

test('re-importing and matching an existing confirmed job keep a single submission', async () => {
  const f = await fixture();
  try {
    // A live confirmed application through the queue.
    const live = await capture(f.db, f.alice, {
      employer: 'Soylent',
      applicationUrl: 'https://boards.greenhouse.io/soylent/jobs/42',
    });
    assert.equal((await dequeueNext(f.db, f.alice, nov8))?.job.id, live.id);
    assert.equal((await beginSubmit(f.db, f.alice, live.id, nov8)).ok, true);
    await confirmSubmission(f.db, f.alice, live.id, randomUUID());
    const file = csv(
      // The same application, recorded by the applicant with a LinkedIn link.
      'Soylent Corp,Software Engineer,2026-11-08,https://www.linkedin.com/jobs/view/42',
      // Same requisition via its ATS URL.
      'Soylent,SWE,2026-11-08,https://boards.greenhouse.io/soylent/jobs/42',
      // A genuinely different earlier application.
      'Soylent,Data Engineer,2026-10-01,https://boards.greenhouse.io/soylent/jobs/7',
    );
    const first = await importHistory(
      f.db,
      f.alice,
      { filename: 'a.csv', csv: file },
      nov8,
    );
    assert.deepEqual(
      first.rows.map((row) => row.outcome),
      ['linked', 'linked', 'counted'],
    );
    const again = await f.app.inject({
      method: 'POST',
      url: '/api/identity/imports',
      headers: { origin, cookie: f.cookie },
      payload: { filename: 'a.csv', csv: file },
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.deepEqual(
      again.json().rows.map((row: any) => row.outcome),
      ['already_imported', 'already_imported', 'already_imported'],
    );
    const submissions = (
      await f.db.query('SELECT * FROM submissions WHERE applicant_id=$1', [
        f.alice,
      ])
    ).rows;
    assert.equal(submissions.length, 2);
    assert.equal(
      (await employerCap(f.db, f.alice, live.canonicalEmployerId!, nov8)).count,
      2,
    );
    assert.equal((await openTickets(f.db, f.alice)).length, 0);
  } finally {
    await f.close();
  }
});

test('an imported application stops an unsubmitted queued sighting of the same requisition', async () => {
  const f = await fixture();
  try {
    const queued = await capture(f.db, f.alice, {
      employer: 'Cyberdyne',
      applicationUrl:
        'https://jobs.lever.co/cyberdyne/0f1e2d3c-aaaa-bbbb-cccc-0000000000aa',
    });
    assert.equal((await queueRow(f.db, queued.id)).state, 'queued');
    const result = await importHistory(
      f.db,
      f.alice,
      {
        filename: 'history.csv',
        csv: csv(
          'Cyberdyne Systems,Software Engineer,2026-11-01,https://jobs.lever.co/cyberdyne/0f1e2d3c-aaaa-bbbb-cccc-0000000000aa',
        ),
      },
      nov8,
    );
    assert.equal(result.summary.counted, 1);
    assert.equal((await jobRow(f.db, queued.id)).status, 'duplicate');
    assert.equal((await queueRow(f.db, queued.id)).state, 'stopped');
    assert.equal(await dequeueNext(f.db, f.alice, nov8), null);
  } finally {
    await f.close();
  }
});

test('import requires a signed-in dashboard origin and reports file-level errors without importing', async () => {
  const f = await fixture();
  try {
    const noOrigin = await f.app.inject({
      method: 'POST',
      url: '/api/identity/imports',
      headers: { cookie: f.cookie },
      payload: { csv: csv('A,B,2026-01-01,https://a.example/1') },
    });
    assert.equal(noOrigin.statusCode, 403);
    const badHeader = await f.app.inject({
      method: 'POST',
      url: '/api/identity/imports',
      headers: { origin, cookie: f.cookie },
      payload: { csv: 'company,role,applied\nA,B,2026-01-01' },
    });
    assert.equal(badHeader.statusCode, 200);
    assert.equal(badHeader.json().batchId, null);
    assert.match(badHeader.json().errors[0].message, /header/);
    // Two rows for the same unknown employer share one ticket; a second employer gets its own.
    const result = await importHistory(
      f.db,
      f.alice,
      {
        filename: 'h.csv',
        csv: csv(
          'Tyrell,Engineer,2026-09-01,https://tyrell.example/jobs/1',
          'Tyrell,Engineer II,2026-09-02,https://tyrell.example/jobs/2',
          'Wonka,Chocolatier,2026-09-03,https://wonka.example/jobs/1',
        ),
      },
      nov8,
    );
    assert.equal(result.summary.pending_employer, 3);
    assert.equal((await openTickets(f.db, f.alice)).length, 2);
    // Bob cannot resolve Alice's import ticket.
    const [ticket] = await openTickets(f.db, f.alice);
    await assert.rejects(
      () => resolveIdentityTicket(f.db, f.bob, ticket.id, { action: 'create' }),
      /not found/,
    );
  } finally {
    await f.close();
  }
});
