import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import { captureJob } from '../ledger.js';
import { modelCaller } from '../model.js';
import { decideEligibility, type CallModel } from './decide.js';
import type {
  ReplayBaselineSection,
  ReplayCost,
  ReplayFixture,
  ReplayMetrics,
} from './replay-types.js';
import { rulesFingerprint } from './rules.js';
import { PROMPT_VERSION, promptFingerprint } from './sol.js';

export interface ReplayCase {
  id: string;
  expected: ReplayFixture['expected'];
  actual: {
    route: string;
    decision: 'passed' | 'excluded' | 'review';
    evidence: string | null;
    reason: string;
  };
}
export interface ReplayReport {
  mode: 'fake' | 'live';
  solModel: string;
  cases: ReplayCase[];
  metrics: ReplayMetrics;
  cost: ReplayCost | null;
}

/** Hash of the parsed fixtures, so reformatting the JSON file does not change it. */
export function fixturesSha256(raw: string) {
  const { fixtures } = JSON.parse(raw) as { fixtures: ReplayFixture[] };
  return createHash('sha256').update(JSON.stringify(fixtures)).digest('hex');
}

/**
 * Deterministic Sol transport for tests and `--fake`: answers with the fixture's
 * scripted reply (or its label) and reports tokens estimated at 4 chars/token.
 */
export function fakeSolTransport(fixture: ReplayFixture): typeof fetch {
  return (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const scripted = fixture.fakeSol;
    const text =
      scripted === 'invalid_output'
        ? '{"decision":"maybe"}'
        : JSON.stringify({
            decision:
              scripted?.decision ??
              (fixture.expected.decision === 'review'
                ? 'unclear'
                : fixture.expected.decision),
            quote: scripted ? scripted.quote : fixture.expected.quote,
            reason: 'Deterministic replay fixture answer.',
          });
    return Response.json({
      status: 'completed',
      model: body.model,
      usage: {
        input_tokens: Math.ceil(
          (String(body.instructions).length + String(body.input).length) / 4,
        ),
        output_tokens: Math.ceil(text.length / 4),
      },
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    });
  }) as typeof fetch;
}

export async function runReplay(options: {
  db: Database;
  applicantId: string;
  fixtures: ReplayFixture[];
  mode: 'fake' | 'live';
  solModel: string;
  /** Live: one configured caller. Fake: built per fixture from fakeSolTransport. */
  callModel?: CallModel;
  rates?: { inputUsdPerMTok: number; outputUsdPerMTok: number };
  projectedPostings?: number;
}): Promise<ReplayReport> {
  const { db, applicantId, mode, solModel } = options;
  const fixtures = options.fixtures.filter(
    (fixture) => mode === 'fake' || !fixture.fakeOnly,
  );
  const cases: ReplayCase[] = [];
  const jobIds: string[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    const job = await captureJob(
      db,
      applicantId,
      {
        clientCaptureId: randomUUID(),
        title: `Replay role ${fixture.id}`,
        employer: `Replay Employer ${String(index + 1).padStart(2, '0')}`,
        discoveryUrl: `https://jobs.example.com/replay/${fixture.id}`,
        applicationUrl: `https://apply.example.com/replay/${fixture.id}`,
        postingText: fixture.text,
      },
      'manual',
    );
    jobIds.push(job.id);
    const callModel =
      mode === 'fake'
        ? modelCaller(
            db,
            { apiKey: 'fake-replay-key', solModel, lunaModel: 'unused' },
            fakeSolTransport(fixture),
          )
        : options.callModel;
    if (!callModel) throw new Error('Live replay needs a model caller');
    const result = await decideEligibility(
      db,
      applicantId,
      job.id,
      fixture.text,
      fixture.source,
      { callModel, solModel, skipReplayGate: true },
    );
    cases.push({
      id: fixture.id,
      expected: fixture.expected,
      actual: {
        route: result.route,
        decision: result.decision,
        evidence: result.evidence,
        reason: result.reason,
      },
    });
  }
  const calls = (
    await db.query(
      'SELECT status,input_tokens,output_tokens FROM model_calls WHERE applicant_id=$1 AND job_id = ANY($2::uuid[])',
      [applicantId, jobIds],
    )
  ).rows;
  const count = (decision: string, key: 'expected' | 'actual') =>
    cases.filter((c) => c[key].decision === decision).length;
  const inputTokens = calls.reduce((n, c) => n + (c.input_tokens ?? 0), 0);
  const outputTokens = calls.reduce((n, c) => n + (c.output_tokens ?? 0), 0);
  const metrics: ReplayMetrics = {
    total: cases.length,
    expectedByDecision: {
      passed: count('passed', 'expected'),
      excluded: count('excluded', 'expected'),
      review: count('review', 'expected'),
    },
    actualByDecision: {
      passed: count('passed', 'actual'),
      excluded: count('excluded', 'actual'),
      review: count('review', 'actual'),
    },
    falseInclusions: cases
      .filter(
        (c) =>
          c.actual.decision === 'passed' && c.expected.decision !== 'passed',
      )
      .map((c) => c.id),
    falseExclusions: cases
      .filter(
        (c) =>
          c.actual.decision === 'excluded' &&
          c.expected.decision !== 'excluded',
      )
      .map((c) => c.id),
    unexpectedReviews: cases
      .filter(
        (c) =>
          c.actual.decision === 'review' && c.expected.decision !== 'review',
      )
      .map((c) => c.id),
    quoteMismatches: cases
      .filter(
        (c) =>
          c.actual.decision === c.expected.decision &&
          c.expected.quote !== null &&
          c.expected.decision !== 'passed' &&
          !(c.actual.evidence ?? '').includes(c.expected.quote),
      )
      .map((c) => c.id),
    routeMismatches: cases
      .filter((c) => c.actual.route !== c.expected.route)
      .map((c) => c.id),
    solCalls: calls.length,
    solCallShare: cases.length
      ? Number((calls.length / cases.length).toFixed(4))
      : 0,
    failedSolCalls: calls.filter((c) => c.status === 'failed').length,
    inputTokens,
    outputTokens,
  };
  let cost: ReplayCost | null = null;
  if (options.rates) {
    const { inputUsdPerMTok, outputUsdPerMTok } = options.rates;
    const price = (input: number, output: number) =>
      (input * inputUsdPerMTok + output * outputUsdPerMTok) / 1_000_000;
    const perPosting = calls.length
      ? price(inputTokens / calls.length, outputTokens / calls.length)
      : 0;
    const projected = options.projectedPostings ?? cases.length;
    cost = {
      inputUsdPerMTok,
      outputUsdPerMTok,
      measuredUsd: round(price(inputTokens, outputTokens)),
      allSolPerPostingUsd: round(perPosting),
      allSolProjectedPostings: projected,
      allSolProjectedUsd: round(perPosting * projected),
    };
  }
  return { mode, solModel, cases, metrics, cost };
}

function round(value: number) {
  return Number(value.toFixed(6));
}

export function baselineSection(
  report: ReplayReport,
  rawFixtures: string,
  recordedAt = new Date().toISOString(),
): ReplayBaselineSection {
  return {
    promptVersion: PROMPT_VERSION,
    promptFingerprint: promptFingerprint(),
    rulesFingerprint: rulesFingerprint(),
    fixturesSha256: fixturesSha256(rawFixtures),
    solModel: report.solModel,
    recordedAt,
    metrics: report.metrics,
  };
}
