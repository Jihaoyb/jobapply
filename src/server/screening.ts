/**
 * Queue → eligibility hand-off (issues 004 + 005). This is the eligibility entry the
 * single-tab worker (007) calls for the job `dequeueNext` returned. It lives outside both
 * lanes so lane B never imports lane A (and vice versa):
 *
 *   gateBeforeEligibility (identity, dedupe → cap → hold)   — refused: no rules, no Sol
 *   captured → eligibility_pending                           — screening started
 *   decideEligibility(posting text)                           — passed → ready (stays active)
 *                                                               excluded → eligibility_excluded,
 *                                                                 queue item stopped
 *                                                               review → ticket, item paused;
 *                                                                 resolution requeues it
 */
import type { Database } from './db.js';
import { findOpenTicket, HttpError } from './ledger.js';
import {
  decideEligibility,
  type EligibilityDeps,
  type EligibilityResult,
} from './eligibility/decide.js';
import type { GateResult } from './identity/gate.js';
import { gateBeforeEligibility } from './identity/queue.js';
import { queueFollowJobStatus } from './identity/queue-hooks.js';

export type ScreenResult =
  | { status: 'gated'; gate: GateResult }
  | { status: 'already_screened' }
  | { status: 'deferred'; reason: string }
  | { status: 'decided'; result: EligibilityResult };

/** `queueGate` for eligibility callers outside the queue path (e.g. the Sol retry route). */
export async function eligibilityQueueGate(
  db: Database,
  applicantId: string,
  jobId: string,
) {
  return (await gateBeforeEligibility(db, applicantId, jobId)).allowed;
}

export async function screenQueuedJob(
  db: Database,
  applicantId: string,
  jobId: string,
  deps: EligibilityDeps = {},
  now = new Date(),
): Promise<ScreenResult> {
  const gate = await gateBeforeEligibility(db, applicantId, jobId, now);
  if (!gate.allowed) return { status: 'gated', gate: gate.result };
  const job = await db.transaction(async (sql) => {
    const row = (
      await sql.query(
        'SELECT status,posting_text FROM jobs WHERE id=$1 AND applicant_id=$2 FOR UPDATE',
        [jobId, applicantId],
      )
    ).rows[0];
    if (row?.status === 'captured') {
      await sql.query(
        "UPDATE jobs SET status='eligibility_pending' WHERE id=$1 AND applicant_id=$2",
        [jobId, applicantId],
      );
      row.status = 'eligibility_pending';
    }
    return row as { status: string; posting_text: string };
  });
  // A ready job was already screened (passed, or resolved by the user); only the gate repeats.
  if (job.status === 'ready') return { status: 'already_screened' };
  let result: EligibilityResult;
  try {
    result = await decideEligibility(
      db,
      applicantId,
      jobId,
      job.posting_text,
      'posting',
      deps,
    );
  } catch (error) {
    // Another lane paused the job while rules/Sol ran (one open ticket per job). Nothing was
    // recorded; the job is screened again when that ticket closes and it is dequeued.
    if (error instanceof HttpError && error.statusCode === 409) {
      const blocker = await findOpenTicket(db, applicantId, jobId);
      return {
        status: 'deferred',
        reason: blocker ? `open ${blocker.cause} ticket` : error.message,
      };
    }
    throw error;
  }
  if (result.decision === 'excluded')
    await db.transaction((sql) =>
      queueFollowJobStatus(sql, applicantId, jobId, 'eligibility_excluded'),
    );
  return { status: 'decided', result };
}
