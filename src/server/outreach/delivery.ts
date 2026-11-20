import { appendEvent, HttpError } from '../ledger.js';
import {
  closeOutreachTicket,
  openOutreachTicket,
  openOutreachTicketFor,
  pauseForProvider,
  type OutreachDeps,
} from './deps.js';
import { SmtpTimeoutError } from './smtp.js';

/** Deliveries this process is sending right now; a stale `sending` row means a crash mid-send. */
const inFlight = new Set<string>();

async function jobInfo(deps: OutreachDeps, applicantId: string, jobId: string) {
  return (
    await deps.db.query(
      'SELECT id,title,employer FROM jobs WHERE id=$1 AND applicant_id=$2',
      [jobId, applicantId],
    )
  ).rows[0] as { id: string; title: string; employer: string };
}
async function deliveryRow(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
) {
  return (
    await deps.db.query(
      'SELECT * FROM outreach_deliveries WHERE applicant_id=$1 AND job_id=$2',
      [applicantId, jobId],
    )
  ).rows[0];
}

/** Records an unknown SMTP outcome and opens the reconciliation ticket before any retry is possible. */
async function markUncertain(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
  deliveryId: string,
) {
  const changed = await deps.db.transaction(async (sql) => {
    const result = await sql.query(
      "UPDATE outreach_deliveries SET status='uncertain' WHERE id=$1 AND applicant_id=$2 AND status='sending' RETURNING id",
      [deliveryId, applicantId],
    );
    if (!result.rows.length) return false;
    await appendEvent(sql, applicantId, jobId, 'email.uncertain', {
      deliveryId,
    });
    return true;
  });
  if (!changed) return;
  const job = await jobInfo(deps, applicantId, jobId);
  const delivery = await deliveryRow(deps, applicantId, jobId);
  await openOutreachTicket(deps, applicantId, jobId, 'uncertain_email', {
    question: `The email to ${delivery.to_address} (“${delivery.subject}”) timed out and may have been sent. Check Gmail Sent before deciding; a retry sends it again.`,
    choices: ['It was sent', 'Not sent: retry once'],
    employer: job.employer,
    role: job.title,
    cause: 'uncertain_email',
    resolveAction: 'reconcile_email',
  });
}

/**
 * Sends the one approved email for a job. Only a `pending` delivery can be
 * claimed, so a second call, a duplicate approval or an uncertain send never
 * reaches SMTP again.
 */
export async function deliverEmail(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
) {
  const delivery = await deliveryRow(deps, applicantId, jobId);
  if (!delivery || delivery.status !== 'pending') return delivery ?? null;
  const job = await jobInfo(deps, applicantId, jobId);
  if (!deps.smtp.configured) {
    await pauseForProvider(
      deps,
      applicantId,
      job,
      new Error('Gmail SMTP is not configured'),
      'Email delivery',
    );
    return deliveryRow(deps, applicantId, jobId);
  }
  const sentToday = (
    await deps.db.query(
      "SELECT count(*)::int AS n FROM outreach_deliveries WHERE applicant_id=$1 AND accepted_at > now() - interval '24 hours'",
      [applicantId],
    )
  ).rows[0].n;
  if (sentToday >= deps.dailyEmailLimit) {
    await pauseForProvider(
      deps,
      applicantId,
      job,
      new Error(`daily email limit of ${deps.dailyEmailLimit} reached`),
      'Email delivery',
    );
    return deliveryRow(deps, applicantId, jobId);
  }
  const claimed = (
    await deps.db.query(
      "UPDATE outreach_deliveries SET status='sending',attempts=attempts+1 WHERE id=$1 AND applicant_id=$2 AND status='pending' RETURNING *",
      [delivery.id, applicantId],
    )
  ).rows[0];
  if (!claimed) return deliveryRow(deps, applicantId, jobId);
  inFlight.add(claimed.id);
  try {
    const result = await deps.smtp.send({
      to: claimed.to_address,
      subject: claimed.subject,
      body: claimed.body,
    });
    await deps.db.transaction(async (sql) => {
      await sql.query(
        "UPDATE outreach_deliveries SET status='accepted',accepted_at=now(),smtp_message_id=$3,smtp_response=$4 WHERE id=$1 AND applicant_id=$2",
        [claimed.id, applicantId, result.messageId, result.response],
      );
      await appendEvent(sql, applicantId, jobId, 'email.accepted', {
        deliveryId: claimed.id,
      });
    });
  } catch (error) {
    if (error instanceof SmtpTimeoutError) {
      await markUncertain(deps, applicantId, jobId, claimed.id);
    } else {
      // Refused before the message was accepted: nothing was sent, so it may be retried after review.
      await deps.db.query(
        "UPDATE outreach_deliveries SET status='pending' WHERE id=$1 AND applicant_id=$2 AND status='sending'",
        [claimed.id, applicantId],
      );
      await pauseForProvider(deps, applicantId, job, error, 'Email delivery');
    }
  } finally {
    inFlight.delete(claimed.id);
  }
  return deliveryRow(deps, applicantId, jobId);
}

/** A `sending` row not owned by this process was interrupted mid-send: its outcome is unknown. */
export async function recoverInterruptedSends(deps: OutreachDeps) {
  const rows = (
    await deps.db.query(
      "SELECT id,applicant_id,job_id FROM outreach_deliveries WHERE status='sending'",
    )
  ).rows;
  for (const row of rows)
    if (!inFlight.has(row.id))
      await markUncertain(deps, row.applicant_id, row.job_id, row.id);
}

/** Applicant's reconciliation of an uncertain send. Only "not sent" permits the single retry. */
export async function reconcileEmail(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
  sent: boolean,
) {
  await deps.db.transaction(async (sql) => {
    const ticket = await openOutreachTicketFor(sql, applicantId, jobId, [
      'uncertain_email',
    ]);
    if (!ticket) throw new HttpError(409, 'No uncertain email to reconcile');
    const delivery = (
      await sql.query(
        "SELECT * FROM outreach_deliveries WHERE applicant_id=$1 AND job_id=$2 AND status='uncertain' FOR UPDATE",
        [applicantId, jobId],
      )
    ).rows[0];
    if (!delivery) throw new HttpError(409, 'No uncertain email to reconcile');
    if (sent) {
      await sql.query(
        "UPDATE outreach_deliveries SET status='accepted',reconciled=true,accepted_at=now() WHERE id=$1",
        [delivery.id],
      );
      await appendEvent(sql, applicantId, jobId, 'email.accepted', {
        deliveryId: delivery.id,
      });
    } else {
      await sql.query(
        "UPDATE outreach_deliveries SET status='pending' WHERE id=$1",
        [delivery.id],
      );
    }
    await closeOutreachTicket(
      sql,
      applicantId,
      ticket.id,
      'no_change',
      sent ? 'Found in Gmail Sent' : 'Not sent; retry approved',
    );
  });
  return sent
    ? deliveryRow(deps, applicantId, jobId)
    : deliverEmail(deps, applicantId, jobId);
}

/** Manual LinkedIn invitation completion: a separate record from SMTP acceptance. */
export async function recordLinkedin(
  deps: OutreachDeps,
  applicantId: string,
  jobId: string,
) {
  return deps.db.transaction(async (sql) => {
    const review = (
      await sql.query(
        'SELECT * FROM outreach_reviews WHERE applicant_id=$1 AND job_id=$2 FOR UPDATE',
        [applicantId, jobId],
      )
    ).rows[0];
    if (!review || review.status !== 'approved')
      throw new HttpError(
        409,
        'Approve the outreach before recording the invitation',
      );
    if (review.linkedin_recorded_at)
      throw new HttpError(409, 'Invitation already recorded');
    await sql.query(
      'UPDATE outreach_reviews SET linkedin_recorded_at=now() WHERE id=$1 AND applicant_id=$2',
      [review.id, applicantId],
    );
    await appendEvent(sql, applicantId, jobId, 'linkedin.recorded', {
      contactId: review.candidate_id,
    });
    return { recorded: true };
  });
}
