import { z } from 'zod';

export const CONTRACT_VERSION = 1 as const;
export const id = z.uuid();
// Opaque UUIDs, never domain/ATS keys. Issue 002 maps those aliases to this ID.
export type CanonicalEmployerId = string & {
  readonly __brand: 'CanonicalEmployerId';
};
export const canonicalEmployerId = id.transform(
  (value) => value as CanonicalEmployerId,
);
export const jobStatuses = [
  'captured',
  'duplicate',
  'capped',
  'eligibility_pending',
  'eligibility_excluded',
  'ready',
  'paused',
  'submitting',
  'uncertain',
  'confirmed',
  'deferred',
] as const;
export const pauseCauses = [
  'employer_identity',
  'import_ambiguity',
  'unanswered_question',
  'required_file',
  'eligibility_ambiguity',
  'unsupported_form',
  'provider_limit',
  'uncertain_submission',
  'uncertain_email',
] as const;
export const reviewOutcomes = [
  'approved',
  'edited_draft',
  'changed_ranking',
  'missed_restriction',
  'reversed_exclusion',
  'no_change',
  'skipped',
  'deferred',
] as const;
export const resolveActions = [
  'resolve_employer',
  'resolve_import',
  'answer_once',
  'answer_employer',
  'answer_global',
  'attach_file',
  'decide_eligibility',
  'reconcile_submission',
  'retry_provider',
  'review_outreach',
  'reconcile_email',
  'defer',
] as const;
export const eventNames = [
  'job.selected',
  'job.duplicate',
  'job.capped',
  'eligibility.decided',
  'application.submitting',
  'application.uncertain',
  'application.confirmed',
  'pause.opened',
  'pause.closed',
  'review.sampled',
  'review.completed',
  'outreach.shortlisted',
  'outreach.reviewed',
  'email.accepted',
  'email.uncertain',
  'linkedin.recorded',
  'adapter.available',
  'model.called',
] as const;
const payloads = {
  'job.selected': z.object({
    source: z.enum(['extension', 'manual']),
    applicationHost: z.string(),
    supportedHost: z.boolean(),
  }),
  'job.duplicate': z.object({ existingJobId: id }),
  'job.capped': z.object({ nextAvailableDate: z.iso.date() }),
  'eligibility.decided': z.object({
    decision: z.enum(['passed', 'excluded', 'review']),
    provenance: z.enum(['rule', 'sol', 'user']),
    evidence: z.string().nullable(),
  }),
  'application.submitting': z.object({}),
  'application.uncertain': z.object({ reason: z.string() }),
  'application.confirmed': z.object({ receiptId: id }),
  'pause.opened': z.object({
    pauseId: id,
    ticketId: id,
    cause: z.enum(pauseCauses),
  }),
  'pause.closed': z.object({
    pauseId: id,
    ticketId: id,
    cause: z.enum(pauseCauses),
    outcome: z.enum(reviewOutcomes),
  }),
  'review.sampled': z.object({
    sampleId: id,
    group: z.enum(['passed', 'excluded']),
  }),
  'review.completed': z.object({
    sampleId: id,
    outcome: z.enum(reviewOutcomes),
  }),
  'outreach.shortlisted': z.object({ shortlistId: id }),
  'outreach.reviewed': z.object({
    ticketId: id,
    outcome: z.enum(reviewOutcomes),
  }),
  'email.accepted': z.object({ deliveryId: id }),
  'email.uncertain': z.object({ deliveryId: id }),
  'linkedin.recorded': z.object({ contactId: id }),
  'adapter.available': z.object({
    host: z.enum(['greenhouse', 'lever', 'ashby']),
  }),
  'model.called': z.object({
    callId: id,
    provider: z.literal('openai'),
    model: z.string(),
    promptVersion: z.string(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    status: z.enum(['completed', 'failed']),
  }),
} satisfies Record<(typeof eventNames)[number], z.ZodType>;
export type EventName = keyof typeof payloads;
export type EventPayload<N extends EventName> = z.infer<(typeof payloads)[N]>;
export function parseEventPayload<N extends EventName>(
  name: N,
  payload: EventPayload<N>,
): EventPayload<N> {
  return payloads[name].parse(payload) as EventPayload<N>;
}
export interface LedgerEvent<N extends EventName = EventName> {
  id: string;
  applicantId: string;
  jobId: string | null;
  occurredAt: string;
  schemaVersion: typeof CONTRACT_VERSION;
  name: N;
  payload: EventPayload<N>;
}
const webUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
  );
}, 'Use an HTTP(S) URL without credentials');
export const captureInput = z.object({
  clientCaptureId: id,
  title: z.string().trim().min(1).max(300),
  employer: z.string().trim().min(1).max(300),
  discoveryUrl: webUrl.max(4000),
  applicationUrl: webUrl.max(4000),
  postingText: z.string().trim().min(1).max(150_000),
});
export type CaptureInput = z.infer<typeof captureInput>;
export interface Job extends CaptureInput {
  id: string;
  applicantId: string;
  canonicalEmployerId: CanonicalEmployerId | null;
  source: 'extension' | 'manual';
  status: (typeof jobStatuses)[number];
  applicationHost: string;
  supportedHost: boolean;
  createdAt: string;
}
export const ticketInput = z.object({
  question: z.string().trim().min(1).max(4000),
  choices: z.array(z.string().min(1).max(1000)).max(100),
  employer: z.string().min(1),
  role: z.string().min(1),
  cause: z.enum(pauseCauses),
  resolveAction: z.enum(resolveActions),
});
export type TicketInput = z.infer<typeof ticketInput>;
export interface Ticket extends TicketInput {
  id: string;
  applicantId: string;
  jobId: string;
  pauseId: string;
  status: 'open' | 'resolved';
  openedAt: string;
  closedAt: string | null;
  resolution: {
    outcome: (typeof reviewOutcomes)[number];
    value: string;
  } | null;
}
export function classifyHost(value: string): {
  applicationHost: string;
  supportedHost: boolean;
} {
  const applicationHost = new URL(value).hostname.toLowerCase();
  return {
    applicationHost,
    supportedHost: [
      'boards.greenhouse.io',
      'job-boards.greenhouse.io',
      'jobs.lever.co',
      'jobs.ashbyhq.com',
    ].includes(applicationHost),
  };
}
