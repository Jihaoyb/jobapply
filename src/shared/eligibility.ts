import { z } from 'zod';

/** Lane B (issue 005) API shapes. Contract v1 event/status names are unchanged. */
export const eligibilityDecisions = ['passed', 'excluded', 'review'] as const;
export const eligibilityRoutes = [
  'exclusion_rule',
  'sol',
  'no_trigger',
  'user',
] as const;

export const eligibilityTicketDecision = z.object({
  decision: z.enum(['passed', 'excluded']),
  note: z.string().trim().max(2000).optional(),
});
export type EligibilityTicketDecision = z.infer<
  typeof eligibilityTicketDecision
>;

export interface EligibilityView {
  decisionId: string;
  jobId: string;
  title: string;
  employer: string;
  jobStatus: string;
  source: 'posting' | 'form';
  route: (typeof eligibilityRoutes)[number];
  decision: (typeof eligibilityDecisions)[number];
  provenance: 'rule' | 'sol' | 'user';
  evidence: string | null;
  ruleId: string | null;
  reason: string;
  rationale: string | null;
  model: string | null;
  promptVersion: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  ticketId: string | null;
  ticketOpen: boolean;
  ticketCause: string | null;
  createdAt: string;
}

export interface EligibilityGateView {
  ok: boolean;
  reason: string | null;
  solModel: string;
  promptVersion: string;
}
