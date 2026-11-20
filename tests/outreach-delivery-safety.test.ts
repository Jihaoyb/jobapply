/**
 * Regression tests for the P2 review findings in lane D (outreach): no second SMTP send after
 * an accepted message whose bookkeeping failed, in-flight registration before the claim, env
 * validation, and no outreach for imported (historical) applications.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { outreachFixture } from './fixtures/outreach/setup.js';
import { csv } from './fixtures/identity/helpers.js';
import { origin } from './helpers.js';
import { runOutreachWorker } from '../src/server/outreach/worker.js';
import { recoverInterruptedSends } from '../src/server/outreach/delivery.js';
import { retryOutreach } from '../src/server/outreach/routes.js';
import { positiveNumberEnv } from '../src/server/outreach/deps.js';
import { importHistory } from '../src/server/identity/importer.js';
import type { Database } from '../src/server/db.js';

type F = Awaited<ReturnType<typeof outreachFixture>>;

async function reviewed(f: F) {
  const { jobId } = await f.job();
  await runOutreachWorker(f.deps, f.alice, jobId);
  const position = (await f.inject('GET', '/api/outreach'))
    .json()
    .positions.find((p: any) => p.jobId === jobId);
  return { jobId, version: position.review.version as number };
}
/** After SMTP accepts, the next `failures` transactions throw (a transient DB error). */
function failAfterAccept(f: F, failures: number) {
  const realTx = f.db.transaction.bind(f.db);
  const send = f.smtp.send.bind(f.smtp);
  f.smtp.send = async (message) => {
    const result = await send(message);
    let left = failures;
    (f.db as any).transaction = async (fn: any) => {
      if (left > 0) {
        left--;
        if (left === 0) (f.db as any).transaction = realTx;
        throw new Error('connection reset');
      }
      return realTx(fn);
    };
    return result;
  };
  return () => {
    f.smtp.send = send;
    (f.db as any).transaction = realTx;
  };
}
const delivery = async (f: F, jobId: string) =>
  (
    await f.db.query(
      'SELECT status, attempts, smtp_message_id FROM outreach_deliveries WHERE job_id=$1',
      [jobId],
    )
  ).rows[0];
const openTicket = async (f: F, jobId: string) =>
  (
    await f.db.query(
      "SELECT cause, resolve_action FROM tickets WHERE job_id=$1 AND status='open'",
      [jobId],
    )
  ).rows[0];

test('a transient DB failure after SMTP accepted is retried idempotently; Retry never re-sends', async () => {
  const f = await outreachFixture();
  try {
    const { jobId, version } = await reviewed(f);
    const restore = failAfterAccept(f, 1);
    const approve = await f.inject(
      'POST',
      `/api/outreach/jobs/${jobId}/approve`,
      { version },
    );
    restore();
    assert.equal(approve.statusCode, 200, approve.body);
    const row = await delivery(f, jobId);
    assert.equal(row.status, 'accepted');
    assert.ok(row.smtp_message_id);
    assert.equal((await f.events(jobId, 'email.accepted')).length, 1);
    assert.equal(
      (await f.inject('POST', `/api/outreach/jobs/${jobId}/retry`, {}))
        .statusCode,
      409,
    );
    assert.equal(f.smtp.sends.length, 1);
  } finally {
    await f.close();
  }
});

test('a persistent DB failure after SMTP accepted marks the delivery uncertain, never pending', async () => {
  const f = await outreachFixture();
  try {
    const { jobId, version } = await reviewed(f);
    const restore = failAfterAccept(f, 3); // every accepted-write attempt fails
    await f.inject('POST', `/api/outreach/jobs/${jobId}/approve`, { version });
    restore();
    assert.equal((await delivery(f, jobId)).status, 'uncertain');
    assert.deepEqual(await openTicket(f, jobId), {
      cause: 'uncertain_email',
      resolve_action: 'reconcile_email',
    });
    assert.equal((await f.events(jobId, 'email.uncertain')).length, 1);
    assert.equal(
      (await f.inject('POST', `/api/outreach/jobs/${jobId}/retry`, {}))
        .statusCode,
      409,
    );
    await recoverInterruptedSends(f.deps);
    assert.equal(f.smtp.sends.length, 1);
  } finally {
    await f.close();
  }
});

test('if no write succeeds after SMTP accepted, the row stays sending and recovery marks it uncertain', async () => {
  const f = await outreachFixture();
  try {
    const { jobId, version } = await reviewed(f);
    const restore = failAfterAccept(f, 1000);
    await f.inject('POST', `/api/outreach/jobs/${jobId}/approve`, { version });
    restore();
    assert.equal((await delivery(f, jobId)).status, 'sending');
    await recoverInterruptedSends(f.deps);
    assert.equal((await delivery(f, jobId)).status, 'uncertain');
    assert.equal((await openTicket(f, jobId)).cause, 'uncertain_email');
    assert.equal(f.smtp.sends.length, 1);
  } finally {
    await f.close();
  }
});

test('a send is registered in flight before its claim, so the recovery sweep never marks it uncertain', async () => {
  const f = await outreachFixture();
  try {
    const { jobId, version } = await reviewed(f);
    // First approval is refused by SMTP: the delivery returns to pending behind a provider pause.
    f.smtp.modes = ['reject'];
    await f.inject('POST', `/api/outreach/jobs/${jobId}/approve`, { version });
    assert.equal((await delivery(f, jobId)).status, 'pending');
    // The production sweep runs right after the pending→sending claim commits.
    const spy: Database = {
      ...f.db,
      query: (async (text: string, params?: any[]) => {
        const result = await f.db.query(text, params);
        if (text.includes("SET status='sending'"))
          await recoverInterruptedSends(f.deps);
        return result;
      }) as Database['query'],
      transaction: f.db.transaction.bind(f.db),
      close: async () => {},
    };
    await retryOutreach({ ...f.deps, db: spy }, f.alice, jobId);
    assert.equal((await delivery(f, jobId)).status, 'accepted');
    assert.equal((await f.events(jobId, 'email.uncertain')).length, 0);
    assert.equal(await openTicket(f, jobId), undefined);
    assert.equal(f.smtp.sends.length, 2); // the refused attempt and the one accepted send
  } finally {
    await f.close();
  }
});

test('OUTREACH_DAILY_EMAIL_LIMIT and GMAIL_SMTP_TIMEOUT_MS fall back to defaults on bad values', () => {
  for (const bad of [undefined, '', '  ', 'abc', 'NaN', '0', '-5', 'Infinity'])
    assert.equal(positiveNumberEnv('X', 20, { X: bad }), 20, String(bad));
  assert.equal(positiveNumberEnv('X', 20, { X: '35' }), 35);
  assert.equal(positiveNumberEnv('X', 30_000, { X: ' 5000 ' }), 5000);
});

test('an imported (historical) confirmed job never starts outreach: zero Apollo calls and a logged skip', async () => {
  const f = await outreachFixture();
  try {
    const imported = await importHistory(f.db, f.alice, {
      filename: 'history.csv',
      csv: csv(
        'Umbrella Labs,Software Engineer,2026-10-01,https://boards.greenhouse.io/umbrellalabs/jobs/7',
      ),
    });
    let jobId = imported.rows[0]?.ticketId
      ? (
          await f.db.query('SELECT job_id FROM tickets WHERE id=$1', [
            imported.rows[0].ticketId,
          ])
        ).rows[0].job_id
      : null;
    if (imported.rows[0]?.ticketId) {
      const resolved = await f.app.inject({
        method: 'POST',
        url: `/api/identity/tickets/${imported.rows[0].ticketId}/resolve`,
        headers: { origin, cookie: f.cookie },
        payload: { action: 'create' },
      });
      assert.equal(resolved.statusCode, 200, resolved.body);
    }
    jobId ??= (
      await f.db.query(
        "SELECT job_id FROM submissions WHERE applicant_id=$1 AND kind='imported'",
        [f.alice],
      )
    ).rows[0].job_id;
    const job = (
      await f.db.query('SELECT status FROM jobs WHERE id=$1', [jobId])
    ).rows[0];
    assert.equal(job.status, 'confirmed');
    assert.equal((await f.events(jobId!, 'application.confirmed')).length, 0);
    const run = await f.inject('POST', `/api/outreach/jobs/${jobId}/run`, {});
    assert.equal(run.statusCode, 200, run.body);
    assert.equal(run.json().result, 'skipped_not_confirmed');
    assert.equal(f.apollo.total, 0);
    assert.equal(f.luna.state.requests.length, 0);
    const log = (
      await f.db.query(
        'SELECT outcome, detail FROM outreach_worker_log WHERE job_id=$1',
        [jobId],
      )
    ).rows;
    assert.equal(log.length, 1);
    assert.equal(log[0].outcome, 'skipped_not_confirmed');
    assert.match(log[0].detail, /application\.confirmed/);
  } finally {
    await f.close();
  }
});
