import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, origin } from './helpers.js';
import {
  capture,
  events,
  jobRow,
  openTickets,
  queueRow,
} from './fixtures/identity/helpers.js';
import { resolveIdentityTicket } from '../src/server/identity/resolve.js';
import { dequeueNext } from '../src/server/identity/queue.js';
import { importHistory } from '../src/server/identity/importer.js';
import { csv } from './fixtures/identity/helpers.js';

test('cross-board sightings of one requisition link before eligibility; distinct requisitions with identical titles survive', async () => {
  const f = await fixture();
  try {
    const first = await capture(f.db, f.alice);
    assert.equal(first.status, 'captured');
    assert.ok(first.canonicalEmployerId);
    // Same Greenhouse requisition found again via Indeed.
    const again = await capture(f.db, f.alice, {
      discoveryUrl: 'https://www.indeed.com/viewjob?jk=abc123',
      title: 'Software Engineer (Remote)',
    });
    assert.equal(again.status, 'duplicate');
    assert.equal(again.canonicalEmployerId, first.canonicalEmployerId);
    const duplicate = await events(f.db, f.alice, 'job.duplicate');
    assert.deepEqual(
      duplicate.map((e) => [e.job_id, e.payload.existingJobId]),
      [[again.id, first.id]],
    );
    // Duplicates never enter the queue, so no eligibility work can start.
    assert.equal((await queueRow(f.db, again.id)).state, 'stopped');
    // Identical title and location, different known requisition: a distinct position.
    const distinct = await capture(f.db, f.alice, {
      applicationUrl: 'https://boards.greenhouse.io/acmerobotics/jobs/2002',
    });
    assert.equal(distinct.status, 'captured');
    assert.equal(distinct.canonicalEmployerId, first.canonicalEmployerId);
    assert.equal((await queueRow(f.db, distinct.id)).state, 'queued');
    const employers = (
      await f.app.inject({
        url: '/api/identity/employers',
        headers: { cookie: f.cookie },
      })
    ).json().employers;
    assert.equal(employers.length, 1);
    // Shared-ATS key only: the nullable domain is exposed and left for issue 010.
    assert.equal(employers[0].domain, null);
    assert.deepEqual(
      employers[0].aliases.map((a: any) => a.key),
      ['greenhouse:acmerobotics'],
    );
  } finally {
    await f.close();
  }
});

test('fallback dedupe matches normalized title and location; Remote and Remote - US stay distinct', async () => {
  const f = await fixture();
  try {
    const base = {
      employer: 'Globex',
      discoveryUrl: 'https://www.linkedin.com/jobs/view/77',
    };
    const first = await capture(f.db, f.alice, {
      ...base,
      title: 'Sr. SWE II',
      applicationUrl: 'https://careers.globex.example/apply/backend',
      postingText: 'Location: Los Angeles, California\nBuild systems.',
    });
    const second = await capture(f.db, f.alice, {
      ...base,
      discoveryUrl: 'https://www.ziprecruiter.com/jobs/globex-77',
      title: 'Senior Software Engineer 2',
      applicationUrl: 'https://jobs.globex.example/positions/backend-2',
      postingText: 'Location: Los Angeles, CA\nBuild systems.',
    });
    assert.equal(second.status, 'duplicate');
    const remote = await capture(f.db, f.alice, {
      ...base,
      title: 'Data Engineer',
      applicationUrl: 'https://careers.globex.example/apply/data-1',
      postingText: 'Location: Remote\nPipelines.',
    });
    const remoteUs = await capture(f.db, f.alice, {
      ...base,
      title: 'Data Engineer',
      applicationUrl: 'https://careers.globex.example/apply/data-2',
      postingText: 'Location: Remote - US\nPipelines.',
    });
    assert.equal(remote.status, 'captured');
    assert.equal(remoteUs.status, 'captured');
    const employer = (
      await f.db.query('SELECT * FROM employers WHERE id=$1', [
        first.canonicalEmployerId,
      ])
    ).rows[0];
    // Employer-owned application site: the domain key fills the nullable domain.
    assert.equal(employer.domain, 'globex.example');
  } finally {
    await f.close();
  }
});

test('a careers page embedding an ATS board links the domain and slug automatically and records both URLs', async () => {
  const f = await fixture();
  try {
    const job = await capture(f.db, f.alice, {
      employer: 'Initrode',
      discoveryUrl: 'https://www.initrode.example/careers/openings?gh_jid=3003',
      applicationUrl: 'https://boards.greenhouse.io/initrode/jobs/3003',
    });
    assert.equal(job.status, 'captured');
    const view = (
      await f.app.inject({
        url: '/api/identity/employers',
        headers: { cookie: f.cookie },
      })
    ).json().employers[0];
    assert.deepEqual(view.aliases.map((a: any) => a.key).sort(), [
      'greenhouse:initrode',
      'initrode.example',
    ]);
    assert.equal(view.domain, 'initrode.example');
    assert.deepEqual(view.links, [
      {
        domainKey: 'initrode.example',
        atsKey: 'greenhouse:initrode',
        relation: 'embed',
        careersUrl: 'https://www.initrode.example/careers/openings?gh_jid=3003',
        atsUrl: 'https://boards.greenhouse.io/initrode/jobs/3003',
        status: 'linked',
      },
    ]);
    // Later sightings on either key resolve to the same canonical employer.
    const direct = await capture(f.db, f.alice, {
      employer: 'Initrode Inc.',
      title: 'Platform Engineer',
      applicationUrl: 'https://jobs.initrode.example/apply/9',
    });
    assert.equal(direct.canonicalEmployerId, job.canonicalEmployerId);
    // The same requisition seen through the careers page alone is a duplicate.
    const viaCareers = await capture(f.db, f.alice, {
      employer: 'Initrode',
      discoveryUrl: 'https://www.google.com/search?q=initrode',
      applicationUrl:
        'https://www.initrode.example/careers/openings?gh_jid=3003',
    });
    assert.equal(viaCareers.status, 'duplicate');
  } finally {
    await f.close();
  }
});

test('a careers link conflicting with established mappings pauses for review; merging combines histories', async () => {
  const f = await fixture();
  const now = new Date('2026-11-08T20:00:00Z');
  try {
    const x = await capture(f.db, f.alice, {
      employer: 'Vandelay Industries',
      title: 'Importer',
      applicationUrl: 'https://careers.vandelay.example/jobs/1',
    });
    const y = await capture(f.db, f.alice, {
      employer: 'Kramerica',
      title: 'Exporter',
      applicationUrl:
        'https://jobs.lever.co/kramerica/0f1e2d3c-aaaa-bbbb-cccc-000000000001',
    });
    assert.notEqual(x.canonicalEmployerId, y.canonicalEmployerId);
    // Each side has one confirmed historical application.
    const imported = await importHistory(
      f.db,
      f.alice,
      {
        filename: 'history.csv',
        csv: csv(
          'Vandelay Industries,Latex Salesman,2026-09-01,https://careers.vandelay.example/jobs/old-1',
          'Kramerica,Intern,2026-10-01,https://jobs.lever.co/kramerica/0f1e2d3c-aaaa-bbbb-cccc-000000000002',
        ),
      },
      now,
    );
    assert.equal(imported.summary.counted, 2);
    const conflicted = await capture(f.db, f.alice, {
      employer: 'Vandelay',
      title: 'Architect',
      discoveryUrl: 'https://careers.vandelay.example/roles/architect',
      applicationUrl:
        'https://jobs.lever.co/kramerica/0f1e2d3c-aaaa-bbbb-cccc-000000000003',
    });
    assert.equal(conflicted.status, 'paused');
    assert.equal(conflicted.canonicalEmployerId, null);
    const [ticket] = await openTickets(f.db, f.alice);
    assert.equal(ticket.job_id, conflicted.id);
    assert.equal(ticket.cause, 'employer_identity');
    assert.equal(ticket.resolve_action, 'resolve_employer');
    const link = (
      await f.db.query('SELECT * FROM employer_links WHERE job_id=$1', [
        conflicted.id,
      ])
    ).rows[0];
    assert.equal(link.status, 'conflict');
    assert.equal(
      link.careers_url,
      'https://careers.vandelay.example/roles/architect',
    );
    assert.equal(
      link.ats_url,
      'https://jobs.lever.co/kramerica/0f1e2d3c-aaaa-bbbb-cccc-000000000003',
    );
    // The generic dashboard approval cannot fake the merge; the identity handler must.
    const listed = (
      await f.app.inject({
        url: '/api/identity/tickets',
        headers: { cookie: f.cookie },
      })
    ).json().tickets;
    assert.equal(listed[0].kind, 'conflict');
    assert.equal(listed[0].candidates.length, 2);
    const resolved = await f.app.inject({
      method: 'POST',
      url: `/api/identity/tickets/${ticket.id}/resolve`,
      headers: { origin, cookie: f.cookie },
      payload: { action: 'merge', employerId: x.canonicalEmployerId },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    const after = await jobRow(f.db, conflicted.id);
    assert.equal(after.status, 'captured');
    assert.equal(after.canonical_employer_id, x.canonicalEmployerId);
    assert.equal((await queueRow(f.db, conflicted.id)).state, 'queued');
    assert.equal(
      (await jobRow(f.db, y.id)).canonical_employer_id,
      x.canonicalEmployerId,
    );
    const pauses = await events(f.db, f.alice);
    const opened = pauses.filter((e) => e.name === 'pause.opened');
    const closed = pauses.filter((e) => e.name === 'pause.closed');
    assert.equal(opened.length, 1);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].payload.pauseId, opened[0].payload.pauseId);
    const view = (
      await f.app.inject({
        url: '/api/identity/employers',
        headers: { cookie: f.cookie },
      })
    ).json();
    assert.equal(view.employers.length, 1);
    assert.equal(view.employers[0].cap.count, 2); // combined history
    assert.deepEqual(view.employers[0].mergedFrom, ['Kramerica']);
    assert.equal(view.employers[0].links[0].status, 'linked');
    const second = await f.app.inject({
      method: 'POST',
      url: `/api/identity/tickets/${ticket.id}/resolve`,
      headers: { origin, cookie: f.cookie },
      payload: { action: 'merge', employerId: x.canonicalEmployerId },
    });
    assert.equal(second.statusCode, 409);
  } finally {
    await f.close();
  }
});

test('a display-name match on a new key asks before applying; the answer becomes an alias', async () => {
  const f = await fixture();
  try {
    const known = await capture(f.db, f.alice, {
      employer: 'Acme Inc.',
      applicationUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    });
    const lever = await capture(f.db, f.alice, {
      employer: 'ACME',
      title: 'Robotics Engineer',
      applicationUrl:
        'https://jobs.lever.co/acme-corp/0f1e2d3c-aaaa-bbbb-cccc-000000000009',
    });
    assert.equal(lever.status, 'paused');
    const [ticket] = await openTickets(f.db, f.alice);
    assert.match(ticket.question, /same employer/);
    assert.deepEqual(ticket.choices, ['Acme Inc.', 'New employer “ACME”']);
    // Nothing was dequeued while the identity question is open.
    assert.equal((await dequeueNext(f.db, f.alice))?.job.id, known.id);
    await resolveIdentityTicket(f.db, f.alice, ticket.id, {
      action: 'assign',
      employerId: known.canonicalEmployerId!,
    });
    const alias = (
      await f.db.query(
        "SELECT * FROM employer_aliases WHERE alias_key='lever:acme-corp'",
      )
    ).rows[0];
    assert.equal(alias.employer_id, known.canonicalEmployerId);
    const again = await capture(f.db, f.alice, {
      employer: 'Acme Corp',
      title: 'Controls Engineer',
      applicationUrl:
        'https://jobs.lever.co/acme-corp/0f1e2d3c-aaaa-bbbb-cccc-000000000010',
    });
    assert.equal(again.status, 'captured');
    assert.equal(again.canonicalEmployerId, known.canonicalEmployerId);
    // "Create" keeps them separate and silences the suggestion for that pair.
    const other = await capture(f.db, f.alice, {
      employer: 'Acme',
      title: 'Chef',
      applicationUrl:
        'https://jobs.ashbyhq.com/acme-foods/0f1e2d3c-aaaa-bbbb-cccc-000000000011',
    });
    const [second] = await openTickets(f.db, f.alice);
    assert.equal(second.job_id, other.id);
    const created = await resolveIdentityTicket(f.db, f.alice, second.id, {
      action: 'create',
      name: 'Acme Foods',
    });
    assert.notEqual(created.employerId, known.canonicalEmployerId);
    const suggestions = (
      await f.app.inject({
        url: '/api/identity/employers',
        headers: { cookie: f.cookie },
      })
    ).json().suggestions;
    assert.deepEqual(suggestions, []);
  } finally {
    await f.close();
  }
});

test('manual merge from suggestions combines histories; a requisition known on both sides keeps one primary', async () => {
  const f = await fixture();
  try {
    const a = await capture(f.db, f.alice, {
      employer: 'Hooli',
      applicationUrl: 'https://boards.greenhouse.io/hooli/jobs/55',
    });
    // Same Greenhouse requisition seen on an employer site that is not yet linked.
    const b = await capture(f.db, f.alice, {
      employer: 'Nucleus Labs',
      title: 'Different title',
      applicationUrl: 'https://careers.nucleus.example/apply?gh_jid=55',
    });
    assert.equal(b.status, 'captured');
    assert.notEqual(a.canonicalEmployerId, b.canonicalEmployerId);
    const renamed = await f.app.inject({
      method: 'PATCH',
      url: `/api/identity/employers/${b.canonicalEmployerId}`,
      headers: { origin, cookie: f.cookie },
      payload: { name: 'Hooli, Inc.' },
    });
    assert.equal(renamed.statusCode, 200, renamed.body);
    const listed = (
      await f.app.inject({
        url: '/api/identity/employers',
        headers: { cookie: f.cookie },
      })
    ).json();
    assert.equal(listed.suggestions.length, 1);
    const bob = await f.login('bob@example.com');
    const forbidden = await f.app.inject({
      method: 'POST',
      url: `/api/identity/employers/${b.canonicalEmployerId}/merge`,
      headers: { origin, cookie: bob },
      payload: { intoEmployerId: a.canonicalEmployerId },
    });
    assert.equal(forbidden.statusCode, 404);
    const merged = await f.app.inject({
      method: 'POST',
      url: `/api/identity/employers/${b.canonicalEmployerId}/merge`,
      headers: { origin, cookie: f.cookie },
      payload: { intoEmployerId: a.canonicalEmployerId },
    });
    assert.equal(merged.statusCode, 200, merged.body);
    const identity = (
      await f.db.query('SELECT * FROM job_identity WHERE job_id=$1', [b.id])
    ).rows[0];
    assert.equal(identity.canonical_employer_id, a.canonicalEmployerId);
    assert.equal(identity.duplicate_of, a.id);
    // The queued newer sighting is stopped as a duplicate before any eligibility work.
    assert.equal((await jobRow(f.db, b.id)).status, 'duplicate');
    assert.equal((await queueRow(f.db, b.id)).state, 'stopped');
    const dup = (await events(f.db, f.alice, 'job.duplicate'))[0];
    assert.equal(dup.job_id, b.id);
    assert.equal(dup.payload.existingJobId, a.id);
    const next = await dequeueNext(f.db, f.alice);
    assert.equal(next?.job.id, a.id);
    const after = (
      await f.app.inject({
        url: '/api/identity/employers',
        headers: { cookie: f.cookie },
      })
    ).json();
    assert.equal(after.employers.length, 1);
    assert.deepEqual(after.suggestions, []);
    assert.equal(
      (
        await f.app.inject({
          url: '/api/identity/employers',
          headers: { cookie: bob },
        })
      ).json().employers.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test('aliases and the employer domain are editable; capture still succeeds when identity cannot resolve', async () => {
  const f = await fixture();
  try {
    const job = await capture(f.db, f.alice, {
      employer: 'Wayne Enterprises',
      applicationUrl: 'https://boards.greenhouse.io/wayne/jobs/7',
    });
    const employerId = job.canonicalEmployerId!;
    const patch = await f.app.inject({
      method: 'PATCH',
      url: `/api/identity/employers/${employerId}`,
      headers: { origin, cookie: f.cookie },
      payload: { domain: 'https://www.Wayne.example/about' },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    assert.equal(patch.json().domain, 'wayne.example');
    const bad = await f.app.inject({
      method: 'PATCH',
      url: `/api/identity/employers/${employerId}`,
      headers: { origin, cookie: f.cookie },
      payload: { domain: 'linkedin.com' },
    });
    assert.equal(bad.statusCode, 400);
    const alias = await f.app.inject({
      method: 'POST',
      url: '/api/identity/aliases',
      headers: { origin, cookie: f.cookie },
      payload: { key: 'Ashby:Wayne', employerId },
    });
    assert.equal(alias.statusCode, 200, alias.body);
    assert.equal(alias.json().key, 'ashby:wayne');
    const invalid = await f.app.inject({
      method: 'POST',
      url: '/api/identity/aliases',
      headers: { origin, cookie: f.cookie },
      payload: { key: 'workday:wayne', employerId },
    });
    assert.equal(invalid.statusCode, 400);
    const ashby = await capture(f.db, f.alice, {
      employer: 'WE',
      title: 'Detective',
      applicationUrl:
        'https://jobs.ashbyhq.com/wayne/0f1e2d3c-aaaa-bbbb-cccc-000000000020',
    });
    assert.equal(ashby.canonicalEmployerId, employerId);
    const removed = await f.app.inject({
      method: 'DELETE',
      url: `/api/identity/aliases/${alias.json().id}`,
      headers: { origin, cookie: f.cookie },
    });
    assert.equal(removed.statusCode, 200);
    // Simulate an identity failure: capture still records the job and its job.selected event.
    await f.db.query('ALTER TABLE job_identity RENAME TO job_identity_off');
    const unresolved = await capture(f.db, f.alice, {
      employer: 'Stark Industries',
      applicationUrl: 'https://boards.greenhouse.io/stark/jobs/1',
    });
    await f.db.query('ALTER TABLE job_identity_off RENAME TO job_identity');
    assert.equal(unresolved.status, 'captured');
    assert.equal(unresolved.canonicalEmployerId, null);
    assert.equal((await queueRow(f.db, unresolved.id)).state, 'queued');
    assert.equal(
      (await events(f.db, f.alice, 'job.selected')).filter(
        (e) => e.job_id === unresolved.id,
      ).length,
      1,
    );
    // The dequeue gate resolves identity before any eligibility work.
    await f.db.query("UPDATE work_queue SET state='done' WHERE job_id<>$1", [
      unresolved.id,
    ]);
    assert.equal((await dequeueNext(f.db, f.alice))?.job.id, unresolved.id);
    assert.ok((await jobRow(f.db, unresolved.id)).canonical_employer_id);
  } finally {
    await f.close();
  }
});
