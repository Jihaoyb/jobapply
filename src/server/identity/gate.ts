/**
 * Identity resolution and the pre-eligibility gate: dedupe -> cap -> hold. Every function here
 * runs inside the caller's transaction after `lockApplicant`.
 */
import type { Sql } from '../db.js';
import { appendEvent, openTicketTx } from '../ledger.js';
import {
  defaultCapSettings,
  evaluateCap,
  laLocalDate,
  type CapEvaluation,
  type CapSettings,
} from './capdates.js';
import {
  addAlias,
  aliasEmployer,
  canonicalEmployer,
  createEmployer,
  plausibleEmployers,
  type EmployerRow,
} from './employers.js';
import {
  deriveJobKeys,
  findDuplicate,
  type DedupeCandidate,
  type IdentityKey,
  type JobKeys,
} from './normalize.js';

/** Job statuses that may still proceed to eligibility, form fill or submit. */
export const GATEABLE_STATUSES = ['captured', 'eligibility_pending', 'ready'];

export async function getCapSettings(
  sql: Sql,
  applicantId: string,
): Promise<CapSettings> {
  const row = (
    await sql.query(
      'SELECT cap_limit,window_months FROM cap_settings WHERE applicant_id=$1',
      [applicantId],
    )
  ).rows[0];
  return row
    ? { limit: Number(row.cap_limit), windowMonths: Number(row.window_months) }
    : defaultCapSettings;
}
export async function confirmedDates(
  sql: Sql,
  applicantId: string,
  employerId: string,
): Promise<string[]> {
  return (
    await sql.query(
      "SELECT to_char(local_date,'YYYY-MM-DD') AS d FROM submissions WHERE applicant_id=$1 AND canonical_employer_id=$2 AND state='confirmed'",
      [applicantId, employerId],
    )
  ).rows.map((row) => row.d as string);
}
export async function employerCap(
  sql: Sql,
  applicantId: string,
  employerId: string,
  now: Date,
): Promise<CapEvaluation> {
  return evaluateCap(
    await confirmedDates(sql, applicantId, employerId),
    laLocalDate(now),
    await getCapSettings(sql, applicantId),
  );
}
/** Jobs whose submit is in flight or uncertain: they hold the employer until reconciled. */
export async function employerHolds(
  sql: Sql,
  applicantId: string,
  employerId: string,
  exceptJobId?: string,
): Promise<string[]> {
  return (
    await sql.query(
      "SELECT job_id FROM submissions WHERE applicant_id=$1 AND canonical_employer_id=$2 AND state IN ('submitting','uncertain') AND job_id IS DISTINCT FROM $3 ORDER BY created_at",
      [applicantId, employerId, exceptJobId ?? null],
    )
  ).rows.map((row) => row.job_id as string);
}

export function identityKeysFor(keys: JobKeys): IdentityKey[] {
  const list: IdentityKey[] = [];
  if (keys.applicationKey) {
    list.push(keys.applicationKey);
    if (keys.careersLink)
      list.push({ key: keys.careersLink.domainKey, kind: 'domain' });
  } else if (keys.discoveryKey) list.push(keys.discoveryKey);
  return list.filter(
    (key, index) => list.findIndex((other) => other.key === key.key) === index,
  );
}

export async function ensureJobIdentityRow(
  sql: Sql,
  applicantId: string,
  job: any,
): Promise<JobKeys> {
  const keys = deriveJobKeys({
    title: job.title,
    discoveryUrl: job.discovery_url,
    applicationUrl: job.application_url,
    postingText: job.posting_text,
  });
  await sql.query(
    `INSERT INTO job_identity (job_id,applicant_id,identity_key,requisition_id,title_key,location_key,url_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (job_id) DO NOTHING`,
    [
      job.id,
      applicantId,
      (keys.applicationKey ?? keys.discoveryKey)?.key ?? null,
      keys.requisitionId,
      keys.titleKey,
      keys.locationKey,
      keys.urlKey,
    ],
  );
  return keys;
}

type TicketKind = 'conflict' | 'plausible' | 'unresolved';
async function openIdentityTicket(
  sql: Sql,
  applicantId: string,
  job: any,
  kind: TicketKind,
  candidates: EmployerRow[],
  unmapped: IdentityKey[],
) {
  const keyText = unmapped.map((key) => key.key).join(', ');
  const question =
    kind === 'conflict'
      ? `This posting links ${keyText || 'its keys'} to different employers (${candidates.map((c) => c.name).join(' / ')}). Which employer is it, and are they the same company?`
      : kind === 'plausible'
        ? `Is “${job.employer}” (${keyText}) the same employer as ${candidates.map((c) => `“${c.name}”`).join(' or ')}? Resolve before applying.`
        : `Which employer posted “${job.title}” as “${job.employer}”?`;
  const ticket = await openTicketTx(sql, applicantId, job.id, {
    question,
    choices: [
      ...candidates.map((candidate) => candidate.name),
      `New employer “${job.employer}”`,
    ],
    employer: job.employer,
    role: job.title,
    cause: 'employer_identity',
    resolveAction: 'resolve_employer',
  });
  await sql.query(
    'INSERT INTO identity_tickets (ticket_id,applicant_id,job_id,kind,candidate_employer_ids,unmapped_keys,employer_name) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [
      ticket.id,
      applicantId,
      job.id,
      kind,
      JSON.stringify(candidates.map((c) => c.id)),
      JSON.stringify(unmapped),
      job.employer,
    ],
  );
  return ticket;
}

export async function recordCareersLink(
  sql: Sql,
  applicantId: string,
  jobId: string,
  keys: JobKeys,
  employerId: string | null,
  status: 'linked' | 'conflict',
) {
  const link = keys.careersLink;
  if (!link) return;
  await sql.query(
    `INSERT INTO employer_links (id,applicant_id,employer_id,job_id,domain_key,ats_key,relation,careers_url,ats_url,status)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      applicantId,
      employerId,
      jobId,
      link.domainKey,
      link.atsKey,
      link.relation,
      link.careersUrl,
      link.atsUrl,
      status,
    ],
  );
}

/**
 * Resolves the job's canonical employer from its identity keys.
 * - keys mapped to one employer: use it and map the job's other keys (careers redirect/embed
 *   auto-link records both URLs)
 * - keys mapped to different employers: conflict ticket (employer_identity)
 * - unmapped keys whose name/stem matches an existing employer: plausible-match ticket
 * - no key: a single exact display-name match is used; several open a ticket; none creates one
 * Returns the employer ID, or null when a ticket now pauses the job.
 */
export async function ensureIdentity(
  sql: Sql,
  applicantId: string,
  job: any,
): Promise<string | null> {
  const current = await canonicalEmployer(
    sql,
    applicantId,
    job.canonical_employer_id,
  );
  if (current) {
    if (current !== job.canonical_employer_id)
      await sql.query(
        'UPDATE jobs SET canonical_employer_id=$3 WHERE id=$1 AND applicant_id=$2',
        [job.id, applicantId, current],
      );
    return current;
  }
  const keys = await ensureJobIdentityRow(sql, applicantId, job);
  const identityKeys = identityKeysFor(keys);
  const mapped = await Promise.all(
    identityKeys.map((key) => aliasEmployer(sql, applicantId, key.key)),
  );
  const employerIds = [...new Set(mapped.filter((id): id is string => !!id))];
  const unmapped = identityKeys.filter((_key, index) => !mapped[index]);
  let employerId: string | null = null;
  if (employerIds.length > 1) {
    await recordCareersLink(sql, applicantId, job.id, keys, null, 'conflict');
    const candidates = (
      await sql.query(
        'SELECT id,name,domain FROM employers WHERE applicant_id=$1 AND id = ANY($2::uuid[]) ORDER BY created_at,id',
        [applicantId, employerIds],
      )
    ).rows as EmployerRow[];
    await openIdentityTicket(
      sql,
      applicantId,
      job,
      'conflict',
      candidates,
      unmapped,
    );
    return null;
  }
  if (employerIds.length === 1) {
    employerId = employerIds[0];
    for (const key of unmapped)
      await addAlias(
        sql,
        applicantId,
        key,
        employerId,
        keys.careersLink ? 'careers_link' : 'capture',
      );
    await recordCareersLink(
      sql,
      applicantId,
      job.id,
      keys,
      employerId,
      'linked',
    );
  } else if (!identityKeys.length) {
    const matches = await plausibleEmployers(
      sql,
      applicantId,
      job.employer,
      [],
    );
    if (matches.length === 1) employerId = matches[0].id;
    else if (matches.length > 1) {
      await openIdentityTicket(
        sql,
        applicantId,
        job,
        'unresolved',
        matches,
        [],
      );
      return null;
    } else employerId = await createEmployer(sql, applicantId, job.employer);
  } else {
    const matches = await plausibleEmployers(
      sql,
      applicantId,
      job.employer,
      identityKeys.map((key) => key.key),
    );
    if (matches.length) {
      await openIdentityTicket(
        sql,
        applicantId,
        job,
        'plausible',
        matches,
        unmapped,
      );
      return null;
    }
    employerId = await createEmployer(sql, applicantId, job.employer);
    for (const key of unmapped)
      await addAlias(
        sql,
        applicantId,
        key,
        employerId,
        keys.careersLink ? 'careers_link' : 'capture',
      );
    await recordCareersLink(
      sql,
      applicantId,
      job.id,
      keys,
      employerId,
      'linked',
    );
  }
  await sql.query(
    'UPDATE jobs SET canonical_employer_id=$3 WHERE id=$1 AND applicant_id=$2',
    [job.id, applicantId, employerId],
  );
  return employerId;
}

export type GateResult =
  | { status: 'ok'; employerId: string; cap: CapEvaluation }
  | { status: 'duplicate'; existingJobId: string }
  | { status: 'capped'; employerId: string; nextAvailableDate: string }
  | { status: 'held'; employerId: string; heldBy: string[] }
  | { status: 'unresolved' }
  | { status: 'not_gateable'; jobStatus: string };

/**
 * Links duplicates, then checks cap and hold for the job's *current* canonical employer.
 * Writes the outcome: duplicate/capped jobs get their status and ledger event and leave the
 * queue; held jobs stay queued with a hold reason. Never calls a model or opens eligibility work.
 */
export async function classifyJob(
  sql: Sql,
  applicantId: string,
  jobId: string,
  now: Date,
): Promise<GateResult> {
  const job = (
    await sql.query(
      'SELECT * FROM jobs WHERE id=$1 AND applicant_id=$2 FOR UPDATE',
      [jobId, applicantId],
    )
  ).rows[0];
  if (!job) return { status: 'not_gateable', jobStatus: 'missing' };
  await ensureJobIdentityRow(sql, applicantId, job);
  const employerId = await canonicalEmployer(
    sql,
    applicantId,
    job.canonical_employer_id,
  );
  if (employerId && employerId !== job.canonical_employer_id)
    await sql.query(
      'UPDATE jobs SET canonical_employer_id=$3 WHERE id=$1 AND applicant_id=$2',
      [jobId, applicantId, employerId],
    );
  const gateable = GATEABLE_STATUSES.includes(job.status);
  if (!employerId)
    return gateable
      ? { status: 'unresolved' }
      : { status: 'not_gateable', jobStatus: job.status };
  const ident = (
    await sql.query(
      'SELECT * FROM job_identity WHERE job_id=$1 AND applicant_id=$2',
      [jobId, applicantId],
    )
  ).rows[0];
  let duplicateOf: string | null = ident.duplicate_of;
  if (!duplicateOf) {
    // Established records (progressed past capture, or older) are preferred as the primary.
    const others = (
      await sql.query(
        `SELECT i.job_id AS "jobId", i.requisition_id AS "requisitionId", i.title_key AS "titleKey",
           i.location_key AS "locationKey", i.url_key AS "urlKey"
         FROM job_identity i JOIN jobs j ON j.id=i.job_id
         WHERE i.applicant_id=$1 AND i.canonical_employer_id=$2 AND i.duplicate_of IS NULL AND i.job_id<>$3
           AND j.status<>'duplicate'
         ORDER BY (j.status IN ('captured','capped')) ASC, j.created_at, j.id`,
        [applicantId, employerId, jobId],
      )
    ).rows as DedupeCandidate[];
    duplicateOf =
      findDuplicate(
        {
          requisitionId: ident.requisition_id,
          titleKey: ident.title_key,
          locationKey: ident.location_key,
          urlKey: ident.url_key,
        },
        others,
      )?.jobId ?? null;
  }
  await sql.query(
    'UPDATE job_identity SET canonical_employer_id=$3, duplicate_of=$4 WHERE job_id=$1 AND applicant_id=$2',
    [jobId, applicantId, employerId, duplicateOf],
  );
  if (duplicateOf) {
    if (gateable) {
      await sql.query(
        "UPDATE jobs SET status='duplicate' WHERE id=$1 AND applicant_id=$2",
        [jobId, applicantId],
      );
      await appendEvent(sql, applicantId, jobId, 'job.duplicate', {
        existingJobId: duplicateOf,
      });
      await stopQueueItem(sql, applicantId, jobId, 'duplicate');
    }
    return { status: 'duplicate', existingJobId: duplicateOf };
  }
  if (!gateable) return { status: 'not_gateable', jobStatus: job.status };
  const cap = await employerCap(sql, applicantId, employerId, now);
  if (cap.capped) {
    await sql.query(
      "UPDATE jobs SET status='capped' WHERE id=$1 AND applicant_id=$2",
      [jobId, applicantId],
    );
    await appendEvent(sql, applicantId, jobId, 'job.capped', {
      nextAvailableDate: cap.nextAvailableDate,
    });
    await stopQueueItem(sql, applicantId, jobId, 'capped');
    return {
      status: 'capped',
      employerId,
      nextAvailableDate: cap.nextAvailableDate,
    };
  }
  const heldBy = await employerHolds(sql, applicantId, employerId, jobId);
  await sql.query(
    'UPDATE work_queue SET hold_reason=$3,updated_at=now() WHERE job_id=$1 AND applicant_id=$2',
    [
      jobId,
      applicantId,
      heldBy.length ? `Awaiting reconciliation of job ${heldBy[0]}` : null,
    ],
  );
  if (heldBy.length) return { status: 'held', employerId, heldBy };
  return { status: 'ok', employerId, cap };
}

async function stopQueueItem(
  sql: Sql,
  applicantId: string,
  jobId: string,
  reason: string,
) {
  await sql.query(
    "UPDATE work_queue SET state='stopped',stop_reason=$3,hold_reason=NULL,updated_at=now() WHERE job_id=$1 AND applicant_id=$2 AND state IN ('queued','active','paused')",
    [jobId, applicantId, reason],
  );
}
