import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, origin, capture } from './helpers.js';
import { hashToken } from '../src/server/auth.js';
import {
  openTicket,
  resolveTicket,
  appendEvent,
} from '../src/server/ledger.js';
import { classifyHost } from '../src/shared/contracts.js';

test('authenticated manual capture persists both routes, text, unsupported host and one ledger event across retry', async () => {
  const f = await fixture();
  try {
    const input = {
      ...capture(),
      applicationUrl: 'https://careers.example.com/jobs/123',
    };
    const request = {
      method: 'POST' as const,
      url: '/api/jobs',
      headers: { origin, cookie: f.cookie },
      payload: input,
    };
    const first = await f.app.inject(request),
      retry = await f.app.inject(request);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(retry.json().id, first.json().id);
    const changed = await f.app.inject({
      ...request,
      payload: { ...input, title: 'Different role' },
    });
    assert.equal(changed.statusCode, 409);
    const jobs = (
      await f.app.inject({ url: '/api/jobs', headers: { cookie: f.cookie } })
    ).json().jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].discoveryUrl, input.discoveryUrl);
    assert.equal(jobs[0].applicationUrl, input.applicationUrl);
    assert.equal(jobs[0].postingText, input.postingText);
    assert.equal(jobs[0].supportedHost, false);
    const events = (
      await f.app.inject({ url: '/api/events', headers: { cookie: f.cookie } })
    ).json().events;
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'job.selected');
    assert.equal(events[0].jobId, jobs[0].id);
    assert.equal(events[0].schemaVersion, 1);
    assert.ok(Date.parse(events[0].occurredAt));
  } finally {
    await f.close();
  }
});

test('pairing is dashboard-only and missing, invalid, revoked and wrong-owner credentials fail before capture', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/pairings',
          headers: { origin },
          payload: { label: 'Laptop' },
        })
      ).statusCode,
      401,
    );
    const paired = await f.app.inject({
      method: 'POST',
      url: '/api/pairings',
      headers: { origin, cookie: f.cookie },
      payload: { label: 'Laptop' },
    });
    assert.equal(paired.statusCode, 200, paired.body);
    const pairing = paired.json();
    const stored = (await f.db.query('SELECT token_hash FROM pairing_tokens'))
      .rows[0];
    assert.equal(stored.token_hash, hashToken(pairing.token));
    assert.notEqual(stored.token_hash, pairing.token);
    const listing = (
      await f.app.inject({
        url: '/api/pairings',
        headers: { cookie: f.cookie },
      })
    ).body;
    assert.ok(!listing.includes(pairing.token));
    assert.ok(!listing.includes('token_hash'));
    const endpoint = `/api/extension/${f.alice}/captures`;
    for (const authorization of [
      undefined,
      'Bearer bad-token',
      `Bearer ${pairing.token}`,
    ]) {
      const response = await f.app.inject({
        method: 'POST',
        url:
          authorization === `Bearer ${pairing.token}`
            ? `/api/extension/${f.bob}/captures`
            : endpoint,
        headers: authorization ? { authorization } : {},
        payload: capture(),
      });
      assert.equal(response.statusCode, 401, response.body);
    }
    assert.equal((await f.db.query('SELECT id FROM jobs')).rows.length, 0);
    const good = await f.app.inject({
      method: 'POST',
      url: endpoint,
      headers: { authorization: `Bearer ${pairing.token}` },
      payload: capture(),
    });
    assert.equal(good.statusCode, 200, good.body);
    assert.equal(good.json().source, 'extension');
    // The pairing credential is not a dashboard login.
    assert.equal(
      (
        await f.app.inject({
          url: '/api/jobs',
          headers: { authorization: `Bearer ${pairing.token}` },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `/api/pairings/${pairing.id}`,
          headers: { origin, cookie: f.cookie },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: endpoint,
          headers: { authorization: `Bearer ${pairing.token}` },
          payload: capture(),
        })
      ).statusCode,
      401,
    );
    assert.equal((await f.db.query('SELECT id FROM jobs')).rows.length, 1);
  } finally {
    await f.close();
  }
});

test('owner isolation, origin checks, input validation and logout protect all dashboard boundaries', async () => {
  const f = await fixture();
  try {
    for (const requestOrigin of [undefined, 'https://attacker.example']) {
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: {
              cookie: f.cookie,
              ...(requestOrigin ? { origin: requestOrigin } : {}),
            },
            payload: capture(),
          })
        ).statusCode,
        403,
      );
    }
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: { origin, cookie: f.cookie },
          payload: { ...capture(), applicationUrl: 'javascript:alert(1)' },
        })
      ).statusCode,
      400,
    );
    const job = (
      await f.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { origin, cookie: f.cookie },
        payload: capture(),
      })
    ).json();
    const pairing = (
      await f.app.inject({
        method: 'POST',
        url: '/api/pairings',
        headers: { origin, cookie: f.cookie },
        payload: { label: 'Laptop' },
      })
    ).json();
    const ticket = await openTicket(f.db, f.alice, job.id, {
      question: 'Which employer?',
      choices: ['Example'],
      employer: 'Example',
      role: job.title,
      cause: 'employer_identity',
      resolveAction: 'resolve_employer',
    });
    const bobCookie = await f.login('bob@example.com');
    for (const [url, property] of [
      ['/api/jobs', 'jobs'],
      ['/api/events', 'events'],
      ['/api/pairings', 'pairings'],
      ['/api/tickets', 'tickets'],
    ])
      assert.equal(
        (await f.app.inject({ url, headers: { cookie: bobCookie } })).json()[
          property
        ].length,
        0,
      );
    assert.equal(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `/api/pairings/${pairing.id}`,
          headers: { origin, cookie: bobCookie },
        })
      ).statusCode,
      404,
    );
    await assert.rejects(
      () =>
        resolveTicket(f.db, f.bob, ticket.id, {
          outcome: 'deferred',
          value: 'Later',
        }),
      /not found/,
    );
    await assert.rejects(
      () =>
        appendEvent(f.db, f.bob, job.id, 'job.selected', {
          source: 'manual',
          applicationHost: 'example.com',
          supportedHost: false,
        }),
      /foreign key/i,
    );
    const logout = await f.app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { origin, cookie: f.cookie },
      payload: {},
    });
    assert.equal(logout.statusCode, 200);
    assert.equal(
      (await f.app.inject({ url: '/api/jobs', headers: { cookie: f.cookie } }))
        .statusCode,
      401,
    );
    assert.equal((await f.app.inject({ url: '/healthz' })).json().status, 'ok');
  } finally {
    await f.close();
  }
});

test('tickets atomically open/close paired pauses once; invalid transitions cannot change the ledger', async () => {
  const f = await fixture();
  try {
    const job = (
      await f.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { origin, cookie: f.cookie },
        payload: capture(),
      })
    ).json();
    const input = {
      question: 'Attach your portfolio',
      choices: ['PDF'],
      employer: job.employer,
      role: job.title,
      cause: 'required_file' as const,
      resolveAction: 'attach_file' as const,
    };
    const ticket = await openTicket(f.db, f.alice, job.id, input);
    await assert.rejects(
      () => openTicket(f.db, f.alice, job.id, input),
      /already has/,
    );
    await assert.rejects(
      () =>
        resolveTicket(f.db, f.alice, ticket.id, {
          outcome: 'approved',
          value: 'Pretend upload',
        }),
      /domain handler/,
    );
    await resolveTicket(f.db, f.alice, ticket.id, {
      outcome: 'deferred',
      value: 'Need time to prepare',
    });
    await assert.rejects(
      () =>
        resolveTicket(f.db, f.alice, ticket.id, {
          outcome: 'deferred',
          value: 'Retry',
        }),
      /already resolved/,
    );
    const events = (
      await f.db.query(
        "SELECT * FROM ledger_events WHERE name LIKE 'pause.%' ORDER BY occurred_at",
      )
    ).rows;
    assert.equal(events.length, 2);
    assert.equal(events[0].payload.pauseId, events[1].payload.pauseId);
    assert.equal(events[0].payload.ticketId, events[1].payload.ticketId);
    assert.equal(events[1].payload.outcome, 'deferred');
    assert.equal(
      (await f.db.query('SELECT status FROM jobs WHERE id=$1', [job.id]))
        .rows[0].status,
      'deferred',
    );
    await assert.rejects(
      () => appendEvent(f.db, f.alice, null, 'application.submitting', {}),
      /jobId/,
    );
    await appendEvent(f.db, f.alice, null, 'adapter.available', {
      host: 'greenhouse',
    });
    assert.equal(
      classifyHost('https://jobs.lever.co.evil.example/a').supportedHost,
      false,
    );
    assert.equal(
      classifyHost('https://jobs.ashbyhq.com/example/a').supportedHost,
      true,
    );
    await assert.rejects(
      () => openTicket(f.db, f.alice, randomUUID(), input),
      /not found/,
    );
  } finally {
    await f.close();
  }
});

test('max-length non-ASCII posting fits the request body limit', async () => {
  const f = await fixture();
  try {
    // 150k CJK characters are ~450 KB of UTF-8 JSON.
    const input = { ...capture(), postingText: '职'.repeat(150_000) };
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { origin, cookie: f.cookie },
      payload: input,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().postingText.length, 150_000);
  } finally {
    await f.close();
  }
});
