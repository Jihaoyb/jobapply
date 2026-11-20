import test from 'node:test';
import assert from 'node:assert/strict';
import { outreachFixture } from './fixtures/outreach/setup.js';
import { runOutreachWorker } from '../src/server/outreach/worker.js';

async function reviewReady(f: Awaited<ReturnType<typeof outreachFixture>>) {
  const { jobId } = await f.job();
  assert.equal(
    await runOutreachWorker(f.deps, f.alice, jobId),
    'review_opened',
  );
  const position = (await f.inject('GET', '/api/outreach'))
    .json()
    .positions.find((p: any) => p.jobId === jobId);
  return { jobId, position };
}

test('changing the recipient enriches only the new selection and invalidates stale drafts and approval', async () => {
  const f = await outreachFixture();
  try {
    const { jobId, position } = await reviewReady(f);
    const [first, second, third] = position.shortlist.candidates;
    assert.equal(position.review.candidateId, first.id);
    assert.equal(position.review.status, 'ready');
    assert.ok(
      position.review.emailSubject &&
        position.review.emailBody &&
        position.review.linkedinNote,
    );
    assert.equal(first.businessEmail, 'avery@northwind.example');
    const staleVersion = position.review.version;
    // An existing sales contact for the new recipient, with fields and lists to preserve.
    f.apollo.contacts.push({
      id: 'contact-sales-1',
      personId: f.apollo.people.find((p) => p.name === second.name)!.id,
      email: null,
      fields: {
        stage: 'Customer',
        owner: 'Sales Rep (synthetic)',
        title: second.title,
      },
      labels: ['Q3 Pipeline'],
    });
    const changed = await f.inject(
      'POST',
      `/api/outreach/jobs/${jobId}/recipient`,
      { candidateId: second.id },
    );
    assert.equal(changed.statusCode, 200, changed.body);
    const after = (await f.inject('GET', '/api/outreach')).json().positions[0];
    assert.equal(after.review.candidateId, second.id);
    assert.ok(after.review.version > staleVersion);
    assert.match(after.review.emailBody, new RegExp(second.name.split(' ')[0]));
    // Approval of what was reviewed before the change is refused.
    const stale = await f.inject(
      'POST',
      `/api/outreach/jobs/${jobId}/approve`,
      { version: staleVersion },
    );
    assert.equal(stale.statusCode, 409);
    assert.equal(f.smtp.sends.length, 0);
    // Only selected recipients were enriched; the third never was.
    assert.deepEqual(f.apollo.matched, [
      f.apollo.people.find((p) => p.name === first.name)!.id,
      f.apollo.people.find((p) => p.name === second.name)!.id,
    ]);
    assert.ok(
      !f.apollo.matched.includes(
        f.apollo.people.find((p) => p.name === third.name)!.id,
      ),
    );
    // Switching back reuses the cached enrichment (no second people_match).
    await f.inject('POST', `/api/outreach/jobs/${jobId}/recipient`, {
      candidateId: first.id,
    });
    await f.inject('POST', `/api/outreach/jobs/${jobId}/recipient`, {
      candidateId: second.id,
    });
    assert.equal(f.apollo.calls.matchPerson, 2);
    // Recipients outside the shortlist are rejected.
    const foreign = await f.inject(
      'POST',
      `/api/outreach/jobs/${jobId}/recipient`,
      {
        candidateId: '00000000-0000-4000-8000-000000000000',
      },
    );
    assert.equal(foreign.statusCode, 400);
    const current = (await f.inject('GET', '/api/outreach')).json()
      .positions[0];
    const approved = await f.inject(
      'POST',
      `/api/outreach/jobs/${jobId}/approve`,
      { version: current.review.version },
    );
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().outcome, 'changed_ranking');
    const reviewed = await f.events(jobId, 'outreach.reviewed');
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0].payload.outcome, 'changed_ranking');
    assert.equal(reviewed[0].payload.ticketId, position.ticket.id);
    // Job Search added while existing sales fields and list memberships are preserved.
    const contact = f.apollo.contacts.find((c) => c.id === 'contact-sales-1')!;
    assert.deepEqual(contact.labels, ['Q3 Pipeline', 'Job Search']);
    assert.deepEqual(contact.fields, {
      stage: 'Customer',
      owner: 'Sales Rep (synthetic)',
      title: second.title,
    });
    assert.equal(f.apollo.contacts.length, 1);
    // After approval the recipient can no longer change.
    assert.equal(
      (
        await f.inject('POST', `/api/outreach/jobs/${jobId}/recipient`, {
          candidateId: first.id,
        })
      ).statusCode,
      409,
    );
    const job = (
      await f.db.query('SELECT status FROM jobs WHERE id=$1', [jobId])
    ).rows[0];
    assert.equal(job.status, 'confirmed');
  } finally {
    await f.close();
  }
});

test('editing drafts sends nothing until approval, and approval sends the edited wording as edited_draft', async () => {
  const f = await outreachFixture();
  try {
    const { jobId, position } = await reviewReady(f);
    const edit = {
      version: position.review.version,
      emailSubject: 'Edited subject',
      emailBody: 'Edited body written by the applicant.',
      linkedinNote: 'Edited note.',
    };
    const saved = await f.inject(
      'PUT',
      `/api/outreach/jobs/${jobId}/drafts`,
      edit,
    );
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(f.smtp.sends.length, 0);
    assert.equal((await f.events(jobId, 'outreach.reviewed')).length, 0);
    // The pre-edit version can no longer be edited or approved.
    assert.equal(
      (await f.inject('PUT', `/api/outreach/jobs/${jobId}/drafts`, edit))
        .statusCode,
      409,
    );
    assert.equal(
      (
        await f.inject('POST', `/api/outreach/jobs/${jobId}/approve`, {
          version: edit.version,
        })
      ).statusCode,
      409,
    );
    const tooLong = await f.inject(
      'PUT',
      `/api/outreach/jobs/${jobId}/drafts`,
      {
        ...edit,
        version: edit.version + 1,
        linkedinNote: 'x'.repeat(301),
      },
    );
    assert.equal(tooLong.statusCode, 400);
    const approved = await f.inject(
      'POST',
      `/api/outreach/jobs/${jobId}/approve`,
      { version: edit.version + 1 },
    );
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().outcome, 'edited_draft');
    assert.equal(f.smtp.sends.length, 1);
    assert.deepEqual(f.smtp.sends[0], {
      to: 'avery@northwind.example',
      subject: 'Edited subject',
      body: 'Edited body written by the applicant.',
    });
    const view = (await f.inject('GET', '/api/outreach')).json().positions[0];
    assert.equal(view.review.linkedinNote, 'Edited note.');
  } finally {
    await f.close();
  }
});

test('skipping closes the review with a skipped outcome and sends nothing', async () => {
  const f = await outreachFixture();
  try {
    const { jobId } = await reviewReady(f);
    const skipped = await f.inject(
      'POST',
      `/api/outreach/jobs/${jobId}/skip`,
      {},
    );
    assert.equal(skipped.statusCode, 200, skipped.body);
    assert.equal(f.smtp.sends.length, 0);
    assert.equal(f.apollo.calls.saveToJobSearch, 0);
    const reviewed = await f.events(jobId, 'outreach.reviewed');
    assert.deepEqual(
      reviewed.map((e) => e.payload.outcome),
      ['skipped'],
    );
    assert.equal(
      (await f.events(jobId, 'pause.closed'))[0].payload.outcome,
      'skipped',
    );
    assert.equal(
      (await f.inject('POST', `/api/outreach/jobs/${jobId}/skip`, {}))
        .statusCode,
      409,
    );
    assert.equal(
      (
        await f.inject('POST', `/api/outreach/jobs/${jobId}/approve`, {
          version: 1,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await f.db.query('SELECT status FROM jobs WHERE id=$1', [jobId])).rows[0]
        .status,
      'confirmed',
    );
  } finally {
    await f.close();
  }
});

test('an unverified business email approves LinkedIn-only outreach without any SMTP send', async () => {
  const f = await outreachFixture();
  try {
    f.apollo.matches.set('syn-p01', {
      email: 'guess@northwind.example',
      emailStatus: 'guessed',
    });
    const { jobId, position } = await reviewReady(f);
    const approved = await f.inject(
      'POST',
      `/api/outreach/jobs/${jobId}/approve`,
      { version: position.review.version },
    );
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().emailQueued, false);
    assert.equal(f.smtp.sends.length, 0);
    assert.equal(
      (await f.db.query('SELECT * FROM outreach_deliveries')).rows.length,
      0,
    );
    assert.equal(
      f.apollo.contacts[0].email,
      null,
      'an unverified address is not saved to Apollo',
    );
  } finally {
    await f.close();
  }
});

test('outreach routes are owner-isolated and require the dashboard origin', async () => {
  const f = await outreachFixture();
  try {
    const { jobId } = await reviewReady(f);
    const bob = await f.login('bob@example.com');
    for (const [method, url, payload] of [
      ['POST', `/api/outreach/jobs/${jobId}/skip`, {}],
      ['POST', `/api/outreach/jobs/${jobId}/approve`, { version: 1 }],
      ['POST', `/api/outreach/jobs/${jobId}/linkedin`, {}],
      [
        'PUT',
        `/api/outreach/jobs/${jobId}/drafts`,
        { version: 1, emailSubject: 'a', emailBody: 'b', linkedinNote: 'c' },
      ],
    ] as const)
      assert.equal((await f.inject(method, url, payload, bob)).statusCode, 404);
    assert.deepEqual(
      (await f.inject('GET', '/api/outreach', undefined, bob)).json().positions,
      [],
    );
    const noOrigin = await f.app.inject({
      method: 'POST',
      url: `/api/outreach/jobs/${jobId}/skip`,
      headers: { cookie: f.cookie },
      payload: {},
    });
    assert.equal(noOrigin.statusCode, 403);
    assert.equal(f.smtp.sends.length, 0);
  } finally {
    await f.close();
  }
});
