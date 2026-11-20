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
import {
  beginSubmit,
  completeActive,
  confirmSubmission,
  dequeueNext,
  gateBeforeEligibility,
  markUncertain,
  reconcileSubmission,
} from '../src/server/identity/queue.js';
import { addDays, laLocalDate } from '../src/server/identity/capdates.js';
import type { Database } from '../src/server/db.js';

const now = new Date('2026-11-08T20:00:00Z');
const acme = (n: number) => ({
  employer: 'Acme Robotics',
  title: `Engineer ${n}`,
  applicationUrl: `https://boards.greenhouse.io/acmerobotics/jobs/${1000 + n}`,
});

/** Stands in for lane B: counts eligibility calls; eligibility always passes. */
function fakeEligibility() {
  const calls: string[] = [];
  return {
    calls,
    async run(db: Database, applicantId: string, jobId: string) {
      const gate = await gateBeforeEligibility(db, applicantId, jobId, now);
      if (!gate.allowed) return false;
      calls.push(jobId);
      await db.query("UPDATE jobs SET status='ready' WHERE id=$1", [jobId]);
      return true;
    },
  };
}

test('two confirmed plus five queued: the first confirmation stops the other four before eligibility or tickets', async () => {
  const f = await fixture();
  try {
    const queued = [];
    for (let n = 1; n <= 5; n++)
      queued.push(await capture(f.db, f.alice, acme(n)));
    assert.ok(queued.every((job) => job.status === 'captured'));
    // Two confirmed applications from imported history (resolved through the alias table).
    const imported = await importHistory(
      f.db,
      f.alice,
      {
        filename: 'history.csv',
        csv: csv(
          'Acme Robotics,Old Role A,2026-09-01,https://boards.greenhouse.io/acmerobotics/jobs/1',
          'Acme Robotics,Old Role B,2026-10-01,https://boards.greenhouse.io/acmerobotics/jobs/2',
        ),
      },
      now,
    );
    assert.equal(imported.summary.counted, 2);
    const eligibility = fakeEligibility();
    const ticketsBefore = (await openTickets(f.db, f.alice)).length;
    // Single worker loop: dequeue -> eligibility -> pre-submit -> confirm -> complete.
    let worked = 0;
    for (
      let next = await dequeueNext(f.db, f.alice, now);
      next;
      next = await dequeueNext(f.db, f.alice, now)
    ) {
      worked++;
      assert.ok(await eligibility.run(f.db, f.alice, next.job.id));
      const check = await beginSubmit(f.db, f.alice, next.job.id, now);
      assert.equal(check.ok, true);
      await confirmSubmission(f.db, f.alice, next.job.id, randomUUID());
    }
    assert.equal(worked, 1);
    assert.deepEqual(eligibility.calls, [queued[0].id]);
    assert.equal((await openTickets(f.db, f.alice)).length, ticketsBefore);
    const capped = await events(f.db, f.alice, 'job.capped');
    assert.deepEqual(
      capped.map((e) => e.job_id).sort(),
      queued
        .slice(1)
        .map((job) => job.id)
        .sort(),
    );
    // Sep 1 ages out first: (Dec 1 - 3 months) = Sep 1, so Dec 1 is the next eligible date.
    assert.ok(
      capped.every((e) => e.payload.nextAvailableDate === '2026-12-01'),
    );
    for (const job of queued.slice(1)) {
      assert.equal((await jobRow(f.db, job.id)).status, 'capped');
      assert.equal((await queueRow(f.db, job.id)).state, 'stopped');
    }
    assert.equal(
      (await events(f.db, f.alice, 'model.called')).length,
      0,
      'no model call for capped jobs',
    );
    assert.equal(
      (await events(f.db, f.alice, 'eligibility.decided')).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test('five queued with one slot survive a worker restart; the resumed job is rechecked', async () => {
  const f = await fixture();
  try {
    const jobs = [];
    for (let n = 1; n <= 5; n++)
      jobs.push(await capture(f.db, f.alice, acme(n)));
    await importHistory(
      f.db,
      f.alice,
      {
        filename: 'h.csv',
        csv: csv(
          'Acme Robotics,Old A,2026-09-01,https://boards.greenhouse.io/acmerobotics/jobs/1',
          'Acme Robotics,Old B,2026-10-01,https://boards.greenhouse.io/acmerobotics/jobs/2',
        ),
      },
      now,
    );
    const first = await dequeueNext(f.db, f.alice, now);
    assert.equal(first?.job.id, jobs[0].id);
    // Restart: the same active job resumes after the recheck, nothing new is activated.
    const resumed = await dequeueNext(f.db, f.alice, now);
    assert.equal(resumed?.job.id, jobs[0].id);
    assert.equal(resumed?.resumed, true);
    const active = (
      await f.db.query(
        "SELECT job_id FROM work_queue WHERE applicant_id=$1 AND state='active'",
        [f.alice],
      )
    ).rows;
    assert.equal(active.length, 1);
    // History changes while the tab is down: the resumed job is now capped and stops.
    await importHistory(
      f.db,
      f.alice,
      {
        filename: 'late.csv',
        csv: csv(
          'Acme Robotics,Old C,2026-11-01,https://boards.greenhouse.io/acmerobotics/jobs/3',
        ),
      },
      now,
    );
    assert.equal(await dequeueNext(f.db, f.alice, now), null);
    for (const job of jobs)
      assert.equal((await jobRow(f.db, job.id)).status, 'capped');
  } finally {
    await f.close();
  }
});

test('the atomic pre-submit check refuses the click after a cap change and records nothing', async () => {
  const f = await fixture();
  try {
    const job = await capture(f.db, f.alice, acme(1));
    await importHistory(
      f.db,
      f.alice,
      {
        filename: 'h.csv',
        csv: csv(
          'Acme Robotics,Old A,2026-09-01,https://boards.greenhouse.io/acmerobotics/jobs/1',
        ),
      },
      now,
    );
    assert.equal((await dequeueNext(f.db, f.alice, now))?.job.id, job.id);
    // The applicant lowers the cap right before the final click.
    const changed = await f.app.inject({
      method: 'PUT',
      url: '/api/identity/cap-settings',
      headers: { origin, cookie: f.cookie },
      payload: { limit: 1, windowMonths: 3 },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    const check = await beginSubmit(f.db, f.alice, job.id, now);
    assert.deepEqual(check, {
      ok: false,
      reason: 'capped',
      nextAvailableDate: '2026-12-01',
    });
    assert.equal((await jobRow(f.db, job.id)).status, 'capped');
    assert.equal(
      (await events(f.db, f.alice, 'application.submitting')).length,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM submissions WHERE kind='live'")).rows
        .length,
      0,
    );
    // Only the active queue item may be submitted.
    const other = await capture(f.db, f.alice, {
      ...acme(2),
      employer: 'Other Co',
      applicationUrl: 'https://boards.greenhouse.io/otherco/jobs/1',
    });
    await assert.rejects(
      () => beginSubmit(f.db, f.alice, other.id, now),
      /active queue item/,
    );
  } finally {
    await f.close();
  }
});

test('an interrupted submit becomes uncertain and holds its employer until reconciliation', async () => {
  const f = await fixture();
  try {
    const a1 = await capture(f.db, f.alice, acme(1));
    const a2 = await capture(f.db, f.alice, acme(2));
    const other = await capture(f.db, f.alice, {
      employer: 'Globex',
      title: 'Engineer',
      applicationUrl:
        'https://jobs.ashbyhq.com/globex/0f1e2d3c-aaaa-bbbb-cccc-000000000001',
    });
    assert.equal((await dequeueNext(f.db, f.alice, now))?.job.id, a1.id);
    const check = await beginSubmit(f.db, f.alice, a1.id, now);
    assert.equal(check.ok, true);
    assert.equal((await jobRow(f.db, a1.id)).status, 'submitting');
    assert.equal(
      (await events(f.db, f.alice, 'application.submitting')).length,
      1,
    );
    // The tab dies before the outcome is recorded; the restarted worker moves on.
    const next = await dequeueNext(f.db, f.alice, now);
    assert.equal(
      next?.job.id,
      other.id,
      'same-employer job is held, other employer proceeds',
    );
    assert.equal((await jobRow(f.db, a1.id)).status, 'uncertain');
    const uncertain = await events(f.db, f.alice, 'application.uncertain');
    assert.equal(uncertain.length, 1);
    assert.equal(uncertain[0].job_id, a1.id);
    const held = await queueRow(f.db, a2.id);
    assert.equal(held.state, 'queued');
    assert.match(held.hold_reason, new RegExp(a1.id));
    assert.equal(
      (await gateBeforeEligibility(f.db, f.alice, a2.id, now)).result.status,
      'held',
    );
    const queueView = (
      await f.app.inject({
        url: '/api/identity/queue',
        headers: { cookie: f.cookie },
      })
    ).json().items;
    assert.ok(
      queueView.some((item: any) => item.jobId === a2.id && item.holdReason),
    );
    await completeActive(f.db, f.alice, other.id);
    assert.equal(await dequeueNext(f.db, f.alice, now), null);
    // Reconciled as never submitted: the hold lifts and a1 returns to the queue.
    await reconcileSubmission(f.db, f.alice, a1.id, {
      outcome: 'not_submitted',
    });
    const resumed = await dequeueNext(f.db, f.alice, now);
    assert.equal(resumed?.job.id, a1.id);
    // Redirect-only outcome on retry: uncertain again, then reconciled as confirmed.
    assert.equal((await beginSubmit(f.db, f.alice, a1.id, now)).ok, true);
    await markUncertain(
      f.db,
      f.alice,
      a1.id,
      'Redirect without acknowledgement',
    );
    await reconcileSubmission(f.db, f.alice, a1.id, {
      outcome: 'confirmed',
      receiptId: randomUUID(),
    });
    assert.equal((await jobRow(f.db, a1.id)).status, 'confirmed');
    const proceed = await dequeueNext(f.db, f.alice, now);
    assert.equal(proceed?.job.id, a2.id);
  } finally {
    await f.close();
  }
});

test('capture of an already-capped employer shows the next eligible date and never queues', async () => {
  const f = await fixture();
  try {
    const today = laLocalDate(new Date());
    await capture(f.db, f.alice, acme(1));
    await importHistory(f.db, f.alice, {
      filename: 'h.csv',
      csv: csv(
        `Acme Robotics,Old A,${addDays(today, -20)},https://boards.greenhouse.io/acmerobotics/jobs/1`,
        `Acme Robotics,Old B,${addDays(today, -10)},https://boards.greenhouse.io/acmerobotics/jobs/2`,
        `Acme Robotics,Old C,${today},https://boards.greenhouse.io/acmerobotics/jobs/3`,
      ),
    });
    const late = await capture(f.db, f.alice, acme(9));
    assert.equal(late.status, 'capped');
    const [event] = (await events(f.db, f.alice, 'job.capped')).filter(
      (e) => e.job_id === late.id,
    );
    assert.ok(event.payload.nextAvailableDate > today);
    assert.equal((await queueRow(f.db, late.id)).state, 'stopped');
    const items = (
      await f.app.inject({
        url: '/api/identity/queue',
        headers: { cookie: f.cookie },
      })
    ).json().items;
    const shown = items.find((item: any) => item.jobId === late.id);
    assert.equal(shown.nextAvailableDate, event.payload.nextAvailableDate);
    const employers = (
      await f.app.inject({
        url: '/api/identity/employers',
        headers: { cookie: f.cookie },
      })
    ).json().employers;
    assert.equal(employers[0].cap.capped, true);
    assert.equal(
      employers[0].cap.nextAvailableDate,
      event.payload.nextAvailableDate,
    );
    // Requeue is allowed; the dequeue gate decides again (still capped today).
    const requeue = await f.app.inject({
      method: 'POST',
      url: `/api/identity/jobs/${late.id}/requeue`,
      headers: { origin, cookie: f.cookie },
      payload: {},
    });
    assert.equal(requeue.statusCode, 200, requeue.body);
    const next = await dequeueNext(f.db, f.alice);
    assert.notEqual(next?.job.id, late.id);
    assert.equal((await jobRow(f.db, late.id)).status, 'capped');
  } finally {
    await f.close();
  }
});
