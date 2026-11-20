import type { Job } from '../../shared/contracts.js';
import type { Sql } from '../db.js';
import { jobFromRow } from '../ledger.js';
import { classifyJob, ensureIdentity } from './gate.js';
import { enqueueTx } from './queue.js';
import { lockApplicant } from './tickets.js';

/**
 * Capture hook (called by ledger.captureJob inside its transaction, after job.selected):
 * resolve the employer, link duplicate sightings, check cap/hold, enqueue. Runs in a savepoint so
 * a failure here never fails the capture; the job stays `captured` and queued, and the dequeue
 * gate retries identity resolution before any eligibility work.
 */
export async function onCapture(
  sql: Sql,
  applicantId: string,
  job: Job,
  now = new Date(),
): Promise<Job> {
  await sql.query('SAVEPOINT identity_capture');
  try {
    await lockApplicant(sql, applicantId);
    await enqueueTx(sql, applicantId, job.id);
    const row = (
      await sql.query('SELECT * FROM jobs WHERE id=$1 AND applicant_id=$2', [
        job.id,
        applicantId,
      ])
    ).rows[0];
    if (await ensureIdentity(sql, applicantId, row))
      await classifyJob(sql, applicantId, job.id, now);
    await sql.query('RELEASE SAVEPOINT identity_capture');
  } catch (error) {
    // Name only: database messages can echo row values.
    console.error('Identity capture hook failed:', (error as Error).name);
    await sql.query('ROLLBACK TO SAVEPOINT identity_capture');
    await sql.query('RELEASE SAVEPOINT identity_capture');
    await enqueueTx(sql, applicantId, job.id);
  }
  const updated = (
    await sql.query('SELECT * FROM jobs WHERE id=$1 AND applicant_id=$2', [
      job.id,
      applicantId,
    ])
  ).rows[0];
  return jobFromRow(updated);
}
