/**
 * Lane C side of an employer merge (called by identity `mergeEmployers` inside its
 * transaction). Employer-scoped answers and employer-specific aliases move from the merged-away
 * employer to the target so the bank follows the combined identity.
 *
 * Conflict rule (unique index answers_employer_question allows one employer answer per
 * normalized question):
 * - same answer text on both sides: the source answer folds into the target one (its aliases
 *   move to the target answer) and is deleted;
 * - different answers: neither is dropped. The target's answer stays in force for matching,
 *   the source's stays attached to the merged-away employer, and both are flagged
 *   `needs_review` so the dashboard lists them together until the user keeps one.
 */
import type { Sql } from '../db.js';

const sameAnswer = (a: string, b: string) =>
  a.trim().replace(/\s+/g, ' ').toLowerCase() ===
  b.trim().replace(/\s+/g, ' ').toLowerCase();
const statusRank: Record<string, number> = {
  proposed: 0,
  rejected: 1,
  approved: 2,
};

export interface AnswerMergeResult {
  moved: number;
  folded: number;
  conflicts: Array<{ sourceAnswerId: string; targetAnswerId: string }>;
}

/** Re-points one alias, merging into an existing identical alias (keeping the decided status). */
async function repointAlias(
  sql: Sql,
  applicantId: string,
  alias: any,
  answerId: string,
  employerId: string | null,
) {
  const twin = (
    await sql.query(
      `SELECT * FROM answer_aliases WHERE applicant_id=$1 AND answer_id=$2 AND normalized_question=$3
       AND canonical_employer_id IS NOT DISTINCT FROM $4::uuid AND id<>$5 FOR UPDATE`,
      [applicantId, answerId, alias.normalized_question, employerId, alias.id],
    )
  ).rows[0];
  if (!twin) {
    await sql.query(
      'UPDATE answer_aliases SET answer_id=$3, canonical_employer_id=$4 WHERE id=$1 AND applicant_id=$2',
      [alias.id, applicantId, answerId, employerId],
    );
    return;
  }
  // A decided status (approved over rejected over proposed) survives the fold.
  if (statusRank[alias.status]! > statusRank[twin.status]!)
    await sql.query(
      'UPDATE answer_aliases SET status=$3, decided_at=$4 WHERE id=$1 AND applicant_id=$2',
      [twin.id, applicantId, alias.status, alias.decided_at],
    );
  await sql.query(
    'DELETE FROM answer_aliases WHERE id=$1 AND applicant_id=$2',
    [alias.id, applicantId],
  );
}

export async function mergeEmployerAnswersTx(
  sql: Sql,
  applicantId: string,
  sourceId: string,
  targetId: string,
): Promise<AnswerMergeResult> {
  const result: AnswerMergeResult = { moved: 0, folded: 0, conflicts: [] };
  const kept = new Set<string>();
  const sources = (
    await sql.query(
      "SELECT * FROM answers WHERE applicant_id=$1 AND scope='employer' AND canonical_employer_id=$2 ORDER BY created_at,id FOR UPDATE",
      [applicantId, sourceId],
    )
  ).rows;
  for (const answer of sources) {
    const target = (
      await sql.query(
        "SELECT * FROM answers WHERE applicant_id=$1 AND scope='employer' AND canonical_employer_id=$2 AND normalized_question=$3 FOR UPDATE",
        [applicantId, targetId, answer.normalized_question],
      )
    ).rows[0];
    if (!target) {
      await sql.query(
        'UPDATE answers SET canonical_employer_id=$3, updated_at=now() WHERE id=$1 AND applicant_id=$2',
        [answer.id, applicantId, targetId],
      );
      result.moved++;
    } else if (sameAnswer(answer.answer, target.answer)) {
      const aliases = (
        await sql.query(
          'SELECT * FROM answer_aliases WHERE applicant_id=$1 AND answer_id=$2 FOR UPDATE',
          [applicantId, answer.id],
        )
      ).rows;
      for (const alias of aliases)
        await repointAlias(
          sql,
          applicantId,
          alias,
          target.id,
          alias.canonical_employer_id === sourceId
            ? targetId
            : alias.canonical_employer_id,
        );
      if (answer.needs_review && !target.needs_review)
        await sql.query(
          'UPDATE answers SET needs_review=true, updated_at=now() WHERE id=$1 AND applicant_id=$2',
          [target.id, applicantId],
        );
      await sql.query('DELETE FROM answers WHERE id=$1 AND applicant_id=$2', [
        answer.id,
        applicantId,
      ]);
      result.folded++;
    } else {
      await sql.query(
        'UPDATE answers SET needs_review=true, updated_at=now() WHERE applicant_id=$1 AND id = ANY($2::uuid[])',
        [applicantId, [answer.id, target.id]],
      );
      kept.add(answer.id);
      result.conflicts.push({
        sourceAnswerId: answer.id,
        targetAnswerId: target.id,
      });
    }
  }
  // Employer-specific aliases follow the employer, except those of a conflicting answer that
  // stays with the merged-away employer for review.
  const aliases = (
    await sql.query(
      'SELECT * FROM answer_aliases WHERE applicant_id=$1 AND canonical_employer_id=$2 ORDER BY created_at,id FOR UPDATE',
      [applicantId, sourceId],
    )
  ).rows;
  for (const alias of aliases)
    if (!kept.has(alias.answer_id))
      await repointAlias(sql, applicantId, alias, alias.answer_id, targetId);
  return result;
}
