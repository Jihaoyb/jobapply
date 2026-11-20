import type { FastifyInstance, FastifyRequest } from 'fastify';
import { id } from '../../shared/contracts.js';
import {
  eligibilityTicketDecision,
  type EligibilityGateView,
  type EligibilityView,
} from '../../shared/eligibility.js';
import type { Database } from '../db.js';
import {
  replayGate,
  resolveEligibilityTicket,
  retryEligibilityTicket,
  type EligibilityDeps,
} from './decide.js';
import { configuredSolModel, PROMPT_VERSION } from './sol.js';

function viewFromRow(row: any): EligibilityView {
  return {
    decisionId: row.id,
    jobId: row.job_id,
    title: row.title,
    employer: row.employer,
    jobStatus: row.job_status,
    source: row.source,
    route: row.route,
    decision: row.decision,
    provenance: row.provenance,
    evidence: row.evidence,
    ruleId: row.rule_id,
    reason: row.reason,
    rationale: row.rationale,
    model: row.model,
    promptVersion: row.prompt_version,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    ticketId: row.ticket_id,
    ticketOpen: row.ticket_status === 'open',
    ticketCause: row.ticket_cause,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Dashboard routes for issue 005. No route starts screening for an arbitrary
 * job: the worker (lane A gate, 007 form flow) calls decideEligibility.
 */
export async function registerEligibilityRoutes(
  app: FastifyInstance,
  db: Database,
  deps: {
    dashboardOwner: (
      req: FastifyRequest,
      mutation?: boolean,
    ) => Promise<string>;
    eligibility?: EligibilityDeps;
  },
) {
  app.get('/api/eligibility', async (req) => {
    const owner = await deps.dashboardOwner(req);
    const rows = (
      await db.query(
        `SELECT DISTINCT ON (d.job_id) d.*, j.title, j.employer, j.status AS job_status,
           m.model, m.input_tokens, m.output_tokens, t.status AS ticket_status, t.cause AS ticket_cause
         FROM eligibility_decisions d
         JOIN jobs j ON j.id=d.job_id AND j.applicant_id=d.applicant_id
         LEFT JOIN model_calls m ON m.id=d.model_call_id AND m.applicant_id=d.applicant_id
         LEFT JOIN tickets t ON t.id=d.ticket_id AND t.applicant_id=d.applicant_id
         WHERE d.applicant_id=$1
         ORDER BY d.job_id, d.created_at DESC, d.id DESC`,
        [owner],
      )
    ).rows;
    const decisions = rows
      .map(viewFromRow)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 200);
    const solModel = deps.eligibility?.solModel ?? configuredSolModel();
    const gate: EligibilityGateView = {
      ...replayGate(solModel),
      solModel,
      promptVersion: PROMPT_VERSION,
    };
    return { decisions, gate };
  });
  app.post('/api/eligibility/tickets/:id/decide', async (req) => {
    const owner = await deps.dashboardOwner(req, true);
    return resolveEligibilityTicket(
      db,
      owner,
      id.parse((req.params as { id: string }).id),
      eligibilityTicketDecision.parse(req.body),
    );
  });
  app.post('/api/eligibility/tickets/:id/retry', async (req) => {
    const owner = await deps.dashboardOwner(req, true);
    return retryEligibilityTicket(
      db,
      owner,
      id.parse((req.params as { id: string }).id),
      deps.eligibility,
    );
  });
}
