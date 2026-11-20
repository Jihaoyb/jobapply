/**
 * Answer-equivalence calibration harness (issue 006).
 *   npm run answers:calibrate            # offline, deterministic fake Luna transport
 *   npm run answers:calibrate -- --live  # human-run: real Luna via OPENAI_API_KEY (server env)
 * Chooses the threshold on the calibration pairs and reports precision/recall on held-out
 * pairs. Calls go through the shared model wrapper against a throwaway in-memory database
 * holding one synthetic applicant and job. Exits 1 when held-out precision misses the target.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { localDatabase } from './local-db.js';
import { migrate } from '../src/server/db.js';
import { configuredModelCaller, modelCaller } from '../src/server/model.js';
import {
  runCalibration,
  type LabeledPair,
} from '../src/server/answers/calibration.js';
import { fakeLunaTransport } from '../tests/fixtures/answers/fake-luna.js';

const live = process.argv.includes('--live');
const minPrecision = Number(
  process.argv.find((a) => a.startsWith('--min-precision='))?.split('=')[1] ??
    1,
);
if (live && !process.env.OPENAI_API_KEY)
  throw new Error('Set OPENAI_API_KEY in the server environment for --live');
const load = async (name: string): Promise<LabeledPair[]> =>
  JSON.parse(
    await readFile(
      new URL(`../tests/fixtures/answers/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
const db = localDatabase();
try {
  await migrate(db);
  const applicantId = randomUUID(),
    jobId = randomUUID();
  await db.query(
    "INSERT INTO applicants (id,email,password_hash) VALUES ($1,'calibration@example.invalid','unused')",
    [applicantId],
  );
  await db.query(
    `INSERT INTO jobs (id,applicant_id,client_capture_id,title,employer,discovery_url,application_url,posting_text,source,status,application_host,supported_host)
     VALUES ($1,$2,$3,'Calibration','Synthetic Employer','https://example.com/d','https://example.com/a','synthetic','manual','captured','example.com',false)`,
    [jobId, applicantId, randomUUID()],
  );
  const callModel = live
    ? configuredModelCaller(db)
    : modelCaller(
        db,
        { apiKey: 'offline', solModel: 'unused', lunaModel: 'fake-luna' },
        fakeLunaTransport().transport,
      );
  const report = await runCalibration(
    callModel,
    { applicantId, jobId },
    await load('calibration'),
    await load('heldout'),
    minPrecision,
  );
  const usage = (
    await db.query(
      "SELECT model, count(*)::int AS calls, sum(input_tokens)::int AS input, sum(output_tokens)::int AS output, count(*) FILTER (WHERE status='failed')::int AS failed FROM model_calls GROUP BY model",
    )
  ).rows;
  console.log(
    JSON.stringify({ mode: live ? 'live' : 'fake', ...report, usage }, null, 2),
  );
  console.log(
    `\nChosen threshold ${report.calibration.threshold} | calibration P=${report.calibration.precision.toFixed(3)} R=${report.calibration.recall.toFixed(3)} | held-out P=${report.heldout.precision.toFixed(3)} R=${report.heldout.recall.toFixed(3)}`,
  );
  if (live)
    console.log(
      `Set ANSWER_EQUIVALENCE_THRESHOLD=${report.calibration.threshold} on the server once reviewed.`,
    );
  process.exitCode = report.passed ? 0 : 1;
} finally {
  await db.close();
}
