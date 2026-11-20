/**
 * Report fixture scenarios with HAND-COUNTED expected values. The expected
 * numbers are written out independently of the report code (arithmetic in the
 * comments) so a test failure means the report and the fixture disagree.
 *
 * T0 = 2026-10-01T16:00:00Z is the first live decision. at(d, h) = T0 + d days + h hours.
 * Each script step happens 10 minutes after the previous one; a closed pause
 * lasts its `hours`; an open pause accrues waiting time to the cutoff.
 */
import type {
  FunnelHost,
  FunnelStageKey,
  PauseCause,
} from '../../../src/shared/report.js';
import type { Scenario } from './generator.js';

export const T0 = Date.parse('2026-10-01T16:00:00Z');
export const at = (day: number, hour = 0, minute = 0) =>
  new Date(T0 + day * 86_400_000 + hour * 3_600_000 + minute * 60_000);
const MIN = 60_000;

type HostCounts = Record<FunnelHost, number | null>;
export interface ExpectedScenario {
  clockStart: string;
  cutoff: string;
  daysCovered: number;
  complete: boolean;
  hostsLive: string[];
  hostsAbsent: string[];
  hostDays: Record<string, number>;
  outreachDays: {
    outreach: number | null;
    email: number | null;
    linkedin: number | null;
  };
  funnel: Record<FunnelStageKey, { total: number | null; byHost: HostCounts }>;
  pauses: Partial<
    Record<
      PauseCause,
      {
        episodes: number | null;
        distinctJobs: number | null;
        openEpisodes: number | null;
        waitingMs: number | null;
      }
    >
  >;
  pauseTotals: {
    episodes: number;
    distinctJobs: number;
    openEpisodes: number;
    waitingMs: number;
  };
  corrections: Record<
    string,
    { corrections: number | null; reviewed: number | null }
  >;
  samples: Record<
    'passed' | 'excluded',
    {
      available: number;
      sampled: number;
      reviewed: number;
      skipped: number;
      deferred: number;
      pending: number;
    }
  >;
  bottleneck: {
    cause: PauseCause;
    waitingMs: number;
    distinctJobs: number;
    jobs: string[];
  };
  intendedStops: {
    duplicate: number;
    capped: number;
    eligibilityExcluded: number;
  };
  excludedFromWindow: {
    jobsBeforeClock: number;
    jobsAfterCutoff: number;
    eventsAfterCutoff: number;
  };
}
const h = (
  gh: number | null,
  lv: number | null,
  ab: number | null,
  other: number | null,
): HostCounts => ({
  greenhouse: gh,
  lever: lv,
  ashby: ab,
  other,
});
const row = (total: number | null, byHost: HostCounts) => ({ total, byHost });

// ---------------------------------------------------------------------------
// Scenario A: complete seven days, all three adapters and outreach observed.
// ---------------------------------------------------------------------------
const passed = { t: 'elig', decision: 'passed' } as const;
export const fullWeek: Scenario = {
  name: 'full-week',
  now: at(7, 8),
  adapters: [
    { host: 'greenhouse', at: at(0, -1) },
    { host: 'greenhouse', at: at(2, 0) }, // repeated emission (restart); first one counts
    { host: 'lever', at: at(3, 0) },
    { host: 'ashby', at: at(5, 0) },
  ],
  jobs: [
    // Synthetic P1 captures before go-live: never in the report.
    {
      key: 'syn1',
      host: 'greenhouse',
      at: new Date('2026-09-10T18:00:00Z'),
      steps: [
        passed,
        {
          t: 'pause',
          cause: 'unanswered_question',
          hours: 2,
          outcome: 'deferred',
        },
      ],
    },
    {
      key: 'syn2',
      host: 'other',
      at: new Date('2026-09-10T19:00:00Z'),
      steps: [passed],
    },
    // Intended stops.
    {
      key: 'd1',
      host: 'greenhouse',
      at: at(0, 0),
      steps: [{ t: 'dup', of: 'c1' }],
    }, // first live decision
    {
      key: 'd2',
      host: 'greenhouse',
      at: at(0, 2),
      steps: [{ t: 'dup', of: 'c1' }],
    },
    {
      key: 'd3',
      host: 'lever',
      at: at(4, 1),
      steps: [{ t: 'dup', of: 'lc1' }],
    },
    { key: 'k1', host: 'greenhouse', at: at(1, 1), steps: [{ t: 'cap' }] },
    { key: 'k2', host: 'ashby', at: at(5, 3), steps: [{ t: 'cap' }] },
    {
      key: 'x1',
      host: 'greenhouse',
      at: at(1, 2),
      steps: [{ t: 'elig', decision: 'excluded' }],
    },
    {
      key: 'x2',
      host: 'greenhouse',
      at: at(1, 3),
      steps: [{ t: 'elig', decision: 'excluded' }],
    },
    {
      key: 'x3',
      host: 'greenhouse',
      at: at(2, 1),
      steps: [{ t: 'elig', decision: 'excluded', provenance: 'sol' }],
    },
    {
      key: 'x4',
      host: 'lever',
      at: at(3, 2),
      steps: [{ t: 'elig', decision: 'excluded' }],
    },
    {
      key: 'x5',
      host: 'other',
      at: at(3, 3),
      steps: [{ t: 'elig', decision: 'excluded' }],
    },
    // Greenhouse confirmations with outreach.
    {
      key: 'c1',
      host: 'greenhouse',
      at: at(0, 1),
      // model 01:10, elig 01:20, submit 01:30, confirm 01:40, shortlist 01:50, review 02:00, email 02:10, linkedin 02:20
      steps: [
        { t: 'model' },
        passed,
        { t: 'submit' },
        { t: 'confirm' },
        { t: 'shortlist' },
        { t: 'oreview', outcome: 'approved' },
        { t: 'email' },
        { t: 'linkedin' },
      ],
    },
    {
      key: 'c2',
      host: 'greenhouse',
      at: at(0, 3),
      steps: [
        passed,
        { t: 'pause', cause: 'unanswered_question', hours: 3 },
        { t: 'submit' },
        { t: 'confirm' },
        { t: 'shortlist' },
        { t: 'oreview', outcome: 'edited_draft' },
        { t: 'email' },
      ],
    },
    {
      key: 'c3',
      host: 'greenhouse',
      at: at(1, 4),
      steps: [
        passed,
        { t: 'pause', cause: 'required_file', hours: 10 },
        { t: 'submit' },
        { t: 'confirm' },
        { t: 'shortlist' },
        { t: 'oreview', outcome: 'changed_ranking' },
        { t: 'linkedin' },
      ],
    },
    {
      key: 'c4',
      host: 'greenhouse',
      at: at(1, 5),
      // Two episodes of the same cause on one job: 2 episodes, 1 distinct job.
      steps: [
        passed,
        { t: 'pause', cause: 'unanswered_question', hours: 20 },
        { t: 'pause', cause: 'unanswered_question', hours: 2 },
        { t: 'submit' },
        { t: 'confirm' },
        { t: 'shortlist' },
        { t: 'oreview', outcome: 'skipped' },
      ],
    },
    {
      key: 'c5',
      host: 'greenhouse',
      at: at(2, 2),
      // A deferred outreach review is not a review: it counts in neither the funnel's
      // "Outreach reviewed" stage nor the outreach corrections denominator.
      steps: [
        passed,
        { t: 'submit' },
        { t: 'confirm' },
        { t: 'shortlist' },
        { t: 'oreview', outcome: 'deferred' },
      ],
    },
    {
      key: 'c6',
      host: 'greenhouse',
      at: at(2, 9),
      // Review → ambiguity ticket → user passes it. Final decision: passed.
      steps: [
        { t: 'elig', decision: 'review', provenance: 'sol' },
        { t: 'pause', cause: 'eligibility_ambiguity', hours: 6 },
        { t: 'elig', decision: 'passed', provenance: 'user' },
        { t: 'submit' },
        { t: 'confirm' },
      ],
    },
    {
      key: 'c7',
      host: 'greenhouse',
      at: at(3, 1),
      steps: [
        passed,
        { t: 'submit' },
        { t: 'confirm' },
        { t: 'shortlist' },
        { t: 'oreview', outcome: 'edited_draft' },
        { t: 'emailUncertain' },
        { t: 'pause', cause: 'uncertain_email', hours: 2 },
        { t: 'email' },
      ],
    },
    // Greenhouse application failures and in-flight work.
    // u1: elig 14:10, submit 14:20, uncertain 14:30, pause 14:40 → open until 7d00:00 = 33h20m.
    {
      key: 'u1',
      host: 'greenhouse',
      at: at(5, 14),
      steps: [
        passed,
        { t: 'submit' },
        { t: 'uncertain' },
        { t: 'pause', cause: 'uncertain_submission' },
      ],
    },
    {
      key: 'u2',
      host: 'greenhouse',
      at: at(3, 10),
      steps: [
        passed,
        { t: 'submit' },
        { t: 'uncertain' },
        { t: 'pause', cause: 'uncertain_submission', hours: 4 },
        { t: 'confirm' },
      ],
    },
    // p1: pause 6d12:20 → open 11h40m.
    {
      key: 'p1',
      host: 'greenhouse',
      at: at(6, 12),
      steps: [passed, { t: 'pause', cause: 'unanswered_question' }],
    },
    {
      key: 'p2',
      host: 'greenhouse',
      at: at(4, 2),
      steps: [
        passed,
        { t: 'pause', cause: 'provider_limit', hours: 1, outcome: 'deferred' },
      ],
    },
    { key: 'q1', host: 'greenhouse', at: at(6, 1), steps: [passed] },
    // q2: pause 6d20:20, closes 7d06:20 (after cutoff) → open in the report, 3h40m.
    {
      key: 'q2',
      host: 'greenhouse',
      at: at(6, 20),
      steps: [passed, { t: 'pause', cause: 'required_file', hours: 10 }],
    },
    // r2: pause 6d08:20 → open 15h40m. Final decision stays "review".
    {
      key: 'r2',
      host: 'greenhouse',
      at: at(6, 8),
      steps: [
        { t: 'elig', decision: 'review', provenance: 'sol' },
        { t: 'pause', cause: 'eligibility_ambiguity' },
      ],
    },
    // late: submit 6d23:20, confirm 7d00:30 (after cutoff → ignored).
    {
      key: 'late',
      host: 'greenhouse',
      at: at(6, 23),
      steps: [
        passed,
        { t: 'submit' },
        { t: 'wait', hours: 1 },
        { t: 'confirm' },
      ],
    },
    // Lever (live from day 3).
    {
      key: 'lc1',
      host: 'lever',
      at: at(3, 5),
      steps: [
        passed,
        { t: 'pause', cause: 'required_file', hours: 30 },
        { t: 'submit' },
        { t: 'confirm' },
        { t: 'shortlist' },
        { t: 'oreview', outcome: 'approved' },
        { t: 'email' },
      ],
    },
    {
      key: 'lc2',
      host: 'lever',
      at: at(4, 6),
      steps: [passed, { t: 'submit' }, { t: 'confirm' }],
    },
    // lp1: pause 1d09:20 → open 134h40m (Lever not yet live when it paused).
    {
      key: 'lp1',
      host: 'lever',
      at: at(1, 9),
      steps: [passed, { t: 'pause', cause: 'unsupported_form' }],
    },
    // Ashby (live from day 5).
    {
      key: 'ac1',
      host: 'ashby',
      at: at(5, 6),
      steps: [
        passed,
        { t: 'submit' },
        { t: 'confirm' },
        { t: 'shortlist' },
        { t: 'oreview', outcome: 'approved' },
        { t: 'linkedin' },
      ],
    },
    // ap1: pause 2d10:20 → open 109h40m.
    {
      key: 'ap1',
      host: 'ashby',
      at: at(2, 10),
      steps: [passed, { t: 'pause', cause: 'unsupported_form' }],
    },
    // Unsupported host: tracked, never submitted.
    {
      key: 'o1',
      host: 'other',
      at: at(2, 12),
      steps: [
        passed,
        {
          t: 'pause',
          cause: 'unsupported_form',
          hours: 8,
          outcome: 'deferred',
        },
      ],
    },
    // Selected after the cutoff: excluded.
    { key: 'after1', host: 'greenhouse', at: at(7, 1), steps: [passed] },
  ],
  // Samples are drawn and reviewed at publication, after the cutoff.
  samples: [
    ...(['c1', 'c2', 'c3', 'c4'] as const).map((job, i) => ({
      job,
      group: 'passed' as const,
      at: at(7, 2, i),
      completions: [{ outcome: 'no_change' as const, at: at(7, 3, i) }],
    })),
    {
      job: 'c5',
      group: 'passed',
      at: at(7, 2, 4),
      completions: [{ outcome: 'missed_restriction', at: at(7, 3, 4) }],
    },
    {
      job: 'c6',
      group: 'passed',
      at: at(7, 2, 5),
      completions: [
        { outcome: 'deferred', at: at(7, 3, 5) },
        { outcome: 'no_change', at: at(7, 4, 5) },
      ],
    },
    {
      job: 'c7',
      group: 'passed',
      at: at(7, 2, 6),
      completions: [{ outcome: 'skipped', at: at(7, 3, 6) }],
    },
    { job: 'u1', group: 'passed', at: at(7, 2, 7), completions: [] },
    { job: 'u2', group: 'passed', at: at(7, 2, 8), completions: [] },
    { job: 'p1', group: 'passed', at: at(7, 2, 9), completions: [] },
    {
      job: 'x1',
      group: 'excluded',
      at: at(7, 2, 10),
      completions: [{ outcome: 'no_change', at: at(7, 3, 10) }],
    },
    {
      job: 'x2',
      group: 'excluded',
      at: at(7, 2, 11),
      completions: [{ outcome: 'no_change', at: at(7, 3, 11) }],
    },
    {
      job: 'x3',
      group: 'excluded',
      at: at(7, 2, 12),
      completions: [{ outcome: 'reversed_exclusion', at: at(7, 3, 12) }],
    },
    {
      job: 'x4',
      group: 'excluded',
      at: at(7, 2, 13),
      completions: [{ outcome: 'no_change', at: at(7, 3, 13) }],
    },
    { job: 'x5', group: 'excluded', at: at(7, 2, 14), completions: [] },
  ],
};

export const fullWeekExpected: ExpectedScenario = {
  clockStart: at(0).toISOString(), // d1 is the first job.selected after Greenhouse went live at T0-1h
  cutoff: at(7).toISOString(),
  daysCovered: 7,
  complete: true,
  hostsLive: ['greenhouse', 'lever', 'ashby'],
  hostsAbsent: [],
  hostDays: { greenhouse: 7, lever: 4, ashby: 2 },
  outreachDays: {
    outreach: 6.92, // c1 shortlist at 0d01:50 → 166h10m / 24
    email: 6.91, // c1 email at 0d02:10 → 165h50m / 24
    linkedin: 6.9, // c1 linkedin at 0d02:20 → 165h40m / 24
  },
  // Hosts: greenhouse d1 d2 k1 x1 x2 x3 c1-c7 u1 u2 p1 p2 q1 q2 r2 late (21);
  // lever d3 x4 lc1 lc2 lp1 (5); ashby k2 ac1 ap1 (3); other x5 o1 (2).
  funnel: {
    selected: row(31, h(21, 5, 3, 2)),
    duplicate: row(3, h(2, 1, 0, 0)),
    capped: row(2, h(1, 0, 1, 0)),
    eligibilityExcluded: row(5, h(3, 1, 0, 1)),
    eligibilityReview: row(1, h(1, 0, 0, 0)), // r2
    eligibilityPassed: row(20, h(14, 3, 2, 1)),
    submitting: row(13, h(10, 2, 1, null)), // gh: c1-c7 u1 u2 late
    confirmed: row(11, h(8, 2, 1, null)), // gh: c1-c7 u2 (late confirms after cutoff)
    uncertain: row(1, h(1, 0, 0, null)), // u1 (u2 later confirmed)
    outreachShortlisted: row(8, h(6, 1, 1, 0)),
    outreachReviewed: row(7, h(5, 1, 1, 0)), // c5's deferred review is excluded
    emailAccepted: row(4, h(3, 1, 0, 0)), // c1 c2 c7 lc1
    linkedinRecorded: row(3, h(2, 0, 1, 0)), // c1 c3 ac1
  },
  pauses: {
    // c2 180 + c4 (1200 + 120) + p1 open 700
    unanswered_question: {
      episodes: 4,
      distinctJobs: 3,
      openEpisodes: 1,
      waitingMs: 2200 * MIN,
    },
    // c3 600 + lc1 1800 + q2 open 220
    required_file: {
      episodes: 3,
      distinctJobs: 3,
      openEpisodes: 1,
      waitingMs: 2620 * MIN,
    },
    // c6 360 + r2 open 940
    eligibility_ambiguity: {
      episodes: 2,
      distinctJobs: 2,
      openEpisodes: 1,
      waitingMs: 1300 * MIN,
    },
    // u2 240 + u1 open 2000
    uncertain_submission: {
      episodes: 2,
      distinctJobs: 2,
      openEpisodes: 1,
      waitingMs: 2240 * MIN,
    },
    uncertain_email: {
      episodes: 1,
      distinctJobs: 1,
      openEpisodes: 0,
      waitingMs: 120 * MIN,
    },
    provider_limit: {
      episodes: 1,
      distinctJobs: 1,
      openEpisodes: 0,
      waitingMs: 60 * MIN,
    },
    // lp1 open 8080 + ap1 open 6580 + o1 480
    unsupported_form: {
      episodes: 3,
      distinctJobs: 3,
      openEpisodes: 2,
      waitingMs: 15140 * MIN,
    },
    employer_identity: {
      episodes: 0,
      distinctJobs: 0,
      openEpisodes: 0,
      waitingMs: 0,
    },
    import_ambiguity: {
      episodes: 0,
      distinctJobs: 0,
      openEpisodes: 0,
      waitingMs: 0,
    },
  },
  pauseTotals: {
    episodes: 16,
    distinctJobs: 15,
    openEpisodes: 6,
    waitingMs: 23680 * MIN,
  },
  corrections: {
    missed_restriction: { corrections: 1, reviewed: 6 }, // c1-c4 no_change, c5 missed, c6 deferred→no_change; c7 skipped
    reversed_exclusion: { corrections: 1, reviewed: 4 }, // x1 x2 x4 no_change, x3 reversed; x5 pending
    edited_draft: { corrections: 2, reviewed: 7 }, // c2 c7 of c1 c2 c3 c4(skipped) c7 lc1 ac1
    changed_ranking: { corrections: 1, reviewed: 7 }, // c3
  },
  samples: {
    passed: {
      available: 20,
      sampled: 10,
      reviewed: 6,
      skipped: 1,
      deferred: 0,
      pending: 3,
    },
    excluded: {
      available: 5,
      sampled: 5,
      reviewed: 4,
      skipped: 0,
      deferred: 0,
      pending: 1,
    },
  },
  bottleneck: {
    cause: 'unsupported_form',
    waitingMs: 15140 * MIN,
    distinctJobs: 3,
    jobs: ['lp1', 'ap1', 'o1'],
  },
  intendedStops: { duplicate: 3, capped: 2, eligibilityExcluded: 5 },
  // late's confirm and q2's pause.closed fall after the cutoff.
  excludedFromWindow: {
    jobsBeforeClock: 2,
    jobsAfterCutoff: 1,
    eventsAfterCutoff: 2,
  },
};

// ---------------------------------------------------------------------------
// Scenario B: day seven with only Greenhouse live and no outreach at all.
// Lever, Ashby and every outreach step must read as labeled gaps, not zeros.
// ---------------------------------------------------------------------------
export const greenhouseOnlyWeek: Scenario = {
  name: 'greenhouse-only-week',
  now: at(7, 5),
  adapters: [{ host: 'greenhouse', at: at(0, 0, -30) }],
  jobs: [
    {
      key: 'g1',
      host: 'greenhouse',
      at: at(0),
      steps: [passed, { t: 'submit' }, { t: 'confirm' }],
    },
    {
      key: 'g2',
      host: 'greenhouse',
      at: at(1, 10),
      steps: [
        passed,
        { t: 'pause', cause: 'unanswered_question', hours: 5 },
        { t: 'submit' },
        { t: 'confirm' },
      ],
    },
    {
      key: 'g3',
      host: 'greenhouse',
      at: at(2),
      steps: [{ t: 'elig', decision: 'excluded' }],
    },
    {
      key: 'g4',
      host: 'greenhouse',
      at: at(3),
      steps: [{ t: 'dup', of: 'g1' }],
    },
    // pause 2d09:20 → open until 7d00:00 = 110h40m
    {
      key: 'l1',
      host: 'lever',
      at: at(2, 9),
      steps: [passed, { t: 'pause', cause: 'unsupported_form' }],
    },
    { key: 'a1', host: 'ashby', at: at(4, 11), steps: [passed] },
    { key: 'a2', host: 'ashby', at: at(4, 12), steps: [{ t: 'cap' }] },
  ],
  samples: [
    {
      job: 'g1',
      group: 'passed',
      at: at(7, 1),
      completions: [{ outcome: 'no_change', at: at(7, 2) }],
    },
    { job: 'g2', group: 'passed', at: at(7, 1, 1), completions: [] },
    { job: 'g3', group: 'excluded', at: at(7, 1, 2), completions: [] },
  ],
};

export const greenhouseOnlyExpected: ExpectedScenario = {
  clockStart: at(0).toISOString(),
  cutoff: at(7).toISOString(),
  daysCovered: 7,
  complete: true,
  hostsLive: ['greenhouse'],
  hostsAbsent: ['lever', 'ashby'],
  hostDays: { greenhouse: 7, lever: 0, ashby: 0 },
  outreachDays: { outreach: null, email: null, linkedin: null },
  funnel: {
    selected: row(7, h(4, 1, 2, 0)),
    duplicate: row(1, h(1, 0, 0, 0)),
    capped: row(1, h(0, 0, 1, 0)),
    eligibilityExcluded: row(1, h(1, 0, 0, 0)),
    eligibilityReview: row(0, h(0, 0, 0, 0)),
    eligibilityPassed: row(4, h(2, 1, 1, 0)),
    submitting: row(2, h(2, null, null, null)),
    confirmed: row(2, h(2, null, null, null)),
    uncertain: row(0, h(0, null, null, null)),
    outreachShortlisted: row(null, h(null, null, null, null)),
    outreachReviewed: row(null, h(null, null, null, null)),
    emailAccepted: row(null, h(null, null, null, null)),
    linkedinRecorded: row(null, h(null, null, null, null)),
  },
  pauses: {
    unanswered_question: {
      episodes: 1,
      distinctJobs: 1,
      openEpisodes: 0,
      waitingMs: 300 * MIN,
    },
    unsupported_form: {
      episodes: 1,
      distinctJobs: 1,
      openEpisodes: 1,
      waitingMs: 6640 * MIN,
    },
    uncertain_submission: {
      episodes: 0,
      distinctJobs: 0,
      openEpisodes: 0,
      waitingMs: 0,
    },
    // No email delivery observed: absent, not zero.
    uncertain_email: {
      episodes: null,
      distinctJobs: null,
      openEpisodes: null,
      waitingMs: null,
    },
  },
  pauseTotals: {
    episodes: 2,
    distinctJobs: 2,
    openEpisodes: 1,
    waitingMs: 6940 * MIN,
  },
  corrections: {
    missed_restriction: { corrections: 0, reviewed: 1 },
    reversed_exclusion: { corrections: 0, reviewed: 0 },
    edited_draft: { corrections: null, reviewed: null },
    changed_ranking: { corrections: null, reviewed: null },
  },
  samples: {
    passed: {
      available: 4,
      sampled: 2,
      reviewed: 1,
      skipped: 0,
      deferred: 0,
      pending: 1,
    },
    excluded: {
      available: 1,
      sampled: 1,
      reviewed: 0,
      skipped: 0,
      deferred: 0,
      pending: 1,
    },
  },
  bottleneck: {
    cause: 'unsupported_form',
    waitingMs: 6640 * MIN,
    distinctJobs: 1,
    jobs: ['l1'],
  },
  intendedStops: { duplicate: 1, capped: 1, eligibilityExcluded: 1 },
  excludedFromWindow: {
    jobsBeforeClock: 0,
    jobsAfterCutoff: 0,
    eventsAfterCutoff: 0,
  },
};
