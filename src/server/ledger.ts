import { randomUUID } from 'node:crypto';
import {
  CONTRACT_VERSION,
  captureInput,
  classifyHost,
  parseEventPayload,
  ticketInput,
  type EventName,
  type EventPayload,
  type CaptureInput,
  type Job,
  type Ticket,
  type TicketInput,
  reviewOutcomes,
} from '../shared/contracts.js';
import type { Database, Sql } from './db.js';
import { onCapture } from './identity/capture.js';
import {
  deferTicketTx,
  queueOnTicketClosedTx,
  queueOnTicketOpenedTx,
} from './ticket-hooks.js';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export function jobFromRow(row: any): Job {
  return {
    id: row.id,
    applicantId: row.applicant_id,
    clientCaptureId: row.client_capture_id,
    canonicalEmployerId: row.canonical_employer_id,
    title: row.title,
    employer: row.employer,
    discoveryUrl: row.discovery_url,
    applicationUrl: row.application_url,
    postingText: row.posting_text,
    source: row.source,
    status: row.status,
    applicationHost: row.application_host,
    supportedHost: row.supported_host,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
export function ticketFromRow(row: any): Ticket {
  return {
    id: row.id,
    applicantId: row.applicant_id,
    jobId: row.job_id,
    pauseId: row.pause_id,
    question: row.question,
    choices: row.choices,
    employer: row.employer,
    role: row.role,
    cause: row.cause,
    resolveAction: row.resolve_action,
    status: row.status,
    openedAt: new Date(row.opened_at).toISOString(),
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    resolution: row.resolution,
  };
}
export async function appendEvent<N extends EventName>(
  sql: Sql,
  applicantId: string,
  jobId: string | null,
  name: N,
  input: EventPayload<N>,
) {
  if (!jobId && name !== 'adapter.available')
    throw new Error('Job events require jobId');
  const payload = parseEventPayload(name, input);
  const eventId = randomUUID();
  await sql.query(
    'INSERT INTO ledger_events (id,applicant_id,job_id,name,schema_version,payload) VALUES ($1,$2,$3,$4,$5,$6)',
    [
      eventId,
      applicantId,
      jobId,
      name,
      CONTRACT_VERSION,
      JSON.stringify(payload),
    ],
  );
  return eventId;
}
export async function captureJob(
  db: Database,
  applicantId: string,
  raw: CaptureInput,
  source: 'extension' | 'manual',
): Promise<Job> {
  const data = captureInput.parse(raw);
  const host = classifyHost(data.applicationUrl);
  return db.transaction(async (sql) => {
    const result = await sql.query(
      `INSERT INTO jobs (id,applicant_id,client_capture_id,title,employer,discovery_url,application_url,posting_text,source,status,application_host,supported_host)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'captured',$10,$11) ON CONFLICT (applicant_id,client_capture_id) DO NOTHING RETURNING *`,
      [
        randomUUID(),
        applicantId,
        data.clientCaptureId,
        data.title,
        data.employer,
        data.discoveryUrl,
        data.applicationUrl,
        data.postingText,
        source,
        host.applicationHost,
        host.supportedHost,
      ],
    );
    if (!result.rows.length) {
      const existing = await sql.query(
        'SELECT * FROM jobs WHERE applicant_id=$1 AND client_capture_id=$2',
        [applicantId, data.clientCaptureId],
      );
      const job = jobFromRow(existing.rows[0]);
      if (
        job.title !== data.title ||
        job.employer !== data.employer ||
        job.discoveryUrl !== data.discoveryUrl ||
        job.applicationUrl !== data.applicationUrl ||
        job.postingText !== data.postingText ||
        job.source !== source
      )
        throw new HttpError(
          409,
          'Capture ID already used for different content',
        );
      return job;
    }
    const job = jobFromRow(result.rows[0]);
    await appendEvent(sql, applicantId, job.id, 'job.selected', {
      source,
      ...host,
    });
    return onCapture(sql, applicantId, job);
  });
}
/**
 * The job already has an open ticket (unique index `one_open_ticket_per_job`). Background
 * workers treat this as "defer and retry after that ticket closes", never as a failure.
 */
export class OpenTicketConflict extends HttpError {
  constructor(public existingTicketId: string | null) {
    super(409, 'Job already has an open ticket');
  }
}
export function isOpenTicketConflict(error: unknown): error is HttpError {
  return (
    error instanceof OpenTicketConflict ||
    (error instanceof HttpError &&
      error.statusCode === 409 &&
      error.message === 'Job already has an open ticket')
  );
}
/** The job's open ticket row, if any (at most one by the unique index). */
export async function findOpenTicket(
  sql: Sql,
  applicantId: string,
  jobId: string,
): Promise<any | undefined> {
  return (
    await sql.query(
      "SELECT * FROM tickets WHERE job_id=$1 AND applicant_id=$2 AND status='open'",
      [jobId, applicantId],
    )
  ).rows[0];
}

/**
 * Opens a ticket and its pause inside the caller's transaction: ticket row, job `paused`
 * (pre-pause status kept in `resume_status`), queue item paused, `pause.opened`. Lanes call
 * this when their own state change must commit together with the pause. Throws
 * `OpenTicketConflict` when the job already has an open ticket.
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
  // The job row lock serializes openers, so this check is authoritative.
  const existing = await findOpenTicket(sql, applicantId, jobId);
  if (existing) throw new OpenTicketConflict(existing.id);
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
  await queueOnTicketOpenedTx(sql, applicantId, jobId);
  await appendEvent(sql, applicantId, jobId, 'pause.opened', {
    pauseId,
    ticketId,
    cause: data.cause,
  });
  return ticketFromRow(rows.rows[0]);
}
export async function openTicket(
  db: Database,
  applicantId: string,
  jobId: string,
  raw: TicketInput,
): Promise<Ticket> {
  return db.transaction((sql) => openTicketTx(sql, applicantId, jobId, raw));
}

/** Locks an open ticket for a domain handler; 404 for another owner, 409 once resolved. */
export async function lockOpenTicketTx(
  sql: Sql,
  applicantId: string,
  ticketId: string,
): Promise<any> {
  const row = (
    await sql.query(
      'SELECT * FROM tickets WHERE id=$1 AND applicant_id=$2 FOR UPDATE',
      [ticketId, applicantId],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, 'Ticket not found');
  if (row.status !== 'open')
    throw new HttpError(409, 'Ticket already resolved');
  return row;
}

/**
 * Closes a ticket and its pause inside the caller's transaction: ticket resolved, job moved
 * from `paused` to `nextJobStatus` (a status another writer set meanwhile is left alone),
 * queue item requeued/stopped to match, `pause.closed` with the outcome.
 */
export async function closeTicketTx(
  sql: Sql,
  applicantId: string,
  ticketRow: any,
  resolution: { outcome: (typeof reviewOutcomes)[number]; value: string },
  nextJobStatus: string,
) {
  const closed = await sql.query(
    "UPDATE tickets SET status='resolved',closed_at=now(),resolution=$3 WHERE id=$1 AND applicant_id=$2 AND status='open' RETURNING id",
    [ticketRow.id, applicantId, JSON.stringify(resolution)],
  );
  if (!closed.rows.length) throw new HttpError(409, 'Ticket already resolved');
  await sql.query(
    "UPDATE jobs SET status=$3 WHERE id=$1 AND applicant_id=$2 AND status='paused'",
    [ticketRow.job_id, applicantId, nextJobStatus],
  );
  const status = (
    await sql.query('SELECT status FROM jobs WHERE id=$1 AND applicant_id=$2', [
      ticketRow.job_id,
      applicantId,
    ])
  ).rows[0]?.status as string;
  await queueOnTicketClosedTx(sql, applicantId, ticketRow.job_id, status);
  await appendEvent(sql, applicantId, ticketRow.job_id, 'pause.closed', {
    pauseId: ticketRow.pause_id,
    ticketId: ticketRow.id,
    cause: ticketRow.cause,
    outcome: resolution.outcome,
  });
}

export const resolutionInput = z.object({
  outcome: z.enum(reviewOutcomes),
  value: z.string().trim().min(1).max(10000),
});
/**
 * Generic resolution from the shared tickets list. Only `deferred` is available here; the
 * owning lane's state reacts in the same transaction (see ticket-hooks.ts).
 */
export async function resolveTicket(
  db: Database,
  applicantId: string,
  ticketId: string,
  raw: z.infer<typeof resolutionInput>,
) {
  const resolution = resolutionInput.parse(raw);
  return db.transaction(async (sql) => {
    const row = await lockOpenTicketTx(sql, applicantId, ticketId);
    // Domain-specific actions must be implemented atomically by their P2 lane.
    // A generic UI cannot claim to attach a file, merge employers or send outreach.
    if (resolution.outcome !== 'deferred')
      throw new HttpError(
        409,
        'This action needs its domain handler; defer is available now',
      );
    await deferTicketTx(sql, applicantId, row, resolution);
    return { resolved: true };
  });
}
