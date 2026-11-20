import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import {
  generateLedger,
  seedLedger,
  type Scenario,
} from './fixtures/report/generator.js';
import {
  at,
  fullWeek,
  fullWeekExpected,
  greenhouseOnlyExpected,
  greenhouseOnlyWeek,
  type ExpectedScenario,
} from './fixtures/report/scenarios.js';
import { computeReport } from '../src/server/report/compute.js';
import { loadReportLedger } from '../src/server/report/load.js';
import type { PilotReport, ReportResponse } from '../src/shared/report.js';

async function seeded(scenario: Scenario) {
  const f = await fixture();
  const ledger = generateLedger(scenario, f.alice);
  await seedLedger(f.db, f.alice, ledger);
  return { f, ledger };
}
function ready(report: ReportResponse): PilotReport {
  assert.equal(report.status, 'ready', JSON.stringify(report));
  return report as PilotReport;
}

function reconcile(
  report: PilotReport,
  expected: ExpectedScenario,
  jobKeyOf: (jobId: string) => string,
) {
  const c = report.coverage;
  assert.equal(c.clockStart, expected.clockStart);
  assert.equal(c.cutoff, expected.cutoff);
  assert.equal(c.daysCovered, expected.daysCovered);
  assert.equal(c.complete, expected.complete);
  assert.deepEqual(c.hostsLive, expected.hostsLive);
  assert.deepEqual(c.hostsAbsent, expected.hostsAbsent);
  for (const [host, days] of Object.entries(expected.hostDays))
    assert.equal(c.hosts[host as 'lever'].days, days, `${host} days`);
  for (const step of ['outreach', 'email', 'linkedin'] as const) {
    const days = expected.outreachDays[step];
    assert.equal(c[step].live, days !== null, `${step} live`);
    if (days !== null) assert.equal(c[step].days, days, `${step} days`);
  }
  // Funnel: every stage, total and per host.
  assert.equal(report.funnel.stages.length, 13);
  for (const stage of report.funnel.stages) {
    const want = expected.funnel[stage.key];
    assert.equal(stage.total, want.total, `funnel ${stage.key} total`);
    assert.deepEqual(stage.byHost, want.byHost, `funnel ${stage.key} hosts`);
    assert.equal(stage.jobIds.length, stage.total ?? 0);
  }
  for (const host of ['greenhouse', 'lever', 'ashby', 'other'] as const)
    assert.equal(
      report.funnel.hostCoverage[host].selectedJobs,
      expected.funnel.selected.byHost[host],
    );
  // Pauses: all nine causes are present; listed ones reconcile exactly.
  assert.equal(report.pauses.causes.length, 9);
  for (const [cause, want] of Object.entries(expected.pauses)) {
    const row = report.pauses.causes.find((r) => r.cause === cause)!;
    assert.deepEqual(
      {
        episodes: row.episodes,
        distinctJobs: row.distinctJobs,
        openEpisodes: row.openEpisodes,
        waitingMs: row.waitingMs,
      },
      want,
      `pause ${cause}`,
    );
  }
  assert.deepEqual(report.pauses.totals, expected.pauseTotals);
  const causeSum = report.pauses.causes.reduce(
    (sum, r) => sum + (r.waitingMs ?? 0),
    0,
  );
  assert.equal(causeSum, report.pauses.totals.waitingMs);
  // Corrections: numerators over reviewed denominators.
  assert.equal(report.corrections.rows.length, 4);
  for (const row of report.corrections.rows) {
    const want = expected.corrections[row.key]!;
    assert.equal(row.corrections, want.corrections, `${row.key} corrections`);
    assert.equal(row.reviewed, want.reviewed, `${row.key} reviewed`);
    assert.equal(
      row.rate,
      want.reviewed ? want.corrections! / want.reviewed : null,
      `${row.key} rate`,
    );
    assert.equal(row.recordIds.length, want.corrections ?? 0);
  }
  for (const group of ['passed', 'excluded'] as const) {
    const {
      outcomes: _outcomes,
      group: _group,
      ...summary
    } = report.corrections.samples[group];
    assert.deepEqual(summary, expected.samples[group], `${group} samples`);
  }
  // Bottleneck and its linked records.
  const b = report.bottleneck!;
  assert.equal(b.cause, expected.bottleneck.cause);
  assert.equal(b.waitingMs, expected.bottleneck.waitingMs);
  assert.equal(b.distinctJobs, expected.bottleneck.distinctJobs);
  assert.deepEqual(
    b.records.map((r) => jobKeyOf(r.jobId)),
    expected.bottleneck.jobs,
  );
  assert.equal(b.improvement, null);
  assert.deepEqual(report.intendedStops, expected.intendedStops);
  assert.deepEqual(report.excludedFromWindow, expected.excludedFromWindow);
}

test('report reconciles every chart number to the full seven-day fixture ledger', async () => {
  const { f, ledger } = await seeded(fullWeek);
  try {
    const keyOf = (jobId: string) =>
      Object.entries(ledger.jobIds).find(([, id]) => id === jobId)![0];
    const report = ready(
      computeReport(await loadReportLedger(f.db, f.alice), {
        now: fullWeek.now,
      }),
    );
    assert.equal(report.coverage.clockSource, 'derived');
    reconcile(report, fullWeekExpected, keyOf);
    // Stage membership, not just counts.
    const members = (key: string) =>
      report.funnel.stages
        .find((s) => s.key === key)!
        .jobIds.map(keyOf)
        .sort();
    assert.deepEqual(members('uncertain'), ['u1']);
    assert.deepEqual(members('emailAccepted'), ['c1', 'c2', 'c7', 'lc1']);
    assert.deepEqual(members('linkedinRecorded'), ['ac1', 'c1', 'c3']);
    assert.ok(!members('selected').some((k) => k.startsWith('syn')));
    assert.ok(!members('confirmed').includes('late'));
    // Bottleneck records link the pause, ticket and both ledger events.
    const top = report.bottleneck!.records[0]!;
    assert.equal(top.pauseId, ledger.pauseIds.lp1![0]);
    assert.equal(top.ticketId, ledger.ticketIds.lp1![0]);
    assert.equal(top.closedAt, null);
    assert.equal(top.eventIds.length, 1);
    assert.match(top.question!, /unsupported form/);
    assert.equal(report.bottleneck!.records[2]!.eventIds.length, 2);
    assert.deepEqual(
      report.bottleneck!.ranking.map((r) => r.cause),
      [
        'unsupported_form',
        'required_file',
        'uncertain_submission',
        'unanswered_question',
        'eligibility_ambiguity',
        'uncertain_email',
        'provider_limit',
      ],
    );
    // Correction records are review IDs: sample IDs and outreach ticket IDs.
    const edited = report.corrections.rows.find(
      (r) => r.key === 'edited_draft',
    )!;
    assert.deepEqual(
      edited.recordIds,
      [ledger.outreachTicketIds.c2!, ledger.outreachTicketIds.c7!].sort(),
    );
    assert.match(report.funnel.coverageLabel, /Days covered: 7 of 7/);
    assert.doesNotMatch(report.funnel.coverageLabel, /not live/);
  } finally {
    await f.close();
  }
});

test('chart numbers match independent SQL counts over the ledger', async () => {
  const { f } = await seeded(fullWeek);
  try {
    const report = ready(
      computeReport(await loadReportLedger(f.db, f.alice), {
        now: fullWeek.now,
      }),
    );
    const start = report.coverage.clockStart,
      cutoff = report.coverage.cutoff;
    const pilot = `SELECT job_id FROM ledger_events WHERE applicant_id=$1 AND name='job.selected' AND occurred_at BETWEEN $2 AND $3`;
    const distinct = async (name: string) =>
      Number(
        (
          await f.db.query(
            `SELECT count(DISTINCT job_id) AS n FROM ledger_events WHERE applicant_id=$1 AND name=$4 AND occurred_at<=$3 AND job_id IN (${pilot})`,
            [f.alice, start, cutoff, name],
          )
        ).rows[0]!.n,
      );
    const map = {
      selected: 'job.selected',
      duplicate: 'job.duplicate',
      capped: 'job.capped',
      submitting: 'application.submitting',
      confirmed: 'application.confirmed',
      outreachShortlisted: 'outreach.shortlisted',
      outreachReviewed: 'outreach.reviewed',
      emailAccepted: 'email.accepted',
      linkedinRecorded: 'linkedin.recorded',
    } as const;
    for (const [key, name] of Object.entries(map))
      assert.equal(
        report.funnel.stages.find((s) => s.key === key)!.total,
        await distinct(name),
        key,
      );
    const pauses = (
      await f.db.query(
        `SELECT count(*) AS episodes, count(DISTINCT o.job_id) AS jobs,
          sum(extract(epoch FROM (COALESCE(c.occurred_at, $3::timestamptz) - o.occurred_at))) AS seconds
        FROM ledger_events o
        LEFT JOIN ledger_events c ON c.applicant_id=o.applicant_id AND c.job_id=o.job_id AND c.name='pause.closed'
          AND c.payload->>'pauseId'=o.payload->>'pauseId' AND c.occurred_at<=$3
        WHERE o.applicant_id=$1 AND o.name='pause.opened' AND o.occurred_at<=$3 AND o.job_id IN (${pilot})`,
        [f.alice, start, cutoff],
      )
    ).rows[0]!;
    assert.equal(report.pauses.totals.episodes, Number(pauses.episodes));
    assert.equal(report.pauses.totals.distinctJobs, Number(pauses.jobs));
    assert.equal(report.pauses.totals.waitingMs, Number(pauses.seconds) * 1000);
    // Ticket rows exist for every pause episode (one ledger, two views).
    const tickets = Number(
      (
        await f.db.query(
          `SELECT count(*) AS n FROM tickets WHERE applicant_id=$1 AND job_id IN (${pilot})`,
          [f.alice, start, cutoff],
        )
      ).rows[0]!.n,
    );
    assert.equal(tickets, report.pauses.totals.episodes);
  } finally {
    await f.close();
  }
});

test('day seven with only Greenhouse live and no outreach renders Lever, Ashby and outreach as labeled gaps', async () => {
  const { f, ledger } = await seeded(greenhouseOnlyWeek);
  try {
    const keyOf = (jobId: string) =>
      Object.entries(ledger.jobIds).find(([, id]) => id === jobId)![0];
    const report = ready(
      computeReport(await loadReportLedger(f.db, f.alice), {
        now: greenhouseOnlyWeek.now,
      }),
    );
    reconcile(report, greenhouseOnlyExpected, keyOf);
    // All three charts publish, each labeling its coverage.
    for (const label of [
      report.funnel.coverageLabel,
      report.pauses.coverageLabel,
      report.corrections.coverageLabel,
    ]) {
      assert.match(label, /Hosts live: Greenhouse from 2026-10-01 \(7 d\)/);
      assert.match(label, /not live \(absent, not zero\): Lever, Ashby/);
      assert.match(label, /Days covered: 7 of 7/);
    }
    assert.match(
      report.funnel.coverageLabel,
      /Outreach: no records \(absent, not zero\)/,
    );
    assert.match(
      report.corrections.coverageLabel,
      /Outreach review: no records \(absent, not zero\)/,
    );
    assert.equal(report.funnel.hostCoverage.lever.live, false);
    assert.equal(report.funnel.hostCoverage.lever.from, null);
    assert.equal(report.corrections.outreach.reviewed, null);
    // Rates without completed reviews are absent, not 0%.
    const reversed = report.corrections.rows.find(
      (r) => r.key === 'reversed_exclusion',
    )!;
    assert.equal(reversed.rate, null);
  } finally {
    await f.close();
  }
});

test('mid-week report accrues open pauses to now and labels the open window', async () => {
  const { f } = await seeded(fullWeek);
  try {
    const report = ready(
      computeReport(await loadReportLedger(f.db, f.alice), {
        now: at(3, 12),
      }),
    );
    assert.equal(report.coverage.cutoff, at(3, 12).toISOString());
    assert.equal(report.coverage.daysCovered, 3.5);
    assert.equal(report.coverage.complete, false);
    assert.equal(report.coverage.hosts.lever.days, 0.5);
    assert.equal(report.coverage.hosts.ashby.live, false);
    assert.match(report.funnel.coverageLabel, /window still open/);
    // lp1 opened 1d09:20 → 2d02:40 by 3d12:00; ap1 opened 2d10:20 → 1d01:40; o1 closed 480.
    const form = report.pauses.causes.find(
      (c) => c.cause === 'unsupported_form',
    )!;
    assert.equal(form.waitingMs, (3040 + 1540 + 480) * 60_000);
    // Ashby is not live yet: its submission stages are absent, not zero.
    const confirmed = report.funnel.stages.find((s) => s.key === 'confirmed')!;
    assert.equal(confirmed.byHost.ashby, null);
    assert.equal(confirmed.byHost.lever, 0);
  } finally {
    await f.close();
  }
});

test('clock start is explicit when given, derived from the first live decision otherwise, and never from synthetic captures', async () => {
  const { f } = await seeded(fullWeek);
  try {
    const ledger = await loadReportLedger(f.db, f.alice);
    const pinned = ready(
      computeReport(ledger, { now: fullWeek.now, clockStart: at(1) }),
    );
    assert.equal(pinned.coverage.clockSource, 'explicit');
    assert.equal(pinned.coverage.clockStart, at(1).toISOString());
    // syn1 syn2 d1 c1 d2 c2 precede day 1; after1 (7d01:00) now falls inside the window.
    assert.equal(pinned.excludedFromWindow.jobsBeforeClock, 6);
    assert.equal(pinned.funnel.stages[0]!.total, 28);
    assert.equal(pinned.coverage.daysCovered, 6.33);
    // Without any adapter.available the clock has not started.
    const synthetic = {
      ...ledger,
      events: ledger.events.filter((e) => e.name !== 'adapter.available'),
    };
    const notStarted = computeReport(synthetic, { now: fullWeek.now });
    assert.equal(notStarted.status, 'not_started');
  } finally {
    await f.close();
  }
});

test('report API is session-scoped, owner-isolated and validates the clock override', async () => {
  const f = await fixture();
  try {
    const ledger = generateLedger(fullWeek, f.alice);
    await seedLedger(f.db, f.alice, ledger);
    await seedLedger(f.db, f.bob, generateLedger(greenhouseOnlyWeek, f.bob));
    assert.equal((await f.app.inject({ url: '/api/report' })).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({
          url: '/api/report?clockStart=yesterday',
          headers: { cookie: f.cookie },
        })
      ).statusCode,
      400,
    );
    const keyOf = (jobId: string) =>
      Object.entries(ledger.jobIds).find(([, id]) => id === jobId)![0];
    // The real clock is past the fixture week, so the cutoff is the window end.
    for (const query of [
      '',
      `?clockStart=${encodeURIComponent(at(0).toISOString())}`,
    ]) {
      const response = await f.app.inject({
        url: `/api/report${query}`,
        headers: { cookie: f.cookie },
      });
      assert.equal(response.statusCode, 200, response.body);
      const report = ready(response.json());
      assert.equal(report.coverage.clockSource, query ? 'explicit' : 'derived');
      reconcile(report, fullWeekExpected, keyOf);
    }
    // Bob sees only his own (Greenhouse-only) ledger.
    const bob = await f.login('bob@example.com');
    const bobReport = ready(
      (
        await f.app.inject({ url: '/api/report', headers: { cookie: bob } })
      ).json(),
    );
    assert.equal(bobReport.funnel.stages[0]!.total, 7);
    assert.deepEqual(bobReport.coverage.hostsAbsent, ['lever', 'ashby']);
  } finally {
    await f.close();
  }
});
