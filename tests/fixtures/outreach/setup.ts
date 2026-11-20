import { randomUUID } from 'node:crypto';
import { hashPassword } from '../../../src/server/auth.js';
import { migrate } from '../../../src/server/db.js';
import { createApp, type AppConfig } from '../../../src/server/app.js';
import { appendEvent, captureJob } from '../../../src/server/ledger.js';
import { modelCaller } from '../../../src/server/model.js';
import type { OutreachDeps } from '../../../src/server/outreach/deps.js';
import { localDatabase } from '../../../scripts/local-db.js';
import { origin, password } from '../../helpers.js';
import { FakeApollo, FakeSmtp, fakeLuna } from './fakes.js';

const passwordHash = hashPassword(password);

/** App + fakes for lane D tests. Synthetic applicant, employers and people only. */
export async function outreachFixture() {
  const db = localDatabase();
  await migrate(db);
  const alice: string = randomUUID(),
    bob: string = randomUUID();
  await db.query(
    'INSERT INTO applicants (id,email,password_hash) VALUES ($1,$2,$3),($4,$5,$3)',
    [alice, 'alice@example.com', passwordHash, bob, 'bob@example.com'],
  );
  const apollo = new FakeApollo(),
    smtp = new FakeSmtp(),
    luna = fakeLuna();
  const logs: Array<{ message: string; data: Record<string, unknown> }> = [];
  const deps: OutreachDeps = {
    db,
    apollo,
    smtp,
    callModel: modelCaller(
      db,
      { apiKey: 'test-key', solModel: 'test-sol', lunaModel: 'test-luna' },
      luna.transport,
    ),
    dailyEmailLimit: 20,
    log: (message, data) => logs.push({ message, data }),
  };
  const config: AppConfig & { outreach: OutreachDeps } = {
    origin,
    production: false,
    outreach: deps,
  };
  const app = await createApp(db, config);
  async function login(email = 'alice@example.com') {
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin },
      payload: { email, password },
    });
    if (response.statusCode !== 200) throw new Error(response.body);
    return response.cookies[0].name + '=' + response.cookies[0].value;
  }
  const cookie = await login();
  async function employer(
    name = 'Northwind Example',
    domain: string | null = 'northwind.example',
    owner = alice,
  ) {
    const employerId = randomUUID();
    await db.query(
      'INSERT INTO employers (id,applicant_id,name,domain) VALUES ($1,$2,$3,$4)',
      [employerId, owner, name, domain],
    );
    return employerId;
  }
  /** A captured job moved to `status` with a fixture application.confirmed event. */
  async function job(
    options: {
      status?: 'confirmed' | 'uncertain' | 'submitting';
      employerId?: string | null;
      applicationUrl?: string;
      postingText?: string;
      owner?: string;
    } = {},
  ) {
    const owner = options.owner ?? alice;
    const created = await captureJob(
      db,
      owner,
      {
        clientCaptureId: randomUUID(),
        title: 'Software Engineer',
        employer: 'Northwind Example',
        discoveryUrl: 'https://www.linkedin.com/jobs/view/987',
        applicationUrl:
          options.applicationUrl ??
          'https://boards.greenhouse.io/northwind/jobs/1',
        postingText:
          options.postingText ??
          'Build reliable services. Remote within the United States.',
      },
      'manual',
    );
    const employerId =
      options.employerId === undefined
        ? await employer(undefined, undefined, owner)
        : options.employerId;
    await db.query(
      'UPDATE jobs SET status=$3, canonical_employer_id=$4 WHERE id=$1 AND applicant_id=$2',
      [created.id, owner, options.status ?? 'confirmed', employerId],
    );
    await db.transaction((sql) =>
      appendEvent(sql, owner, created.id, 'application.confirmed', {
        receiptId: randomUUID(),
      }),
    );
    const event = {
      name: 'application.confirmed' as const,
      applicantId: owner,
      jobId: created.id,
    };
    return { jobId: created.id, employerId, event };
  }
  const events = async (jobId: string, name?: string) =>
    (
      await db.query(
        `SELECT name, payload FROM ledger_events WHERE job_id=$1 ${name ? 'AND name=$2' : ''} ORDER BY occurred_at, id`,
        name ? [jobId, name] : [jobId],
      )
    ).rows;
  const inject = (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    as = cookie,
  ) =>
    app.inject({
      method,
      url,
      headers: { origin, cookie: as },
      payload: payload as any,
    });
  return {
    app,
    db,
    deps,
    apollo,
    smtp,
    luna,
    logs,
    alice,
    bob,
    cookie,
    login,
    employer,
    job,
    events,
    inject,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
