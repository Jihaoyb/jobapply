import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import { configuredModelCaller, type ModelRequest } from '../model.js';
import { appendEvent, HttpError, openTicket } from '../ledger.js';
import { reviewOutcomes, type TicketInput } from '../../shared/contracts.js';
import { httpApollo, type ApolloClient } from './apollo.js';
import { gmailSmtp, type SmtpSender } from './smtp.js';

export type ModelCall = <T>(request: ModelRequest<T>) => Promise<T>;
export interface OutreachDeps {
  db: Database;
  apollo: ApolloClient;
  smtp: SmtpSender;
  /** Must be the single wrapper from src/server/model.ts (fakes inject its transport). */
  callModel: ModelCall;
  /** Applicant-side sending cap per rolling 24 hours, below Gmail's account limit. */
  dailyEmailLimit: number;
  log: (message: string, data: Record<string, unknown>) => void;
}
export type OutreachKind =
  'employer' | 'domain' | 'provider' | 'review' | 'uncertain_email';

/** Production wiring. Every credential is read from server env only; none is required to boot. */
export function configuredOutreachDeps(db: Database): OutreachDeps {
  return {
    db,
    apollo: httpApollo(process.env.APOLLO_API_KEY || undefined),
    smtp: gmailSmtp({
      host: process.env.GMAIL_SMTP_HOST ?? 'smtp.gmail.com',
      port: Number(process.env.GMAIL_SMTP_PORT ?? 465),
      user: process.env.GMAIL_SMTP_USER || undefined,
      appPassword: process.env.GMAIL_APP_PASSWORD || undefined,
      timeoutMs: Number(process.env.GMAIL_SMTP_TIMEOUT_MS ?? 30_000),
    }),
    callModel: configuredModelCaller(db),
    dailyEmailLimit: Number(process.env.OUTREACH_DAILY_EMAIL_LIMIT ?? 20),
    log: (message, data) =>
      console.log(JSON.stringify({ scope: 'outreach', message, ...data })),
  };
}

/** Opens a ticket through the shared primitive and tags it as an outreach ticket. */
export async function openOutreachTicket(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
  kind: OutreachKind,
  input: TicketInput,
  proposedDomains: string[] = [],
) {
  const ticket = await openTicket(deps.db, applicantId, jobId, input);
  await deps.db.query(
    'INSERT INTO outreach_tickets (ticket_id,applicant_id,job_id,kind,proposed_domains) VALUES ($1,$2,$3,$4,$5)',
    [ticket.id, applicantId, jobId, kind, JSON.stringify(proposedDomains)],
  );
  return ticket;
}
export async function openOutreachTicketFor(
  sql: Sql,
  applicantId: string,
  jobId: string,
  kinds: OutreachKind[],
) {
  return (
    await sql.query(
      `SELECT t.*, o.kind, o.proposed_domains FROM tickets t JOIN outreach_tickets o ON o.ticket_id=t.id
       WHERE t.applicant_id=$1 AND t.job_id=$2 AND t.status='open' AND o.kind = ANY($3::text[]) FOR UPDATE OF t`,
      [applicantId, jobId, kinds],
    )
  ).rows[0] as any | undefined;
}
/**
 * Outreach domain handler for the ticket primitive: closes the ticket and its
 * pause in the caller's transaction and restores the job's pre-pause status.
 */
export async function closeOutreachTicket(
  sql: Sql,
  applicantId: string,
  ticketId: string,
  outcome: (typeof reviewOutcomes)[number],
  value: string,
) {
  const row = (
    await sql.query(
      'SELECT * FROM tickets WHERE id=$1 AND applicant_id=$2 FOR UPDATE',
      [ticketId, applicantId],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, 'Ticket not found');
  if (row.status !== 'open')
    throw new HttpError(409, 'Ticket already resolved');
  await sql.query(
    "UPDATE tickets SET status='resolved',closed_at=now(),resolution=$3 WHERE id=$1 AND applicant_id=$2",
    [ticketId, applicantId, JSON.stringify({ outcome, value })],
  );
  await sql.query(
    "UPDATE jobs SET status=$3 WHERE id=$1 AND applicant_id=$2 AND status='paused'",
    [row.job_id, applicantId, row.resume_status],
  );
  await appendEvent(sql, applicantId, row.job_id, 'pause.closed', {
    pauseId: row.pause_id,
    ticketId,
    cause: row.cause,
    outcome,
  });
  return row;
}
export async function logWorker(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
  outcome: string,
  detail = '',
) {
  deps.log(`worker ${outcome}`, { applicantId, jobId, detail });
  await deps.db.query(
    'INSERT INTO outreach_worker_log (id,applicant_id,job_id,outcome,detail) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), applicantId, jobId, outcome, detail],
  );
}

/** Opens a provider_limit pause for missing setup, limits, or failed provider calls. */
export async function pauseForProvider(
  deps: OutreachDeps,
  applicantId: string,
  job: { id: string; employer: string; title: string },
  error: unknown,
  what: string,
): Promise<'paused_provider'> {
  const message = error instanceof Error ? error.message : 'Provider failed';
  try {
    await openOutreachTicket(deps, applicantId, job.id, 'provider', {
      question: `${what} paused: ${message}. Fix the provider setup or wait for limits to reset, then retry.`,
      choices: ['Retry', 'Defer'],
      employer: job.employer,
      role: job.title,
      cause: 'provider_limit',
      resolveAction: 'retry_provider',
    });
  } catch (ticketError) {
    deps.log('provider pause not opened', {
      jobId: job.id,
      reason: (ticketError as Error).message,
    });
  }
  await logWorker(
    deps,
    applicantId,
    job.id,
    'paused_provider',
    `${what}: ${message}`,
  );
  return 'paused_provider';
}
