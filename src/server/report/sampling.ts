import { createHash, randomUUID } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import { appendEvent, HttpError } from '../ledger.js';
import {
  sampleOutcomes,
  type ReviewOutcome,
  type ReviewSample,
} from '../../shared/report.js';
import { computeReport } from './compute.js';
import { loadReportLedger } from './load.js';

export const SAMPLE_SIZE = 10;
type Group = 'passed' | 'excluded';

/**
 * Stable sample ID: a UUIDv8 derived from owner, group and job, so redrawing
 * can never mint a second ID for the same sampled posting.
 */
export function stableSampleId(
  applicantId: string,
  group: Group,
  jobId: string,
): string {
  const hex = createHash('sha256')
    .update(`review-sample:v1:${applicantId}:${group}:${jobId}`)
    .digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function lockOwner(sql: Sql, applicantId: string) {
  // Serializes sampling and review completion per owner.
  await sql.query('SELECT id FROM applicants WHERE id=$1 FOR UPDATE', [
    applicantId,
  ]);
}

/**
 * Randomly samples up to ten distinct passed and ten distinct excluded pilot
 * postings (or all available), topping up earlier draws. Persists each pick as
 * `review.sampled`. Selection order is a seeded hash so tests can pin it.
 */
export async function drawReviewSample(
  db: Database,
  applicantId: string,
  options: { now: Date; clockStart?: Date; seed?: string },
) {
  const seed = options.seed ?? randomUUID();
  return db.transaction(async (sql) => {
    await lockOwner(sql, applicantId);
    const ledger = await loadReportLedger(sql, applicantId);
    const report = computeReport(ledger, options);
    if (report.status !== 'ready')
      throw new HttpError(409, 'The pilot clock has not started');
    const pilotJobs = new Set(
      report.funnel.stages.find((s) => s.key === 'selected')!.jobIds,
    );
    const already = { passed: new Set<string>(), excluded: new Set<string>() };
    for (const event of ledger.events)
      if (
        event.name === 'review.sampled' &&
        event.jobId &&
        pilotJobs.has(event.jobId)
      )
        already[event.payload.group as Group].add(event.jobId);
    const drawn: { sampleId: string; jobId: string; group: Group }[] = [];
    for (const group of ['passed', 'excluded'] as const) {
      const pool = report.funnel.stages.find(
        (s) =>
          s.key ===
          (group === 'passed' ? 'eligibilityPassed' : 'eligibilityExcluded'),
      )!.jobIds;
      const need = SAMPLE_SIZE - already[group].size;
      if (need <= 0) continue;
      const rank = (jobId: string) =>
        createHash('sha256').update(`${seed}:${jobId}`).digest('hex');
      const picks = pool
        .filter((jobId) => !already[group].has(jobId))
        .map((jobId) => ({ jobId, rank: rank(jobId) }))
        .sort((a, b) => a.rank.localeCompare(b.rank))
        .slice(0, need);
      for (const { jobId } of picks) {
        const sampleId = stableSampleId(applicantId, group, jobId);
        await appendEvent(sql, applicantId, jobId, 'review.sampled', {
          sampleId,
          group,
        });
        drawn.push({ sampleId, jobId, group });
      }
    }
    return { drawn };
  });
}

/** Records an actual review of a sampled posting as `review.completed`. */
export async function completeSampleReview(
  db: Database,
  applicantId: string,
  sampleId: string,
  outcome: ReviewOutcome,
) {
  return db.transaction(async (sql) => {
    await lockOwner(sql, applicantId);
    const sampled = (
      await sql.query(
        "SELECT job_id,payload FROM ledger_events WHERE applicant_id=$1 AND name='review.sampled' AND payload->>'sampleId'=$2 ORDER BY occurred_at LIMIT 1",
        [applicantId, sampleId],
      )
    ).rows[0];
    if (!sampled) throw new HttpError(404, 'Sample not found');
    const payload =
      typeof sampled.payload === 'string'
        ? JSON.parse(sampled.payload)
        : sampled.payload;
    const group = payload.group as Group;
    if (!(sampleOutcomes[group] as readonly string[]).includes(outcome))
      throw new HttpError(
        400,
        `Outcome ${outcome} does not apply to a ${group} sample`,
      );
    const previous = (
      await sql.query(
        "SELECT payload FROM ledger_events WHERE applicant_id=$1 AND name='review.completed' AND payload->>'sampleId'=$2 ORDER BY occurred_at DESC,id DESC LIMIT 1",
        [applicantId, sampleId],
      )
    ).rows[0];
    const last = previous
      ? (typeof previous.payload === 'string'
          ? JSON.parse(previous.payload)
          : previous.payload
        ).outcome
      : null;
    if (last && last !== 'deferred')
      throw new HttpError(409, 'Sample already reviewed');
    await appendEvent(sql, applicantId, sampled.job_id, 'review.completed', {
      sampleId,
      outcome,
    });
    return { sampleId, outcome };
  });
}

export async function listSamples(
  db: Database,
  applicantId: string,
): Promise<ReviewSample[]> {
  const ledger = await loadReportLedger(db, applicantId);
  const jobs = new Map(ledger.jobs.map((j) => [j.id, j]));
  const samples = new Map<string, ReviewSample>();
  for (const event of ledger.events) {
    if (event.name === 'review.sampled' && !samples.has(event.payload.sampleId))
      samples.set(event.payload.sampleId, {
        sampleId: event.payload.sampleId,
        jobId: event.jobId!,
        group: event.payload.group,
        title: jobs.get(event.jobId!)?.title ?? '',
        employer: jobs.get(event.jobId!)?.employer ?? '',
        sampledAt: event.occurredAt,
        outcome: null,
        completedAt: null,
      });
    if (event.name === 'review.completed') {
      const sample = samples.get(event.payload.sampleId);
      if (sample) {
        sample.outcome = event.payload.outcome;
        sample.completedAt = event.occurredAt;
      }
    }
  }
  return [...samples.values()];
}
