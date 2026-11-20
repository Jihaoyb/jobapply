import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { id } from '../../shared/contracts.js';
import {
  createAnswerInput,
  editAnswerInput,
  ticketAnswerInput,
} from '../../shared/answers.js';
import type { Database } from '../db.js';
import {
  createAnswer,
  decideAlias,
  deleteAnswer,
  editAnswer,
  listAnswers,
  seedProfileAnswers,
} from './bank.js';
import { pendingQuestions, resolveAnswerTicket } from './session.js';

export interface AnswerRouteDeps {
  /** Dashboard session check from app.ts; `mutation` also enforces the dashboard Origin. */
  dashboardOwner(req: FastifyRequest, mutation?: boolean): Promise<string>;
}
const param = (req: FastifyRequest) =>
  id.parse((req.params as { id: string }).id);

/** Dashboard-only answer bank routes. The extension credential has no access. */
export async function registerAnswerRoutes(
  app: FastifyInstance,
  db: Database,
  deps: AnswerRouteDeps,
) {
  app.get('/api/answers', async (req) =>
    listAnswers(db, await deps.dashboardOwner(req)),
  );
  app.post('/api/answers', async (req) =>
    createAnswer(
      db,
      await deps.dashboardOwner(req, true),
      createAnswerInput.parse(req.body),
    ),
  );
  app.patch('/api/answers/:id', async (req) =>
    editAnswer(
      db,
      await deps.dashboardOwner(req, true),
      param(req),
      editAnswerInput.parse(req.body),
    ),
  );
  app.delete('/api/answers/:id', async (req) =>
    deleteAnswer(db, await deps.dashboardOwner(req, true), param(req)),
  );
  app.post('/api/answers/seed', async (req) =>
    seedProfileAnswers(db, await deps.dashboardOwner(req, true)),
  );
  app.post('/api/answers/aliases/:id/decision', async (req) =>
    decideAlias(
      db,
      await deps.dashboardOwner(req, true),
      param(req),
      z.object({ status: z.enum(['approved', 'rejected']) }).parse(req.body)
        .status,
    ),
  );
  app.get('/api/answers/questions', async (req) => ({
    questions: await pendingQuestions(db, await deps.dashboardOwner(req)),
  }));
  app.post('/api/answers/questions/:id/resolve', async (req) =>
    resolveAnswerTicket(
      db,
      await deps.dashboardOwner(req, true),
      param(req),
      ticketAnswerInput.parse(req.body),
    ),
  );
}
