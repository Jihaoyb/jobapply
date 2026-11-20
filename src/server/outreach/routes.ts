import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { id } from '../../shared/contracts.js';
import type { OutreachView, OutreachPosition } from '../../shared/outreach.js';
import type { Database } from '../db.js';
import { HttpError } from '../ledger.js';
import {
  closeOutreachTicket,
  configuredOutreachDeps,
  openOutreachTicketFor,
  type OutreachDeps,
} from './deps.js';
import {
  deliverEmail,
  reconcileEmail,
  recordLinkedin,
  recoverInterruptedSends,
} from './delivery.js';
import { isEmployerDomain, normalizeDomain } from './domain.js';
import {
  approveOutreach,
  changeRecipient,
  editDrafts,
  editInput,
  refreshDrafts,
  skipOutreach,
} from './review.js';
import { runOutreachWorker, sweepOutreach } from './worker.js';

type Owner = (req: FastifyRequest, mutation?: boolean) => Promise<string>;

/** Confirms the employer domain once (stored on the canonical employer) and resumes lookup. */
export async function confirmDomain(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
  raw: string,
) {
  const domain = normalizeDomain(raw);
  if (!domain || !isEmployerDomain(domain))
    throw new HttpError(400, 'Enter the employer’s own company domain');
  await deps.db.transaction(async (sql) => {
    const ticket = await openOutreachTicketFor(sql, applicantId, jobId, [
      'domain',
    ]);
    if (!ticket) throw new HttpError(409, 'No domain confirmation is pending');
    const employer = (
      await sql.query(
        `SELECT e.* FROM employers e JOIN jobs j ON j.canonical_employer_id=e.id AND j.applicant_id=e.applicant_id
         WHERE j.id=$1 AND j.applicant_id=$2 FOR UPDATE OF e`,
        [jobId, applicantId],
      )
    ).rows[0];
    if (!employer) throw new HttpError(409, 'Resolve the employer first');
    if (employer.domain && normalizeDomain(employer.domain) !== domain)
      throw new HttpError(
        409,
        `Employer already has domain ${employer.domain}; resolve the dispute first`,
      );
    await sql.query(
      'UPDATE employers SET domain=$3 WHERE id=$1 AND applicant_id=$2',
      [employer.id, applicantId, domain],
    );
    const proposed: string[] = ticket.proposed_domains ?? [];
    await closeOutreachTicket(
      sql,
      applicantId,
      ticket.id,
      proposed.includes(domain) ? 'approved' : 'no_change',
      `Domain confirmed: ${domain}`,
    );
  });
  return runOutreachWorker(deps, applicantId, jobId);
}

/** Closes an outreach provider/employer pause and resumes the step that paused. */
export async function retryOutreach(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
) {
  await deps.db.transaction(async (sql) => {
    const ticket = await openOutreachTicketFor(sql, applicantId, jobId, [
      'provider',
      'employer',
    ]);
    if (!ticket) throw new HttpError(409, 'Nothing to retry');
    await closeOutreachTicket(
      sql,
      applicantId,
      ticket.id,
      'no_change',
      'Retry requested',
    );
  });
  const delivery = (
    await deps.db.query(
      "SELECT id FROM outreach_deliveries WHERE applicant_id=$1 AND job_id=$2 AND status='pending'",
      [applicantId, jobId],
    )
  ).rows[0];
  if (delivery) return deliverEmail(deps, applicantId, jobId);
  return runOutreachWorker(deps, applicantId, jobId);
}

export async function outreachView(
  db: Database,
  applicantId: string,
): Promise<OutreachView> {
  const jobs = (
    await db.query(
      `SELECT j.* FROM jobs j WHERE j.applicant_id=$1 AND (
         EXISTS (SELECT 1 FROM outreach_worker_log l WHERE l.job_id=j.id AND l.applicant_id=j.applicant_id)
         OR EXISTS (SELECT 1 FROM outreach_shortlists s WHERE s.job_id=j.id AND s.applicant_id=j.applicant_id))
       ORDER BY j.created_at DESC LIMIT 100`,
      [applicantId],
    )
  ).rows;
  const positions: OutreachPosition[] = [];
  for (const job of jobs) {
    const q = async (text: string) =>
      (await db.query(text, [applicantId, job.id])).rows;
    const [log] = await q(
      'SELECT outcome, detail, created_at FROM outreach_worker_log WHERE applicant_id=$1 AND job_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1',
    );
    const [ticket] = await q(
      `SELECT t.id, t.question, t.choices, o.kind, o.proposed_domains FROM tickets t JOIN outreach_tickets o ON o.ticket_id=t.id
       WHERE t.applicant_id=$1 AND t.job_id=$2 AND t.status='open'`,
    );
    const [shortlist] = await q(
      'SELECT * FROM outreach_shortlists WHERE applicant_id=$1 AND job_id=$2',
    );
    const candidates = shortlist
      ? (
          await db.query(
            'SELECT * FROM outreach_candidates WHERE applicant_id=$1 AND shortlist_id=$2 ORDER BY rank',
            [applicantId, shortlist.id],
          )
        ).rows
      : [];
    const [review] = await q(
      'SELECT * FROM outreach_reviews WHERE applicant_id=$1 AND job_id=$2',
    );
    const [delivery] = await q(
      'SELECT * FROM outreach_deliveries WHERE applicant_id=$1 AND job_id=$2',
    );
    const [reviewTicket] = review
      ? (
          await db.query('SELECT status FROM tickets WHERE id=$1', [
            review.ticket_id,
          ])
        ).rows
      : [];
    positions.push({
      jobId: job.id,
      title: job.title,
      employer: job.employer,
      jobStatus: job.status,
      worker: log ? { outcome: log.outcome, detail: log.detail } : null,
      ticket: ticket
        ? {
            id: ticket.id,
            kind: ticket.kind,
            question: ticket.question,
            choices: ticket.choices,
            proposedDomains: ticket.proposed_domains,
          }
        : null,
      shortlist: shortlist
        ? {
            id: shortlist.id,
            domain: shortlist.domain,
            candidatesSent: shortlist.candidates_sent,
            candidates: candidates.map((c) => ({
              id: c.id,
              rank: c.rank,
              name: c.name,
              title: c.title,
              organization: c.organization,
              linkedinUrl: c.linkedin_url,
              score: c.score,
              reason: c.reason,
              evidence: c.evidence,
              priorContact: c.prior_contact,
              priorContactDetail: c.prior_contact_detail,
              businessEmail: c.business_email,
              emailStatus: c.email_status,
            })),
          }
        : null,
      review: review
        ? {
            status:
              reviewTicket?.status === 'open' || review.status !== 'ready'
                ? review.status
                : 'closed',
            version: review.version,
            candidateId: review.candidate_id,
            emailSubject: review.email_subject,
            emailBody: review.email_body,
            linkedinNote: review.linkedin_note,
            draftError: review.draft_error,
            outcome: review.outcome,
            linkedinRecordedAt: review.linkedin_recorded_at
              ? new Date(review.linkedin_recorded_at).toISOString()
              : null,
          }
        : null,
      delivery: delivery
        ? {
            id: delivery.id,
            status: delivery.status,
            toAddress: delivery.to_address,
            attempts: delivery.attempts,
            reconciled: delivery.reconciled,
          }
        : null,
    });
  }
  return { positions };
}

/**
 * Dashboard routes for outreach. `owner` is the app's session/CSRF helper so
 * these routes share the existing authentication and owner isolation.
 */
export async function registerOutreachRoutes(
  app: FastifyInstance,
  db: Database,
  owner: Owner,
  config: { production: boolean; outreach?: OutreachDeps },
) {
  // Tests inject fakes through config.outreach; production reads server env only.
  const deps: OutreachDeps = config.outreach ?? configuredOutreachDeps(db);
  const jobParam = (req: FastifyRequest) =>
    id.parse((req.params as { jobId: string }).jobId);
  async function ownedJob(req: FastifyRequest) {
    const applicantId = await owner(req, true);
    const jobId = jobParam(req);
    const found = await db.query(
      'SELECT id FROM jobs WHERE id=$1 AND applicant_id=$2',
      [jobId, applicantId],
    );
    if (!found.rows.length) throw new HttpError(404, 'Job not found');
    return { applicantId, jobId };
  }
  app.get('/api/outreach', async (req) => outreachView(db, await owner(req)));
  app.post('/api/outreach/setup/verify', async (req) => {
    await owner(req, true);
    const [apollo, smtp] = await Promise.all([
      deps.apollo.verify(),
      deps.smtp.verify(),
    ]);
    return {
      apollo,
      smtp: {
        ...smtp,
        dailyEmailLimit: deps.dailyEmailLimit,
        note: 'Gmail personal accounts allow about 500 recipients per rolling 24 hours; this pilot caps sends lower.',
      },
    };
  });
  app.post('/api/outreach/jobs/:jobId/run', async (req) => {
    const { applicantId, jobId } = await ownedJob(req);
    return { result: await runOutreachWorker(deps, applicantId, jobId) };
  });
  app.post('/api/outreach/jobs/:jobId/domain', async (req) => {
    const { applicantId, jobId } = await ownedJob(req);
    const { domain } = z
      .object({ domain: z.string().trim().min(3).max(253) })
      .parse(req.body);
    return { result: await confirmDomain(deps, applicantId, jobId, domain) };
  });
  app.post('/api/outreach/jobs/:jobId/retry', async (req) => {
    const { applicantId, jobId } = await ownedJob(req);
    await retryOutreach(deps, applicantId, jobId);
    return { retried: true };
  });
  app.post('/api/outreach/jobs/:jobId/recipient', async (req) => {
    const { applicantId, jobId } = await ownedJob(req);
    const { candidateId } = z.object({ candidateId: id }).parse(req.body);
    await changeRecipient(deps, applicantId, jobId, candidateId);
    return { changed: true };
  });
  app.post('/api/outreach/jobs/:jobId/redraft', async (req) => {
    const { applicantId, jobId } = await ownedJob(req);
    await refreshDrafts(deps, applicantId, jobId);
    return { refreshed: true };
  });
  app.put('/api/outreach/jobs/:jobId/drafts', async (req) => {
    const { applicantId, jobId } = await ownedJob(req);
    await editDrafts(deps, applicantId, jobId, editInput.parse(req.body));
    return { saved: true };
  });
  app.post('/api/outreach/jobs/:jobId/approve', async (req) => {
    const { applicantId, jobId } = await ownedJob(req);
    const { version } = z
      .object({ version: z.number().int().positive() })
      .parse(req.body);
    const result = await approveOutreach(deps, applicantId, jobId, version);
    return {
      outcome: result.outcome,
      emailQueued: result.emailQueued,
      deliveryStatus: result.delivery?.status ?? null,
    };
  });
  app.post('/api/outreach/jobs/:jobId/skip', async (req) => {
    const { applicantId, jobId } = await ownedJob(req);
    return skipOutreach(deps, applicantId, jobId);
  });
  app.post('/api/outreach/jobs/:jobId/reconcile', async (req) => {
    const { applicantId, jobId } = await ownedJob(req);
    const { sent } = z.object({ sent: z.boolean() }).parse(req.body);
    const delivery = await reconcileEmail(deps, applicantId, jobId, sent);
    return { deliveryStatus: delivery?.status ?? null };
  });
  app.post('/api/outreach/jobs/:jobId/linkedin', async (req) => {
    const { applicantId, jobId } = await ownedJob(req);
    return recordLinkedin(deps, applicantId, jobId);
  });
  if (config.production) {
    // Production wake-up fallback. 007 may also call handleOutreachEvent directly after commit.
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await recoverInterruptedSends(deps);
        await sweepOutreach(deps);
      } catch (error) {
        deps.log('sweep failed', { reason: (error as Error).message });
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void tick(), 60_000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }
}
