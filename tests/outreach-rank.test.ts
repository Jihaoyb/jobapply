import test from 'node:test';
import assert from 'node:assert/strict';
import { outreachFixture } from './fixtures/outreach/setup.js';
import { apolloLimit } from './fixtures/outreach/fakes.js';
import {
  handleOutreachEvent,
  runOutreachWorker,
  sweepOutreach,
} from '../src/server/outreach/worker.js';
import {
  httpApollo,
  ApolloLimitError,
  ApolloNotConfiguredError,
} from '../src/server/outreach/apollo.js';
import {
  domainFromPosting,
  normalizeDomain,
} from '../src/server/outreach/domain.js';

test('a confirmation event for an uncertain job makes zero Apollo calls and logs a skip', async () => {
  const f = await outreachFixture();
  try {
    for (const status of ['uncertain', 'submitting'] as const) {
      const { jobId, event } = await f.job({ status });
      assert.equal(
        await handleOutreachEvent(f.deps, event),
        'skipped_not_confirmed',
      );
      const log = (
        await f.db.query(
          'SELECT outcome, detail FROM outreach_worker_log WHERE job_id=$1',
          [jobId],
        )
      ).rows;
      assert.deepEqual(log, [
        { outcome: 'skipped_not_confirmed', detail: `status=${status}` },
      ]);
    }
    assert.equal(f.apollo.total, 0);
    assert.equal(f.luna.state.requests.length, 0);
    assert.equal(
      (await f.db.query('SELECT * FROM outreach_shortlists')).rows.length,
      0,
    );
    assert.equal((await f.db.query('SELECT * FROM tickets')).rows.length, 0);
    // The sweep fallback never touches non-confirmed jobs either.
    assert.deepEqual(await sweepOutreach(f.deps), []);
    assert.equal(f.apollo.total, 0);
    assert.ok(
      f.logs.some((entry) => entry.message === 'worker skipped_not_confirmed'),
    );
  } finally {
    await f.close();
  }
});

test('duplicate confirmation events produce one shortlist; Luna gets at most ten candidates and returns up to three', async () => {
  const f = await outreachFixture();
  try {
    const { jobId, event } = await f.job();
    // Concurrent duplicate delivery, then a late third delivery.
    const results = await Promise.all([
      handleOutreachEvent(f.deps, event),
      handleOutreachEvent(f.deps, event),
    ]);
    assert.deepEqual(results.sort(), [
      'review_opened',
      'skipped_not_confirmed',
    ]);
    assert.equal(
      await handleOutreachEvent(f.deps, event),
      'skipped_not_confirmed',
    );
    assert.equal(
      (
        await f.db.query('SELECT * FROM outreach_shortlists WHERE job_id=$1', [
          jobId,
        ])
      ).rows.length,
      1,
    );
    assert.equal((await f.events(jobId, 'outreach.shortlisted')).length, 1);
    assert.equal(f.apollo.calls.searchPeople, 1);
    assert.equal(f.apollo.searches[0].domain, 'northwind.example');
    assert.equal(f.apollo.searches[0].perPage, 10);
    assert.ok(f.apollo.searches[0].titles.includes('technical recruiter'));
    // Apollo returned 14 synthetic people; only 10 reached Luna.
    const ranking = f.luna.state.requests.find(
      (r) => JSON.parse(r.input).task === 'contact_ranking',
    );
    assert.equal(JSON.parse(ranking.input).candidates.length, 10);
    assert.equal(ranking.model, 'test-luna');
    const candidates = (
      await f.db.query('SELECT * FROM outreach_candidates ORDER BY rank')
    ).rows;
    assert.equal(candidates.length, 3);
    for (const c of candidates) {
      assert.ok(c.score >= 1 && c.score <= 5);
      assert.ok(c.reason && c.evidence);
      assert.equal(c.prior_contact, false);
    }
    // Model provenance is recorded through the single wrapper.
    const calls = (
      await f.db.query(
        'SELECT prompt_version FROM model_calls WHERE job_id=$1 ORDER BY created_at',
        [jobId],
      )
    ).rows;
    assert.deepEqual(calls.map((c) => c.prompt_version).sort(), [
      'contact-ranking-v1',
      'outreach-draft-v1',
    ]);
    // One review ticket opened, and only the recommended recipient was enriched.
    const tickets = (
      await f.db.query('SELECT * FROM tickets WHERE job_id=$1', [jobId])
    ).rows;
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0].resolve_action, 'review_outreach');
    assert.equal(tickets[0].resume_status, 'confirmed');
    assert.deepEqual(f.apollo.matched, [candidates[0].apollo_person_id]);
    assert.equal(f.apollo.calls.saveToJobSearch, 0);
    // The dashboard shows the evidence-backed shortlist.
    const view = (await f.inject('GET', '/api/outreach')).json();
    assert.equal(view.positions[0].shortlist.candidates.length, 3);
    assert.equal(view.positions[0].shortlist.candidatesSent, 10);
    assert.equal(view.positions[0].ticket.kind, 'review');
  } finally {
    await f.close();
  }
});

test('posting employer link proposes a domain that is confirmed once; lookup pauses until then', async () => {
  const f = await outreachFixture();
  try {
    const employerId = await f.employer('Northwind Example', null);
    const first = await f.job({
      employerId,
      applicationUrl: 'https://careers.northwind.example/jobs/42',
    });
    assert.equal(
      await handleOutreachEvent(f.deps, first.event),
      'paused_domain',
    );
    assert.equal(f.apollo.total, 0, 'posting link needs no Apollo lookup');
    const view = (await f.inject('GET', '/api/outreach')).json();
    assert.equal(view.positions[0].ticket.kind, 'domain');
    assert.deepEqual(view.positions[0].ticket.proposedDomains, [
      'northwind.example',
    ]);
    const paused = (await f.events(first.jobId, 'pause.opened'))[0].payload;
    assert.equal(paused.cause, 'employer_identity');
    // Job board / ATS hosts are rejected as employer domains.
    assert.equal(
      (
        await f.inject('POST', `/api/outreach/jobs/${first.jobId}/domain`, {
          domain: 'boards.greenhouse.io',
        })
      ).statusCode,
      400,
    );
    const confirmed = await f.inject(
      'POST',
      `/api/outreach/jobs/${first.jobId}/domain`,
      {
        domain: 'https://www.northwind.example/about',
      },
    );
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmed.json().result, 'review_opened');
    assert.equal(
      (
        await f.db.query('SELECT domain FROM employers WHERE id=$1', [
          employerId,
        ])
      ).rows[0].domain,
      'northwind.example',
    );
    const closed = (await f.events(first.jobId, 'pause.closed'))[0].payload;
    assert.equal(closed.outcome, 'approved');
    // Second position at the same employer: no second confirmation.
    const second = await f.job({ employerId });
    assert.equal(
      await handleOutreachEvent(f.deps, second.event),
      'review_opened',
    );
    assert.equal(f.apollo.calls.searchPeople, 2);
    assert.equal(f.apollo.calls.enrichOrganization, 0);
  } finally {
    await f.close();
  }
});

test('without a posting link Apollo proposes a domain by name; unknown domains pause lookup only', async () => {
  const f = await outreachFixture();
  try {
    f.apollo.organizations.set('Contoso Example', 'contoso.example');
    const contoso = await f.employer('Contoso Example', null);
    const proposed = await f.job({ employerId: contoso });
    assert.equal(
      await runOutreachWorker(f.deps, f.alice, proposed.jobId),
      'paused_domain',
    );
    assert.equal(f.apollo.calls.enrichOrganization, 1);
    assert.equal(f.apollo.calls.searchPeople, 0);
    const ticket = (await f.inject('GET', '/api/outreach')).json().positions[0]
      .ticket;
    assert.deepEqual(ticket.proposedDomains, ['contoso.example']);
    const unknown = await f.job({
      employerId: await f.employer('Unknown Example', null),
    });
    assert.equal(
      await runOutreachWorker(f.deps, f.alice, unknown.jobId),
      'paused_domain',
    );
    const unknownTicket = (
      await f.db.query('SELECT * FROM tickets WHERE job_id=$1', [unknown.jobId])
    ).rows[0];
    assert.deepEqual(unknownTicket.choices, ['Enter another domain']);
    assert.equal(f.apollo.calls.searchPeople, 0);
    // A disputed domain (employer already has another one) is refused.
    await f.db.query(
      "UPDATE employers SET domain='other.example' WHERE id=$1",
      [contoso],
    );
    assert.equal(
      (
        await f.inject('POST', `/api/outreach/jobs/${proposed.jobId}/domain`, {
          domain: 'contoso.example',
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});

test('missing canonical employer pauses with zero Apollo calls; retry resumes once resolved', async () => {
  const f = await outreachFixture();
  try {
    const { jobId } = await f.job({ employerId: null });
    assert.equal(
      await runOutreachWorker(f.deps, f.alice, jobId),
      'paused_employer',
    );
    assert.equal(f.apollo.total, 0);
    const employerId = await f.employer();
    await f.db.query('UPDATE jobs SET canonical_employer_id=$2 WHERE id=$1', [
      jobId,
      employerId,
    ]);
    const retried = await f.inject(
      'POST',
      `/api/outreach/jobs/${jobId}/retry`,
      {},
    );
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(
      (
        await f.db.query('SELECT * FROM outreach_shortlists WHERE job_id=$1', [
          jobId,
        ])
      ).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('Apollo limits and missing setup open provider_limit pauses; retry resumes without a second shortlist', async () => {
  const f = await outreachFixture();
  try {
    f.apollo.fail.searchPeople = apolloLimit();
    const { jobId } = await f.job();
    assert.equal(
      await runOutreachWorker(f.deps, f.alice, jobId),
      'paused_provider',
    );
    const ticket = (
      await f.db.query('SELECT * FROM tickets WHERE job_id=$1', [jobId])
    ).rows[0];
    assert.equal(ticket.cause, 'provider_limit');
    assert.equal(ticket.resolve_action, 'retry_provider');
    assert.equal(
      (await f.db.query('SELECT * FROM outreach_shortlists')).rows.length,
      0,
    );
    // Retrying while still limited pauses again; it never fabricates a shortlist.
    await f.inject('POST', `/api/outreach/jobs/${jobId}/retry`, {});
    assert.equal(
      (
        await f.db.query(
          "SELECT * FROM tickets WHERE job_id=$1 AND status='open'",
          [jobId],
        )
      ).rows.length,
      1,
    );
    delete f.apollo.fail.searchPeople;
    assert.equal(
      (await f.inject('POST', `/api/outreach/jobs/${jobId}/retry`, {}))
        .statusCode,
      200,
    );
    assert.equal(
      (await f.db.query('SELECT * FROM outreach_shortlists')).rows.length,
      1,
    );
    // Enrichment limit after shortlisting: retry reuses the shortlist.
    f.apollo.fail.matchPerson = apolloLimit();
    const second = await f.job();
    assert.equal(
      await runOutreachWorker(f.deps, f.alice, second.jobId),
      'paused_provider',
    );
    delete f.apollo.fail.matchPerson;
    await f.inject('POST', `/api/outreach/jobs/${second.jobId}/retry`, {});
    assert.equal(
      (
        await f.db.query('SELECT * FROM outreach_shortlists WHERE job_id=$1', [
          second.jobId,
        ])
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await f.db.query('SELECT * FROM outreach_reviews WHERE job_id=$1', [
          second.jobId,
        ])
      ).rows.length,
      1,
    );
    // Unconfigured Apollo key pauses rather than crashing.
    f.apollo.configured = false;
    const third = await f.job();
    assert.equal(
      await runOutreachWorker(f.deps, f.alice, third.jobId),
      'paused_provider',
    );
    const question = (
      await f.db.query(
        "SELECT question FROM tickets WHERE job_id=$1 AND status='open'",
        [third.jobId],
      )
    ).rows[0].question;
    assert.match(question, /not configured/);
  } finally {
    await f.close();
  }
});

test('a person contacted for an earlier position carries a repeat-recipient flag', async () => {
  const f = await outreachFixture();
  try {
    const first = await f.job();
    await runOutreachWorker(f.deps, f.alice, first.jobId);
    const view = (await f.inject('GET', '/api/outreach')).json().positions[0];
    const approved = await f.inject(
      'POST',
      `/api/outreach/jobs/${first.jobId}/approve`,
      { version: view.review.version },
    );
    assert.equal(approved.statusCode, 200, approved.body);
    const second = await f.job();
    await runOutreachWorker(f.deps, f.alice, second.jobId);
    const flagged = (
      await f.db.query(
        `SELECT c.* FROM outreach_candidates c JOIN outreach_shortlists s ON s.id=c.shortlist_id WHERE s.job_id=$1 ORDER BY rank`,
        [second.jobId],
      )
    ).rows;
    assert.equal(flagged[0].prior_contact, true);
    assert.match(
      flagged[0].prior_contact_detail,
      /Software Engineer at Northwind Example/,
    );
    assert.equal(flagged[1].prior_contact, false);
  } finally {
    await f.close();
  }
});

test('setup verification reports Apollo and SMTP readiness through the dashboard', async () => {
  const f = await outreachFixture();
  try {
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/outreach/setup/verify',
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/outreach/setup/verify',
          headers: { origin: 'http://localhost:3000' },
        })
      ).statusCode,
      401,
    );
    const response = await f.inject('POST', '/api/outreach/setup/verify', {});
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().apollo.ok, true);
    assert.equal(response.json().smtp.ok, true);
    assert.equal(response.json().smtp.dailyEmailLimit, 20);
  } finally {
    await f.close();
  }
});

test('HTTP Apollo adapter: unset key, limits, credits, match flags and label-preserving contact save', async () => {
  assert.equal((await httpApollo(undefined).verify()).ok, false);
  await assert.rejects(
    httpApollo(undefined).searchPeople({
      domain: 'x.example',
      titles: [],
      perPage: 1,
    }),
    ApolloNotConfiguredError,
  );
  const requests: Array<{
    url: string;
    method: string;
    body: any;
    key: string;
  }> = [];
  let responder: (url: string) => Response = () => Response.json({});
  const transport = (async (url: string, init: RequestInit) => {
    requests.push({
      url,
      method: init.method!,
      body: init.body ? JSON.parse(init.body as string) : undefined,
      key: (init.headers as Record<string, string>)['X-Api-Key'],
    });
    return responder(url);
  }) as unknown as typeof fetch;
  const apollo = httpApollo('apollo-test-key', transport);
  responder = () => new Response('{}', { status: 429 });
  await assert.rejects(
    apollo.searchPeople({
      domain: 'n.example',
      titles: ['recruiter'],
      perPage: 10,
    }),
    ApolloLimitError,
  );
  responder = () =>
    new Response('{"error":"insufficient credits"}', { status: 422 });
  await assert.rejects(
    apollo.matchPerson({ id: 'syn-1' } as any),
    ApolloLimitError,
  );
  assert.equal(requests[0].key, 'apollo-test-key');
  assert.deepEqual(requests[0].body.q_organization_domains_list, ['n.example']);
  assert.equal(requests[0].body.per_page, 10);
  const match = requests[1].body;
  assert.equal(match.reveal_personal_emails, false);
  assert.equal(match.reveal_phone_number, false);
  assert.equal(match.run_waterfall_email, false);
  assert.equal(match.run_waterfall_phone, false);
  responder = (url) => {
    if (url.endsWith('/auth/health'))
      return Response.json({ is_logged_in: true });
    if (url.endsWith('/users/api_profile'))
      return Response.json({ user: { email_credits_remaining: 0 } });
    return Response.json({});
  };
  const report = await apollo.verify();
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((c) => c.name === 'credits')!.ok, false);
  assert.equal(report.checks.find((c) => c.name === 'key')!.ok, true);
  // Existing contact: only label_ids are sent, keeping prior labels; other fields untouched.
  requests.length = 0;
  responder = (url) => {
    if (url.endsWith('/labels'))
      return Response.json([
        { id: 'lbl-js', name: 'Job Search', modality: 'contacts' },
      ]);
    if (url.endsWith('/contacts/search'))
      return Response.json({
        contacts: [
          {
            id: 'c-1',
            person_id: 'syn-1',
            email: 'a@n.example',
            label_ids: ['lbl-sales'],
          },
        ],
      });
    return Response.json({ contact: { id: 'c-1' } });
  };
  const saved = await apollo.saveToJobSearch(
    {
      id: 'syn-1',
      name: 'Avery Quill',
      firstName: 'Avery',
      lastName: 'Quill',
    } as any,
    'a@n.example',
  );
  assert.deepEqual(saved, { contactId: 'c-1', created: false });
  const update = requests.find((r) => r.method === 'PUT')!;
  assert.match(update.url, /\/contacts\/c-1$/);
  assert.deepEqual(update.body, { label_ids: ['lbl-sales', 'lbl-js'] });
});

test('domain helpers ignore boards and normalize hosts', () => {
  assert.equal(
    normalizeDomain('https://careers.acme.co.uk/jobs'),
    'acme.co.uk',
  );
  assert.equal(normalizeDomain('WWW.Northwind.Example'), 'northwind.example');
  assert.equal(normalizeDomain('not a domain'), null);
  assert.equal(
    domainFromPosting({
      applicationUrl: 'https://jobs.lever.co/acme/1',
      discoveryUrl: 'https://www.linkedin.com/jobs/view/1',
      postingText: 'Learn more at https://www.acme.example/about.',
    }),
    'acme.example',
  );
});
