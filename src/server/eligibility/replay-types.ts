export interface ReplayFixture {
  id: string;
  tags: string[];
  source: 'posting' | 'form';
  text: string;
  expected: {
    route: 'exclusion_rule' | 'sol' | 'no_trigger';
    decision: 'passed' | 'excluded' | 'review';
    /** Phrase the stored evidence must contain (verbatim in text), or null. */
    quote: string | null;
  };
  /** Scripted Sol answer for the deterministic transport (oracle by default). */
  fakeSol?:
    | { decision: 'excluded' | 'passed' | 'unclear'; quote: string | null }
    | 'invalid_output';
  /** Exercises a failure mode of the fake transport; skipped in live replay. */
  fakeOnly?: boolean;
}

export interface ReplayMetrics {
  total: number;
  expectedByDecision: Record<'passed' | 'excluded' | 'review', number>;
  actualByDecision: Record<'passed' | 'excluded' | 'review', number>;
  /** Expected excluded/review but passed: a restriction slipped through. */
  falseInclusions: string[];
  /** Expected passed/review but excluded: an eligible job was screened out. */
  falseExclusions: string[];
  /** Expected passed/excluded but sent to review (human time, not an error). */
  unexpectedReviews: string[];
  /** Correct decision whose stored evidence lacks the expected quote. */
  quoteMismatches: string[];
  routeMismatches: string[];
  solCalls: number;
  solCallShare: number;
  failedSolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ReplayCost {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  measuredUsd: number;
  /** Mean measured tokens per Sol call priced as if every posting reached Sol. */
  allSolPerPostingUsd: number;
  allSolProjectedPostings: number;
  allSolProjectedUsd: number;
}

export interface ReplayFingerprint {
  promptVersion: string;
  promptFingerprint: string;
  rulesFingerprint: string;
  fixturesSha256: string;
  solModel: string;
}

export interface ReplayBaselineSection extends ReplayFingerprint {
  recordedAt: string;
  metrics: ReplayMetrics;
}

export interface EligibilityBaseline {
  /** Deterministic fake-Sol replay; checked by `npm test`. */
  fake: ReplayBaselineSection | null;
  /** Human-run live replay against the configured Sol model. */
  live: ReplayBaselineSection | null;
}
