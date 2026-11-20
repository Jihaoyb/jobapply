/**
 * Deterministic synthetic ledger generator for the pilot report (013a).
 * Builds v1-contract rows (jobs, ledger_events, tickets, model_calls) from
 * per-job scripts with explicit timestamps. Every ID is derived from the
 * scenario name and job key, so a scenario always produces the same ledger.
 * All employers, hosts and people are synthetic (example.com style).
 */
import { createHash } from 'node:crypto';
import type { Database } from '../../../src/server/db.js';
import {
  CONTRACT_VERSION,
  classifyHost,
  parseEventPayload,
  type EventName,
  type EventPayload,
} from '../../../src/shared/contracts.js';
import type {
  FunnelHost,
  PauseCause,
  PilotHost,
  ReviewOutcome,
} from '../../../src/shared/report.js';
import { stableSampleId } from '../../../src/server/report/sampling.js';

export type Step =
  | { t: 'dup'; of: string }
  | { t: 'cap' }
  | {
      t: 'elig';
      decision: 'passed' | 'excluded' | 'review';
      provenance?: 'rule' | 'sol' | 'user';
    }
  /** `hours` omitted: the pause stays open (it must be the job's last step). */
  | { t: 'pause'; cause: PauseCause; hours?: number; outcome?: ReviewOutcome }
  | { t: 'submit' }
  | { t: 'uncertain' }
  | { t: 'confirm' }
  | { t: 'shortlist' }
  | { t: 'oreview'; outcome: ReviewOutcome }
  | { t: 'email' }
  | { t: 'emailUncertain' }
  | { t: 'linkedin' }
  | { t: 'model' }
  | { t: 'wait'; hours: number };

export interface JobScript {
  key: string;
  host: FunnelHost;
  /** Time of `job.selected`. */
  at: Date;
  steps: Step[];
}
export interface SampleScript {
  job: string;
  group: 'passed' | 'excluded';
  at: Date;
  completions: { outcome: ReviewOutcome; at: Date }[];
}
export interface Scenario {
  name: string;
  now: Date;
  adapters: { host: PilotHost; at: Date }[];
  jobs: JobScript[];
  samples: SampleScript[];
}

const STEP_MS = 10 * 60_000;
const HOUR = 3_600_000;
export function fixtureId(...parts: string[]) {
  const hex = createHash('sha256')
    .update(`report-fixture:${parts.join(':')}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function applicationUrl(host: FunnelHost, key: string) {
  switch (host) {
    case 'greenhouse':
      return `https://boards.greenhouse.io/fixture-${key}/jobs/1001`;
    case 'lever':
      return `https://jobs.lever.co/fixture-${key}/0001`;
    case 'ashby':
      return `https://jobs.ashbyhq.com/fixture-${key}/0001`;
    case 'other':
      return `https://careers.fixture-${key}.example.com/jobs/1001`;
  }
}
const resolveActionFor: Record<PauseCause, string> = {
  employer_identity: 'resolve_employer',
  import_ambiguity: 'resolve_import',
  unanswered_question: 'answer_once',
  required_file: 'attach_file',
  eligibility_ambiguity: 'decide_eligibility',
  unsupported_form: 'defer',
  provider_limit: 'retry_provider',
  uncertain_submission: 'reconcile_submission',
  uncertain_email: 'reconcile_email',
};

export interface GeneratedEvent {
  id: string;
  jobId: string | null;
  name: EventName;
  occurredAt: Date;
  payload: unknown;
}
export interface GeneratedLedger {
  jobIds: Record<string, string>;
  jobs: {
    id: string;
    key: string;
    title: string;
    employer: string;
    applicationUrl: string;
    status: string;
    createdAt: Date;
  }[];
  events: GeneratedEvent[];
  tickets: {
    id: string;
    jobId: string;
    pauseId: string;
    question: string;
    employer: string;
    role: string;
    cause: PauseCause;
    openedAt: Date;
    closedAt: Date | null;
    outcome: ReviewOutcome | null;
  }[];
  modelCalls: { id: string; jobId: string; createdAt: Date }[];
  ticketIds: Record<string, string[]>;
  pauseIds: Record<string, string[]>;
  outreachTicketIds: Record<string, string>;
}

export function generateLedger(
  scenario: Scenario,
  applicantId: string,
): GeneratedLedger {
  const id = (...parts: string[]) =>
    fixtureId(scenario.name, applicantId, ...parts);
  const jobIds = Object.fromEntries(
    scenario.jobs.map((job) => [job.key, id('job', job.key)]),
  );
  const out: GeneratedLedger = {
    jobIds,
    jobs: [],
    events: [],
    tickets: [],
    modelCalls: [],
    ticketIds: {},
    pauseIds: {},
    outreachTicketIds: {},
  };
  let counter = 0;
  function emit<N extends EventName>(
    jobId: string | null,
    name: N,
    payload: EventPayload<N>,
    at: Date,
  ) {
    out.events.push({
      id: id('event', String(counter++)),
      jobId,
      name,
      occurredAt: at,
      payload: parseEventPayload(name, payload),
    });
  }
  for (const adapter of scenario.adapters)
    emit(null, 'adapter.available', { host: adapter.host }, adapter.at);
  for (const job of scenario.jobs) {
    const jobId = jobIds[job.key]!;
    const url = applicationUrl(job.host, job.key);
    const host = classifyHost(url);
    const employer = `Fixture Employer ${job.key.toUpperCase()}`;
    const title = `Synthetic Engineer ${job.key}`;
    let cursor = job.at.getTime();
    let status = 'captured';
    emit(
      jobId,
      'job.selected',
      { source: 'extension', ...host },
      new Date(cursor),
    );
    let pauseIndex = 0;
    for (const step of job.steps) {
      if (step.t === 'wait') {
        cursor += step.hours * HOUR;
        continue;
      }
      cursor += STEP_MS;
      const at = new Date(cursor);
      switch (step.t) {
        case 'dup':
          emit(jobId, 'job.duplicate', { existingJobId: jobIds[step.of]! }, at);
          status = 'duplicate';
          break;
        case 'cap':
          emit(jobId, 'job.capped', { nextAvailableDate: '2027-01-15' }, at);
          status = 'capped';
          break;
        case 'elig':
          emit(
            jobId,
            'eligibility.decided',
            {
              decision: step.decision,
              provenance: step.provenance ?? 'rule',
              evidence:
                step.decision === 'excluded'
                  ? 'Must not require sponsorship now or in the future.'
                  : null,
            },
            at,
          );
          status =
            step.decision === 'passed'
              ? 'ready'
              : step.decision === 'excluded'
                ? 'eligibility_excluded'
                : 'eligibility_pending';
          break;
        case 'pause': {
          const n = String(pauseIndex++);
          const pauseId = id('pause', job.key, n),
            ticketId = id('ticket', job.key, n);
          (out.pauseIds[job.key] ??= []).push(pauseId);
          (out.ticketIds[job.key] ??= []).push(ticketId);
          emit(
            jobId,
            'pause.opened',
            { pauseId, ticketId, cause: step.cause },
            at,
          );
          let closedAt: Date | null = null;
          const outcome =
            step.hours === undefined ? null : (step.outcome ?? 'approved');
          if (step.hours !== undefined) {
            cursor += step.hours * HOUR;
            closedAt = new Date(cursor);
            emit(
              jobId,
              'pause.closed',
              { pauseId, ticketId, cause: step.cause, outcome: outcome! },
              closedAt,
            );
            status = outcome === 'deferred' ? 'deferred' : status;
          } else status = 'paused';
          out.tickets.push({
            id: ticketId,
            jobId,
            pauseId,
            question: `Synthetic ${step.cause.replaceAll('_', ' ')} question for ${job.key}`,
            employer,
            role: title,
            cause: step.cause,
            openedAt: at,
            closedAt,
            outcome,
          });
          break;
        }
        case 'submit':
          emit(jobId, 'application.submitting', {}, at);
          status = 'submitting';
          break;
        case 'uncertain':
          emit(
            jobId,
            'application.uncertain',
            { reason: 'Redirect without acknowledgement text' },
            at,
          );
          status = 'uncertain';
          break;
        case 'confirm':
          emit(
            jobId,
            'application.confirmed',
            { receiptId: id('receipt', job.key) },
            at,
          );
          status = 'confirmed';
          break;
        case 'shortlist':
          emit(
            jobId,
            'outreach.shortlisted',
            { shortlistId: id('shortlist', job.key) },
            at,
          );
          break;
        case 'oreview': {
          const ticketId = id('outreach-ticket', job.key);
          out.outreachTicketIds[job.key] = ticketId;
          emit(
            jobId,
            'outreach.reviewed',
            { ticketId, outcome: step.outcome },
            at,
          );
          break;
        }
        case 'email':
          emit(
            jobId,
            'email.accepted',
            { deliveryId: id('delivery', job.key) },
            at,
          );
          break;
        case 'emailUncertain':
          emit(
            jobId,
            'email.uncertain',
            { deliveryId: id('delivery', job.key) },
            at,
          );
          break;
        case 'linkedin':
          emit(
            jobId,
            'linkedin.recorded',
            { contactId: id('contact', job.key) },
            at,
          );
          break;
        case 'model': {
          const callId = id('model-call', job.key);
          out.modelCalls.push({ id: callId, jobId, createdAt: at });
          emit(
            jobId,
            'model.called',
            {
              callId,
              provider: 'openai',
              model: 'fixture-sol',
              promptVersion: 'eligibility-v1',
              inputTokens: 1200,
              outputTokens: 80,
              status: 'completed',
            },
            at,
          );
          break;
        }
      }
    }
    out.jobs.push({
      id: jobId,
      key: job.key,
      title,
      employer,
      applicationUrl: url,
      status,
      createdAt: job.at,
    });
  }
  for (const sample of scenario.samples) {
    const jobId = jobIds[sample.job]!;
    const sampleId = stableSampleId(applicantId, sample.group, jobId);
    emit(jobId, 'review.sampled', { sampleId, group: sample.group }, sample.at);
    for (const completion of sample.completions)
      emit(
        jobId,
        'review.completed',
        { sampleId, outcome: completion.outcome },
        completion.at,
      );
  }
  return out;
}

/** Inserts a generated ledger with its explicit timestamps. */
export async function seedLedger(
  db: Database,
  applicantId: string,
  ledger: GeneratedLedger,
) {
  await db.transaction(async (sql) => {
    for (const job of ledger.jobs) {
      const host = classifyHost(job.applicationUrl);
      await sql.query(
        `INSERT INTO jobs (id,applicant_id,client_capture_id,title,employer,discovery_url,application_url,posting_text,source,status,application_host,supported_host,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'extension',$9,$10,$11,$12)`,
        [
          job.id,
          applicantId,
          fixtureId('capture', applicantId, job.key),
          job.title,
          job.employer,
          `https://jobs.example.com/listing/${job.key}`,
          job.applicationUrl,
          `Synthetic posting for ${job.key}.`,
          job.status,
          host.applicationHost,
          host.supportedHost,
          job.createdAt,
        ],
      );
    }
    for (const call of ledger.modelCalls)
      await sql.query(
        `INSERT INTO model_calls (id,applicant_id,job_id,provider,model,prompt_version,input_tokens,output_tokens,status,created_at)
        VALUES ($1,$2,$3,'openai','fixture-sol','eligibility-v1',1200,80,'completed',$4)`,
        [call.id, applicantId, call.jobId, call.createdAt],
      );
    for (const ticket of ledger.tickets)
      await sql.query(
        `INSERT INTO tickets (id,applicant_id,job_id,pause_id,question,choices,employer,role,cause,resolve_action,status,opened_at,closed_at,resolution,resume_status)
        VALUES ($1,$2,$3,$4,$5,'[]',$6,$7,$8,$9,$10,$11,$12,$13,'ready')`,
        [
          ticket.id,
          applicantId,
          ticket.jobId,
          ticket.pauseId,
          ticket.question,
          ticket.employer,
          ticket.role,
          ticket.cause,
          resolveActionFor[ticket.cause],
          ticket.closedAt ? 'resolved' : 'open',
          ticket.openedAt,
          ticket.closedAt,
          ticket.closedAt
            ? JSON.stringify({ outcome: ticket.outcome, value: 'fixture' })
            : null,
        ],
      );
    for (const event of ledger.events)
      await sql.query(
        'INSERT INTO ledger_events (id,applicant_id,job_id,name,occurred_at,schema_version,payload) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          event.id,
          applicantId,
          event.jobId,
          event.name,
          event.occurredAt,
          CONTRACT_VERSION,
          JSON.stringify(event.payload),
        ],
      );
  });
}
