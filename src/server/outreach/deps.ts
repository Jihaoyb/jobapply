import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import { configuredModelCaller, type ModelRequest } from '../model.js';
import {
  closeTicketTx,
  isOpenTicketConflict,
  lockOpenTicketTx,
  openTicketTx,
} from '../ledger.js';
import {
  reviewOutcomes,
  type Ticket,
  type TicketInput,
} from '../../shared/contracts.js';
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

/**
 * Opens a ticket through the shared primitive and tags it as an outreach ticket in the same
 * transaction; `alsoTx` lets the caller commit its own row (e.g. the review) with the pause.
 * Returns null when the job already has another lane's open ticket: outreach defers (logged
 * `deferred_open_ticket`) and a later wake retries once that ticket has closed.
 */
export async function openOutreachTicket(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
  kind: OutreachKind,
  input: TicketInput,
  proposedDomains: string[] = [],
  alsoTx?: (sql: Sql, ticket: Ticket) => Promise<void>,
): Promise<Ticket | null> {
  try {
    return await deps.db.transaction(async (sql) => {
      const ticket = await openTicketTx(sql, applicantId, jobId, input);
      await sql.query(
        'INSERT INTO outreach_tickets (ticket_id,applicant_id,job_id,kind,proposed_domains) VALUES ($1,$2,$3,$4,$5)',
        [ticket.id, applicantId, jobId, kind, JSON.stringify(proposedDomains)],
      );
      if (alsoTx) await alsoTx(sql, ticket);
      return ticket;
    });
  } catch (error) {
    if (!isOpenTicketConflict(error)) throw error;
    await logWorker(
      deps,
      applicantId,
      jobId,
      'deferred_open_ticket',
      `${kind} ticket not opened: job has an open ticket`,
    );
    return null;
  }
}
/** Another lane's open ticket on the job, if any (outreach waits for it to close). */
export async function foreignOpenTicket(
  sql: Sql,
  applicantId: string,
  jobId: string,
) {
  return (
    await sql.query(
      `SELECT t.id, t.cause FROM tickets t WHERE t.applicant_id=$1 AND t.job_id=$2 AND t.status='open'
       AND NOT EXISTS (SELECT 1 FROM outreach_tickets o WHERE o.ticket_id=t.id)`,
      [applicantId, jobId],
    )
  ).rows[0] as { id: string; cause: string } | undefined;
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
  const row = await lockOpenTicketTx(sql, applicantId, ticketId);
  await closeTicketTx(
    sql,
    applicantId,
    row,
    { outcome, value },
    row.resume_status,
  );
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
): Promise<'paused_provider' | 'deferred_open_ticket'> {
  const message = error instanceof Error ? error.message : 'Provider failed';
  const ticket = await openOutreachTicket(
    deps,
    applicantId,
    job.id,
    'provider',
    {
      question: `${what} paused: ${message}. Fix the provider setup or wait for limits to reset, then retry.`,
      choices: ['Retry', 'Defer'],
      employer: job.employer,
      role: job.title,
      cause: 'provider_limit',
      resolveAction: 'retry_provider',
    },
  );
  if (!ticket) return 'deferred_open_ticket';
  await logWorker(
    deps,
    applicantId,
    job.id,
    'paused_provider',
    `${what}: ${message}`,
  );
  return 'paused_provider';
}
