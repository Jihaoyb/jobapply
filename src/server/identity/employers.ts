import { randomUUID } from 'node:crypto';
import type { Sql } from '../db.js';
import { appendEvent, HttpError } from '../ledger.js';
import {
  keyNameStem,
  normalizeEmployerName,
  type IdentityKey,
} from './normalize.js';

export type AliasSource =
  'capture' | 'careers_link' | 'manual' | 'import' | 'ticket';

export interface EmployerRow {
  id: string;
  name: string;
  domain: string | null;
}

/** Follows a merge pointer to the active canonical employer (merges are flattened). */
export async function canonicalEmployer(
  sql: Sql,
  applicantId: string,
  employerId: string | null,
): Promise<string | null> {
  if (!employerId) return null;
  const row = (
    await sql.query(
      'SELECT id, merged_into FROM employers WHERE id=$1 AND applicant_id=$2',
      [employerId, applicantId],
    )
  ).rows[0];
  if (!row) return null;
  return row.merged_into ?? row.id;
}
export async function activeEmployer(
  sql: Sql,
  applicantId: string,
  employerId: string,
): Promise<EmployerRow> {
  const row = (
    await sql.query(
      'SELECT id,name,domain FROM employers WHERE id=$1 AND applicant_id=$2 AND merged_into IS NULL',
      [employerId, applicantId],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, 'Employer not found');
  return row as EmployerRow;
}

export async function aliasEmployer(
  sql: Sql,
  applicantId: string,
  key: string,
): Promise<string | null> {
  const row = (
    await sql.query(
      'SELECT employer_id FROM employer_aliases WHERE applicant_id=$1 AND alias_key=$2',
      [applicantId, key],
    )
  ).rows[0];
  return canonicalEmployer(sql, applicantId, row?.employer_id ?? null);
}

export async function createEmployer(
  sql: Sql,
  applicantId: string,
  name: string,
): Promise<string> {
  const id = randomUUID();
  await sql.query(
    'INSERT INTO employers (id,applicant_id,name) VALUES ($1,$2,$3)',
    [id, applicantId, name.trim().slice(0, 300)],
  );
  return id;
}

/**
 * Maps an unmapped key to an employer. A domain key also fills the nullable employer domain
 * when it is empty (employer-owned site); shared-ATS keys never set a domain.
 */
export async function addAlias(
  sql: Sql,
  applicantId: string,
  key: IdentityKey,
  employerId: string,
  source: AliasSource,
): Promise<boolean> {
  const inserted = await sql.query(
    `INSERT INTO employer_aliases (id,applicant_id,alias_key,kind,employer_id,source)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (applicant_id,alias_key) DO NOTHING RETURNING id`,
    [randomUUID(), applicantId, key.key, key.kind, employerId, source],
  );
  if (inserted.rows.length && key.kind === 'domain')
    await sql.query(
      'UPDATE employers SET domain=$3 WHERE id=$1 AND applicant_id=$2 AND domain IS NULL',
      [employerId, applicantId, key.key],
    );
  return inserted.rows.length > 0;
}

/**
 * Active employers whose display name or alias-key stem matches: merge *suggestions* only.
 * Pairs the user marked distinct are excluded.
 */
export async function plausibleEmployers(
  sql: Sql,
  applicantId: string,
  name: string,
  keys: string[],
  exclude: string[] = [],
): Promise<EmployerRow[]> {
  const stems = new Set(
    [normalizeEmployerName(name), ...keys.map(keyNameStem)].filter(
      (stem) => stem.length >= 2,
    ),
  );
  const employers = await employersWithStems(sql, applicantId);
  const distinct = await distinctPairs(sql, applicantId);
  return employers
    .filter(
      (employer) =>
        !exclude.includes(employer.id) &&
        employer.stems.some((stem) => stems.has(stem)) &&
        !exclude.some((other) => distinct.has(pairKey(other, employer.id))),
    )
    .map(({ id, name, domain }) => ({ id, name, domain }));
}

async function employersWithStems(sql: Sql, applicantId: string) {
  const employers = (
    await sql.query(
      'SELECT id,name,domain,created_at FROM employers WHERE applicant_id=$1 AND merged_into IS NULL ORDER BY created_at,id',
      [applicantId],
    )
  ).rows;
  const aliases = (
    await sql.query(
      'SELECT alias_key,employer_id FROM employer_aliases WHERE applicant_id=$1',
      [applicantId],
    )
  ).rows;
  return employers.map((employer) => ({
    id: employer.id as string,
    name: employer.name as string,
    domain: employer.domain as string | null,
    stems: [
      normalizeEmployerName(employer.name),
      ...aliases
        .filter((alias) => alias.employer_id === employer.id)
        .map((alias) => keyNameStem(alias.alias_key)),
    ].filter((stem) => stem.length >= 2),
  }));
}
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
async function distinctPairs(sql: Sql, applicantId: string) {
  const rows = (
    await sql.query(
      'SELECT employer_a,employer_b FROM employer_distinct WHERE applicant_id=$1',
      [applicantId],
    )
  ).rows;
  return new Set(rows.map((row) => pairKey(row.employer_a, row.employer_b)));
}
export async function markDistinct(
  sql: Sql,
  applicantId: string,
  a: string,
  b: string,
) {
  if (a === b) return;
  const [first, second] = a < b ? [a, b] : [b, a];
  await sql.query(
    'INSERT INTO employer_distinct (applicant_id,employer_a,employer_b) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [applicantId, first, second],
  );
}

export interface MergeSuggestion {
  employerIds: [string, string];
  names: [string, string];
  reason: string;
}
/** Display-name (and key-stem) matches between active employers, never merged automatically. */
export async function mergeSuggestions(
  sql: Sql,
  applicantId: string,
): Promise<MergeSuggestion[]> {
  const employers = await employersWithStems(sql, applicantId);
  const distinct = await distinctPairs(sql, applicantId);
  const suggestions: MergeSuggestion[] = [];
  for (let i = 0; i < employers.length; i++)
    for (let j = i + 1; j < employers.length; j++) {
      const a = employers[i],
        b = employers[j];
      if (distinct.has(pairKey(a.id, b.id))) continue;
      const shared = a.stems.find((stem) => b.stems.includes(stem));
      if (shared)
        suggestions.push({
          employerIds: [a.id, b.id],
          names: [a.name, b.name],
          reason: `Both match “${shared}”`,
        });
    }
  return suggestions;
}

/**
 * Merges `sourceId` into `targetId`: aliases, jobs, dedupe keys, submissions and earlier merges
 * move to the target so cap and dedupe checks see one combined history. A requisition known on
 * both sides keeps the older job as the primary record and links the newer one as a duplicate.
 */
export async function mergeEmployers(
  sql: Sql,
  applicantId: string,
  sourceId: string,
  targetId: string,
) {
  if (sourceId === targetId)
    throw new HttpError(400, 'Choose two different employers');
  const rows = (
    await sql.query(
      'SELECT id,merged_into,domain FROM employers WHERE applicant_id=$1 AND id = ANY($2::uuid[]) FOR UPDATE',
      [applicantId, [sourceId, targetId]],
    )
  ).rows;
  const source = rows.find((row) => row.id === sourceId),
    target = rows.find((row) => row.id === targetId);
  if (!source || !target || source.merged_into || target.merged_into)
    throw new HttpError(404, 'Employer not found');
  const collisions = (
    await sql.query(
      `SELECT s.job_id AS source_job, t.job_id AS target_job,
        (sj.created_at, sj.id) < (tj.created_at, tj.id) AS source_older
       FROM job_identity s JOIN job_identity t
         ON t.applicant_id=s.applicant_id AND t.requisition_id=s.requisition_id
       JOIN jobs sj ON sj.id=s.job_id JOIN jobs tj ON tj.id=t.job_id
       WHERE s.applicant_id=$1 AND s.canonical_employer_id=$2 AND t.canonical_employer_id=$3
         AND s.duplicate_of IS NULL AND t.duplicate_of IS NULL AND s.requisition_id IS NOT NULL`,
      [applicantId, sourceId, targetId],
    )
  ).rows;
  for (const collision of collisions) {
    const [newer, older] = collision.source_older
      ? [collision.target_job, collision.source_job]
      : [collision.source_job, collision.target_job];
    await sql.query(
      'UPDATE job_identity SET duplicate_of=$3 WHERE job_id=$1 AND applicant_id=$2',
      [newer, applicantId, older],
    );
    // A not-yet-submitted sighting leaves the queue now, before any eligibility work.
    const stopped = await sql.query(
      "UPDATE jobs SET status='duplicate' WHERE id=$1 AND applicant_id=$2 AND status IN ('captured','eligibility_pending','ready') RETURNING id",
      [newer, applicantId],
    );
    if (stopped.rows.length) {
      await appendEvent(sql, applicantId, newer, 'job.duplicate', {
        existingJobId: older,
      });
      await sql.query(
        "UPDATE work_queue SET state='stopped',stop_reason='duplicate',hold_reason=NULL,updated_at=now() WHERE job_id=$1 AND applicant_id=$2 AND state IN ('queued','active','paused')",
        [newer, applicantId],
      );
    }
  }
  const params = [applicantId, sourceId, targetId];
  await sql.query(
    'UPDATE employers SET merged_into=$3 WHERE applicant_id=$1 AND (id=$2 OR merged_into=$2)',
    params,
  );
  await sql.query(
    'UPDATE employer_aliases SET employer_id=$3,updated_at=now() WHERE applicant_id=$1 AND employer_id=$2',
    params,
  );
  await sql.query(
    'UPDATE jobs SET canonical_employer_id=$3 WHERE applicant_id=$1 AND canonical_employer_id=$2',
    params,
  );
  await sql.query(
    'UPDATE job_identity SET canonical_employer_id=$3 WHERE applicant_id=$1 AND canonical_employer_id=$2',
    params,
  );
  await sql.query(
    'UPDATE submissions SET canonical_employer_id=$3,updated_at=now() WHERE applicant_id=$1 AND canonical_employer_id=$2',
    params,
  );
  await sql.query(
    'UPDATE employer_links SET employer_id=$3 WHERE applicant_id=$1 AND employer_id=$2',
    params,
  );
  if (!target.domain && source.domain)
    await sql.query(
      'UPDATE employers SET domain=$3 WHERE id=$2 AND applicant_id=$1',
      [applicantId, targetId, source.domain],
    );
  await sql.query(
    'INSERT INTO employer_merges (id,applicant_id,source_employer_id,target_employer_id) VALUES ($1,$2,$3,$4)',
    [randomUUID(), applicantId, sourceId, targetId],
  );
}
