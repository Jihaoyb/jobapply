import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../db.js';
import {
  reportQuery,
  sampleCompleteInput,
  sampleDrawInput,
  sampleIdParam,
} from '../../shared/report.js';
import { computeReport } from './compute.js';
import { loadReportLedger } from './load.js';
import {
  completeSampleReview,
  drawReviewSample,
  listSamples,
} from './sampling.js';

type DashboardOwner = (
  req: FastifyRequest,
  mutation?: boolean,
) => Promise<string>;

/** Pilot report API. Every route is dashboard-session scoped; mutations need the dashboard Origin. */
export async function registerReportRoutes(
  app: FastifyInstance,
  db: Database,
  dashboardOwner: DashboardOwner,
) {
  app.get('/api/report', async (req) => {
    const owner = await dashboardOwner(req);
    const { clockStart } = reportQuery.parse(req.query);
    return computeReport(await loadReportLedger(db, owner), {
      now: new Date(),
      clockStart: clockStart ? new Date(clockStart) : undefined,
    });
  });
  app.get('/api/report/samples', async (req) => ({
    samples: await listSamples(db, await dashboardOwner(req)),
  }));
  app.post('/api/report/samples', async (req) => {
    const owner = await dashboardOwner(req, true);
    const input = sampleDrawInput.parse(req.body ?? {});
    return drawReviewSample(db, owner, {
      now: new Date(),
      clockStart: input.clockStart ? new Date(input.clockStart) : undefined,
      seed: input.seed,
    });
  });
  app.post('/api/report/samples/:sampleId/complete', async (req) => {
    const owner = await dashboardOwner(req, true);
    const { sampleId } = sampleIdParam.parse(req.params);
    const { outcome } = sampleCompleteInput.parse(req.body);
    return completeSampleReview(db, owner, sampleId, outcome);
  });
}
