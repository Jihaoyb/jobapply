/**
 * Regression tests for the P2 review findings in lane A (identity): merge primary selection,
 * submit gating on eligibility, cap-settings serialization and import linking to in-flight
 * submissions. Synthetic employers and postings only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, origin, password } from './helpers.js';
import {
  capture,
  csv,
  events,
  jobRow,
  passEligibility,
  queueRow,
} from './fixtures/identity/helpers.js';
import { createApp } from '../src/server/app.js';
import type { Database, Sql } from '../src/server/db.js';
import { mergeEmployers } from '../src/server/identity/employers.js';
import { importHistory } from '../src/server/identity/importer.js';
import {
  beginSubmit,
  dequeueNext,
  gateBeforeEligibility,
  markUncertain,
} from '../src/server/identity/queue.js';

const now = new Date('2026-11-08T20:00:00Z');

test('merge: a confirmed job stays primary over an older unsubmitted sighting of the same requisition', async () => {
  const f = await fixture();
  try {
    // A: older captured sighting, employer X.
    const a = await capture(f.db, f.alice);
    const ja = await jobRow(f.db, a.id);
    const ia = (
      await f.db.query('SELECT * FROM job_identity WHERE job_id=$1', [a.id])
    ).rows[0];
    assert.ok(ia.requisition_id);
    // B: same requisition recorded under a separate employer Y, created later, already confirmed.
    const y = randomUUID(),
      b = randomUUID();
    await f.db.query(
      "INSERT INTO employers (id,applicant_id,name) VALUES ($1,$2,'Acme Robotics (other record)')",
      [y, f.alice],
    );
    await f.db.query(
      `INSERT INTO jobs (id,applicant_id,client_capture_id,title,employer,discovery_url,application_url,posting_text,source,status,application_host,supported_host,canonical_employer_id,created_at)
       VALUES ($1,$2,$3,'Software Engineer','Acme Robotics','https://x.example/1','https://x.example/1','t','manual','confirmed','x.example',false,$4, now()+interval '1 minute')`,
      [b, f.alice, randomUUID(), y],
    );
    await f.db.query(
      'INSERT INTO job_identity (job_id,applicant_id,canonical_employer_id,requisition_id,title_key,location_key) VALUES ($1,$2,$3,$4,$5,$6)',
      [b, f.alice, y, ia.requisition_id, ia.title_key, ia.location_key],
    );
    await f.db.query(
      "INSERT INTO submissions (id,applicant_id,job_id,canonical_employer_id,kind,state,local_date) VALUES ($1,$2,$3,$4,'live','confirmed',current_date)",
      [randomUUID(), f.alice, b, y],
    );
    await f.db.transaction((sql) =>
      mergeEmployers(sql, f.alice, ja.canonical_employer_id, y),
    );
    const identity = Object.fromEntries(
      (
        await f.db.query(
          'SELECT job_id,duplicate_of FROM job_identity WHERE applicant_id=$1',
          [f.alice],
        )
      ).rows.map((row) => [row.job_id, row.duplicate_of]),
    );
    assert.equal(identity[b], null, 'the confirmed job is the primary record');
    assert.equal(
      identity[a.id],
      b,
      'the unsubmitted sighting is its duplicate',
    );
    assert.equal((await jobRow(f.db, a.id)).status, 'duplicate');
    assert.equal((await jobRow(f.db, b)).status, 'confirmed');
    assert.equal((await queueRow(f.db, a.id)).state, 'stopped');
    // End to end: the older sighting can no longer reach eligibility or a second submission.
    const gate = await gateBeforeEligibility(f.db, f.alice, a.id, now);
    assert.equal(gate.allowed, false);
    assert.notEqual(gate.result.status, 'ok');
    assert.equal(await dequeueNext(f.db, f.alice, now), null);
  } finally {
    await f.close();
  }
});

test('beginSubmit refuses a job that never passed eligibility', async () => {
  const f = await fixture();
  try {
    const a = await capture(f.db, f.alice);
    assert.equal((await dequeueNext(f.db, f.alice, now))?.job.id, a.id);
    assert.equal((await jobRow(f.db, a.id)).status, 'captured');
    assert.deepEqual(await beginSubmit(f.db, f.alice, a.id, now), {
      ok: false,
      reason: 'not_ready',
    });
    await f.db.query(
      "UPDATE jobs SET status='eligibility_pending' WHERE id=$1",
      [a.id],
    );
    assert.deepEqual(await beginSubmit(f.db, f.alice, a.id, now), {
      ok: false,
      reason: 'not_ready',
    });
    // Nothing was recorded and the tab still owns the job.
    assert.equal(
      (await events(f.db, f.alice, 'application.submitting')).length,
      0,
    );
    assert.equal(
      (await f.db.query('SELECT * FROM submissions')).rows.length,
      0,
    );
    assert.equal((await queueRow(f.db, a.id)).state, 'active');
    // After a passed eligibility decision the same job may be submitted.
    await passEligibility(f.db, a.id);
    assert.equal((await beginSubmit(f.db, f.alice, a.id, now)).ok, true);
  } finally {
    await f.close();
  }
});

test('PUT /api/identity/cap-settings writes under the applicant lock beginSubmit uses', async () => {
  const f = await fixture();
  try {
    const statements: string[][] = [];
    const record = (sql: Sql, log: string[]): Sql => ({
      query: (text: string, params?: unknown[]) => {
        log.push(text);
        return sql.query(text, params as any);
      },
    });
    const spy: Database = {
      ...f.db,
      query: f.db.query.bind(f.db),
      transaction: (fn) =>
        f.db.transaction((sql) => {
          const log: string[] = [];
          statements.push(log);
          return fn(record(sql, log));
        }),
      close: async () => {},
    };
    const app = await createApp(spy, { origin, production: false });
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin },
        payload: { email: 'alice@example.com', password },
      });
      const cookie = login.cookies[0].name + '=' + login.cookies[0].value;
      statements.length = 0;
      const response = await app.inject({
        method: 'PUT',
        url: '/api/identity/cap-settings',
        headers: { origin, cookie },
        payload: { limit: 1, windowMonths: 3 },
      });
      assert.equal(response.statusCode, 200, response.body);
      const tx = statements.find((log) =>
        log.some((text) => text.includes('INSERT INTO cap_settings')),
      );
      assert.ok(tx, 'the cap write runs inside a transaction');
      const lockAt = tx.findIndex((text) =>
        text.includes('pg_advisory_xact_lock(42002'),
      );
      const writeAt = tx.findIndex((text) =>
        text.includes('INSERT INTO cap_settings'),
      );
      assert.ok(lockAt >= 0 && lockAt < writeAt, 'applicant lock taken first');
    } finally {
      await app.close();
    }
    assert.equal(
      (
        await f.db.query(
          'SELECT cap_limit FROM cap_settings WHERE applicant_id=$1',
          [f.alice],
        )
      ).rows[0].cap_limit,
      1,
    );
  } finally {
    await f.close();
  }
});

for (const state of ['submitting', 'uncertain'] as const)
  test(`import links to a ${state} live submission instead of counting a second one`, async () => {
    const f = await fixture();
    try {
      const live = await capture(f.db, f.alice, {
        employer: 'Soylent',
        applicationUrl: 'https://boards.greenhouse.io/soylent/jobs/42',
      });
      assert.equal((await dequeueNext(f.db, f.alice, now))?.job.id, live.id);
      await passEligibility(f.db, live.id);
      assert.equal((await beginSubmit(f.db, f.alice, live.id, now)).ok, true);
      if (state === 'uncertain')
        await markUncertain(f.db, f.alice, live.id, 'Lost response');
      const result = await importHistory(
        f.db,
        f.alice,
        {
          filename: 'a.csv',
          csv: csv(
            'Soylent,Software Engineer,2026-11-08,https://boards.greenhouse.io/soylent/jobs/42',
          ),
        },
        now,
      );
      assert.deepEqual(
        result.rows.map((row) => row.outcome),
        ['linked'],
      );
      const submissions = (
        await f.db.query('SELECT * FROM submissions WHERE applicant_id=$1', [
          f.alice,
        ])
      ).rows;
      assert.equal(submissions.length, 1);
      assert.equal(submissions[0].job_id, live.id);
      assert.equal(submissions[0].state, state);
      const row = (
        await f.db.query('SELECT * FROM import_rows WHERE applicant_id=$1', [
          f.alice,
        ])
      ).rows[0];
      assert.equal(row.status, 'linked');
      assert.equal(row.submission_id, submissions[0].id);
    } finally {
      await f.close();
    }
  });
