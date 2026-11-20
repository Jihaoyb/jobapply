import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import { HttpError } from '../ledger.js';
import type {
  AnswerAlias,
  AnswerScope,
  SavedAnswer,
} from '../../shared/answers.js';
import { normalizeQuestion, questionKey } from './normalize.js';
import { profileSeedAnswers } from './seed.js';

export function answerFromRow(row: any): SavedAnswer {
  return {
    id: row.id,
    scope: row.scope,
    jobId: row.job_id,
    canonicalEmployerId: row.canonical_employer_id,
    employerName: row.employer_name ?? null,
    question: row.question,
    choices: row.choices,
    answer: row.answer,
    source: row.source,
    needsReview: row.needs_review,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const conflictTarget: Record<AnswerScope, string> = {
  job: "(applicant_id, job_id, normalized_question) WHERE scope = 'job'",
  employer:
    "(applicant_id, canonical_employer_id, normalized_question) WHERE scope = 'employer'",
  global: "(applicant_id, normalized_question) WHERE scope = 'global'",
};
/** Insert or replace the answer for (scope, owner of scope, normalized question). */
export async function upsertAnswer(
  sql: Sql,
  applicantId: string,
  input: {
    scope: AnswerScope;
    jobId?: string | null;
    canonicalEmployerId?: string | null;
    question: string;
    choices: string[];
    answer: string;
    source: 'seed' | 'ticket' | 'dashboard';
    needsReview?: boolean;
  },
  onConflict: 'replace' | 'keep' = 'replace',
): Promise<string | null> {
  const action =
    onConflict === 'keep'
      ? 'DO NOTHING'
      : 'DO UPDATE SET question=EXCLUDED.question, choices=EXCLUDED.choices, answer=EXCLUDED.answer, source=EXCLUDED.source, needs_review=EXCLUDED.needs_review, updated_at=now()';
  const result = await sql.query(
    `INSERT INTO answers (id,applicant_id,scope,job_id,canonical_employer_id,question,normalized_question,choices,answer,source,needs_review)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT ${conflictTarget[input.scope]} ${action} RETURNING id`,
    [
      randomUUID(),
      applicantId,
      input.scope,
      input.scope === 'job' ? input.jobId : null,
      input.scope === 'employer' ? input.canonicalEmployerId : null,
      input.question,
      questionKey(input.question),
      JSON.stringify(input.choices),
      input.answer,
      input.source,
      input.needsReview ?? false,
    ],
  );
  return result.rows[0]?.id ?? null;
}

/** Answers visible to a job: one-time answers for it, its employer's, and global ones. */
export async function answersInScope(
  sql: Sql,
  applicantId: string,
  jobId: string,
  employerId: string | null,
) {
  return (
    await sql.query(
      `SELECT * FROM answers WHERE applicant_id=$1 AND (scope='global'
        OR (scope='employer' AND canonical_employer_id IS NOT DISTINCT FROM $2::uuid AND $2::uuid IS NOT NULL)
        OR (scope='job' AND job_id=$3))`,
      [applicantId, employerId, jobId],
    )
  ).rows;
}

export async function listAnswers(db: Database, applicantId: string) {
  const answers = (
    await db.query(
      `SELECT a.*, e.name AS employer_name FROM answers a
       LEFT JOIN employers e ON e.id=a.canonical_employer_id AND e.applicant_id=a.applicant_id
       WHERE a.applicant_id=$1 ORDER BY a.needs_review DESC, a.scope, a.updated_at DESC LIMIT 500`,
      [applicantId],
    )
  ).rows.map(answerFromRow);
  const aliases: AnswerAlias[] = (
    await db.query(
      `SELECT l.*, a.question AS answer_question, a.answer FROM answer_aliases l
       JOIN answers a ON a.id=l.answer_id AND a.applicant_id=l.applicant_id
       WHERE l.applicant_id=$1 AND l.status <> 'rejected' ORDER BY l.status DESC, l.created_at DESC LIMIT 500`,
      [applicantId],
    )
  ).rows.map((row) => ({
    id: row.id,
    answerId: row.answer_id,
    canonicalEmployerId: row.canonical_employer_id,
    question: row.question,
    answerQuestion: row.answer_question,
    answer: row.answer,
    status: row.status,
    score: row.score,
  }));
  return { answers, aliases };
}

export async function createAnswer(
  db: Database,
  applicantId: string,
  input: {
    scope: 'employer' | 'global';
    canonicalEmployerId?: string;
    question: string;
    choices: string[];
    answer: string;
  },
) {
  if (input.scope === 'employer') {
    const employer = await db.query(
      'SELECT id FROM employers WHERE id=$1 AND applicant_id=$2',
      [input.canonicalEmployerId ?? null, applicantId],
    );
    if (!employer.rows.length) throw new HttpError(404, 'Employer not found');
  }
  const answerId = await upsertAnswer(db, applicantId, {
    ...input,
    source: 'dashboard',
  });
  return { id: answerId };
}

export async function editAnswer(
  db: Database,
  applicantId: string,
  answerId: string,
  input: { answer?: string; reviewed?: boolean },
) {
  const result = await db.query(
    `UPDATE answers SET answer=COALESCE($3, answer),
       needs_review=CASE WHEN $4::boolean IS NULL THEN needs_review ELSE NOT $4::boolean END,
       updated_at=now() WHERE id=$1 AND applicant_id=$2 RETURNING id`,
    [answerId, applicantId, input.answer ?? null, input.reviewed ?? null],
  );
  if (!result.rows.length) throw new HttpError(404, 'Answer not found');
  return { updated: true };
}

export async function deleteAnswer(
  db: Database,
  applicantId: string,
  answerId: string,
) {
  const result = await db.query(
    'DELETE FROM answers WHERE id=$1 AND applicant_id=$2 RETURNING id',
    [answerId, applicantId],
  );
  if (!result.rows.length) throw new HttpError(404, 'Answer not found');
  return { deleted: true };
}

export async function proposeAlias(
  sql: Sql,
  applicantId: string,
  input: {
    answerId: string;
    canonicalEmployerId: string | null;
    question: string;
    score: number;
  },
) {
  const key = normalizeQuestion(input.question);
  if (!key) return; // never match on an empty key
  await sql.query(
    `INSERT INTO answer_aliases (id,applicant_id,answer_id,canonical_employer_id,question,normalized_question,status,score)
     VALUES ($1,$2,$3,$4,$5,$6,'proposed',$7) ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      applicantId,
      input.answerId,
      input.canonicalEmployerId,
      input.question,
      key,
      input.score,
    ],
  );
}

export async function decideAlias(
  db: Database,
  applicantId: string,
  aliasId: string,
  status: 'approved' | 'rejected',
) {
  const result = await db.query(
    "UPDATE answer_aliases SET status=$3, decided_at=now() WHERE id=$1 AND applicant_id=$2 AND status='proposed' RETURNING id",
    [aliasId, applicantId, status],
  );
  if (!result.rows.length) throw new HttpError(404, 'Proposed alias not found');
  return { status };
}

/**
 * Re-keys stored answers and aliases whose `normalized_question` no longer matches the current
 * `normalizeQuestion` (the key became lossless in the P2 review fixes). Idempotent: rows already
 * on the current key are untouched. The new key is strictly finer than the old one, so two
 * stored rows never collide with each other; a row whose new key is already taken by a newer
 * row (or would be empty) keeps its old key, which no longer matches any form question, and an
 * answer is flagged `needs_review` so the dashboard shows it. Runs at boot and before seeding.
 */
export async function renormalizeAnswerKeysTx(sql: Sql, applicantId?: string) {
  const owner = applicantId ? 'AND applicant_id=$1' : '';
  const params = applicantId ? [applicantId] : [];
  let rekeyed = 0,
    flagged = 0;
  const answers = (
    await sql.query(
      `SELECT id,applicant_id,scope,job_id,canonical_employer_id,question,normalized_question FROM answers WHERE true ${owner} FOR UPDATE`,
      params,
    )
  ).rows;
  for (const row of answers) {
    const key = normalizeQuestion(row.question);
    if (key === row.normalized_question) continue;
    const taken =
      !key ||
      (
        await sql.query(
          `SELECT 1 FROM answers WHERE applicant_id=$1 AND scope=$2 AND normalized_question=$3 AND id<>$4
             AND job_id IS NOT DISTINCT FROM $5::uuid AND canonical_employer_id IS NOT DISTINCT FROM $6::uuid`,
          [
            row.applicant_id,
            row.scope,
            key,
            row.id,
            row.scope === 'job' ? row.job_id : null,
            row.scope === 'employer' ? row.canonical_employer_id : null,
          ],
        )
      ).rows.length > 0;
    if (taken) {
      await sql.query(
        'UPDATE answers SET needs_review=true, updated_at=now() WHERE id=$1 AND applicant_id=$2',
        [row.id, row.applicant_id],
      );
      flagged++;
    } else {
      await sql.query(
        'UPDATE answers SET normalized_question=$3 WHERE id=$1 AND applicant_id=$2',
        [row.id, row.applicant_id, key],
      );
      rekeyed++;
    }
  }
  const aliases = (
    await sql.query(
      `SELECT id,applicant_id,answer_id,canonical_employer_id,question,normalized_question FROM answer_aliases WHERE true ${owner} FOR UPDATE`,
      params,
    )
  ).rows;
  for (const row of aliases) {
    const key = normalizeQuestion(row.question);
    if (key === row.normalized_question) continue;
    const taken =
      !key ||
      (
        await sql.query(
          `SELECT 1 FROM answer_aliases WHERE applicant_id=$1 AND answer_id=$2 AND normalized_question=$3 AND id<>$4
             AND canonical_employer_id IS NOT DISTINCT FROM $5::uuid`,
          [
            row.applicant_id,
            row.answer_id,
            key,
            row.id,
            row.canonical_employer_id,
          ],
        )
      ).rows.length > 0;
    // A twin alias already exists on the new key (or the key is empty): this one is redundant.
    if (taken)
      await sql.query(
        'DELETE FROM answer_aliases WHERE id=$1 AND applicant_id=$2',
        [row.id, row.applicant_id],
      );
    else
      await sql.query(
        'UPDATE answer_aliases SET normalized_question=$3 WHERE id=$1 AND applicant_id=$2',
        [row.id, row.applicant_id, key],
      );
    rekeyed++;
  }
  return { rekeyed, flagged };
}
export async function renormalizeAnswerKeys(db: Database) {
  return db.transaction((sql) => renormalizeAnswerKeysTx(sql));
}

/**
 * Seeds the work-authorization profile answers once; every seed needs human review. Stored
 * keys are brought to the current normalization first, so a re-run never duplicates a seed.
 */
export async function seedProfileAnswers(db: Database, applicantId: string) {
  return db.transaction(async (sql) => {
    await renormalizeAnswerKeysTx(sql, applicantId);
    let inserted = 0;
    for (const seed of profileSeedAnswers)
      if (
        await upsertAnswer(
          sql,
          applicantId,
          { ...seed, scope: 'global', source: 'seed', needsReview: true },
          'keep',
        )
      )
        inserted++;
    return { inserted };
  });
}
