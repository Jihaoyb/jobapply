import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Sql } from '../db.js';
import {
  closeTicketTx,
  findOpenTicket,
  HttpError,
  isOpenTicketConflict,
  lockOpenTicketTx,
  openTicketTx,
} from '../ledger.js';
import {
  actionScope,
  formField,
  ticketAnswerInput,
  type FormField,
  type PendingQuestion,
  type TicketAnswerInput,
} from '../../shared/answers.js';
import { answersInScope, proposeAlias, upsertAnswer } from './bank.js';
import {
  configuredThreshold,
  judgeCandidates,
  selectCandidate,
  type CallModel,
  type Candidate,
} from './equivalence.js';
import { matchChoice, normalizeQuestion } from './normalize.js';

export interface AnswerDeps {
  /** The shared wrapper (configuredModelCaller). Absent means Luna is not configured. */
  callModel?: CallModel;
  threshold?: number;
}
export type Tier = 'exact' | 'alias' | 'luna' | 'ticket' | 'skipped';
export interface FieldAnswer {
  value: string | null;
  tier: Tier;
  answerId: string | null;
  score?: number;
  ticketId?: string;
}
export type FieldResolution =
  | { status: 'answered'; answer: FieldAnswer }
  | {
      status: 'needs_answer';
      reason: string;
      suggestion: PendingQuestion['suggestion'];
    };

const scopeRank: Record<string, number> = { job: 0, employer: 1, global: 2 };
const MAX_CANDIDATES = 10;
const stopwords = new Set(
  'a an the you your are is do does did to of in for be will would can could have has with or and on at as this that what please'.split(
    ' ',
  ),
);
function overlap(a: string, b: string) {
  const set = (s: string) =>
    new Set(
      normalizeQuestion(s)
        .split(' ')
        .filter((w) => w && !stopwords.has(w)),
    );
  const x = set(a),
    y = set(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.max(1, new Set([...x, ...y]).size);
}

/** Tiers: scoped exact match → approved alias → guarded Luna equivalence. */
export async function resolveField(
  db: Database,
  deps: AnswerDeps,
  ctx: { applicantId: string; jobId: string; employerId: string | null },
  field: FormField,
): Promise<FieldResolution> {
  const normalized = normalizeQuestion(field.question);
  const rows = (
    await answersInScope(db, ctx.applicantId, ctx.jobId, ctx.employerId)
  ).sort((a, b) => scopeRank[a.scope]! - scopeRank[b.scope]!);
  const exact = rows.filter((row) => row.normalized_question === normalized);
  for (const row of exact) {
    const value = matchChoice(row.answer, field.choices);
    if (value !== null)
      return {
        status: 'answered',
        answer: { value, tier: 'exact', answerId: row.id },
      };
  }
  if (exact.length)
    return {
      status: 'needs_answer',
      reason: 'choices_incompatible',
      suggestion: {
        answer: exact[0].answer,
        question: exact[0].question,
        blockedBy: ['choices'],
      },
    };
  const aliases = (
    await db.query(
      `SELECT answer_id, canonical_employer_id FROM answer_aliases WHERE applicant_id=$1 AND status='approved'
       AND normalized_question=$2 AND (canonical_employer_id IS NULL OR canonical_employer_id=$3::uuid)`,
      [ctx.applicantId, normalized, ctx.employerId],
    )
  ).rows.sort(
    (a, b) =>
      Number(b.canonical_employer_id !== null) -
      Number(a.canonical_employer_id !== null),
  );
  for (const alias of aliases) {
    const row = rows.find((r) => r.id === alias.answer_id);
    const value = row ? matchChoice(row.answer, field.choices) : null;
    if (row && value !== null)
      return {
        status: 'answered',
        answer: { value, tier: 'alias', answerId: row.id },
      };
  }
  // One candidate per normalized question, keeping the most specific scope.
  const seen = new Set<string>();
  const candidates: Candidate[] = rows
    .filter((row) => {
      if (seen.has(row.normalized_question)) return false;
      seen.add(row.normalized_question);
      return true;
    })
    .map((row) => ({
      answerId: row.id,
      question: row.question,
      answer: row.answer,
      scope: row.scope,
    }))
    .sort(
      (a, b) =>
        overlap(b.question, field.question) -
        overlap(a.question, field.question),
    )
    .slice(0, MAX_CANDIDATES);
  if (!candidates.length)
    return {
      status: 'needs_answer',
      reason: 'no_saved_answer',
      suggestion: null,
    };
  if (!deps.callModel)
    return {
      status: 'needs_answer',
      reason: 'luna_not_configured',
      suggestion: null,
    };
  let judgments;
  try {
    judgments = await judgeCandidates(
      deps.callModel,
      { applicantId: ctx.applicantId, jobId: ctx.jobId },
      field.question,
      field.choices,
      candidates,
    );
  } catch {
    // The wrapper already recorded the failed call; ask the applicant instead of guessing.
    return { status: 'needs_answer', reason: 'luna_failed', suggestion: null };
  }
  const selection = selectCandidate(
    field,
    candidates,
    judgments,
    deps.threshold ?? configuredThreshold(),
  );
  if (selection.kind === 'accept') {
    if (selection.candidate.scope !== 'job')
      await proposeAlias(db, ctx.applicantId, {
        answerId: selection.candidate.answerId,
        canonicalEmployerId: ctx.employerId,
        question: field.question,
        score: selection.score,
      });
    return {
      status: 'answered',
      answer: {
        value: selection.value,
        tier: 'luna',
        answerId: selection.candidate.answerId,
        score: selection.score,
      },
    };
  }
  return {
    status: 'needs_answer',
    reason: selection.reason,
    suggestion: selection.suggestion && {
      answer: selection.suggestion.candidate.answer,
      question: selection.suggestion.candidate.question,
      blockedBy: selection.suggestion.blockedBy,
    },
  };
}

export interface SessionState {
  sessionId: string;
  jobId: string;
  status: 'running' | 'paused' | 'completed' | 'deferred';
  /** Index of the field the form must resume at. */
  resumeIndex: number;
  pausedFieldId: string | null;
  ticketId: string | null;
  answers: Record<string, FieldAnswer>;
  /**
   * Set when the session could not pause because another lane's ticket is open on the job
   * (one open ticket per job). The session stays `running` at `resumeIndex`; advance it again
   * after that ticket closes.
   */
  blockedByTicketId?: string;
}
function stateFromRow(row: any): SessionState {
  return {
    sessionId: row.id,
    jobId: row.job_id,
    status: row.status,
    resumeIndex: row.resume_index,
    pausedFieldId: row.paused_field_id,
    ticketId: row.ticket_id,
    answers: row.resolved,
  };
}

/** Creates the resumable state for one form; 007 binds `fields` to real inputs. */
export async function startFieldSession(
  db: Database,
  applicantId: string,
  jobId: string,
  rawFields: z.input<typeof formField>[],
): Promise<SessionState> {
  const fields = z.array(formField).min(1).max(200).parse(rawFields);
  if (new Set(fields.map((f) => f.fieldId)).size !== fields.length)
    throw new HttpError(400, 'Field IDs must be unique');
  const job = await db.query(
    'SELECT id FROM jobs WHERE id=$1 AND applicant_id=$2',
    [jobId, applicantId],
  );
  if (!job.rows.length) throw new HttpError(404, 'Job not found');
  const row = (
    await db.query(
      `INSERT INTO answer_sessions (id,applicant_id,job_id,fields,status) VALUES ($1,$2,$3,$4,'running') RETURNING *`,
      [randomUUID(), applicantId, jobId, JSON.stringify(fields)],
    )
  ).rows[0];
  return stateFromRow(row);
}

async function loadSession(sql: Sql, applicantId: string, sessionId: string) {
  const row = (
    await sql.query(
      'SELECT * FROM answer_sessions WHERE id=$1 AND applicant_id=$2',
      [sessionId, applicantId],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, 'Session not found');
  return row;
}

/**
 * Resolves fields from the resume pointer onward. A required field without a reusable
 * answer opens an unanswered_question ticket and pauses at exactly that field.
 */
export async function advanceFieldSession(
  db: Database,
  deps: AnswerDeps,
  applicantId: string,
  sessionId: string,
): Promise<SessionState> {
  let row = await loadSession(db, applicantId, sessionId);
  if (row.status !== 'running') return stateFromRow(row);
  // One open ticket per job: wait for another lane's pause before any Luna call.
  const blocking = await findOpenTicket(db, applicantId, row.job_id);
  if (blocking) return { ...stateFromRow(row), blockedByTicketId: blocking.id };
  const job = (
    await db.query('SELECT * FROM jobs WHERE id=$1 AND applicant_id=$2', [
      row.job_id,
      applicantId,
    ])
  ).rows[0];
  const fields: FormField[] = row.fields;
  const resolved: Record<string, FieldAnswer> = { ...row.resolved };
  let index: number = row.resume_index;
  for (; index < fields.length; index++) {
    const field = fields[index]!;
    if (resolved[field.fieldId]) continue;
    const result = await resolveField(
      db,
      deps,
      {
        applicantId,
        jobId: job.id,
        employerId: job.canonical_employer_id,
      },
      field,
    );
    if (result.status === 'answered') {
      resolved[field.fieldId] = result.answer;
    } else if (!field.required) {
      resolved[field.fieldId] = {
        value: null,
        tier: 'skipped',
        answerId: null,
      };
    } else {
      let paused;
      try {
        paused = await db.transaction(async (sql) => {
          const ticket = await openTicketTx(sql, applicantId, job.id, {
            question: field.question,
            choices: field.choices,
            employer: job.employer,
            role: job.title,
            cause: 'unanswered_question',
            resolveAction: 'answer_once',
          });
          return (
            await sql.query(
              `UPDATE answer_sessions SET status='paused', resume_index=$3, resolved=$4, paused_field_id=$5,
             ticket_id=$6, pause_detail=$7, updated_at=now() WHERE id=$1 AND applicant_id=$2 AND status='running' RETURNING *`,
              [
                sessionId,
                applicantId,
                index,
                JSON.stringify(resolved),
                field.fieldId,
                ticket.id,
                JSON.stringify({
                  reason: result.reason,
                  suggestion: result.suggestion,
                }),
              ],
            )
          ).rows[0];
        });
      } catch (error) {
        if (!isOpenTicketConflict(error)) throw error;
        // Another lane paused the job meanwhile: keep progress, stay running at this field.
        row = (
          await db.query(
            'UPDATE answer_sessions SET resume_index=$3, resolved=$4, updated_at=now() WHERE id=$1 AND applicant_id=$2 RETURNING *',
            [sessionId, applicantId, index, JSON.stringify(resolved)],
          )
        ).rows[0];
        const blocker = await findOpenTicket(db, applicantId, job.id);
        return { ...stateFromRow(row), blockedByTicketId: blocker?.id };
      }
      if (!paused) throw new HttpError(409, 'Session changed while resolving');
      return stateFromRow(paused);
    }
    // Persist progress per field so a worker restart resumes at the same place.
    await db.query(
      'UPDATE answer_sessions SET resume_index=$3, resolved=$4, updated_at=now() WHERE id=$1 AND applicant_id=$2',
      [sessionId, applicantId, index, JSON.stringify(resolved)],
    );
  }
  row = (
    await db.query(
      `UPDATE answer_sessions SET status='completed', resume_index=$3, resolved=$4, updated_at=now()
       WHERE id=$1 AND applicant_id=$2 RETURNING *`,
      [sessionId, applicantId, fields.length, JSON.stringify(resolved)],
    )
  ).rows[0];
  return stateFromRow(row);
}

export async function getFieldSession(
  db: Database,
  applicantId: string,
  sessionId: string,
) {
  return stateFromRow(await loadSession(db, applicantId, sessionId));
}

/**
 * Domain handler for unanswered_question tickets: saves the answer at the chosen scope,
 * records it for exactly the paused field, closes the ticket/pause and restores the job
 * status in one transaction. Defer closes the pause and defers the position.
 */
export async function resolveAnswerTicket(
  db: Database,
  applicantId: string,
  ticketId: string,
  raw: TicketAnswerInput,
) {
  const input = ticketAnswerInput.parse(raw);
  return db.transaction(async (sql) => {
    const ticket = await lockOpenTicketTx(sql, applicantId, ticketId);
    // Outreach review tickets share the cause (v1 has no review cause) but not the action.
    if (
      ticket.cause !== 'unanswered_question' ||
      !['answer_once', 'answer_employer', 'answer_global'].includes(
        ticket.resolve_action,
      )
    )
      throw new HttpError(409, 'Not an unanswered question ticket');
    const session = (
      await sql.query(
        'SELECT * FROM answer_sessions WHERE ticket_id=$1 AND applicant_id=$2 FOR UPDATE',
        [ticketId, applicantId],
      )
    ).rows[0];
    const job = (
      await sql.query(
        'SELECT * FROM jobs WHERE id=$1 AND applicant_id=$2 FOR UPDATE',
        [ticket.job_id, applicantId],
      )
    ).rows[0];
    let answerId: string | null = null,
      value: string | null = null;
    const outcome = input.action === 'defer' ? 'deferred' : 'approved';
    if (input.action !== 'defer') {
      value = matchChoice(input.answer, ticket.choices);
      if (value === null)
        throw new HttpError(400, 'Answer must be one of the offered choices');
      const scope = actionScope[input.action];
      if (scope === 'employer' && !job.canonical_employer_id)
        throw new HttpError(
          409,
          'Employer identity is unresolved; answer once or save globally',
        );
      answerId = await upsertAnswer(sql, applicantId, {
        scope,
        jobId: job.id,
        canonicalEmployerId: job.canonical_employer_id,
        question: ticket.question,
        choices: ticket.choices,
        answer: value,
        source: 'ticket',
      });
    }
    if (session) {
      const resolved = { ...session.resolved };
      if (value !== null)
        resolved[session.paused_field_id] = {
          value,
          tier: 'ticket',
          answerId,
          ticketId,
        };
      await sql.query(
        `UPDATE answer_sessions SET status=$3, resolved=$4, ticket_id=NULL, paused_field_id=NULL,
         pause_detail=NULL, updated_at=now() WHERE id=$1 AND applicant_id=$2`,
        [
          session.id,
          applicantId,
          value === null ? 'deferred' : 'running',
          JSON.stringify(resolved),
        ],
      );
    }
    await closeTicketTx(
      sql,
      applicantId,
      ticket,
      {
        outcome,
        value: JSON.stringify({
          action: input.action,
          answerId,
          fieldId: session?.paused_field_id ?? null,
        }),
      },
      value === null ? 'deferred' : ticket.resume_status,
    );
    return {
      resolved: true,
      answerId,
      value,
      sessionId: session?.id ?? null,
      fieldId: session?.paused_field_id ?? null,
    };
  });
}

/** Open unanswered-question tickets with the exact field, choices, employer and role. */
export async function pendingQuestions(
  db: Database,
  applicantId: string,
): Promise<PendingQuestion[]> {
  const rows = (
    await db.query(
      `SELECT t.*, s.id AS session_id, s.paused_field_id, s.pause_detail, j.canonical_employer_id
       FROM tickets t JOIN answer_sessions s ON s.ticket_id=t.id AND s.applicant_id=t.applicant_id
       JOIN jobs j ON j.id=t.job_id AND j.applicant_id=t.applicant_id
       WHERE t.applicant_id=$1 AND t.status='open' AND t.cause='unanswered_question' ORDER BY t.opened_at`,
      [applicantId],
    )
  ).rows;
  return rows.map((row) => ({
    ticketId: row.id,
    sessionId: row.session_id,
    fieldId: row.paused_field_id,
    question: row.question,
    choices: row.choices,
    employer: row.employer,
    role: row.role,
    canonicalEmployerId: row.canonical_employer_id,
    reason: row.pause_detail?.reason ?? 'unknown',
    suggestion: row.pause_detail?.suggestion ?? null,
  }));
}
