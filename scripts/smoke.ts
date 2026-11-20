import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const origin = process.env.APP_ORIGIN;
const email = process.env.SMOKE_EMAIL,
  password = process.env.SMOKE_PASSWORD;
if (!origin || !email || !password)
  throw new Error(
    'Set APP_ORIGIN, SMOKE_EMAIL and SMOKE_PASSWORD in the shell',
  );
if (new URL(origin).origin !== origin)
  throw new Error('APP_ORIGIN must be an origin');
let cookie = '',
  token = '',
  pairingId = '',
  applicantId = '';
async function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    bearer?: string;
    session?: boolean;
  } = {},
) {
  const response = await fetch(origin + path, {
    method: options.method ?? 'GET',
    redirect: 'error',
    headers: {
      origin: origin!,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.session && cookie ? { cookie } : {}),
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return response;
}
try {
  assert.equal((await request('/healthz')).status, 200);
  const login = await request('/api/login', {
    method: 'POST',
    body: { email, password },
  });
  assert.equal(login.status, 200, 'Dashboard login');
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  const pair = await request('/api/pairings', {
    method: 'POST',
    body: { label: 'P1 smoke test (revoked on completion)' },
    session: true,
  });
  assert.equal(pair.status, 200);
  ({ token, id: pairingId, applicantId } = await pair.json());
  const body = {
    clientCaptureId: randomUUID(),
    title: 'P1 smoke test — synthetic',
    employer: 'Smoke test fixture',
    discoveryUrl: 'https://example.com/discovery',
    applicationUrl: 'https://boards.greenhouse.io/example/jobs/smoke',
    postingText:
      'Synthetic P1 capture fixture. No application will be submitted.',
  };
  const path = `/api/extension/${applicantId}/captures`;
  assert.equal(
    (await request(path, { method: 'POST', body })).status,
    401,
    'Missing token',
  );
  const wrongOwner = `/api/extension/${randomUUID()}/captures`;
  assert.equal(
    (await request(wrongOwner, { method: 'POST', body, bearer: token })).status,
    401,
    'Wrong owner',
  );
  const capture = await request(path, { method: 'POST', body, bearer: token });
  assert.equal(capture.status, 200, 'Extension capture');
  const saved = await capture.json();
  const retry = await request(path, { method: 'POST', body, bearer: token });
  assert.equal((await retry.json()).id, saved.id, 'Idempotent retry');
  const jobs = await (await request('/api/jobs', { session: true })).json();
  const job = jobs.jobs.find((job: { id: string }) => job.id === saved.id);
  assert.equal(job.discoveryUrl, body.discoveryUrl);
  assert.equal(job.applicationUrl, body.applicationUrl);
  assert.equal(job.postingText, body.postingText);
  const revoked = await request(`/api/pairings/${pairingId}`, {
    method: 'DELETE',
    session: true,
  });
  assert.equal(revoked.status, 200);
  assert.equal(
    (await request(path, { method: 'POST', body, bearer: token })).status,
    401,
    'Revoked token',
  );
  console.log(
    'PASS: health, login, pair, capture, retry, ledger, missing/wrong-owner/revoked token rejection. One labeled synthetic job remains in the ledger.',
  );
} finally {
  if (pairingId && cookie)
    await request(`/api/pairings/${pairingId}`, {
      method: 'DELETE',
      session: true,
    });
  if (cookie)
    await request('/api/logout', { method: 'POST', body: {}, session: true });
}
