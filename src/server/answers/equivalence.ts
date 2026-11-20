import { z } from 'zod';
import type { ModelRequest } from '../model.js';
import { guardMismatches, matchChoice, normalizeChoice } from './normalize.js';

export const EQUIVALENCE_PROMPT_VERSION = 'answer-equivalence-v1';
/**
 * Placeholder until the human-run live calibration (`npm run answers:calibrate -- --live`)
 * picks a validated value; override with ANSWER_EQUIVALENCE_THRESHOLD.
 */
export const DEFAULT_EQUIVALENCE_THRESHOLD = 0.85;
export function configuredThreshold(): number {
  const raw = Number(process.env.ANSWER_EQUIVALENCE_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 && raw <= 1
    ? raw
    : DEFAULT_EQUIVALENCE_THRESHOLD;
}
export type CallModel = <T>(request: ModelRequest<T>) => Promise<T>;

export const judgmentSchema = z.object({
  candidateId: z.string(),
  equivalent: z.boolean(),
  score: z.number().min(0).max(1),
  samePolarity: z.boolean(),
  sameTimeHorizon: z.boolean(),
  sameLocation: z.boolean(),
  ambiguous: z.boolean(),
});
export type Judgment = z.infer<typeof judgmentSchema>;
const outputSchema = z.object({ judgments: z.array(judgmentSchema).max(50) });

export const EQUIVALENCE_INSTRUCTIONS = `You compare a job application question with previously approved questions.
For each candidate decide whether an answer approved for the candidate can be reused verbatim for the new question.
They are equivalent only if they ask for the same fact with the same polarity (e.g. "require sponsorship" vs "work without sponsorship" differ),
the same time horizon (now, in the future, or both), the same location or jurisdiction, and no other material qualifier changes the answer
(hourly vs annual, active vs obtainable clearance, specific numbers). If wording is unclear or you are unsure, set ambiguous=true.
Return JSON only: {"judgments":[{"candidateId":string,"equivalent":boolean,"score":number between 0 and 1,"samePolarity":boolean,"sameTimeHorizon":boolean,"sameLocation":boolean,"ambiguous":boolean}]} with one entry per candidate.`;

export interface Candidate {
  answerId: string;
  question: string;
  answer: string;
  scope: 'job' | 'employer' | 'global';
}
/** One Luna call through the shared model wrapper. Answers are never sent, only questions. */
export async function judgeCandidates(
  callModel: CallModel,
  owner: { applicantId: string; jobId: string },
  question: string,
  choices: string[],
  candidates: { question: string }[],
): Promise<(Judgment | null)[]> {
  const ids = candidates.map((_, index) => `c${index + 1}`);
  const result = await callModel({
    ...owner,
    purpose: 'answer_equivalence',
    promptVersion: EQUIVALENCE_PROMPT_VERSION,
    instructions: EQUIVALENCE_INSTRUCTIONS,
    input: JSON.stringify({
      question,
      choices,
      candidates: candidates.map((c, index) => ({
        candidateId: ids[index],
        question: c.question,
      })),
    }),
    output: outputSchema,
  });
  // Missing or duplicated judgments count as "not equivalent" rather than guessing.
  return ids.map((candidateId) => {
    const found = result.judgments.filter((j) => j.candidateId === candidateId);
    return found.length === 1 ? found[0]! : null;
  });
}

export interface PairDecision {
  accepted: boolean;
  highScore: boolean;
  blockedBy: string[];
}
/** The reuse rule for one candidate: high score, Luna agreement, deterministic guards, choices. */
export function decidePair(
  stored: { question: string; answer?: string },
  asked: { question: string; choices?: string[] },
  judgment: Judgment | null,
  threshold: number,
): PairDecision {
  const highScore =
    !!judgment && judgment.equivalent && judgment.score >= threshold;
  const blockedBy = guardMismatches(stored.question, asked.question);
  if (judgment) {
    if (!judgment.samePolarity && !blockedBy.includes('polarity'))
      blockedBy.push('polarity');
    if (!judgment.sameTimeHorizon && !blockedBy.includes('time_horizon'))
      blockedBy.push('time_horizon');
    if (!judgment.sameLocation && !blockedBy.includes('location'))
      blockedBy.push('location');
    if (judgment.ambiguous) blockedBy.push('ambiguous');
  }
  if (
    stored.answer !== undefined &&
    matchChoice(stored.answer, asked.choices ?? []) === null
  )
    blockedBy.push('choices');
  return { accepted: highScore && !blockedBy.length, highScore, blockedBy };
}

const scopeRank = { job: 0, employer: 1, global: 2 } as const;
export type Selection =
  | { kind: 'accept'; candidate: Candidate; score: number; value: string }
  | {
      kind: 'pause';
      reason: 'no_match' | 'qualifier_mismatch' | 'multiple_matches';
      suggestion: { candidate: Candidate; blockedBy: string[] } | null;
    };
/**
 * Reuse requires exactly one equivalent answer above threshold that passes every guard.
 * Several accepted candidates are fine only if they map to the same choice. A high-scoring
 * candidate that fails a guard pauses (ambiguity despite a high score).
 */
export function selectCandidate(
  asked: { question: string; choices: string[] },
  candidates: Candidate[],
  judgments: (Judgment | null)[],
  threshold: number,
): Selection {
  const decisions = candidates.map((candidate, index) => ({
    candidate,
    judgment: judgments[index] ?? null,
    ...decidePair(candidate, asked, judgments[index] ?? null, threshold),
  }));
  const accepted = decisions
    .filter((d) => d.accepted)
    .sort(
      (a, b) =>
        scopeRank[a.candidate.scope] - scopeRank[b.candidate.scope] ||
        b.judgment!.score - a.judgment!.score,
    );
  if (accepted.length) {
    const values = new Set(
      accepted.map((d) =>
        normalizeChoice(matchChoice(d.candidate.answer, asked.choices)!),
      ),
    );
    const best = accepted[0]!;
    if (values.size === 1)
      return {
        kind: 'accept',
        candidate: best.candidate,
        score: best.judgment!.score,
        value: matchChoice(best.candidate.answer, asked.choices)!,
      };
    return {
      kind: 'pause',
      reason: 'multiple_matches',
      suggestion: {
        candidate: best.candidate,
        blockedBy: ['multiple_matches'],
      },
    };
  }
  const high = decisions
    .filter((d) => d.highScore)
    .sort((a, b) => b.judgment!.score - a.judgment!.score)[0];
  if (high)
    return {
      kind: 'pause',
      reason: 'qualifier_mismatch',
      suggestion: { candidate: high.candidate, blockedBy: high.blockedBy },
    };
  return { kind: 'pause', reason: 'no_match', suggestion: null };
}
