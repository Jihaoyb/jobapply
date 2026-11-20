import type { Sql } from '../db.js';
import type { ReportLedger } from './compute.js';

const toIso = (value: unknown) => new Date(value as string).toISOString();

/** Reads the owner's v1 ledger (events, jobs, tickets). Model calls do not feed the three charts. */
export async function loadReportLedger(
  sql: Sql,
  applicantId: string,
): Promise<ReportLedger> {
  // Sequential: the same client may be inside a transaction.
  const events = await sql.query(
    "SELECT id,job_id,name,occurred_at,payload FROM ledger_events WHERE applicant_id=$1 AND name<>'model.called' ORDER BY occurred_at,id",
    [applicantId],
  );
  const jobs = await sql.query(
    'SELECT id,title,employer,application_host FROM jobs WHERE applicant_id=$1',
    [applicantId],
  );
  const tickets = await sql.query(
    'SELECT id,job_id,pause_id,question,resolve_action FROM tickets WHERE applicant_id=$1',
    [applicantId],
  );
  return {
    events: events.rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      name: row.name,
      occurredAt: toIso(row.occurred_at),
      payload:
        typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    })),
    jobs: jobs.rows.map((row) => ({
      id: row.id,
      title: row.title,
      employer: row.employer,
      applicationHost: row.application_host,
    })),
    tickets: tickets.rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      pauseId: row.pause_id,
      question: row.question,
      resolveAction: row.resolve_action,
    })),
  };
}
