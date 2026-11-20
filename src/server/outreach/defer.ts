import type { Sql } from '../db.js';
import { appendEvent } from '../ledger.js';
import type { OutreachKind } from './deps.js';

/** The outreach tag of a ticket (`outreach_tickets.kind`), or null for other lanes' tickets. */
export async function outreachTicketKind(
  sql: Sql,
  applicantId: string,
  ticketId: string,
): Promise<OutreachKind | null> {
  return (
    (
      await sql.query(
        'SELECT kind FROM outreach_tickets WHERE ticket_id=$1 AND applicant_id=$2',
        [ticketId, applicantId],
      )
    ).rows[0]?.kind ?? null
  );
}

/**
 * Lane D reaction to a generic defer (ticket-hooks.ts). A deferred review is recorded like a
 * skip but with outcome `deferred` (the report keeps it out of the reviewed denominator).
 * Deferred domain/provider/employer pauses stop outreach for that position: the sweep and
 * later wakes skip it (worker.ts). A deferred email reconciliation leaves the delivery
 * `uncertain`, which is never resent automatically.
 */
export async function deferOutreachTicketTx(
  sql: Sql,
  applicantId: string,
  ticketRow: any,
  kind: OutreachKind,
) {
  if (kind !== 'review') return;
  const review = await sql.query(
    "UPDATE outreach_reviews SET status='skipped',outcome='deferred' WHERE ticket_id=$1 AND applicant_id=$2 AND status IN ('drafting','ready') RETURNING id",
    [ticketRow.id, applicantId],
  );
  if (review.rows.length)
    await appendEvent(sql, applicantId, ticketRow.job_id, 'outreach.reviewed', {
      ticketId: ticketRow.id,
      outcome: 'deferred',
    });
}
