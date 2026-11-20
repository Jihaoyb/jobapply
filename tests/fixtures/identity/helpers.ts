import { randomUUID } from 'node:crypto';
import type { Database } from '../../../src/server/db.js';
import { captureJob } from '../../../src/server/ledger.js';

/** Synthetic postings only (example-style domains, fictional employers). */
export function posting(overrides: Partial<Record<string, string>> = {}) {
  return {
    clientCaptureId: randomUUID(),
    title: 'Software Engineer',
    employer: 'Acme Robotics',
    discoveryUrl: 'https://www.linkedin.com/jobs/view/1001',
    applicationUrl: 'https://boards.greenhouse.io/acmerobotics/jobs/1001',
    postingText: 'Location: Remote - US\nBuild reliable robots.',
    ...overrides,
  };
}
export async function capture(
  db: Database,
  applicantId: string,
  overrides: Partial<Record<string, string>> = {},
) {
  return captureJob(db, applicantId, posting(overrides), 'extension');
}
export async function events(db: Database, applicantId: string, name?: string) {
  return (
    await db.query(
      `SELECT * FROM ledger_events WHERE applicant_id=$1 ${name ? 'AND name=$2' : ''} ORDER BY occurred_at,id`,
      name ? [applicantId, name] : [applicantId],
    )
  ).rows;
}
export async function jobRow(db: Database, jobId: string) {
  return (await db.query('SELECT * FROM jobs WHERE id=$1', [jobId])).rows[0];
}
export async function queueRow(db: Database, jobId: string) {
  return (await db.query('SELECT * FROM work_queue WHERE job_id=$1', [jobId]))
    .rows[0];
}
export async function openTickets(db: Database, applicantId: string) {
  return (
    await db.query(
      "SELECT * FROM tickets WHERE applicant_id=$1 AND status='open' ORDER BY opened_at",
      [applicantId],
    )
  ).rows;
}
export function csv(...rows: string[]) {
  return ['employer,title,date,source URL', ...rows].join('\n');
}
