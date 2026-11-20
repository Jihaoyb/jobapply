/**
 * Confirmed-history CSV import (issue 003).
 *
 * Each counted row becomes a job (source `manual`, status `confirmed`, no `job.selected`, so it
 * never enters the pilot funnel) plus an `imported` submission dated on the row's original local
 * date. The job gives import tickets their required `job_id` and lets later live sightings of the
 * same posting dedupe against it. Re-imports are idempotent by row hash; a row matching an
 * existing confirmed submission is linked to it instead of counted again.
 */
import { randomUUID } from 'node:crypto';
import { classifyHost } from '../../shared/contracts.js';
import type { Database, Sql } from '../db.js';
import { appendEvent } from '../ledger.js';
import { laLocalDate, parseIsoDate } from './capdates.js';
import { parseImportCsv, type ImportRowError } from './csv.js';
import { aliasEmployer, plausibleEmployers } from './employers.js';
import { GATEABLE_STATUSES } from './gate.js';
import {
  identityKeyFromUrl,
  locationKey,
  normalizeEmployerName,
  normalizeLocation,
  normalizeTitle,
  requisitionFromUrls,
  requisitionNamespace,
  urlKey,
} from './normalize.js';
import { openTicketTx } from '../ledger.js';
import { lockApplicant } from './tickets.js';

export interface ImportRowInput {
  line: number;
  employer: string;
  title: string;
  date: string;
  sourceUrl: string;
}
export type ImportOutcome =
  'counted' | 'linked' | 'pending_employer' | 'already_imported';
export interface ImportResult {
  batchId: string | null;
  rows: {
    line: number;
    outcome: ImportOutcome;
    employer: string;
    title: string;
    date: string;
    ticketId?: string;
  }[];
  errors: ImportRowError[];
  repeated: { line: number; sameAsLine: number }[];
  summary: Record<ImportOutcome | 'errors' | 'repeated', number>;
}

function dayDistance(a: string, b: string) {
  const x = parseIsoDate(a)!,
    y = parseIsoDate(b)!;
  return (
    Math.abs(
      Date.UTC(x.year, x.month - 1, x.day) -
        Date.UTC(y.year, y.month - 1, y.day),
    ) / 86_400_000
  );
}

async function createImportJob(
  sql: Sql,
  applicantId: string,
  row: ImportRowInput,
  filename: string,
) {
  const jobId = randomUUID();
  const host = classifyHost(row.sourceUrl);
  await sql.query(
    `INSERT INTO jobs (id,applicant_id,client_capture_id,title,employer,discovery_url,application_url,posting_text,source,status,application_host,supported_host)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'manual','confirmed',$8,$9)`,
    [
      jobId,
      applicantId,
      randomUUID(),
      row.title,
      row.employer,
      row.sourceUrl,
      `Imported application history (${filename.slice(0, 200)}, line ${row.line}, applied ${row.date}).`,
      host.applicationHost,
      host.supportedHost,
    ],
  );
  await sql.query(
    `INSERT INTO job_identity (job_id,applicant_id,identity_key,requisition_id,title_key,location_key,url_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      jobId,
      applicantId,
      identityKeyFromUrl(row.sourceUrl)?.key ?? null,
      requisitionFromUrls(row.sourceUrl),
      normalizeTitle(row.title),
      locationKey(normalizeLocation(null)),
      urlKey(row.sourceUrl),
    ],
  );
  return jobId;
}

/**
 * Counts one resolved row for `employerId`, or links it to a matching confirmed submission.
 * Matching: same posting URL, same requisition ID, or same normalized title within one day
 * (when no comparable requisition IDs disagree).
 */
export async function countImportRow(
  sql: Sql,
  applicantId: string,
  row: ImportRowInput,
  employerId: string,
  filename: string,
  hostJobId: string | null,
): Promise<{
  status: 'counted' | 'linked';
  jobId: string | null;
  submissionId: string;
}> {
  const req = requisitionFromUrls(row.sourceUrl);
  const posting = urlKey(row.sourceUrl);
  const title = normalizeTitle(row.title);
  const confirmed = (
    await sql.query(
      `SELECT s.id, s.job_id, to_char(s.local_date,'YYYY-MM-DD') AS d, i.requisition_id, i.url_key, i.title_key
       FROM submissions s JOIN job_identity i ON i.job_id=s.job_id
       WHERE s.applicant_id=$1 AND s.canonical_employer_id=$2 AND s.state='confirmed'
       ORDER BY s.local_date, s.created_at`,
      [applicantId, employerId],
    )
  ).rows;
  const match = confirmed.find((existing) => {
    if (posting && posting === existing.url_key) return true;
    if (req && existing.requisition_id) {
      if (req === existing.requisition_id) return true;
      if (
        requisitionNamespace(req) ===
        requisitionNamespace(existing.requisition_id)
      )
        return false;
    }
    return (
      title === existing.title_key && dayDistance(row.date, existing.d) <= 1
    );
  });
  if (match) {
    if (hostJobId) {
      await sql.query(
        'UPDATE job_identity SET canonical_employer_id=$3,duplicate_of=$4 WHERE job_id=$1 AND applicant_id=$2',
        [hostJobId, applicantId, employerId, match.job_id],
      );
      await sql.query(
        'UPDATE jobs SET canonical_employer_id=$3 WHERE id=$1 AND applicant_id=$2',
        [hostJobId, applicantId, employerId],
      );
    }
    return { status: 'linked', jobId: hostJobId, submissionId: match.id };
  }
  const jobId =
    hostJobId ?? (await createImportJob(sql, applicantId, row, filename));
  await sql.query(
    'UPDATE jobs SET canonical_employer_id=$3 WHERE id=$1 AND applicant_id=$2',
    [jobId, applicantId, employerId],
  );
  // The imported submission is the established record: an unsubmitted sighting of the same
  // posting or requisition becomes its duplicate instead of a second application.
  const same = (
    await sql.query(
      `SELECT i.job_id, j.status FROM job_identity i JOIN jobs j ON j.id=i.job_id
       WHERE i.applicant_id=$1 AND i.canonical_employer_id=$2 AND i.duplicate_of IS NULL AND i.job_id<>$3
         AND ((i.url_key IS NOT NULL AND i.url_key=$4) OR (i.requisition_id IS NOT NULL AND i.requisition_id=$5))`,
      [applicantId, employerId, jobId, posting, req],
    )
  ).rows;
  for (const other of same) {
    await sql.query(
      'UPDATE job_identity SET duplicate_of=$3 WHERE job_id=$1 AND applicant_id=$2',
      [other.job_id, applicantId, jobId],
    );
    if (GATEABLE_STATUSES.includes(other.status)) {
      await sql.query(
        "UPDATE jobs SET status='duplicate' WHERE id=$1 AND applicant_id=$2",
        [other.job_id, applicantId],
      );
      await appendEvent(sql, applicantId, other.job_id, 'job.duplicate', {
        existingJobId: jobId,
      });
      await sql.query(
        "UPDATE work_queue SET state='stopped',stop_reason='duplicate',updated_at=now() WHERE job_id=$1 AND applicant_id=$2 AND state IN ('queued','active','paused')",
        [other.job_id, applicantId],
      );
    }
  }
  await sql.query(
    'UPDATE job_identity SET canonical_employer_id=$3,duplicate_of=NULL WHERE job_id=$1 AND applicant_id=$2',
    [jobId, applicantId, employerId],
  );
  const submissionId = randomUUID();
  await sql.query(
    `INSERT INTO submissions (id,applicant_id,job_id,canonical_employer_id,kind,state,local_date)
     VALUES ($1,$2,$3,$4,'imported','confirmed',$5)`,
    [submissionId, applicantId, jobId, employerId, row.date],
  );
  return { status: 'counted', jobId, submissionId };
}

/** Parses, validates and imports a four-column CSV. Invalid rows are reported, not imported. */
export async function importHistory(
  db: Database,
  applicantId: string,
  input: { filename: string; csv: string },
  now = new Date(),
): Promise<ImportResult> {
  const parsed = parseImportCsv(input.csv, laLocalDate(now));
  const result: ImportResult = {
    batchId: null,
    rows: [],
    errors: parsed.errors,
    repeated: parsed.repeated,
    summary: {
      counted: 0,
      linked: 0,
      pending_employer: 0,
      already_imported: 0,
      errors: new Set(parsed.errors.map((error) => error.line)).size,
      repeated: parsed.repeated.length,
    },
  };
  if (!parsed.rows.length) return result;
  const filename = input.filename.trim().slice(0, 200) || 'history.csv';
  return db.transaction(async (sql) => {
    await lockApplicant(sql, applicantId);
    const batchId = randomUUID();
    result.batchId = batchId;
    await sql.query(
      "INSERT INTO import_batches (id,applicant_id,filename,summary) VALUES ($1,$2,$3,'{}')",
      [batchId, applicantId, filename],
    );
    for (const row of parsed.rows) {
      const base = {
        line: row.line,
        employer: row.employer,
        title: row.title,
        date: row.date,
      };
      const existing = (
        await sql.query(
          'SELECT id FROM import_rows WHERE applicant_id=$1 AND row_hash=$2',
          [applicantId, row.rowHash],
        )
      ).rows[0];
      if (existing) {
        result.rows.push({ ...base, outcome: 'already_imported' });
        continue;
      }
      const key = identityKeyFromUrl(row.sourceUrl);
      let employerId = key
        ? await aliasEmployer(sql, applicantId, key.key)
        : null;
      const candidates = employerId
        ? []
        : await plausibleEmployers(sql, applicantId, row.employer, []);
      if (!employerId && !key && candidates.length === 1)
        employerId = candidates[0].id;
      const rowId = randomUUID();
      if (employerId) {
        const counted = await countImportRow(
          sql,
          applicantId,
          row,
          employerId,
          filename,
          null,
        );
        await sql.query(
          `INSERT INTO import_rows (id,applicant_id,batch_id,line,row_hash,employer_name,title,local_date,source_url,status,job_id,submission_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            rowId,
            applicantId,
            batchId,
            row.line,
            row.rowHash,
            row.employer,
            row.title,
            row.date,
            row.sourceUrl,
            counted.status,
            counted.jobId,
            counted.submissionId,
          ],
        );
        result.rows.push({ ...base, outcome: counted.status });
        continue;
      }
      // Unmatched employer: one import ticket per employer name/key; later rows wait on it.
      const groupKey = `${normalizeEmployerName(row.employer)}|${key?.key ?? ''}`;
      const open = (
        await sql.query(
          `SELECT it.ticket_id FROM identity_tickets it JOIN tickets t ON t.id=it.ticket_id
           WHERE it.applicant_id=$1 AND it.kind='import' AND it.group_key=$2 AND t.status='open'`,
          [applicantId, groupKey],
        )
      ).rows[0];
      let ticketId: string = open?.ticket_id;
      let hostJobId: string | null = null;
      if (!ticketId) {
        hostJobId = await createImportJob(sql, applicantId, row, filename);
        const ticket = await openTicketTx(sql, applicantId, hostJobId, {
          question: `Which employer is “${row.employer}” in your imported history (${row.title}, applied ${row.date})? It counts toward the cap once resolved.`,
          choices: [
            ...candidates.map((candidate) => candidate.name),
            `New employer “${row.employer}”`,
          ],
          employer: row.employer,
          role: row.title,
          cause: 'import_ambiguity',
          resolveAction: 'resolve_import',
        });
        ticketId = ticket.id;
        await sql.query(
          `INSERT INTO identity_tickets (ticket_id,applicant_id,job_id,kind,candidate_employer_ids,unmapped_keys,employer_name,group_key)
           VALUES ($1,$2,$3,'import',$4,$5,$6,$7)`,
          [
            ticketId,
            applicantId,
            hostJobId,
            JSON.stringify(candidates.map((candidate) => candidate.id)),
            JSON.stringify(key ? [key] : []),
            row.employer,
            groupKey,
          ],
        );
      }
      await sql.query(
        `INSERT INTO import_rows (id,applicant_id,batch_id,line,row_hash,employer_name,title,local_date,source_url,status,job_id,ticket_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_employer',$10,$11)`,
        [
          rowId,
          applicantId,
          batchId,
          row.line,
          row.rowHash,
          row.employer,
          row.title,
          row.date,
          row.sourceUrl,
          hostJobId,
          ticketId,
        ],
      );
      result.rows.push({ ...base, outcome: 'pending_employer', ticketId });
    }
    for (const row of result.rows) result.summary[row.outcome]++;
    await sql.query(
      'UPDATE import_batches SET summary=$3 WHERE id=$1 AND applicant_id=$2',
      [batchId, applicantId, JSON.stringify(result.summary)],
    );
    return result;
  });
}

/** Resolves every pending row waiting on an import ticket; returns the host job's next status. */
export async function resolvePendingImportRows(
  sql: Sql,
  applicantId: string,
  ticketId: string,
  employerId: string,
): Promise<{
  hostStatus: 'confirmed' | 'duplicate';
  counted: number;
  linked: number;
}> {
  const rows = (
    await sql.query(
      `SELECT r.*, to_char(r.local_date,'YYYY-MM-DD') AS d, b.filename FROM import_rows r
       JOIN import_batches b ON b.id=r.batch_id
       WHERE r.applicant_id=$1 AND r.ticket_id=$2 AND r.status='pending_employer' ORDER BY r.created_at,r.line`,
      [applicantId, ticketId],
    )
  ).rows;
  let hostStatus: 'confirmed' | 'duplicate' = 'confirmed',
    counted = 0,
    linked = 0;
  for (const row of rows) {
    const outcome = await countImportRow(
      sql,
      applicantId,
      {
        line: row.line,
        employer: row.employer_name,
        title: row.title,
        date: row.d,
        sourceUrl: row.source_url,
      },
      employerId,
      row.filename,
      row.job_id,
    );
    if (row.job_id && outcome.status === 'linked') hostStatus = 'duplicate';
    if (outcome.status === 'counted') counted++;
    else linked++;
    await sql.query(
      'UPDATE import_rows SET status=$3,job_id=$4,submission_id=$5 WHERE id=$1 AND applicant_id=$2',
      [
        row.id,
        applicantId,
        outcome.status,
        outcome.jobId,
        outcome.submissionId,
      ],
    );
  }
  return { hostStatus, counted, linked };
}
