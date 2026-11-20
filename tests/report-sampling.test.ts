import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, origin } from './helpers.js';
import { generateLedger, seedLedger } from './fixtures/report/generator.js';
import { fullWeek } from './fixtures/report/scenarios.js';
import { stableSampleId } from '../src/server/report/sampling.js';
import type { PilotReport, ReviewSample } from '../src/shared/report.js';

const unsampled = { ...fullWeek, samples: [] };

/** `idSalt` reuses another fixture's job IDs so draws can be compared. */
async function drawFor(seed: string, idSalt?: string) {
  const f = await fixture();
  const ledger = generateLedger(unsampled, idSalt ?? f.alice);
  await seedLedger(f.db, f.alice, ledger);
  const keyOf = (jobId: string) =>
    Object.entries(ledger.jobIds).find(([, id]) => id === jobId)![0];
  const draw = () =>
    f.app.inject({
      method: 'POST',
      url: '/api/report/samples',
      headers: { origin, cookie: f.cookie },
      payload: { seed },
    });
  return { f, ledger, keyOf, draw };
}

test('sampling picks ten distinct passed and all available excluded postings with stable, persisted IDs', async () => {
  const a = await drawFor('pilot-seed-1');
  const b = await drawFor('pilot-seed-1', a.f.alice);
  try {
    const first = await a.draw();
    assert.equal(first.statusCode, 200, first.body);
    const drawn = first.json().drawn as {
      sampleId: string;
      jobId: string;
      group: 'passed' | 'excluded';
    }[];
    const passed = drawn.filter((d) => d.group === 'passed');
    const excluded = drawn.filter((d) => d.group === 'excluded');
    assert.equal(passed.length, 10); // 20 available
    assert.equal(excluded.length, 5); // only 5 available: all of them
    assert.equal(new Set(drawn.map((d) => d.jobId)).size, 15);
    const passedPool = new Set([
      ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'u1', 'u2', 'p1', 'p2'],
      ...['q1', 'q2', 'late', 'lc1', 'lc2', 'lp1', 'ac1', 'ap1', 'o1'],
    ]);
    for (const d of passed) assert.ok(passedPool.has(a.keyOf(d.jobId)));
    assert.deepEqual(excluded.map((d) => a.keyOf(d.jobId)).sort(), [
      'x1',
      'x2',
      'x3',
      'x4',
      'x5',
    ]);
    for (const d of drawn)
      assert.equal(d.sampleId, stableSampleId(a.f.alice, d.group, d.jobId));
    // Same seed and postings, same draw (independent database).
    const again = (await b.draw()).json().drawn as typeof drawn;
    assert.deepEqual(
      again.map((d) => b.keyOf(d.jobId)).sort(),
      drawn.map((d) => a.keyOf(d.jobId)).sort(),
    );
    // Redrawing never re-samples or mints new IDs.
    assert.deepEqual((await a.draw()).json().drawn, []);
    const events = (
      await a.f.db.query(
        "SELECT count(*) AS n FROM ledger_events WHERE applicant_id=$1 AND name='review.sampled'",
        [a.f.alice],
      )
    ).rows[0]!;
    assert.equal(Number(events.n), 15);
    const listed = (
      await a.f.app.inject({
        url: '/api/report/samples',
        headers: { cookie: a.f.cookie },
      })
    ).json().samples as ReviewSample[];
    assert.equal(listed.length, 15);
    assert.ok(listed.every((s) => s.outcome === null && s.title));
    // Selections do not count as reviews.
    const report = (
      await a.f.app.inject({
        url: '/api/report',
        headers: { cookie: a.f.cookie },
      })
    ).json() as PilotReport;
    assert.equal(report.corrections.samples.passed.sampled, 10);
    assert.equal(report.corrections.samples.passed.reviewed, 0);
    assert.equal(report.corrections.samples.passed.pending, 10);
    assert.equal(report.corrections.rows[0]!.rate, null);
  } finally {
    await a.f.close();
    await b.f.close();
  }
});

test('completed reviews are tracked separately, validated per group, owner-scoped and recorded once', async () => {
  const { f, draw } = await drawFor('pilot-seed-2');
  try {
    const drawn = (await draw()).json().drawn as {
      sampleId: string;
      group: string;
    }[];
    const [p1, p2] = drawn.filter((d) => d.group === 'passed');
    const [x1] = drawn.filter((d) => d.group === 'excluded');
    const complete = (sampleId: string, outcome: string, cookie = f.cookie) =>
      f.app.inject({
        method: 'POST',
        url: `/api/report/samples/${sampleId}/complete`,
        headers: { origin, cookie },
        payload: { outcome },
      });
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/report/samples/${p1!.sampleId}/complete`,
          headers: { cookie: f.cookie },
          payload: { outcome: 'no_change' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await complete(p1!.sampleId, 'reversed_exclusion')).statusCode,
      400,
    );
    assert.equal(
      (await complete(x1!.sampleId, 'missed_restriction')).statusCode,
      400,
    );
    const bob = await f.login('bob@example.com');
    assert.equal(
      (await complete(p1!.sampleId, 'no_change', bob)).statusCode,
      404,
    );
    assert.equal(
      (await complete(p1!.sampleId, 'missed_restriction')).statusCode,
      200,
    );
    assert.equal((await complete(p1!.sampleId, 'no_change')).statusCode, 409);
    // A deferral is not a review and can be followed by the real one.
    assert.equal((await complete(p2!.sampleId, 'deferred')).statusCode, 200);
    let report = (
      await f.app.inject({ url: '/api/report', headers: { cookie: f.cookie } })
    ).json() as PilotReport;
    assert.equal(report.corrections.samples.passed.reviewed, 1);
    assert.equal(report.corrections.samples.passed.deferred, 1);
    assert.equal((await complete(p2!.sampleId, 'no_change')).statusCode, 200);
    assert.equal(
      (await complete(x1!.sampleId, 'reversed_exclusion')).statusCode,
      200,
    );
    report = (
      await f.app.inject({ url: '/api/report', headers: { cookie: f.cookie } })
    ).json() as PilotReport;
    const rows = Object.fromEntries(
      report.corrections.rows.map((r) => [r.key, r]),
    );
    assert.equal(rows.missed_restriction!.corrections, 1);
    assert.equal(rows.missed_restriction!.reviewed, 2);
    assert.equal(rows.missed_restriction!.rate, 0.5);
    assert.deepEqual(rows.missed_restriction!.recordIds, [p1!.sampleId]);
    assert.equal(rows.reversed_exclusion!.reviewed, 1);
    assert.equal(rows.reversed_exclusion!.rate, 1);
    assert.equal(report.corrections.samples.passed.pending, 8);
    // Bob has no live ledger: sampling is refused, not fabricated.
    const bobDraw = await f.app.inject({
      method: 'POST',
      url: '/api/report/samples',
      headers: { origin, cookie: bob },
      payload: {},
    });
    assert.equal(bobDraw.statusCode, 409);
    assert.equal(
      (
        await f.app.inject({ url: '/api/report', headers: { cookie: bob } })
      ).json().status,
      'not_started',
    );
  } finally {
    await f.close();
  }
});
