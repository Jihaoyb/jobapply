import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { duplexPair } from 'node:stream';
import { outreachFixture } from './fixtures/outreach/setup.js';
import {
  runOutreachWorker,
  sweepOutreach,
} from '../src/server/outreach/worker.js';
import {
  deliverEmail,
  recoverInterruptedSends,
} from '../src/server/outreach/delivery.js';
import {
  gmailSmtp,
  SmtpLimitError,
  SmtpTimeoutError,
} from '../src/server/outreach/smtp.js';

async function approved(f: Awaited<ReturnType<typeof outreachFixture>>) {
  const { jobId } = await f.job();
  await runOutreachWorker(f.deps, f.alice, jobId);
  const position = (await f.inject('GET', '/api/outreach'))
    .json()
    .positions.find((p: any) => p.jobId === jobId);
  const response = await f.inject(
    'POST',
    `/api/outreach/jobs/${jobId}/approve`,
    { version: position.review.version },
  );
  assert.equal(response.statusCode, 200, response.body);
  return { jobId, position, response: response.json() };
}
const names = (rows: Array<Record<string, any>>) =>
  rows.map((row) => row.name as string);

test('approval sends exactly one email per position and records SMTP acceptance', async () => {
  const f = await outreachFixture();
  try {
    const { jobId, position, response } = await approved(f);
    assert.equal(response.deliveryStatus, 'accepted');
    assert.equal(f.smtp.sends.length, 1);
    assert.equal((await f.events(jobId, 'email.accepted')).length, 1);
    // A repeated approval, delivery call or sweep never sends again.
    assert.equal(
      (
        await f.inject('POST', `/api/outreach/jobs/${jobId}/approve`, {
          version: position.review.version,
        })
      ).statusCode,
      409,
    );
    await deliverEmail(f.deps, f.alice, jobId);
    await sweepOutreach(f.deps);
    assert.equal(f.smtp.sends.length, 1);
    // The database itself refuses a second delivery row for the same position.
    const review = (
      await f.db.query('SELECT id FROM outreach_reviews WHERE job_id=$1', [
        jobId,
      ])
    ).rows[0];
    await assert.rejects(
      f.db.query(
        "INSERT INTO outreach_deliveries (id,applicant_id,job_id,review_id,to_address,subject,body,status) VALUES ($1,$2,$3,$4,'x@n.example','s','b','pending')",
        [randomUUID(), f.alice, jobId, review.id],
      ),
    );
    const delivery = (await f.inject('GET', '/api/outreach')).json()
      .positions[0].delivery;
    assert.equal(delivery.status, 'accepted');
    assert.equal(delivery.attempts, 1);
  } finally {
    await f.close();
  }
});

test('an SMTP timeout opens a reconciliation ticket before any retry; "not sent" allows one retry', async () => {
  const f = await outreachFixture();
  try {
    f.smtp.modes = ['timeout'];
    const { jobId, response } = await approved(f);
    assert.equal(response.deliveryStatus, 'uncertain');
    assert.equal(f.smtp.sends.length, 1);
    const ticket = (
      await f.db.query(
        "SELECT * FROM tickets WHERE job_id=$1 AND status='open'",
        [jobId],
      )
    ).rows[0];
    assert.equal(ticket.cause, 'uncertain_email');
    assert.equal(ticket.resolve_action, 'reconcile_email');
    const ledger = names(await f.events(jobId));
    assert.ok(
      ledger.indexOf('email.uncertain') < ledger.lastIndexOf('pause.opened'),
    );
    assert.equal(ledger.filter((n) => n === 'email.accepted').length, 0);
    // No automatic retry: delivery, sweep, recovery and retry routes all leave it alone.
    await deliverEmail(f.deps, f.alice, jobId);
    await sweepOutreach(f.deps);
    await recoverInterruptedSends(f.deps);
    assert.equal(
      (await f.inject('POST', `/api/outreach/jobs/${jobId}/retry`, {}))
        .statusCode,
      409,
    );
    assert.equal(f.smtp.sends.length, 1);
    const retried = await f.inject(
      'POST',
      `/api/outreach/jobs/${jobId}/reconcile`,
      { sent: false },
    );
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(retried.json().deliveryStatus, 'accepted');
    assert.equal(f.smtp.sends.length, 2);
    assert.equal(
      (
        await f.inject('POST', `/api/outreach/jobs/${jobId}/reconcile`, {
          sent: false,
        })
      ).statusCode,
      409,
    );
    assert.equal(f.smtp.sends.length, 2);
    assert.deepEqual(
      names(await f.events(jobId)).filter((n) => n.startsWith('email.')),
      ['email.uncertain', 'email.accepted'],
    );
  } finally {
    await f.close();
  }
});

test('reconciling an uncertain email as sent records acceptance without resending', async () => {
  const f = await outreachFixture();
  try {
    f.smtp.modes = ['timeout'];
    const { jobId } = await approved(f);
    const response = await f.inject(
      'POST',
      `/api/outreach/jobs/${jobId}/reconcile`,
      { sent: true },
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(f.smtp.sends.length, 1);
    const delivery = (
      await f.db.query('SELECT * FROM outreach_deliveries WHERE job_id=$1', [
        jobId,
      ])
    ).rows[0];
    assert.equal(delivery.status, 'accepted');
    assert.equal(delivery.reconciled, true);
    assert.equal(
      (await f.db.query('SELECT status FROM jobs WHERE id=$1', [jobId])).rows[0]
        .status,
      'confirmed',
    );
  } finally {
    await f.close();
  }
});

test('a crash mid-send is treated as uncertain, never resent automatically', async () => {
  const f = await outreachFixture();
  try {
    f.smtp.configured = false;
    const { jobId } = await approved(f);
    assert.equal(f.smtp.sends.length, 0);
    // Simulate a process that died after claiming the send.
    await f.db.query(
      "UPDATE outreach_deliveries SET status='sending', attempts=1 WHERE job_id=$1",
      [jobId],
    );
    await f.db.query(
      'UPDATE tickets SET status=\'resolved\', closed_at=now(), resolution=\'{"outcome":"deferred","value":"x"}\' WHERE job_id=$1 AND status=\'open\'',
      [jobId],
    );
    await f.db.query("UPDATE jobs SET status='confirmed' WHERE id=$1", [jobId]);
    await recoverInterruptedSends(f.deps);
    const delivery = (
      await f.db.query(
        'SELECT status FROM outreach_deliveries WHERE job_id=$1',
        [jobId],
      )
    ).rows[0];
    assert.equal(delivery.status, 'uncertain');
    assert.equal(
      (
        await f.db.query(
          "SELECT cause FROM tickets WHERE job_id=$1 AND status='open'",
          [jobId],
        )
      ).rows[0].cause,
      'uncertain_email',
    );
    assert.equal(f.smtp.sends.length, 0);
  } finally {
    await f.close();
  }
});

test('missing SMTP setup, refusals and the daily cap pause delivery; retry sends once', async () => {
  const f = await outreachFixture();
  try {
    f.smtp.configured = false;
    const { jobId, response } = await approved(f);
    assert.equal(response.deliveryStatus, 'pending');
    const ticket = (
      await f.db.query(
        "SELECT * FROM tickets WHERE job_id=$1 AND status='open'",
        [jobId],
      )
    ).rows[0];
    assert.equal(ticket.cause, 'provider_limit');
    assert.match(ticket.question, /not configured/);
    f.smtp.configured = true;
    f.smtp.modes = ['reject'];
    await f.inject('POST', `/api/outreach/jobs/${jobId}/retry`, {});
    assert.equal(f.smtp.sends.length, 1);
    assert.equal(
      (
        await f.db.query(
          'SELECT status FROM outreach_deliveries WHERE job_id=$1',
          [jobId],
        )
      ).rows[0].status,
      'pending',
    );
    await f.inject('POST', `/api/outreach/jobs/${jobId}/retry`, {});
    assert.equal(f.smtp.sends.length, 2);
    assert.equal((await f.events(jobId, 'email.accepted')).length, 1);
    // Daily cap: the next approved position pauses instead of sending.
    f.deps.dailyEmailLimit = 1;
    const second = await approved(f);
    assert.equal(second.response.deliveryStatus, 'pending');
    assert.equal(f.smtp.sends.length, 2);
    assert.match(
      (
        await f.db.query(
          "SELECT question FROM tickets WHERE job_id=$1 AND status='open'",
          [second.jobId],
        )
      ).rows[0].question,
      /daily email limit/,
    );
  } finally {
    await f.close();
  }
});

test('manual LinkedIn completion is its own ledger event, recorded once after approval', async () => {
  const f = await outreachFixture();
  try {
    const { jobId } = await f.job();
    await runOutreachWorker(f.deps, f.alice, jobId);
    assert.equal(
      (await f.inject('POST', `/api/outreach/jobs/${jobId}/linkedin`, {}))
        .statusCode,
      409,
    );
    const position = (await f.inject('GET', '/api/outreach')).json()
      .positions[0];
    assert.match(
      position.shortlist.candidates[0].linkedinUrl,
      /^https:\/\/www\.linkedin\.com\/in\//,
    );
    await f.inject('POST', `/api/outreach/jobs/${jobId}/approve`, {
      version: position.review.version,
    });
    const recorded = await f.inject(
      'POST',
      `/api/outreach/jobs/${jobId}/linkedin`,
      {},
    );
    assert.equal(recorded.statusCode, 200, recorded.body);
    assert.equal(
      (await f.inject('POST', `/api/outreach/jobs/${jobId}/linkedin`, {}))
        .statusCode,
      409,
    );
    const linkedin = await f.events(jobId, 'linkedin.recorded');
    assert.equal(linkedin.length, 1);
    assert.equal(linkedin[0].payload.contactId, position.review.candidateId);
    assert.equal((await f.events(jobId, 'email.accepted')).length, 1);
    assert.ok(
      (await f.inject('GET', '/api/outreach')).json().positions[0].review
        .linkedinRecordedAt,
    );
  } finally {
    await f.close();
  }
});

/** Scripted SMTP server on an in-memory duplex: no network. */
function scriptedServer(
  script: (line: string, reply: (text: string) => void) => void,
) {
  const received: string[] = [];
  const connect = () => {
    const [client, server] = duplexPair();
    server.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    const reply = (text: string) => server.write(text + '\r\n');
    server.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        received.push(line);
        if (inData) {
          if (line === '.') {
            inData = false;
            script('<END-DATA>', reply);
          }
          continue;
        }
        if (line === 'DATA') inData = true;
        script(line, reply);
      }
    });
    setImmediate(() => reply('220 smtp.example ESMTP ready'));
    return client;
  };
  return { connect, received };
}
const standard = (afterData: (reply: (text: string) => void) => void) =>
  scriptedServer((line, reply) => {
    if (line.startsWith('EHLO'))
      reply('250-smtp.example\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME');
    else if (line.startsWith('AUTH PLAIN')) reply('235 2.7.0 Accepted');
    else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO'))
      reply('250 2.1.0 OK');
    else if (line === 'DATA') reply('354 Go ahead');
    else if (line === '<END-DATA>') afterData(reply);
    else if (line === 'QUIT') reply('221 2.0.0 closing');
  });

test('Gmail SMTP client authenticates with the app password and sends one MIME message', async () => {
  const server = standard((reply) => reply('250 2.0.0 OK 1700000000 queued'));
  const smtp = gmailSmtp({
    host: 'smtp.example',
    port: 465,
    user: 'applicant@example.com',
    appPassword: 'test-app-password',
    timeoutMs: 2000,
    connect: server.connect,
  });
  const result = await smtp.send({
    to: 'avery@northwind.example',
    subject: 'Hello – role',
    body: 'Line one\nLine two',
  });
  assert.match(result.messageId, /^<.+@example\.com>$/);
  assert.match(result.response, /queued/);
  const auth = server.received.find((line) => line.startsWith('AUTH PLAIN'))!;
  assert.equal(
    Buffer.from(auth.slice(11), 'base64').toString(),
    '\0applicant@example.com\0test-app-password',
  );
  assert.ok(server.received.includes('RCPT TO:<avery@northwind.example>'));
  assert.ok(
    server.received.includes(
      'Subject: =?UTF-8?B?' +
        Buffer.from('Hello – role').toString('base64') +
        '?=',
    ),
  );
  const bodyLine =
    server.received[
      server.received.indexOf('Content-Transfer-Encoding: base64') + 2
    ];
  assert.equal(
    Buffer.from(bodyLine, 'base64').toString(),
    'Line one\r\nLine two',
  );
  assert.equal((await smtp.verify()).ok, true);
  assert.equal(
    gmailSmtp({ host: 'h', port: 465, timeoutMs: 10 }).configured,
    false,
  );
});

test('Gmail SMTP client: no reply after data is a timeout; quota and auth refusals are definite', async () => {
  const silent = standard(() => undefined);
  const config = {
    host: 'smtp.example',
    port: 465,
    user: 'a@example.com',
    appPassword: 'pw',
    timeoutMs: 200,
  };
  await assert.rejects(
    gmailSmtp({ ...config, connect: silent.connect }).send({
      to: 'b@n.example',
      subject: 's',
      body: 'b',
    }),
    SmtpTimeoutError,
  );
  const quota = standard((reply) =>
    reply('550 5.4.5 Daily user sending limit exceeded'),
  );
  await assert.rejects(
    gmailSmtp({ ...config, connect: quota.connect }).send({
      to: 'b@n.example',
      subject: 's',
      body: 'b',
    }),
    SmtpLimitError,
  );
  const badAuth = scriptedServer((line, reply) => {
    if (line.startsWith('EHLO')) reply('250 smtp.example');
    else if (line.startsWith('AUTH'))
      reply('535 5.7.8 Username and Password not accepted');
  });
  const report = await gmailSmtp({
    ...config,
    connect: badAuth.connect,
  }).verify();
  assert.equal(report.ok, false);
  assert.match(report.checks[0].detail, /535/);
});
