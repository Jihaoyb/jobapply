/**
 * Cross-lane reactions to the shared ticket primitive (ledger.openTicketTx / closeTicketTx /
 * resolveTicket). Each lane owns its reaction; this module only routes to them, so the ledger
 * keeps one place where lane state follows a pause opening, closing or a generic defer.
 * Everything here runs inside the caller's transaction.
 */
import type { Sql } from './db.js';
import type { reviewOutcomes } from '../shared/contracts.js';
import { closeTicketTx } from './ledger.js';
import { deferAnswerSessionTx } from './answers/defer.js';
import { deferOutreachTicketTx, outreachTicketKind } from './outreach/defer.js';
import {
  queueFollowJobStatus,
  queueAfterOpen,
} from './identity/queue-hooks.js';

/** A pause frees the single tab: the job's queue item (if any) becomes `paused`. */
export async function queueOnTicketOpenedTx(
  sql: Sql,
  applicantId: string,
  jobId: string,
) {
  await queueAfterOpen(sql, applicantId, jobId);
}
/** After a close the queue item follows the job: back in line, stopped, or untouched. */
export async function queueOnTicketClosedTx(
  sql: Sql,
  applicantId: string,
  jobId: string,
  jobStatus: string,
) {
  await queueFollowJobStatus(sql, applicantId, jobId, jobStatus);
}

/**
 * Generic "Defer" from the shared tickets list, routed per lane:
 * - outreach-tagged tickets: the application stays `confirmed` (outreach is deferred, not the
 *   position); a review ticket also records `outreach.reviewed {outcome: deferred}`;
 * - answer-session tickets: the session becomes `deferred` (never paused on a closed ticket);
 * - everything else: the job becomes `deferred` and its queue item stops.
 */
export async function deferTicketTx(
  sql: Sql,
  applicantId: string,
  ticketRow: any,
  resolution: { outcome: (typeof reviewOutcomes)[number]; value: string },
) {
  const outreachKind = await outreachTicketKind(sql, applicantId, ticketRow.id);
  await closeTicketTx(
    sql,
    applicantId,
    ticketRow,
    resolution,
    outreachKind ? ticketRow.resume_status : 'deferred',
  );
  await deferAnswerSessionTx(sql, applicantId, ticketRow.id);
  if (outreachKind)
    await deferOutreachTicketTx(sql, applicantId, ticketRow, outreachKind);
}
