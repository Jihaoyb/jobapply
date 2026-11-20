import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Job } from '../../shared/contracts.js';
import type { Sql } from '../db.js';
import { appendEvent, HttpError, jobFromRow } from '../ledger.js';
import type { ApolloPerson } from './apollo.js';
import {
  closeOutreachTicket,
  logWorker,
  openOutreachTicket,
  pauseForProvider,
  type OutreachDeps,
} from './deps.js';
import { deliverEmail } from './delivery.js';

export const DRAFT_PROMPT_VERSION = 'outreach-draft-v1';
export const LINKEDIN_NOTE_LIMIT = 300;
export const draftsSchema = z.object({
  emailSubject: z.string().trim().min(1).max(200),
  emailBody: z.string().trim().min(1).max(5000),
  linkedinNote: z.string().trim().min(1).max(LINKEDIN_NOTE_LIMIT),
});
export type Drafts = z.infer<typeof draftsSchema>;
const DRAFT_INSTRUCTIONS = `You draft one short outreach email and one LinkedIn connection note for a job applicant who has already submitted an application.
Return JSON only, shaped {"emailSubject":string,"emailBody":string,"linkedinNote":string}.
The LinkedIn note must be at most ${LINKEDIN_NOTE_LIMIT} characters. Address the recipient by first name, mention the role and that the application was submitted, and ask one light question.
Use only the facts provided. Do not invent experience, metrics, mutual connections or placeholders in brackets. The applicant reviews and may edit before anything is sent.`;

export function personFromCandidate(row: any): ApolloPerson {
  const [firstName, ...rest] = String(row.name).split(' ');
  return {
    id: row.apollo_person_id,
    name: row.name,
    firstName: firstName ?? '',
    lastName: rest.join(' '),
    title: row.title,
    organizationName: row.organization,
    linkedinUrl: row.linkedin_url,
    headline: null,
    seniority: null,
    departments: [],
  };
}

/** people_match for the selected recipient only, cached on the candidate row. */
async function enrichSelected(
  deps: OutreachDeps,
  applicantId: string,
  candidate: any,
) {
  if (candidate.enriched_at) return candidate;
  const match = await deps.apollo.matchPerson(personFromCandidate(candidate));
  return (
    await deps.db.query(
      'UPDATE outreach_candidates SET business_email=$3,email_status=$4,enriched_at=now() WHERE id=$1 AND applicant_id=$2 RETURNING *',
      [candidate.id, applicantId, match.email, match.emailStatus],
    )
  ).rows[0];
}
async function draftFor(
  deps: OutreachDeps,
  applicantId: string,
  job: Job,
  candidate: any,
) {
  return deps.callModel({
    applicantId,
    jobId: job.id,
    purpose: 'outreach_draft',
    promptVersion: DRAFT_PROMPT_VERSION,
    instructions: DRAFT_INSTRUCTIONS,
    input: JSON.stringify({
      task: 'outreach_draft',
      job: {
        title: job.title,
        employer: job.employer,
        posting: job.postingText.slice(0, 3000),
      },
      applicant: { applicationStatus: 'submitted' },
      recipient: {
        name: candidate.name,
        title: candidate.title,
        organization: candidate.organization,
        whyChosen: candidate.reason,
        evidence: candidate.evidence,
      },
    }),
    output: draftsSchema,
  });
}
async function candidateRow(
  sql: Sql,
  applicantId: string,
  candidateId: string,
) {
  return (
    await sql.query(
      'SELECT * FROM outreach_candidates WHERE id=$1 AND applicant_id=$2',
      [candidateId, applicantId],
    )
  ).rows[0];
}

/** Enriches and drafts for the recommended recipient, then opens one review ticket. */
export async function prepareReview(
  deps: OutreachDeps,
  applicantId: string,
  job: Job,
  shortlistId: string,
): Promise<'review_opened' | 'paused_provider' | 'deferred_open_ticket'> {
  let candidate = (
    await deps.db.query(
      'SELECT * FROM outreach_candidates WHERE shortlist_id=$1 AND applicant_id=$2 ORDER BY rank LIMIT 1',
      [shortlistId, applicantId],
    )
  ).rows[0];
  let drafts: Drafts;
  try {
    candidate = await enrichSelected(deps, applicantId, candidate);
  } catch (error) {
    return pauseForProvider(
      deps,
      applicantId,
      job,
      error,
      'Recipient enrichment',
    );
  }
  try {
    drafts = await draftFor(deps, applicantId, job, candidate);
  } catch (error) {
    return pauseForProvider(deps, applicantId, job, error, 'Drafting');
  }
  const names = (
    await deps.db.query(
      'SELECT name, title FROM outreach_candidates WHERE shortlist_id=$1 AND applicant_id=$2 ORDER BY rank',
      [shortlistId, applicantId],
    )
  ).rows.map((row) => `${row.name} (${row.title})`);
  const ticket = await openOutreachTicket(
    deps,
    applicantId,
    job.id,
    'review',
    {
      question: `Review outreach for ${job.title}: recommended recipient ${candidate.name}. Approve, edit, change the recipient, or skip.`,
      choices: names,
      employer: job.employer,
      role: job.title,
      // v1 has no outreach-review cause; the report attributes resolve_action
      // review_outreach separately ("outreach review").
      cause: 'unanswered_question',
      resolveAction: 'review_outreach',
    },
    [],
    // The review row commits with its ticket and pause.
    async (sql, opened) => {
      await sql.query(
        `INSERT INTO outreach_reviews (id,applicant_id,job_id,shortlist_id,ticket_id,candidate_id,status,email_subject,email_body,linkedin_note,drafts_candidate_id)
         VALUES ($1,$2,$3,$4,$5,$6,'ready',$7,$8,$9,$6)`,
        [
          randomUUID(),
          applicantId,
          job.id,
          shortlistId,
          opened.id,
          candidate.id,
          drafts.emailSubject,
          drafts.emailBody,
          drafts.linkedinNote,
        ],
      );
    },
  );
  if (!ticket) return 'deferred_open_ticket';
  await logWorker(deps, applicantId, job.id, 'review_opened', candidate.id);
  return 'review_opened';
}

async function lockReview(sql: Sql, applicantId: string, jobId: string) {
  const review = (
    await sql.query(
      'SELECT * FROM outreach_reviews WHERE applicant_id=$1 AND job_id=$2 FOR UPDATE',
      [applicantId, jobId],
    )
  ).rows[0];
  if (!review) throw new HttpError(404, 'No outreach review for this job');
  const ticket = (
    await sql.query(
      'SELECT status FROM tickets WHERE id=$1 AND applicant_id=$2',
      [review.ticket_id, applicantId],
    )
  ).rows[0];
  return { review, ticketOpen: ticket?.status === 'open' };
}
function assertOpen(review: any, ticketOpen: boolean) {
  if (!ticketOpen || !['ready', 'drafting'].includes(review.status))
    throw new HttpError(409, 'This outreach review is closed');
}
async function loadJob(deps: OutreachDeps, applicantId: string, jobId: string) {
  return jobFromRow(
    (
      await deps.db.query(
        'SELECT * FROM jobs WHERE id=$1 AND applicant_id=$2',
        [jobId, applicantId],
      )
    ).rows[0],
  );
}

/** Enrich + redraft for the currently selected recipient; stale results are discarded. */
export async function refreshDrafts(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
) {
  const review = (
    await deps.db.query(
      'SELECT * FROM outreach_reviews WHERE applicant_id=$1 AND job_id=$2',
      [applicantId, jobId],
    )
  ).rows[0];
  if (!review) throw new HttpError(404, 'No outreach review for this job');
  if (review.status !== 'drafting') return review;
  const job = await loadJob(deps, applicantId, jobId);
  let draftError: string | null = null,
    drafts: Drafts | null = null;
  try {
    const candidate = await enrichSelected(
      deps,
      applicantId,
      await candidateRow(deps.db, applicantId, review.candidate_id),
    );
    drafts = await draftFor(deps, applicantId, job, candidate);
  } catch (error) {
    draftError = `Could not prepare drafts: ${(error as Error).message}`;
  }
  return (
    await deps.db.query(
      drafts
        ? `UPDATE outreach_reviews SET status='ready',draft_error=NULL,email_subject=$4,email_body=$5,linkedin_note=$6,drafts_candidate_id=candidate_id
           WHERE applicant_id=$1 AND job_id=$2 AND version=$3 AND status='drafting' RETURNING *`
        : `UPDATE outreach_reviews SET draft_error=$4 WHERE applicant_id=$1 AND job_id=$2 AND version=$3 AND status='drafting' RETURNING *`,
      drafts
        ? [
            applicantId,
            jobId,
            review.version,
            drafts.emailSubject,
            drafts.emailBody,
            drafts.linkedinNote,
          ]
        : [applicantId, jobId, review.version, draftError],
    )
  ).rows[0];
}

/** Changing the recipient clears drafts and any approval-in-waiting (version bump). */
export async function changeRecipient(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
  candidateId: string,
) {
  await deps.db.transaction(async (sql) => {
    const { review, ticketOpen } = await lockReview(sql, applicantId, jobId);
    assertOpen(review, ticketOpen);
    if (review.candidate_id === candidateId) return;
    const candidate = await candidateRow(sql, applicantId, candidateId);
    if (!candidate || candidate.shortlist_id !== review.shortlist_id)
      throw new HttpError(400, 'Choose a recipient from this shortlist');
    await sql.query(
      `UPDATE outreach_reviews SET candidate_id=$3,version=version+1,status='drafting',draft_error=NULL,
         email_subject=NULL,email_body=NULL,linkedin_note=NULL,drafts_candidate_id=NULL,
         drafts_edited=false,recipient_changed=$4,approved_version=NULL
       WHERE applicant_id=$1 AND job_id=$2`,
      [applicantId, jobId, candidateId, candidate.rank !== 1],
    );
  });
  return refreshDrafts(deps, applicantId, jobId);
}

export const editInput = draftsSchema.extend({
  version: z.number().int().positive(),
});
/** Saves edited wording only. Nothing is sent. */
export async function editDrafts(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
  input: z.infer<typeof editInput>,
) {
  return deps.db.transaction(async (sql) => {
    const { review, ticketOpen } = await lockReview(sql, applicantId, jobId);
    assertOpen(review, ticketOpen);
    if (review.status !== 'ready' || review.version !== input.version)
      throw new HttpError(409, 'The drafts changed; reload before editing');
    const changed =
      review.email_subject !== input.emailSubject ||
      review.email_body !== input.emailBody ||
      review.linkedin_note !== input.linkedinNote;
    if (!changed) return review;
    return (
      await sql.query(
        `UPDATE outreach_reviews SET email_subject=$3,email_body=$4,linkedin_note=$5,drafts_edited=true,version=version+1
         WHERE applicant_id=$1 AND job_id=$2 RETURNING *`,
        [
          applicantId,
          jobId,
          input.emailSubject,
          input.emailBody,
          input.linkedinNote,
        ],
      )
    ).rows[0];
  });
}

/**
 * Approval of exactly the version the applicant saw. Saves the contact to
 * Apollo Job Search, records outreach.reviewed, and queues at most one email.
 */
export async function approveOutreach(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
  version: number,
) {
  const current = (
    await deps.db.query(
      'SELECT * FROM outreach_reviews WHERE applicant_id=$1 AND job_id=$2',
      [applicantId, jobId],
    )
  ).rows[0];
  if (!current) throw new HttpError(404, 'No outreach review for this job');
  if (current.status !== 'ready' || current.version !== version)
    throw new HttpError(409, 'Stale approval: the recipient or drafts changed');
  const candidate = await candidateRow(
    deps.db,
    applicantId,
    current.candidate_id,
  );
  const verifiedEmail =
    candidate.email_status === 'verified' && candidate.business_email
      ? (candidate.business_email as string)
      : null;
  let contact;
  try {
    contact = await deps.apollo.saveToJobSearch(
      personFromCandidate(candidate),
      verifiedEmail,
    );
  } catch (error) {
    throw new HttpError(
      503,
      `Apollo contact save failed: ${(error as Error).message}`,
    );
  }
  const outcome = await deps.db.transaction(async (sql) => {
    const { review, ticketOpen } = await lockReview(sql, applicantId, jobId);
    assertOpen(review, ticketOpen);
    if (
      review.status !== 'ready' ||
      review.version !== version ||
      review.candidate_id !== candidate.id
    )
      throw new HttpError(
        409,
        'Stale approval: the recipient or drafts changed',
      );
    const outcome = review.recipient_changed
      ? ('changed_ranking' as const)
      : review.drafts_edited
        ? ('edited_draft' as const)
        : ('approved' as const);
    await sql.query(
      `UPDATE outreach_reviews SET status='approved',outcome=$3,approved_version=version,approved_at=now(),apollo_contact_id=$4
       WHERE applicant_id=$1 AND job_id=$2`,
      [applicantId, jobId, outcome, contact.contactId],
    );
    if (verifiedEmail)
      await sql.query(
        `INSERT INTO outreach_deliveries (id,applicant_id,job_id,review_id,to_address,subject,body,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') ON CONFLICT DO NOTHING`,
        [
          randomUUID(),
          applicantId,
          jobId,
          review.id,
          verifiedEmail,
          review.email_subject,
          review.email_body,
        ],
      );
    await closeOutreachTicket(
      sql,
      applicantId,
      review.ticket_id,
      outcome,
      `Approved recipient ${candidate.name}`,
    );
    await appendEvent(sql, applicantId, jobId, 'outreach.reviewed', {
      ticketId: review.ticket_id,
      outcome,
    });
    return outcome;
  });
  const delivery = verifiedEmail
    ? await deliverEmail(deps, applicantId, jobId)
    : null;
  return { outcome, delivery, emailQueued: Boolean(verifiedEmail) };
}

/** Skipping closes the review and sends nothing. */
export async function skipOutreach(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
) {
  return deps.db.transaction(async (sql) => {
    const { review, ticketOpen } = await lockReview(sql, applicantId, jobId);
    assertOpen(review, ticketOpen);
    await sql.query(
      "UPDATE outreach_reviews SET status='skipped',outcome='skipped' WHERE applicant_id=$1 AND job_id=$2",
      [applicantId, jobId],
    );
    await closeOutreachTicket(
      sql,
      applicantId,
      review.ticket_id,
      'skipped',
      'Outreach skipped',
    );
    await appendEvent(sql, applicantId, jobId, 'outreach.reviewed', {
      ticketId: review.ticket_id,
      outcome: 'skipped',
    });
    return { outcome: 'skipped' as const };
  });
}
