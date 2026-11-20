/**
 * Lane A queue reactions to the shared ticket primitive (called via ticket-hooks.ts).
 * Kept free of other identity imports so the ledger can load it without a cycle at
 * module-evaluation time.
 */
import type { Sql } from '../db.js';

/** Statuses that may still proceed to eligibility, form fill or submit (see gate.ts). */
const QUEUEABLE = new Set(['captured', 'eligibility_pending', 'ready']);
/** Statuses that end the job's queue work. */
const STOPPED = new Set([
  'deferred',
  'eligibility_excluded',
  'duplicate',
  'capped',
]);

/** Any open ticket frees the single tab (the former identity-only openTicketTx behavior). */
export async function queueAfterOpen(
  sql: Sql,
  applicantId: string,
  jobId: string,
) {
  await sql.query(
    "UPDATE work_queue SET state='paused',updated_at=now() WHERE job_id=$1 AND applicant_id=$2 AND state IN ('queued','active')",
    [jobId, applicantId],
  );
}
/**
 * After a close: a job that can proceed goes back in line (`dequeueNext` re-gates it); a
 * deferred, excluded, duplicate or capped job leaves the queue. Other statuses (confirmed,
 * uncertain …) are left to their owners.
 */
export async function queueFollowJobStatus(
  sql: Sql,
  applicantId: string,
  jobId: string,
  jobStatus: string,
) {
  if (QUEUEABLE.has(jobStatus))
    await sql.query(
      "UPDATE work_queue SET state='queued',updated_at=now() WHERE job_id=$1 AND applicant_id=$2 AND state='paused'",
      [jobId, applicantId],
    );
  else if (STOPPED.has(jobStatus))
    await sql.query(
      "UPDATE work_queue SET state='stopped',stop_reason=$3,hold_reason=NULL,updated_at=now() WHERE job_id=$1 AND applicant_id=$2 AND state IN ('queued','active','paused')",
      [jobId, applicantId, jobStatus],
    );
}
