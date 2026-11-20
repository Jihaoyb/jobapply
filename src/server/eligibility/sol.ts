import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Span } from './rules.js';

/** Bump with any change to SOL_INSTRUCTIONS or the input/output shape; then re-run replay. */
export const PROMPT_VERSION = 'eligibility-sol-v1';

/** Matches the fallback in configuredModelCaller (src/server/model.ts). */
export function configuredSolModel() {
  return process.env.OPENAI_SOL_MODEL ?? 'gpt-6.1-sol';
}

export const SOL_INSTRUCTIONS = `You screen job-posting or application-form text for work-authorization restrictions that would exclude one applicant.
Applicant: on F-1 OPT and currently authorized to work in the United States; will require H-1B visa sponsorship in the future; not a U.S. citizen; not a permanent resident (no green card); not a "U.S. person" under ITAR/EAR; holds no security clearance.
Decide one of:
- "excluded": the text states a definite requirement this applicant cannot meet: U.S. citizenship or permanent residency required; U.S. person / ITAR / export-control eligibility required; a security clearance (or the ability to obtain one) required; the employer will not sponsor visas now or in the future, or candidates must not need future sponsorship; OPT, CPT or F-1 candidates not accepted.
- "passed": the text does not exclude this applicant: sponsorship is offered, only current work authorization is required, the restriction is only a preference, it is negated, it is a question rather than a requirement, or it does not apply to this role.
- "unclear": the wording is hedged, conditional or conflicting, or you cannot tell whether it bars future sponsorship.
Preference wording ("preferred", "a plus", "nice to have") never excludes. Negated wording ("no clearance required", "citizenship not required") never excludes.
For "excluded" and "unclear", copy the single sentence that supports the decision into "quote" exactly as written in the passages, character for character. Never paraphrase or combine sentences. Use null only when no sentence supports the decision.
Respond only with a JSON object of the form {"decision": "excluded" | "passed" | "unclear", "quote": string | null, "reason": string} where reason is one short sentence.`;

export const solOutput = z.object({
  decision: z.enum(['excluded', 'passed', 'unclear']),
  quote: z.string().max(4000).nullable(),
  reason: z.string().max(1000),
});
export type SolOutput = z.infer<typeof solOutput>;

export function solInput(args: {
  source: 'posting' | 'form';
  employer: string;
  role: string;
  passages: Span[];
}) {
  return JSON.stringify({
    source: args.source,
    employer: args.employer,
    role: args.role,
    passages: args.passages.map((passage) => passage.text),
  });
}

export function promptFingerprint() {
  return createHash('sha256')
    .update(PROMPT_VERSION + '\n' + SOL_INSTRUCTIONS)
    .digest('hex');
}
