import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LedgerEvent } from '../../shared/contracts.js';
import { appendEvent, jobFromRow } from '../ledger.js';
import type { ApolloPerson } from './apollo.js';
import {
  foreignOpenTicket,
  logWorker,
  openOutreachTicket,
  pauseForProvider,
  type OutreachDeps,
} from './deps.js';
import {
  domainFromPosting,
  normalizeDomain,
  relevantTitles,
} from './domain.js';
import { prepareReview } from './review.js';

export const MAX_CANDIDATES = 10;
export const MAX_RECOMMENDATIONS = 3;
export const RANKING_PROMPT_VERSION = 'contact-ranking-v1';
const rankingOutput = z.object({
  recommendations: z
    .array(
      z.object({
        personId: z.string().min(1),
        score: z.number().int().min(1).max(5),
        reason: z.string().trim().min(1).max(600),
        evidence: z.string().trim().min(1).max(600),
      }),
    )
    .max(10),
});
const RANKING_INSTRUCTIONS = `You rank possible outreach recipients for a job applicant whose application was already submitted.
Return JSON only, shaped {"recommendations":[{"personId":string,"score":1-5,"reason":string,"evidence":string}]}.
Return at most ${MAX_RECOMMENDATIONS} people, best first, chosen only from the candidates provided (use their personId).
Favor a named hiring contact for this role or a confirmed manager of the hiring team, then recruiters for the role's function.
"reason" is one brief sentence. "evidence" quotes the candidate fields (title, headline, department) that support the reason; never invent facts.`;

// Single-worker pilot: serialize runs per job inside this process. The unique
// shortlist key is the cross-process guard.
const running = new Map<string, Promise<unknown>>();
function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const previous = running.get(jobId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  running.set(jobId, next);
  // Cleanup must not create a second, unobserved rejection: the caller owns `next`'s error.
  const cleanup = () => {
    if (running.get(jobId) === next) running.delete(jobId);
  };
  next.then(cleanup, cleanup);
  return next;
}

export type WorkerResult =
  | 'missing'
  | 'skipped_not_confirmed'
  | 'skipped_deferred'
  | 'deferred_open_ticket'
  | 'skipped_already_shortlisted'
  | 'paused_employer'
  | 'paused_domain'
  | 'paused_provider'
  | 'no_candidates'
  | 'review_opened'
  | 'shortlisted';

/**
 * The outreach worker. Any wake (event, sweep, retry) lands here; it trusts only
 * the persisted job status and never the event that woke it.
 */
export function runOutreachWorker(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
): Promise<WorkerResult> {
  return withJobLock(jobId, () => runLocked(deps, applicantId, jobId));
}
async function runLocked(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
): Promise<WorkerResult> {
  const row = (
    await deps.db.query('SELECT * FROM jobs WHERE id=$1 AND applicant_id=$2', [
      jobId,
      applicantId,
    ])
  ).rows[0];
  if (!row) return 'missing';
  const job = jobFromRow(row);
  if (job.status !== 'confirmed') {
    await logWorker(
      deps,
      applicantId,
      jobId,
      'skipped_not_confirmed',
      `status=${job.status}`,
    );
    return 'skipped_not_confirmed';
  }
  // One open ticket per job: another lane's pause wins; outreach waits and a later wake
  // (sweep, event, retry) runs once it has closed. No Apollo or model call meanwhile.
  const blocking = await foreignOpenTicket(deps.db, applicantId, jobId);
  if (blocking) {
    await logWorker(
      deps,
      applicantId,
      jobId,
      'deferred_open_ticket',
      `open ${blocking.cause} ticket ${blocking.id}`,
    );
    return 'deferred_open_ticket';
  }
  // A generic Defer of an outreach pause ends outreach for this position.
  if (await outreachDeferred(deps.db, applicantId, jobId)) {
    await logWorker(deps, applicantId, jobId, 'skipped_deferred');
    return 'skipped_deferred';
  }
  const existing = (
    await deps.db.query(
      'SELECT s.id, (SELECT count(*) FROM outreach_candidates c WHERE c.shortlist_id=s.id)::int AS n, (SELECT count(*) FROM outreach_reviews r WHERE r.job_id=s.job_id AND r.applicant_id=s.applicant_id)::int AS reviews FROM outreach_shortlists s WHERE s.applicant_id=$1 AND s.job_id=$2',
      [applicantId, jobId],
    )
  ).rows[0];
  if (existing) {
    if (existing.n > 0 && existing.reviews === 0)
      return prepareReview(deps, applicantId, job, existing.id);
    await logWorker(deps, applicantId, jobId, 'skipped_already_shortlisted');
    return 'skipped_already_shortlisted';
  }
  if (!job.canonicalEmployerId) {
    const ticket = await openOutreachTicket(
      deps,
      applicantId,
      jobId,
      'employer',
      {
        question:
          'Contact lookup needs a resolved employer identity. Resolve the employer, then retry outreach.',
        choices: ['Retry', 'Defer'],
        employer: job.employer,
        role: job.title,
        cause: 'employer_identity',
        resolveAction: 'resolve_employer',
      },
    );
    if (!ticket) return 'deferred_open_ticket';
    await logWorker(
      deps,
      applicantId,
      jobId,
      'paused_employer',
      'canonical employer missing',
    );
    return 'paused_employer';
  }
  const employer = (
    await deps.db.query(
      'SELECT * FROM employers WHERE id=$1 AND applicant_id=$2',
      [job.canonicalEmployerId, applicantId],
    )
  ).rows[0];
  const domain = employer.domain ? normalizeDomain(employer.domain) : null;
  if (!domain) {
    const proposals: string[] = [];
    const observed = domainFromPosting(job);
    if (observed) proposals.push(observed);
    else {
      try {
        const org = await deps.apollo.enrichOrganization(employer.name);
        const proposed = org?.domain ? normalizeDomain(org.domain) : null;
        if (proposed) proposals.push(proposed);
      } catch (error) {
        return pauseForProvider(
          deps,
          applicantId,
          job,
          error,
          'Organization lookup',
        );
      }
    }
    const ticket = await openOutreachTicket(
      deps,
      applicantId,
      jobId,
      'domain',
      {
        question: proposals.length
          ? `Confirm ${employer.name}'s company domain before contact lookup. Proposed: ${proposals.join(', ')} (${observed ? 'employer link in the posting' : 'Apollo organization match'}).`
          : `No company domain is known for ${employer.name}. Enter it to start contact lookup.`,
        choices: [...proposals, 'Enter another domain'],
        employer: job.employer,
        role: job.title,
        cause: 'employer_identity',
        resolveAction: 'resolve_employer',
      },
      proposals,
    );
    if (!ticket) return 'deferred_open_ticket';
    await logWorker(
      deps,
      applicantId,
      jobId,
      'paused_domain',
      proposals.join(',') || 'unknown',
    );
    return 'paused_domain';
  }
  let people: ApolloPerson[];
  try {
    people = await deps.apollo.searchPeople({
      domain,
      titles: relevantTitles(job.title),
      perPage: MAX_CANDIDATES,
    });
  } catch (error) {
    return pauseForProvider(deps, applicantId, job, error, 'People search');
  }
  const seen = new Set<string>();
  const candidates = people
    .filter((person) => !seen.has(person.id) && seen.add(person.id))
    .slice(0, MAX_CANDIDATES);
  let recommendations: Array<
    z.infer<typeof rankingOutput>['recommendations'][number] & {
      person: ApolloPerson;
    }
  > = [];
  if (candidates.length) {
    let ranked;
    try {
      ranked = await deps.callModel({
        applicantId,
        jobId,
        purpose: 'contact_ranking',
        promptVersion: RANKING_PROMPT_VERSION,
        instructions: RANKING_INSTRUCTIONS,
        input: JSON.stringify({
          task: 'contact_ranking',
          job: {
            title: job.title,
            employer: job.employer,
            domain,
            posting: job.postingText.slice(0, 4000),
          },
          candidates: candidates.map((person) => ({
            personId: person.id,
            name: person.name,
            title: person.title,
            headline: person.headline,
            seniority: person.seniority,
            departments: person.departments,
            organization: person.organizationName,
          })),
        }),
        output: rankingOutput,
      });
    } catch (error) {
      return pauseForProvider(deps, applicantId, job, error, 'Contact ranking');
    }
    const byId = new Map(candidates.map((person) => [person.id, person]));
    const used = new Set<string>();
    recommendations = ranked.recommendations
      .filter(
        (rec) =>
          byId.has(rec.personId) &&
          !used.has(rec.personId) &&
          used.add(rec.personId),
      )
      .map((rec) => ({ ...rec, person: byId.get(rec.personId)! }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RECOMMENDATIONS);
  }
  const shortlistId = randomUUID();
  const inserted = await deps.db.transaction(async (sql) => {
    const result = await sql.query(
      'INSERT INTO outreach_shortlists (id,applicant_id,job_id,domain,candidates_sent) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (applicant_id,job_id) DO NOTHING RETURNING id',
      [shortlistId, applicantId, jobId, domain, candidates.length],
    );
    if (!result.rows.length) return false;
    for (const [index, rec] of recommendations.entries()) {
      const prior = (
        await sql.query(
          `SELECT j.title, j.employer FROM outreach_reviews r
           JOIN outreach_candidates c ON c.id=r.candidate_id AND c.applicant_id=r.applicant_id
           JOIN jobs j ON j.id=r.job_id AND j.applicant_id=r.applicant_id
           WHERE r.applicant_id=$1 AND r.status='approved' AND r.job_id<>$2 AND c.apollo_person_id=$3
           ORDER BY r.approved_at DESC LIMIT 1`,
          [applicantId, jobId, rec.person.id],
        )
      ).rows[0];
      await sql.query(
        `INSERT INTO outreach_candidates (id,applicant_id,shortlist_id,rank,apollo_person_id,name,title,organization,linkedin_url,score,reason,evidence,prior_contact,prior_contact_detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          randomUUID(),
          applicantId,
          shortlistId,
          index + 1,
          rec.person.id,
          rec.person.name,
          rec.person.title,
          rec.person.organizationName,
          rec.person.linkedinUrl,
          rec.score,
          rec.reason,
          rec.evidence,
          Boolean(prior),
          prior ? `Contacted for ${prior.title} at ${prior.employer}` : null,
        ],
      );
    }
    await appendEvent(sql, applicantId, jobId, 'outreach.shortlisted', {
      shortlistId,
    });
    return true;
  });
  if (!inserted) {
    await logWorker(deps, applicantId, jobId, 'skipped_already_shortlisted');
    return 'skipped_already_shortlisted';
  }
  if (!recommendations.length) {
    await logWorker(
      deps,
      applicantId,
      jobId,
      'no_candidates',
      `sent=${candidates.length}`,
    );
    return 'no_candidates';
  }
  await logWorker(
    deps,
    applicantId,
    jobId,
    'shortlisted',
    `sent=${candidates.length} recommended=${recommendations.length}`,
  );
  return prepareReview(deps, applicantId, job, shortlistId);
}

/** True once any outreach pause on the job was closed by a generic Defer. */
async function outreachDeferred(
  db: OutreachDeps['db'],
  applicantId: string,
  jobId: string,
) {
  return (
    (
      await db.query(
        `SELECT 1 FROM outreach_tickets o JOIN tickets t ON t.id=o.ticket_id AND t.applicant_id=o.applicant_id
         WHERE o.applicant_id=$1 AND o.job_id=$2 AND t.status='resolved' AND t.resolution->>'outcome'='deferred'`,
        [applicantId, jobId],
      )
    ).rows.length > 0
  );
}

/** Event entry point: an application.confirmed event only wakes the worker. */
export async function handleOutreachEvent(
  deps: OutreachDeps,
  event: Pick<LedgerEvent, 'name' | 'applicantId' | 'jobId'>,
) {
  if (event.name !== 'application.confirmed' || !event.jobId) return null;
  return runOutreachWorker(deps, event.applicantId, event.jobId);
}

/** Polling fallback: wakes confirmed jobs that have a confirmation event but no outreach yet. */
export async function sweepOutreach(deps: OutreachDeps) {
  const rows = (
    await deps.db.query(
      `SELECT DISTINCT e.applicant_id, e.job_id FROM ledger_events e
       JOIN jobs j ON j.id=e.job_id AND j.applicant_id=e.applicant_id
       WHERE e.name='application.confirmed' AND j.status='confirmed'
         AND NOT EXISTS (SELECT 1 FROM outreach_reviews r WHERE r.job_id=j.id AND r.applicant_id=j.applicant_id)
         AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.job_id=j.id AND t.applicant_id=j.applicant_id AND t.status='open')
         AND NOT EXISTS (SELECT 1 FROM outreach_tickets o JOIN tickets t ON t.id=o.ticket_id
           WHERE o.job_id=j.id AND o.applicant_id=j.applicant_id AND t.resolution->>'outcome'='deferred')
         AND NOT EXISTS (SELECT 1 FROM outreach_shortlists s WHERE s.job_id=j.id AND s.applicant_id=j.applicant_id
           AND NOT EXISTS (SELECT 1 FROM outreach_candidates c WHERE c.shortlist_id=s.id))
       LIMIT 20`,
    )
  ).rows;
  const results = [];
  for (const row of rows)
    results.push(await runOutreachWorker(deps, row.applicant_id, row.job_id));
  return results;
}
