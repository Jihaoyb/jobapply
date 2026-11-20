import { randomUUID } from 'node:crypto';
import {
  ticketInput,
  type Ticket,
  type TicketInput,
  type reviewOutcomes,
} from '../../shared/contracts.js';
import type { Sql } from '../db.js';
import { appendEvent, HttpError, ticketFromRow } from '../ledger.js';

/** Serializes identity, cap and queue writes for one applicant (pairs with row locks). */
export async function lockApplicant(sql: Sql, applicantId: string) {
  await sql.query('SELECT pg_advisory_xact_lock(42002, hashtext($1::text))', [
    applicantId,
  ]);
}

/**
 * Same rows and pause.opened event as ledger.openTicket, but inside the caller's transaction so
 * the identity/import state change and the pause commit together.
 */
export async function openTicketTx(
  sql: Sql,
  applicantId: string,
  jobId: string,
  raw: TicketInput,
): Promise<Ticket> {
  const data = ticketInput.parse(raw);
  const job = (
    await sql.query(
      'SELECT * FROM jobs WHERE id=$1 AND applicant_id=$2 FOR UPDATE',
      [jobId, applicantId],
    )
  ).rows[0];
  if (!job) throw new HttpError(404, 'Job not found');
  const open = await sql.query(
    "SELECT id FROM tickets WHERE job_id=$1 AND status='open'",
    [jobId],
  );
  if (open.rows.length)
    throw new HttpError(409, 'Job already has an open ticket');
  const ticketId = randomUUID(),
    pauseId = randomUUID();
  const rows = await sql.query(
    `INSERT INTO tickets (id,applicant_id,job_id,pause_id,question,choices,employer,role,cause,resolve_action,status,resume_status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',$11) RETURNING *`,
    [
      ticketId,
      applicantId,
      jobId,
      pauseId,
      data.question,
      JSON.stringify(data.choices),
      data.employer,
      data.role,
      data.cause,
      data.resolveAction,
      job.status,
    ],
  );
  await sql.query(
    "UPDATE jobs SET status='paused' WHERE id=$1 AND applicant_id=$2",
    [jobId, applicantId],
  );
  await sql.query(
    "UPDATE work_queue SET state='paused',updated_at=now() WHERE job_id=$1 AND applicant_id=$2 AND state IN ('queued','active')",
    [jobId, applicantId],
  );
  await appendEvent(sql, applicantId, jobId, 'pause.opened', {
    pauseId,
    ticketId,
    cause: data.cause,
  });
  return ticketFromRow(rows.rows[0]);
}

/** Closes an open ticket and its pause in the caller's transaction (domain handler path). */
export async function closeTicketTx(
  sql: Sql,
  applicantId: string,
  ticketRow: any,
  resolution: { outcome: (typeof reviewOutcomes)[number]; value: string },
  nextJobStatus: string,
) {
  await sql.query(
    "UPDATE tickets SET status='resolved',closed_at=now(),resolution=$3 WHERE id=$1 AND applicant_id=$2",
    [ticketRow.id, applicantId, JSON.stringify(resolution)],
  );
  await sql.query('UPDATE jobs SET status=$3 WHERE id=$1 AND applicant_id=$2', [
    ticketRow.job_id,
    applicantId,
    nextJobStatus,
  ]);
  await appendEvent(sql, applicantId, ticketRow.job_id, 'pause.closed', {
    pauseId: ticketRow.pause_id,
    ticketId: ticketRow.id,
    cause: ticketRow.cause,
    outcome: resolution.outcome,
  });
}
