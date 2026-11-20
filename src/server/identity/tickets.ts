import type { Sql } from '../db.js';

/** Serializes identity, cap and queue writes for one applicant (pairs with row locks). */
export async function lockApplicant(sql: Sql, applicantId: string) {
  await sql.query('SELECT pg_advisory_xact_lock(42002, hashtext($1::text))', [
    applicantId,
  ]);
}

// Ticket open/close inside a caller's transaction is the ledger primitive
// (ledger.openTicketTx / closeTicketTx); identity no longer keeps a copy.
