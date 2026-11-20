import { z } from 'zod';
import { id } from './contracts.js';

/** Lane C (issue 006) schemas. Contracts v1 stays frozen; these are lane-local. */
export const answerScopes = ['job', 'employer', 'global'] as const;
export type AnswerScope = (typeof answerScopes)[number];
export const answerActions = [
  'answer_once',
  'answer_employer',
  'answer_global',
] as const;
export const actionScope: Record<(typeof answerActions)[number], AnswerScope> =
  {
    answer_once: 'job',
    answer_employer: 'employer',
    answer_global: 'global',
  };
const answerText = z.string().trim().min(1).max(4000);

export const formField = z.object({
  fieldId: z.string().trim().min(1).max(200),
  question: z.string().trim().min(1).max(4000),
  choices: z.array(z.string().trim().min(1).max(1000)).max(100).default([]),
  required: z.boolean().default(true),
});
export type FormField = z.infer<typeof formField>;

export const ticketAnswerInput = z.discriminatedUnion('action', [
  z.object({ action: z.enum(answerActions), answer: answerText }),
  z.object({ action: z.literal('defer') }),
]);
export type TicketAnswerInput = z.infer<typeof ticketAnswerInput>;

export const createAnswerInput = z.object({
  scope: z.enum(['employer', 'global']),
  canonicalEmployerId: id.optional(),
  question: z.string().trim().min(1).max(4000),
  choices: z.array(z.string().trim().min(1).max(1000)).max(100).default([]),
  answer: answerText,
});
export const editAnswerInput = z
  .object({ answer: answerText.optional(), reviewed: z.boolean().optional() })
  .refine((v) => v.answer !== undefined || v.reviewed !== undefined, {
    message: 'Provide an answer or reviewed flag',
  });

export interface SavedAnswer {
  id: string;
  scope: AnswerScope;
  jobId: string | null;
  canonicalEmployerId: string | null;
  employerName: string | null;
  question: string;
  choices: string[];
  answer: string;
  source: 'seed' | 'ticket' | 'dashboard';
  needsReview: boolean;
  updatedAt: string;
}
export interface AnswerAlias {
  id: string;
  answerId: string;
  canonicalEmployerId: string | null;
  question: string;
  answerQuestion: string;
  answer: string;
  status: 'proposed' | 'approved' | 'rejected';
  score: number | null;
}
export interface PendingQuestion {
  ticketId: string;
  sessionId: string;
  fieldId: string;
  question: string;
  choices: string[];
  employer: string;
  role: string;
  canonicalEmployerId: string | null;
  reason: string;
  suggestion: { answer: string; question: string; blockedBy: string[] } | null;
}
