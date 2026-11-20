import type { Sql } from '../db.js';

/**
 * Lane C reaction to a generic defer of its ticket (ticket-hooks.ts): the session paused on
 * that ticket becomes `deferred`, exactly as the answers handler's own defer does.
 */
export async function deferAnswerSessionTx(
  sql: Sql,
  applicantId: string,
  ticketId: string,
) {
  await sql.query(
    `UPDATE answer_sessions SET status='deferred', ticket_id=NULL, paused_field_id=NULL, pause_detail=NULL,
     updated_at=now() WHERE ticket_id=$1 AND applicant_id=$2 AND status='paused'`,
    [ticketId, applicantId],
  );
}
