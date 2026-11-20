import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { id } from '../../shared/contracts.js';
import {
  aliasInput,
  capSettingsInput,
  distinctInput,
  employerPatch,
  identityResolution,
  importInput,
  mergeInput,
  type EmployerView,
  type QueueItemView,
} from '../../shared/identity.js';
import type { Database } from '../db.js';
import { HttpError } from '../ledger.js';
import {
  activeEmployer,
  canonicalEmployer,
  markDistinct,
  mergeEmployers,
  mergeSuggestions,
  type EmployerRow,
} from './employers.js';
import { employerCap, employerHolds, getCapSettings } from './gate.js';
import { importHistory } from './importer.js';
import {
  isEmployerDomain,
  normalizeDomain,
  parseIdentityKey,
} from './normalize.js';
import { requeueCapped } from './queue.js';
import { resolveIdentityTicket } from './resolve.js';
import { lockApplicant } from './tickets.js';

export interface IdentityRouteAuth {
  dashboardOwner(req: FastifyRequest, mutation?: boolean): Promise<string>;
}
const param = (req: FastifyRequest) =>
  id.parse((req.params as { id: string }).id);

export async function listEmployers(
  db: Database,
  owner: string,
  now = new Date(),
): Promise<EmployerView[]> {
  const employers = (
    await db.query(
      'SELECT id,name,domain FROM employers WHERE applicant_id=$1 AND merged_into IS NULL ORDER BY lower(name),id',
      [owner],
    )
  ).rows;
  const aliases = (
    await db.query(
      'SELECT id,alias_key,kind,source,employer_id FROM employer_aliases WHERE applicant_id=$1 ORDER BY alias_key',
      [owner],
    )
  ).rows;
  const links = (
    await db.query(
      'SELECT * FROM employer_links WHERE applicant_id=$1 ORDER BY created_at',
      [owner],
    )
  ).rows;
  const merged = (
    await db.query(
      'SELECT name,merged_into FROM employers WHERE applicant_id=$1 AND merged_into IS NOT NULL',
      [owner],
    )
  ).rows;
  const views: EmployerView[] = [];
  for (const employer of employers) {
    const cap = await employerCap(db, owner, employer.id, now);
    views.push({
      id: employer.id,
      name: employer.name,
      domain: employer.domain,
      aliases: aliases
        .filter((alias) => alias.employer_id === employer.id)
        .map((alias) => ({
          id: alias.id,
          key: alias.alias_key,
          kind: alias.kind,
          source: alias.source,
        })),
      links: links
        .filter((link) => link.employer_id === employer.id)
        .map((link) => ({
          domainKey: link.domain_key,
          atsKey: link.ats_key,
          relation: link.relation,
          careersUrl: link.careers_url,
          atsUrl: link.ats_url,
          status: link.status,
        })),
      mergedFrom: merged
        .filter((row) => row.merged_into === employer.id)
        .map((row) => row.name),
      cap: {
        count: cap.count,
        limit: cap.limit,
        capped: cap.capped,
        windowStart: cap.windowStart,
        nextAvailableDate: cap.nextAvailableDate,
        heldBy: await employerHolds(db, owner, employer.id),
      },
    });
  }
  return views;
}

export async function listQueue(
  db: Database,
  owner: string,
  now = new Date(),
): Promise<QueueItemView[]> {
  const rows = (
    await db.query(
      `SELECT q.job_id,q.state,q.hold_reason,q.stop_reason,j.title,j.employer,j.status,j.canonical_employer_id
       FROM work_queue q JOIN jobs j ON j.id=q.job_id
       WHERE q.applicant_id=$1 AND (q.state<>'done' AND q.state<>'stopped' OR q.stop_reason='capped')
       ORDER BY q.enqueued_at,q.job_id LIMIT 200`,
      [owner],
    )
  ).rows;
  const items: QueueItemView[] = [];
  for (const row of rows) {
    const employerId = await canonicalEmployer(
      db,
      owner,
      row.canonical_employer_id,
    );
    // Queued jobs show the cap they will meet at dequeue; capped jobs show when to revisit.
    const cap = employerId
      ? await employerCap(db, owner, employerId, now)
      : null;
    items.push({
      jobId: row.job_id,
      title: row.title,
      employer: row.employer,
      jobStatus: row.status,
      state: row.state,
      holdReason: row.hold_reason,
      stopReason: row.stop_reason,
      nextAvailableDate: cap?.capped ? cap.nextAvailableDate : null,
    });
  }
  return items;
}

/** Dashboard routes (session + Origin checks reuse the app's dashboardOwner). */
export async function registerIdentityRoutes(
  app: FastifyInstance,
  db: Database,
  auth: IdentityRouteAuth,
) {
  app.get('/api/identity/employers', async (req) => {
    const owner = await auth.dashboardOwner(req);
    return {
      employers: await listEmployers(db, owner),
      suggestions: await mergeSuggestions(db, owner),
    };
  });
  app.patch('/api/identity/employers/:id', async (req) => {
    const owner = await auth.dashboardOwner(req, true);
    const employerId = param(req);
    const input = employerPatch.parse(req.body);
    let domain: string | null | undefined = input.domain;
    if (domain) {
      const normalized = normalizeDomain(domain);
      if (!normalized || !isEmployerDomain(normalized))
        throw new HttpError(
          400,
          'Enter the employer’s own domain, e.g. acme.example',
        );
      domain = normalized;
    }
    return db.transaction(async (sql) => {
      await lockApplicant(sql, owner);
      await activeEmployer(sql, owner, employerId);
      if (input.name !== undefined)
        await sql.query(
          'UPDATE employers SET name=$3 WHERE id=$1 AND applicant_id=$2',
          [employerId, owner, input.name],
        );
      if (domain !== undefined)
        await sql.query(
          'UPDATE employers SET domain=$3 WHERE id=$1 AND applicant_id=$2',
          [employerId, owner, domain || null],
        );
      return activeEmployer(sql, owner, employerId);
    });
  });
  app.post('/api/identity/employers/:id/merge', async (req) => {
    const owner = await auth.dashboardOwner(req, true);
    const sourceId = param(req);
    const { intoEmployerId } = mergeInput.parse(req.body);
    await db.transaction(async (sql) => {
      await lockApplicant(sql, owner);
      await mergeEmployers(sql, owner, sourceId, intoEmployerId);
    });
    return { merged: true };
  });
  app.post('/api/identity/employers/:id/distinct', async (req) => {
    const owner = await auth.dashboardOwner(req, true);
    const employerId = param(req);
    const { otherEmployerId } = distinctInput.parse(req.body);
    await db.transaction(async (sql) => {
      await activeEmployer(sql, owner, employerId);
      await activeEmployer(sql, owner, otherEmployerId);
      await markDistinct(sql, owner, employerId, otherEmployerId);
    });
    return { distinct: true };
  });
  app.post('/api/identity/aliases', async (req) => {
    const owner = await auth.dashboardOwner(req, true);
    const input = aliasInput.parse(req.body);
    const key = parseIdentityKey(input.key);
    if (!key)
      throw new HttpError(
        400,
        'Use an employer domain (acme.example) or provider:slug (greenhouse:acme, lever:acme, ashby:acme)',
      );
    return db.transaction(async (sql) => {
      await lockApplicant(sql, owner);
      await activeEmployer(sql, owner, input.employerId);
      const row = (
        await sql.query(
          `INSERT INTO employer_aliases (id,applicant_id,alias_key,kind,employer_id,source) VALUES ($1,$2,$3,$4,$5,'manual')
           ON CONFLICT (applicant_id,alias_key) DO UPDATE SET employer_id=EXCLUDED.employer_id,source='manual',updated_at=now()
           RETURNING id,alias_key AS key,kind,employer_id AS "employerId"`,
          [randomUUID(), owner, key.key, key.kind, input.employerId],
        )
      ).rows[0];
      if (key.kind === 'domain')
        await sql.query(
          'UPDATE employers SET domain=$3 WHERE id=$1 AND applicant_id=$2 AND domain IS NULL',
          [input.employerId, owner, key.key],
        );
      return row;
    });
  });
  app.delete('/api/identity/aliases/:id', async (req) => {
    const owner = await auth.dashboardOwner(req, true);
    const result = await db.query(
      'DELETE FROM employer_aliases WHERE id=$1 AND applicant_id=$2 RETURNING id',
      [param(req), owner],
    );
    if (!result.rows.length) throw new HttpError(404, 'Alias not found');
    return { deleted: true };
  });
  app.get('/api/identity/tickets', async (req) => {
    const owner = await auth.dashboardOwner(req);
    const rows = (
      await db.query(
        `SELECT it.ticket_id,it.kind,it.candidate_employer_ids,it.unmapped_keys,it.employer_name
         FROM identity_tickets it JOIN tickets t ON t.id=it.ticket_id
         WHERE it.applicant_id=$1 AND t.status='open' ORDER BY t.opened_at`,
        [owner],
      )
    ).rows;
    const tickets = [];
    for (const row of rows) {
      const candidates: EmployerRow[] = [];
      for (const candidateId of row.candidate_employer_ids as string[]) {
        const current = await canonicalEmployer(db, owner, candidateId);
        if (current && !candidates.some((c) => c.id === current))
          candidates.push(await activeEmployer(db, owner, current));
      }
      tickets.push({
        ticketId: row.ticket_id,
        kind: row.kind,
        employerName: row.employer_name,
        keys: (row.unmapped_keys as { key: string }[]).map((key) => key.key),
        candidates,
      });
    }
    return { tickets };
  });
  app.post('/api/identity/tickets/:id/resolve', async (req) => {
    const owner = await auth.dashboardOwner(req, true);
    return resolveIdentityTicket(
      db,
      owner,
      param(req),
      identityResolution.parse(req.body),
    );
  });
  app.post('/api/identity/imports', { bodyLimit: 1_000_000 }, async (req) => {
    const owner = await auth.dashboardOwner(req, true);
    return importHistory(db, owner, importInput.parse(req.body));
  });
  app.get('/api/identity/imports', async (req) => {
    const owner = await auth.dashboardOwner(req);
    const batches = (
      await db.query(
        'SELECT id,filename,summary,created_at AS "createdAt" FROM import_batches WHERE applicant_id=$1 ORDER BY created_at DESC LIMIT 20',
        [owner],
      )
    ).rows;
    return { batches };
  });
  app.get('/api/identity/queue', async (req) => {
    const owner = await auth.dashboardOwner(req);
    return { items: await listQueue(db, owner) };
  });
  app.post('/api/identity/jobs/:id/requeue', async (req) => {
    const owner = await auth.dashboardOwner(req, true);
    await requeueCapped(db, owner, param(req));
    return { requeued: true };
  });
  app.get('/api/identity/cap-settings', async (req) => {
    const owner = await auth.dashboardOwner(req);
    return getCapSettings(db, owner);
  });
  app.put('/api/identity/cap-settings', async (req) => {
    const owner = await auth.dashboardOwner(req, true);
    const input = capSettingsInput.parse(req.body);
    await db.query(
      `INSERT INTO cap_settings (applicant_id,cap_limit,window_months) VALUES ($1,$2,$3)
       ON CONFLICT (applicant_id) DO UPDATE SET cap_limit=EXCLUDED.cap_limit,window_months=EXCLUDED.window_months,updated_at=now()`,
      [owner, input.limit, input.windowMonths],
    );
    return input;
  });
}
