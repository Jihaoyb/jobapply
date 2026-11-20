/**
 * Single-active-tab work queue and submission state (issue 004).
 *
 * Capture enqueues. The worker (extension tab, via 007) calls `dequeueNext`, which resumes the
 * active job or activates the oldest queued job only after re-resolving its canonical employer
 * and rechecking duplicate, cap and hold. Eligibility (lane B) runs only on the returned job, and
 * may call `gateBeforeEligibility` again immediately before any model call. `beginSubmit` is
 * the atomic pre-submit check and `submitting` transition; an interrupted submit becomes
 * `uncertain` and holds the employer until `reconcileSubmission`.
 */
import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import { appendEvent, HttpError, jobFromRow } from '../ledger.js';
import type { Job } from '../../shared/contracts.js';
import { laLocalDate } from './capdates.js';
import {
  classifyJob,
  ensureIdentity,
  GATEABLE_STATUSES,
  type GateResult,
} from './gate.js';
import { lockApplicant } from './tickets.js';

export async function enqueueTx(sql: Sql, applicantId: string, jobId: string) {
  await sql.query(
    "INSERT INTO work_queue (job_id,applicant_id,state) VALUES ($1,$2,'queued') ON CONFLICT (job_id) DO NOTHING",
    [jobId, applicantId],
  );
}

async function loadJob(sql: Sql, applicantId: string, jobId: string) {
  const row = (
    await sql.query('SELECT * FROM jobs WHERE id=$1 AND applicant_id=$2', [
      jobId,
      applicantId,
    ])
  ).rows[0];
  if (!row) throw new HttpError(404, 'Job not found');
  return row;
}
async function hasOpenTicket(sql: Sql, jobId: string) {
  return (
    (
      await sql.query(
        "SELECT 1 FROM tickets WHERE job_id=$1 AND status='open'",
        [jobId],
      )
    ).rows.length > 0
  );
}

/**
 * Full gate for one queued/active job: identity (may open an employer_identity ticket), then
 * duplicate, cap and hold. Writes statuses/events but never eligibility work.
 */
export async function gateJobTx(
  sql: Sql,
  applicantId: string,
  jobId: string,
  now: Date,
): Promise<GateResult> {
  const job = await loadJob(sql, applicantId, jobId);
  if (!GATEABLE_STATUSES.includes(job.status))
    return { status: 'not_gateable', jobStatus: job.status };
  const employerId = await ensureIdentity(sql, applicantId, job);
  if (!employerId) return { status: 'unresolved' };
  return classifyJob(sql, applicantId, jobId, now);
}

/** Interface for lane B: call immediately before eligibility routing or any model call. */
export async function gateBeforeEligibility(
  db: Database,
  applicantId: string,
  jobId: string,
  now = new Date(),
): Promise<{ allowed: boolean; result: GateResult }> {
  return db.transaction(async (sql) => {
    await lockApplicant(sql, applicantId);
    const result = await gateJobTx(sql, applicantId, jobId, now);
    return { allowed: result.status === 'ok', result };
  });
}

export interface Dequeued {
  job: Job;
  resumed: boolean;
}
/**
 * Returns the job the single tab should work on, or null when nothing can proceed. A job left
 * active by a restart is resumed after the same recheck; one left `submitting` becomes
 * `uncertain` (its employer stays held) and the queue moves on.
 */
export async function dequeueNext(
  db: Database,
  applicantId: string,
  now = new Date(),
): Promise<Dequeued | null> {
  return db.transaction(async (sql) => {
    await lockApplicant(sql, applicantId);
    const active = (
      await sql.query(
        "SELECT job_id FROM work_queue WHERE applicant_id=$1 AND state='active'",
        [applicantId],
      )
    ).rows[0];
    if (active) {
      const job = await loadJob(sql, applicantId, active.job_id);
      if (job.status === 'submitting')
        await markUncertainTx(
          sql,
          applicantId,
          job.id,
          'Session ended before the submit outcome was recorded',
        );
      else {
        const result = await gateJobTx(sql, applicantId, job.id, now);
        if (result.status === 'ok')
          return {
            job: jobFromRow(await loadJob(sql, applicantId, job.id)),
            resumed: true,
          };
        await settleItem(sql, applicantId, job.id, result);
      }
    }
    const queued = (
      await sql.query(
        "SELECT job_id FROM work_queue WHERE applicant_id=$1 AND state='queued' ORDER BY enqueued_at,job_id",
        [applicantId],
      )
    ).rows;
    for (const item of queued) {
      const result = await gateJobTx(sql, applicantId, item.job_id, now);
      if (result.status === 'ok') {
        await sql.query(
          "UPDATE work_queue SET state='active',hold_reason=NULL,updated_at=now() WHERE job_id=$1 AND applicant_id=$2",
          [item.job_id, applicantId],
        );
        return {
          job: jobFromRow(await loadJob(sql, applicantId, item.job_id)),
          resumed: false,
        };
      }
      await settleItem(sql, applicantId, item.job_id, result);
    }
    return null;
  });
}
/** Moves a queue item that cannot proceed to its durable state. */
async function settleItem(
  sql: Sql,
  applicantId: string,
  jobId: string,
  result: GateResult,
) {
  if (result.status === 'held')
    await sql.query(
      "UPDATE work_queue SET state='queued',updated_at=now() WHERE job_id=$1 AND applicant_id=$2 AND state='active'",
      [jobId, applicantId],
    );
  else if (result.status === 'unresolved' || (await hasOpenTicket(sql, jobId)))
    await sql.query(
      "UPDATE work_queue SET state='paused',updated_at=now() WHERE job_id=$1 AND applicant_id=$2 AND state IN ('queued','active')",
      [jobId, applicantId],
    );
  else if (result.status === 'not_gateable')
    await sql.query(
      "UPDATE work_queue SET state='stopped',stop_reason=$3,updated_at=now() WHERE job_id=$1 AND applicant_id=$2 AND state IN ('queued','active')",
      [jobId, applicantId, `status ${result.jobStatus}`],
    );
}

async function queueItem(sql: Sql, applicantId: string, jobId: string) {
  return (
    await sql.query(
      'SELECT * FROM work_queue WHERE job_id=$1 AND applicant_id=$2 FOR UPDATE',
      [jobId, applicantId],
    )
  ).rows[0];
}
/** The active job finished its work (e.g. confirmed or excluded); frees the tab. */
export async function completeActive(
  db: Database,
  applicantId: string,
  jobId: string,
) {
  return db.transaction(async (sql) => {
    await lockApplicant(sql, applicantId);
    const item = await queueItem(sql, applicantId, jobId);
    if (!item || item.state !== 'active')
      throw new HttpError(409, 'Job is not the active queue item');
    await sql.query(
      "UPDATE work_queue SET state='done',updated_at=now() WHERE job_id=$1 AND applicant_id=$2",
      [jobId, applicantId],
    );
  });
}
/** The active job is durably paused (a ticket is open); frees the tab. */
export async function pauseActive(
  db: Database,
  applicantId: string,
  jobId: string,
) {
  return db.transaction(async (sql) => {
    await lockApplicant(sql, applicantId);
    const item = await queueItem(sql, applicantId, jobId);
    if (!item || !['active', 'paused'].includes(item.state))
      throw new HttpError(409, 'Job is not the active queue item');
    await sql.query(
      "UPDATE work_queue SET state='paused',updated_at=now() WHERE job_id=$1 AND applicant_id=$2",
      [jobId, applicantId],
    );
  });
}
/** Returns a paused job to the queue; `dequeueNext` repeats the full check before resuming. */
export async function resumeQueued(
  db: Database,
  applicantId: string,
  jobId: string,
) {
  return db.transaction(async (sql) => {
    await lockApplicant(sql, applicantId);
    await resumeQueuedTx(sql, applicantId, jobId);
  });
}
export async function resumeQueuedTx(
  sql: Sql,
  applicantId: string,
  jobId: string,
) {
  const result = await sql.query(
    "UPDATE work_queue SET state='queued',updated_at=now() WHERE job_id=$1 AND applicant_id=$2 AND state='paused' RETURNING job_id",
    [jobId, applicantId],
  );
  if (!result.rows.length) await enqueueTx(sql, applicantId, jobId);
}
/** Puts a capped job back in line (e.g. after its next available date); gated again on dequeue. */
export async function requeueCapped(
  db: Database,
  applicantId: string,
  jobId: string,
) {
  return db.transaction(async (sql) => {
    await lockApplicant(sql, applicantId);
    const job = await loadJob(sql, applicantId, jobId);
    if (job.status !== 'capped')
      throw new HttpError(409, 'Only capped jobs can be requeued');
    await sql.query(
      "UPDATE jobs SET status='captured' WHERE id=$1 AND applicant_id=$2",
      [jobId, applicantId],
    );
    await sql.query(
      `INSERT INTO work_queue (job_id,applicant_id,state) VALUES ($1,$2,'queued')
       ON CONFLICT (job_id) DO UPDATE SET state='queued',stop_reason=NULL,enqueued_at=now(),updated_at=now()`,
      [jobId, applicantId],
    );
  });
}

export type SubmitCheck =
  | { ok: true; submissionId: string; localDate: string }
  | {
      ok: false;
      reason: 'capped' | 'held' | 'duplicate' | 'unresolved' | 'not_gateable';
      nextAvailableDate?: string;
      heldBy?: string[];
    };
/**
 * Atomic pre-submit check, run immediately before the final click. Under the applicant lock and
 * an employer row lock it rechecks duplicate, cap and hold, then records `submitting` and emits
 * `application.submitting` in the same transaction. A refusal means: do not click.
 */
export async function beginSubmit(
  db: Database,
  applicantId: string,
  jobId: string,
  now = new Date(),
): Promise<SubmitCheck> {
  return db.transaction(async (sql) => {
    await lockApplicant(sql, applicantId);
    const item = await queueItem(sql, applicantId, jobId);
    if (!item || item.state !== 'active')
      throw new HttpError(409, 'Only the active queue item can be submitted');
    const job = await loadJob(sql, applicantId, jobId);
    if (job.canonical_employer_id)
      await sql.query(
        'SELECT id FROM employers WHERE applicant_id=$1 AND id=$2 FOR UPDATE',
        [applicantId, job.canonical_employer_id],
      );
    const result = await gateJobTx(sql, applicantId, jobId, now);
    if (result.status !== 'ok') {
      await settleItem(sql, applicantId, jobId, result);
      return {
        ok: false,
        reason: result.status,
        ...(result.status === 'capped'
          ? { nextAvailableDate: result.nextAvailableDate }
          : {}),
        ...(result.status === 'held' ? { heldBy: result.heldBy } : {}),
      };
    }
    const localDate = laLocalDate(now);
    const submissionId = randomUUID();
    const inserted = await sql.query(
      `INSERT INTO submissions (id,applicant_id,job_id,canonical_employer_id,kind,state,local_date)
       VALUES ($1,$2,$3,$4,'live','submitting',$5)
       ON CONFLICT (job_id) DO UPDATE SET state='submitting',local_date=EXCLUDED.local_date,canonical_employer_id=EXCLUDED.canonical_employer_id,updated_at=now()
         WHERE submissions.state='not_submitted'
       RETURNING id`,
      [submissionId, applicantId, jobId, result.employerId, localDate],
    );
    if (!inserted.rows.length)
      throw new HttpError(409, 'Submission already recorded for this job');
    await sql.query(
      "UPDATE jobs SET status='submitting' WHERE id=$1 AND applicant_id=$2",
      [jobId, applicantId],
    );
    await appendEvent(sql, applicantId, jobId, 'application.submitting', {});
    return { ok: true, submissionId: inserted.rows[0].id, localDate };
  });
}

async function submissionFor(sql: Sql, applicantId: string, jobId: string) {
  return (
    await sql.query(
      'SELECT * FROM submissions WHERE job_id=$1 AND applicant_id=$2 FOR UPDATE',
      [jobId, applicantId],
    )
  ).rows[0];
}
/**
 * Records a verified confirmation (007 supplies the persisted receipt ID). The submission counts
 * toward the cap on its submit local date; the queue item is done.
 */
export async function confirmSubmission(
  db: Database,
  applicantId: string,
  jobId: string,
  receiptId: string,
) {
  return db.transaction(async (sql) => {
    await lockApplicant(sql, applicantId);
    const submission = await submissionFor(sql, applicantId, jobId);
    if (!submission || !['submitting', 'uncertain'].includes(submission.state))
      throw new HttpError(409, 'No submit in progress for this job');
    await sql.query(
      "UPDATE submissions SET state='confirmed',receipt_id=$3,updated_at=now() WHERE job_id=$1 AND applicant_id=$2",
      [jobId, applicantId, receiptId],
    );
    await sql.query(
      "UPDATE jobs SET status='confirmed' WHERE id=$1 AND applicant_id=$2",
      [jobId, applicantId],
    );
    await sql.query(
      "UPDATE work_queue SET state='done',updated_at=now() WHERE job_id=$1 AND applicant_id=$2",
      [jobId, applicantId],
    );
    await appendEvent(sql, applicantId, jobId, 'application.confirmed', {
      receiptId,
    });
  });
}
async function markUncertainTx(
  sql: Sql,
  applicantId: string,
  jobId: string,
  reason: string,
) {
  const submission = await submissionFor(sql, applicantId, jobId);
  if (!submission || submission.state !== 'submitting')
    throw new HttpError(409, 'No submit in progress for this job');
  await sql.query(
    "UPDATE submissions SET state='uncertain',updated_at=now() WHERE job_id=$1 AND applicant_id=$2",
    [jobId, applicantId],
  );
  await sql.query(
    "UPDATE jobs SET status='uncertain' WHERE id=$1 AND applicant_id=$2",
    [jobId, applicantId],
  );
  await sql.query(
    "UPDATE work_queue SET state='paused',updated_at=now() WHERE job_id=$1 AND applicant_id=$2",
    [jobId, applicantId],
  );
  await appendEvent(sql, applicantId, jobId, 'application.uncertain', {
    reason,
  });
}
/** Outcome unknown (redirect only, lost response): hold the employer until reconciled. */
export async function markUncertain(
  db: Database,
  applicantId: string,
  jobId: string,
  reason: string,
) {
  return db.transaction(async (sql) => {
    await lockApplicant(sql, applicantId);
    await markUncertainTx(sql, applicantId, jobId, reason);
  });
}
/**
 * Reconciles an uncertain/interrupted submit: `confirmed` counts it (with a receipt);
 * `not_submitted` releases the hold and returns the job to the queue as ready.
 */
export async function reconcileSubmission(
  db: Database,
  applicantId: string,
  jobId: string,
  outcome:
    { outcome: 'confirmed'; receiptId: string } | { outcome: 'not_submitted' },
) {
  if (outcome.outcome === 'confirmed')
    return confirmSubmission(db, applicantId, jobId, outcome.receiptId);
  return db.transaction(async (sql) => {
    await lockApplicant(sql, applicantId);
    const submission = await submissionFor(sql, applicantId, jobId);
    if (!submission || !['submitting', 'uncertain'].includes(submission.state))
      throw new HttpError(409, 'Nothing to reconcile for this job');
    await sql.query(
      "UPDATE submissions SET state='not_submitted',updated_at=now() WHERE job_id=$1 AND applicant_id=$2",
      [jobId, applicantId],
    );
    await sql.query(
      "UPDATE jobs SET status='ready' WHERE id=$1 AND applicant_id=$2",
      [jobId, applicantId],
    );
    await sql.query(
      "UPDATE work_queue SET state='queued',updated_at=now() WHERE job_id=$1 AND applicant_id=$2 AND state IN ('paused','active')",
      [jobId, applicantId],
    );
  });
}
