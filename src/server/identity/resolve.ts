/**
 * Domain handler for employer_identity (resolve_employer) and import_ambiguity (resolve_import)
 * tickets: the employer decision, alias updates, history merge and ticket/pause close commit in
 * one transaction, then the job continues through the gate.
 */
import type { Database } from '../db.js';
import { HttpError } from '../ledger.js';
import type { IdentityResolution } from '../../shared/identity.js';
import {
  activeEmployer,
  addAlias,
  canonicalEmployer,
  createEmployer,
  markDistinct,
  mergeEmployers,
} from './employers.js';
import { classifyJob, recordCareersLink, type GateResult } from './gate.js';
import { resolvePendingImportRows } from './importer.js';
import { deriveJobKeys, type IdentityKey } from './normalize.js';
import { resumeQueuedTx } from './queue.js';
import { closeTicketTx, lockApplicant } from './tickets.js';

export async function resolveIdentityTicket(
  db: Database,
  applicantId: string,
  ticketId: string,
  input: IdentityResolution,
  now = new Date(),
): Promise<{
  employerId: string;
  gate?: GateResult;
  imported?: { counted: number; linked: number };
}> {
  return db.transaction(async (sql) => {
    await lockApplicant(sql, applicantId);
    const ticket = (
      await sql.query(
        'SELECT * FROM tickets WHERE id=$1 AND applicant_id=$2 FOR UPDATE',
        [ticketId, applicantId],
      )
    ).rows[0];
    if (!ticket) throw new HttpError(404, 'Ticket not found');
    if (ticket.status !== 'open')
      throw new HttpError(409, 'Ticket already resolved');
    const context = (
      await sql.query(
        'SELECT * FROM identity_tickets WHERE ticket_id=$1 AND applicant_id=$2',
        [ticketId, applicantId],
      )
    ).rows[0];
    if (!context)
      throw new HttpError(
        409,
        'This ticket is not an employer identity ticket',
      );
    const candidates: string[] = [];
    for (const id of context.candidate_employer_ids as string[]) {
      const current = await canonicalEmployer(sql, applicantId, id);
      if (current && !candidates.includes(current)) candidates.push(current);
    }
    let target: string;
    let description: string;
    if (input.action === 'create') {
      target = await createEmployer(
        sql,
        applicantId,
        input.name?.trim() || context.employer_name,
      );
      for (const candidate of candidates)
        await markDistinct(sql, applicantId, target, candidate);
      description = 'Created a new employer';
    } else {
      const chosen = await canonicalEmployer(
        sql,
        applicantId,
        input.employerId,
      );
      if (!chosen) throw new HttpError(404, 'Employer not found');
      target = (await activeEmployer(sql, applicantId, chosen)).id;
      if (input.action === 'merge') {
        if (!candidates.includes(target))
          throw new HttpError(400, 'Merge into one of the ticket’s employers');
        for (const candidate of candidates)
          if (candidate !== target)
            await mergeEmployers(sql, applicantId, candidate, target);
        description = 'Merged employers';
      } else description = 'Assigned to an existing employer';
    }
    const source = context.kind === 'import' ? 'import' : 'ticket';
    for (const key of context.unmapped_keys as IdentityKey[])
      await addAlias(sql, applicantId, key, target, source);
    if (context.kind === 'import') {
      const imported = await resolvePendingImportRows(
        sql,
        applicantId,
        ticketId,
        target,
      );
      await closeTicketTx(
        sql,
        applicantId,
        ticket,
        { outcome: 'approved', value: description },
        imported.hostStatus,
      );
      return {
        employerId: target,
        imported: { counted: imported.counted, linked: imported.linked },
      };
    }
    await sql.query(
      "UPDATE employer_links SET status=$3,employer_id=$4 WHERE job_id=$1 AND applicant_id=$2 AND status='conflict'",
      [
        ticket.job_id,
        applicantId,
        input.action === 'merge' ? 'linked' : 'resolved',
        target,
      ],
    );
    if (context.kind === 'plausible') {
      const job = (
        await sql.query('SELECT * FROM jobs WHERE id=$1 AND applicant_id=$2', [
          ticket.job_id,
          applicantId,
        ])
      ).rows[0];
      const keys = deriveJobKeys({
        title: job.title,
        discoveryUrl: job.discovery_url,
        applicationUrl: job.application_url,
        postingText: job.posting_text,
      });
      await recordCareersLink(sql, applicantId, job.id, keys, target, 'linked');
    }
    await sql.query(
      'UPDATE jobs SET canonical_employer_id=$3 WHERE id=$1 AND applicant_id=$2',
      [ticket.job_id, applicantId, target],
    );
    await closeTicketTx(
      sql,
      applicantId,
      ticket,
      { outcome: 'approved', value: description },
      ticket.resume_status,
    );
    const gate = await classifyJob(sql, applicantId, ticket.job_id, now);
    if (gate.status === 'ok' || gate.status === 'held')
      await resumeQueuedTx(sql, applicantId, ticket.job_id);
    return { employerId: target, gate };
  });
}
