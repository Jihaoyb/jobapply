import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { Database } from './db.js';
import {
  hashToken,
  opaqueToken,
  verifyPassword,
  hashPassword,
} from './auth.js';
import { captureInput, id } from '../shared/contracts.js';
import {
  captureJob,
  HttpError,
  jobFromRow,
  ticketFromRow,
  resolveTicket,
  resolutionInput,
} from './ledger.js';
import { registerAnswerRoutes } from './answers/routes.js';
import { registerReportRoutes } from './report/routes.js';
import { registerOutreachRoutes } from './outreach/routes.js';
import { registerEligibilityRoutes } from './eligibility/routes.js';

export interface AppConfig {
  origin: string;
  production: boolean;
  staticRoot?: string;
}
export async function createApp(db: Database, config: AppConfig) {
  // 150k posting chars can exceed 450 KB as UTF-8 JSON; leave headroom.
  const app = Fastify({
    bodyLimit: 1_000_000,
    logger: config.production
      ? {
          level: 'info',
          redact: ['req.headers.authorization', 'req.headers.cookie'],
        }
      : false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const dummyPassword = hashPassword(opaqueToken());
  const cookieName = config.production ? '__Host-jobapply' : 'jobapply';
  const cookieOptions = {
    httpOnly: true,
    secure: config.production,
    sameSite: 'strict' as const,
    path: '/',
  };
  app.addHook('onSend', async (_req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      )
      .header('Cache-Control', 'no-store');
    if (config.production)
      reply.header('Strict-Transport-Security', 'max-age=31536000');
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: 'Invalid input',
        fields: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    const status = (error as { statusCode?: number }).statusCode;
    if (error instanceof HttpError || (status && status >= 400 && status < 500))
      return reply.code(status ?? 400).send({
        error: error instanceof Error ? error.message : 'Invalid request',
      });
    // Log name/message/stack only: never request bodies, SQL parameters or credentials.
    const failure = error instanceof Error ? error : new Error(String(error));
    req.log.error(
      {
        err: {
          name: failure.name,
          message: failure.message,
          stack: failure.stack,
        },
      },
      'Request failed',
    );
    // Never return database errors, SQL parameters, credentials, or posting text.
    return reply.code(500).send({ error: 'Request failed' });
  });
  function checkOrigin(req: FastifyRequest) {
    if (req.headers.origin !== config.origin)
      throw new HttpError(403, 'Dashboard origin required');
  }
  async function dashboardOwner(req: FastifyRequest, mutation = false) {
    if (mutation) checkOrigin(req);
    const token = req.cookies[cookieName];
    if (!token || token.length > 200)
      throw new HttpError(401, 'Sign in required');
    const result = await db.query(
      'SELECT applicant_id FROM sessions WHERE token_hash=$1 AND expires_at>now()',
      [hashToken(token)],
    );
    if (!result.rows.length) throw new HttpError(401, 'Sign in required');
    return result.rows[0].applicant_id as string;
  }
  async function extensionOwner(req: FastifyRequest, ownerId: string) {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.length > 250)
      throw new HttpError(401, 'Pairing token required');
    const result = await db.query(
      'SELECT applicant_id FROM pairing_tokens WHERE token_hash=$1 AND revoked_at IS NULL',
      [hashToken(authorization.slice(7))],
    );
    if (!result.rows.length || result.rows[0].applicant_id !== ownerId)
      throw new HttpError(401, 'Invalid pairing token');
    return ownerId;
  }
  app.get('/healthz', async () => {
    await db.query('SELECT 1');
    return { status: 'ok' };
  });
  app.post(
    '/api/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      checkOrigin(req);
      const input = z
        .object({
          email: z.email().max(320),
          password: z.string().min(1).max(1000),
        })
        .parse(req.body);
      const row = (
        await db.query(
          'SELECT id,password_hash FROM applicants WHERE email=$1',
          [input.email.toLowerCase()],
        )
      ).rows[0];
      const valid = verifyPassword(
        input.password,
        row?.password_hash ?? dummyPassword,
      );
      if (!valid || !row) throw new HttpError(401, 'Invalid email or password');
      const token = opaqueToken();
      await db.transaction(async (sql) => {
        await sql.query('DELETE FROM sessions WHERE expires_at<=now()');
        // Rotate an existing browser session instead of leaving it active.
        if (req.cookies[cookieName])
          await sql.query('DELETE FROM sessions WHERE token_hash=$1', [
            hashToken(req.cookies[cookieName]!),
          ]);
        await sql.query(
          "INSERT INTO sessions (token_hash,applicant_id,expires_at) VALUES ($1,$2,now()+interval '7 days')",
          [hashToken(token), row.id],
        );
      });
      reply.setCookie(cookieName, token, {
        ...cookieOptions,
        maxAge: 7 * 86400,
      });
      return { applicantId: row.id };
    },
  );
  app.post('/api/logout', async (req, reply) => {
    await dashboardOwner(req, true);
    await db.query('DELETE FROM sessions WHERE token_hash=$1', [
      hashToken(req.cookies[cookieName]!),
    ]);
    reply.clearCookie(cookieName, cookieOptions);
    return { signedOut: true };
  });
  app.get('/api/me', async (req) => ({
    applicantId: await dashboardOwner(req),
  }));
  app.get('/api/pairings', async (req) => {
    const owner = await dashboardOwner(req);
    const result = await db.query(
      'SELECT id,label,created_at AS "createdAt",revoked_at AS "revokedAt" FROM pairing_tokens WHERE applicant_id=$1 ORDER BY created_at DESC',
      [owner],
    );
    return { pairings: result.rows };
  });
  app.post('/api/pairings', async (req) => {
    const owner = await dashboardOwner(req, true);
    const { label } = z
      .object({ label: z.string().trim().min(1).max(100) })
      .parse(req.body);
    const token = opaqueToken(),
      pairingId = randomUUID();
    await db.query(
      'INSERT INTO pairing_tokens (id,applicant_id,token_hash,label) VALUES ($1,$2,$3,$4)',
      [pairingId, owner, hashToken(token), label],
    );
    return {
      id: pairingId,
      token,
      applicantId: owner,
      serverUrl: config.origin,
    };
  });
  app.delete('/api/pairings/:id', async (req) => {
    const owner = await dashboardOwner(req, true);
    const pairingId = id.parse((req.params as { id: string }).id);
    const result = await db.query(
      'UPDATE pairing_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND applicant_id=$2 RETURNING id',
      [pairingId, owner],
    );
    if (!result.rows.length) throw new HttpError(404, 'Pairing not found');
    return { revoked: true };
  });
  app.get('/api/jobs', async (req) => {
    const owner = await dashboardOwner(req);
    const result = await db.query(
      'SELECT * FROM jobs WHERE applicant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200',
      [owner],
    );
    return { jobs: result.rows.map(jobFromRow) };
  });
  app.post('/api/jobs', async (req) =>
    captureJob(
      db,
      await dashboardOwner(req, true),
      captureInput.parse(req.body),
      'manual',
    ),
  );
  app.get('/api/events', async (req) => {
    const owner = await dashboardOwner(req);
    const result = await db.query(
      'SELECT id,applicant_id AS "applicantId",job_id AS "jobId",name,occurred_at AS "occurredAt",schema_version AS "schemaVersion",payload FROM ledger_events WHERE applicant_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 1000',
      [owner],
    );
    // Newest 1000, returned oldest-first so consumers keep chronological order.
    return { events: result.rows.reverse() };
  });
  app.get('/api/tickets', async (req) => {
    const owner = await dashboardOwner(req);
    return {
      tickets: (
        await db.query(
          "SELECT * FROM tickets WHERE applicant_id=$1 AND status='open' ORDER BY opened_at",
          [owner],
        )
      ).rows.map(ticketFromRow),
    };
  });
  app.post('/api/tickets/:id/resolve', async (req) => {
    const owner = await dashboardOwner(req, true);
    return resolveTicket(
      db,
      owner,
      id.parse((req.params as { id: string }).id),
      resolutionInput.parse(req.body),
    );
  });
  await registerEligibilityRoutes(app, db, { dashboardOwner });
  app.get('/api/extension/:ownerId/pairing', async (req) => {
    const owner = id.parse((req.params as { ownerId: string }).ownerId);
    return { applicantId: await extensionOwner(req, owner) };
  });
  app.post('/api/extension/:ownerId/captures', async (req) => {
    const owner = id.parse((req.params as { ownerId: string }).ownerId);
    await extensionOwner(req, owner);
    return captureJob(db, owner, captureInput.parse(req.body), 'extension');
  });
  await registerAnswerRoutes(app, db, { dashboardOwner });
  await registerReportRoutes(app, db, dashboardOwner);
  await registerOutreachRoutes(app, db, dashboardOwner, config);
  // The extension credential intentionally has no access to ledger read/admin APIs.
  if (config.staticRoot) {
    await app.register(staticFiles, { root: config.staticRoot });
    app.get('/', (_req, reply) => reply.sendFile('index.html'));
  }
  return app;
}
