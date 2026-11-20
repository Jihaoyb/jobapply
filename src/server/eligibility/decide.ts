import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Sql } from '../db.js';
import {
  appendEvent,
  HttpError,
  openTicket,
  resolutionInput,
} from '../ledger.js';
import { configuredModelCaller, type ModelRequest } from '../model.js';
import {
  eligibilityTicketDecision,
  type EligibilityTicketDecision,
} from '../../shared/eligibility.js';
import { eligibilityBaseline, type EligibilityBaseline } from './baseline.js';
import {
  evaluateRules,
  quoteHasTrigger,
  rulesFingerprint,
  verifyQuote,
  type Span,
} from './rules.js';
import {
  configuredSolModel,
  PROMPT_VERSION,
  promptFingerprint,
  SOL_INSTRUCTIONS,
  solInput,
  solOutput,
  type SolOutput,
} from './sol.js';

export type EligibilitySource = 'posting' | 'form';
export type CallModel = <T>(request: ModelRequest<T>) => Promise<T>;
export interface EligibilityDeps {
  /** Defaults to configuredModelCaller(db): the single model boundary. */
  callModel?: CallModel;
  /** Model the caller is configured with; checked against the replay gate. */
  solModel?: string;
  /** Only the replay harness may bypass the gate (it is how a change is validated). */
  skipReplayGate?: boolean;
}
export interface EligibilityResult {
  decisionId: string;
  decision: 'passed' | 'excluded' | 'review';
  provenance: 'rule' | 'sol' | 'user';
  route: 'exclusion_rule' | 'sol' | 'no_trigger' | 'user';
  evidence: string | null;
  ruleId: string | null;
  reason: string;
  ticketId: string | null;
  modelCallId: string | null;
}

/** Statuses from which eligibility may run. Lane A decides whether to call at all. */
const RUNNABLE = new Set(['captured', 'eligibility_pending', 'ready']);

export function replayGate(
  solModel = configuredSolModel(),
  baseline: EligibilityBaseline = eligibilityBaseline,
): { ok: boolean; reason: string | null } {
  const current = {
    promptVersion: PROMPT_VERSION,
    promptFingerprint: promptFingerprint(),
    rulesFingerprint: rulesFingerprint(),
  };
  const matches = (section: NonNullable<EligibilityBaseline['fake']>) =>
    section.promptVersion === current.promptVersion &&
    section.promptFingerprint === current.promptFingerprint &&
    section.rulesFingerprint === current.rulesFingerprint;
  if (!baseline.fake || !matches(baseline.fake))
    return {
      ok: false,
      reason: 'Prompt or rules changed since the last recorded replay',
    };
  if (baseline.live) {
    if (!matches(baseline.live))
      return {
        ok: false,
        reason: 'Live replay baseline is stale for this prompt or rules',
      };
    if (baseline.live.solModel !== solModel)
      return {
        ok: false,
        reason: `Sol model ${solModel} has no live replay baseline`,
      };
  } else if (baseline.fake.solModel !== solModel)
    return {
      ok: false,
      reason: `Sol model ${solModel} has no replay baseline`,
    };
  return { ok: true, reason: null };
}

interface Recorded {
  source: EligibilitySource;
  route: EligibilityResult['route'];
  decision: EligibilityResult['decision'];
  provenance: EligibilityResult['provenance'];
  evidence: Span | null;
  ruleId: string | null;
  reason: string;
  rationale: string | null;
  modelCallId: string | null;
  promptVersion: string | null;
  ticketId: string | null;
  sourceText: string;
}

async function record(
  sql: Sql,
  applicantId: string,
  jobId: string,
  input: Recorded,
): Promise<string> {
  const decisionId = randomUUID();
  await sql.query(
    `INSERT INTO eligibility_decisions (id,applicant_id,job_id,source,route,decision,provenance,evidence,evidence_start,evidence_end,rule_id,reason,rationale,model_call_id,prompt_version,ticket_id,source_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      decisionId,
      applicantId,
      jobId,
      input.source,
      input.route,
      input.decision,
      input.provenance,
      input.evidence?.text ?? null,
      input.evidence?.start ?? null,
      input.evidence?.end ?? null,
      input.ruleId,
      input.reason,
      input.rationale,
      input.modelCallId,
      input.promptVersion,
      input.ticketId,
      input.sourceText,
    ],
  );
  await appendEvent(sql, applicantId, jobId, 'eligibility.decided', {
    decision: input.decision,
    provenance: input.provenance,
    evidence: input.evidence?.text ?? null,
  });
  return decisionId;
}

function nextStatus(
  decision: 'passed' | 'excluded',
  current: string,
): string | null {
  if (decision === 'excluded') return 'eligibility_excluded';
  // A passed posting screen makes a captured job ready for form fill; a passed
  // form-revealed restriction leaves the in-progress fill status unchanged.
  return current === 'captured' || current === 'eligibility_pending'
    ? 'ready'
    : null;
}

async function finalize(
  db: Database,
  applicantId: string,
  jobId: string,
  input: Recorded,
): Promise<EligibilityResult> {
  const decisionId = await db.transaction(async (sql) => {
    const job = (
      await sql.query(
        'SELECT status FROM jobs WHERE id=$1 AND applicant_id=$2 FOR UPDATE',
        [jobId, applicantId],
      )
    ).rows[0];
    if (!job) throw new HttpError(404, 'Job not found');
    if (input.decision !== 'review') {
      if (!RUNNABLE.has(job.status))
        throw new HttpError(409, `Job status changed to ${job.status}`);
      const status = nextStatus(input.decision, job.status);
      if (status)
        await sql.query(
          'UPDATE jobs SET status=$3 WHERE id=$1 AND applicant_id=$2',
          [jobId, applicantId, status],
        );
    }
    return record(sql, applicantId, jobId, input);
  });
  return {
    decisionId,
    decision: input.decision,
    provenance: input.provenance,
    route: input.route,
    evidence: input.evidence?.text ?? null,
    ruleId: input.ruleId,
    reason: input.reason,
    ticketId: input.ticketId,
    modelCallId: input.modelCallId,
  };
}

function excerpt(value: string, max = 600) {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

async function review(
  db: Database,
  applicantId: string,
  job: { id: string; employer: string; title: string },
  input: Omit<Recorded, 'decision' | 'ticketId'> & {
    cause: 'eligibility_ambiguity' | 'provider_limit';
    question: string;
  },
): Promise<EligibilityResult> {
  const ticket = await openTicket(db, applicantId, job.id, {
    question: input.question,
    choices: ['passed', 'excluded'],
    employer: job.employer,
    role: job.title,
    cause: input.cause,
    resolveAction:
      input.cause === 'provider_limit'
        ? 'retry_provider'
        : 'decide_eligibility',
  });
  const { cause: _cause, question: _question, ...rest } = input;
  return finalize(db, applicantId, job.id, {
    ...rest,
    decision: 'review',
    ticketId: ticket.id,
  });
}

/**
 * Single eligibility entry point for posting text and form-revealed text.
 * Routes: narrow exclusion rule → Sol (only when a trigger remains) → pass.
 * Every automatic exclusion carries a verbatim quote verified against `text`.
 */
export async function decideEligibility(
  db: Database,
  applicantId: string,
  jobId: string,
  text: string,
  source: EligibilitySource,
  deps: EligibilityDeps = {},
): Promise<EligibilityResult> {
  z.string().trim().min(1).max(150_000).parse(text);
  z.enum(['posting', 'form']).parse(source);
  const job = (
    await db.query(
      'SELECT id,employer,title,status FROM jobs WHERE id=$1 AND applicant_id=$2',
      [jobId, applicantId],
    )
  ).rows[0] as
    { id: string; employer: string; title: string; status: string } | undefined;
  if (!job) throw new HttpError(404, 'Job not found');
  if (!RUNNABLE.has(job.status))
    throw new HttpError(409, `Eligibility cannot run for a ${job.status} job`);

  const base = {
    source,
    sourceText: text,
    rationale: null,
    modelCallId: null,
    promptVersion: null,
  };
  const outcome = evaluateRules(text);
  if (outcome.route === 'exclusion_rule')
    return finalize(db, applicantId, jobId, {
      ...base,
      route: 'exclusion_rule',
      decision: 'excluded',
      provenance: 'rule',
      evidence: outcome.match.sentence,
      ruleId: outcome.match.ruleId,
      reason: 'exclusion_rule',
      ticketId: null,
    });
  if (outcome.route === 'no_trigger')
    return finalize(db, applicantId, jobId, {
      ...base,
      route: 'no_trigger',
      decision: 'passed',
      provenance: 'rule',
      evidence: null,
      ruleId: null,
      reason: 'no_trigger',
      ticketId: null,
    });

  const solModel = deps.solModel ?? configuredSolModel();
  const firstPassage = outcome.passages[0]!;
  if (!deps.skipReplayGate) {
    const gate = replayGate(solModel);
    if (!gate.ok)
      return review(db, applicantId, job, {
        ...base,
        route: 'sol',
        provenance: 'rule',
        evidence: null,
        ruleId: null,
        reason: 'replay_gate',
        cause: 'eligibility_ambiguity',
        question: `Eligibility needs review (${source}); Sol is gated: ${gate.reason}. Re-run the eligibility replay. Passage: “${excerpt(firstPassage.text)}”`,
      });
  }

  const callModel = deps.callModel ?? configuredModelCaller(db);
  const latestCall = async () =>
    (
      (
        await db.query(
          'SELECT id FROM model_calls WHERE applicant_id=$1 AND job_id=$2 AND prompt_version=$3 ORDER BY created_at DESC, id DESC LIMIT 1',
          [applicantId, jobId, PROMPT_VERSION],
        )
      ).rows[0] as { id: string } | undefined
    )?.id ?? null;
  const previousCall = await latestCall();
  let answer: SolOutput | null = null;
  try {
    answer = await callModel({
      applicantId,
      jobId,
      purpose: 'eligibility',
      promptVersion: PROMPT_VERSION,
      instructions: SOL_INSTRUCTIONS,
      input: solInput({
        source,
        employer: job.employer,
        role: job.title,
        passages: outcome.passages,
      }),
      output: solOutput,
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
  }
  // The wrapper records exactly one model_calls row per attempted request (none
  // when OpenAI is not configured). The single worker runs one job at a time.
  const currentCall = await latestCall();
  const modelCallId = currentCall !== previousCall ? currentCall : null;
  const sol = {
    ...base,
    route: 'sol' as const,
    provenance: 'sol' as const,
    ruleId: null,
    modelCallId,
    promptVersion: PROMPT_VERSION,
  };
  if (!answer)
    return review(db, applicantId, job, {
      ...sol,
      evidence: null,
      reason: 'sol_unavailable',
      cause: 'provider_limit',
      question: `Sol could not screen this ${source} text (not configured or the request failed). Retry, or decide manually. Passage: “${excerpt(firstPassage.text)}”`,
    });

  const verified = verifyQuote(text, answer.quote);
  const rationale = answer.reason.slice(0, 1000);
  if (answer.decision === 'excluded') {
    if (verified && quoteHasTrigger(verified.text))
      return finalize(db, applicantId, jobId, {
        ...sol,
        rationale,
        decision: 'excluded',
        evidence: verified,
        reason: 'sol_excluded',
        ticketId: null,
      });
    return review(db, applicantId, job, {
      ...sol,
      rationale,
      evidence: null,
      reason: 'quote_unverified',
      cause: 'eligibility_ambiguity',
      question: `Sol flagged a restriction (${source}) but its quote was not found verbatim in the source. Review the passage: “${excerpt(firstPassage.text)}”`,
    });
  }
  if (answer.decision === 'unclear')
    return review(db, applicantId, job, {
      ...sol,
      rationale,
      evidence: verified,
      reason: 'sol_unclear',
      cause: 'eligibility_ambiguity',
      question: `Is this restriction compatible with F-1 OPT now and H-1B sponsorship later? (${source}) “${excerpt(verified?.text ?? firstPassage.text)}”`,
    });
  return finalize(db, applicantId, jobId, {
    ...sol,
    rationale,
    decision: 'passed',
    evidence: verified,
    reason: 'sol_passed',
    ticketId: null,
  });
}

async function eligibilityTicket(
  sql: Sql,
  applicantId: string,
  ticketId: string,
) {
  const ticket = (
    await sql.query(
      'SELECT * FROM tickets WHERE id=$1 AND applicant_id=$2 FOR UPDATE',
      [ticketId, applicantId],
    )
  ).rows[0];
  if (!ticket) throw new HttpError(404, 'Ticket not found');
  if (ticket.status !== 'open')
    throw new HttpError(409, 'Ticket already resolved');
  const origin = (
    await sql.query(
      "SELECT * FROM eligibility_decisions WHERE ticket_id=$1 AND applicant_id=$2 AND decision='review' ORDER BY created_at DESC LIMIT 1",
      [ticketId, applicantId],
    )
  ).rows[0];
  if (!origin) throw new HttpError(409, 'Not an eligibility ticket');
  return { ticket, origin };
}

/** Domain handler for decide_eligibility (and manual decisions on Sol outages). */
export async function resolveEligibilityTicket(
  db: Database,
  applicantId: string,
  ticketId: string,
  raw: EligibilityTicketDecision,
): Promise<EligibilityResult> {
  const input = eligibilityTicketDecision.parse(raw);
  const resolution = resolutionInput.parse({
    outcome: 'approved',
    value: input.note ? `${input.decision}: ${input.note}` : input.decision,
  });
  return db.transaction(async (sql) => {
    const { ticket, origin } = await eligibilityTicket(
      sql,
      applicantId,
      ticketId,
    );
    await sql.query(
      "UPDATE tickets SET status='resolved',closed_at=now(),resolution=$3 WHERE id=$1 AND applicant_id=$2",
      [ticketId, applicantId, JSON.stringify(resolution)],
    );
    const status =
      input.decision === 'excluded'
        ? 'eligibility_excluded'
        : ['captured', 'eligibility_pending'].includes(ticket.resume_status)
          ? 'ready'
          : ticket.resume_status;
    await sql.query(
      'UPDATE jobs SET status=$3 WHERE id=$1 AND applicant_id=$2',
      [ticket.job_id, applicantId, status],
    );
    await appendEvent(sql, applicantId, ticket.job_id, 'pause.closed', {
      pauseId: ticket.pause_id,
      ticketId,
      cause: ticket.cause,
      outcome: resolution.outcome,
    });
    const evidence: Span | null =
      origin.evidence === null
        ? null
        : {
            start: origin.evidence_start,
            end: origin.evidence_end,
            text: origin.evidence,
          };
    const decisionId = await record(sql, applicantId, ticket.job_id, {
      source: origin.source,
      route: 'user',
      decision: input.decision,
      provenance: 'user',
      evidence,
      ruleId: null,
      reason: 'user_decision',
      rationale: input.note ?? null,
      modelCallId: null,
      promptVersion: null,
      ticketId,
      sourceText: origin.source_text,
    });
    return {
      decisionId,
      decision: input.decision,
      provenance: 'user' as const,
      route: 'user' as const,
      evidence: evidence?.text ?? null,
      ruleId: null,
      reason: 'user_decision',
      ticketId,
      modelCallId: null,
    };
  });
}

/** Domain handler for retry_provider on an eligibility Sol outage ticket. */
export async function retryEligibilityTicket(
  db: Database,
  applicantId: string,
  ticketId: string,
  deps: EligibilityDeps = {},
): Promise<EligibilityResult> {
  const origin = await db.transaction(async (sql) => {
    const { ticket, origin } = await eligibilityTicket(
      sql,
      applicantId,
      ticketId,
    );
    if (ticket.cause !== 'provider_limit')
      throw new HttpError(409, 'Only a Sol outage ticket can be retried');
    await sql.query(
      "UPDATE tickets SET status='resolved',closed_at=now(),resolution=$3 WHERE id=$1 AND applicant_id=$2",
      [
        ticketId,
        applicantId,
        JSON.stringify({ outcome: 'no_change', value: 'retry_provider' }),
      ],
    );
    await sql.query(
      'UPDATE jobs SET status=$3 WHERE id=$1 AND applicant_id=$2',
      [ticket.job_id, applicantId, ticket.resume_status],
    );
    await appendEvent(sql, applicantId, ticket.job_id, 'pause.closed', {
      pauseId: ticket.pause_id,
      ticketId,
      cause: ticket.cause,
      outcome: 'no_change',
    });
    return origin;
  });
  return decideEligibility(
    db,
    applicantId,
    origin.job_id,
    origin.source_text,
    origin.source,
    deps,
  );
}
