import { z } from 'zod';
import { id, pauseCauses, reviewOutcomes } from './contracts.js';

/** Pilot ATS hosts whose availability is reported only from `adapter.available`. */
export const pilotHosts = ['greenhouse', 'lever', 'ashby'] as const;
export type PilotHost = (typeof pilotHosts)[number];
/** Funnel host rows: the three pilot adapters plus every other (unsupported) host. */
export type FunnelHost = PilotHost | 'other';
export const funnelHosts: FunnelHost[] = [...pilotHosts, 'other'];

const hostnames: Record<string, PilotHost> = {
  'boards.greenhouse.io': 'greenhouse',
  'job-boards.greenhouse.io': 'greenhouse',
  'jobs.lever.co': 'lever',
  'jobs.ashbyhq.com': 'ashby',
};
/** Maps a recorded application hostname to its pilot adapter, if any. */
export function pilotHostOf(applicationHost: string): FunnelHost {
  return hostnames[applicationHost.toLowerCase()] ?? 'other';
}

export const REPORT_WINDOW_DAYS = 7;

/**
 * Funnel stages, each counted as distinct pilot jobs. `group` controls which
 * coverage applies: `intake` is always observable once the clock starts,
 * `submission` needs the job's host adapter, `outreach`/`email`/`linkedin`
 * need the corresponding outreach step to have been observed.
 */
export const funnelStages = [
  { key: 'selected', label: 'Selected', group: 'intake' },
  { key: 'duplicate', label: 'Duplicate', group: 'intake' },
  { key: 'capped', label: 'Capped', group: 'intake' },
  {
    key: 'eligibilityExcluded',
    label: 'Eligibility excluded',
    group: 'intake',
  },
  { key: 'eligibilityReview', label: 'Eligibility in review', group: 'intake' },
  { key: 'eligibilityPassed', label: 'Eligibility passed', group: 'intake' },
  { key: 'submitting', label: 'Submitting', group: 'submission' },
  { key: 'confirmed', label: 'Confirmed submitted', group: 'submission' },
  { key: 'uncertain', label: 'Uncertain (unresolved)', group: 'submission' },
  {
    key: 'outreachShortlisted',
    label: 'Outreach shortlisted',
    group: 'outreach',
  },
  { key: 'outreachReviewed', label: 'Outreach reviewed', group: 'outreach' },
  { key: 'emailAccepted', label: 'Email accepted (SMTP)', group: 'email' },
  {
    key: 'linkedinRecorded',
    label: 'LinkedIn recorded (manual)',
    group: 'linkedin',
  },
] as const;
export type FunnelStageKey = (typeof funnelStages)[number]['key'];
export type StageGroup = (typeof funnelStages)[number]['group'];

export type PauseCause = (typeof pauseCauses)[number];
/**
 * Report rows for pauses: the nine v1 causes plus `outreach_review`. Lane D's review tickets
 * carry cause `unanswered_question` (v1 has no review cause); the report attributes tickets
 * with resolve_action `review_outreach` to this separate row so real unanswered-question
 * waiting time is not inflated.
 */
export const pauseCategories = [...pauseCauses, 'outreach_review'] as const;
export type PauseCategory = (typeof pauseCategories)[number];
export function pauseCategoryLabel(category: PauseCategory) {
  return category.replaceAll('_', ' ');
}
export type ReviewOutcome = (typeof reviewOutcomes)[number];

/** A host or outreach step's observed coverage inside the report window. */
export interface CoverageWindow {
  live: boolean;
  /** Start of coverage inside the window (clipped to the clock start). */
  from: string | null;
  /** End of coverage (the report cutoff) when live. */
  to: string | null;
  /** Days of the window this source covered, rounded to 0.01. */
  days: number;
  /** Ledger event that established coverage (first `adapter.available`, or first outreach event). */
  sourceEventId: string | null;
}
export interface ReportCoverage {
  clockStart: string;
  clockSource: 'explicit' | 'derived';
  windowEnd: string;
  cutoff: string;
  daysCovered: number;
  complete: boolean;
  hosts: Record<PilotHost, CoverageWindow>;
  outreach: CoverageWindow;
  email: CoverageWindow;
  linkedin: CoverageWindow;
  hostsLive: PilotHost[];
  hostsAbsent: PilotHost[];
}

/** `null` means the stage was not covered and nothing was observed: absent, not zero. */
export type Count = number | null;
export interface FunnelStage {
  key: FunnelStageKey;
  label: string;
  group: StageGroup;
  total: Count;
  byHost: Record<FunnelHost, Count>;
  jobIds: string[];
}
export interface FunnelChart {
  coverageLabel: string;
  hostCoverage: Record<FunnelHost, CoverageWindow & { selectedJobs: number }>;
  stages: FunnelStage[];
}

export interface PauseEpisode {
  pauseId: string;
  ticketId: string;
  jobId: string;
  /** The v1 cause on the pause events. */
  cause: PauseCause;
  /** The report row it counts under (see `pauseCategories`). */
  category: PauseCategory;
  openedAt: string;
  closedAt: string | null;
  open: boolean;
  waitingMs: number;
  outcome: ReviewOutcome | null;
  openedEventId: string;
  closedEventId: string | null;
}
export interface PauseCauseRow {
  cause: PauseCategory;
  label: string;
  /** Null when the cause cannot occur without uncovered sources and none occurred. */
  episodes: Count;
  distinctJobs: Count;
  openEpisodes: Count;
  waitingMs: Count;
  episodeIds: string[];
}
export interface PausesChart {
  coverageLabel: string;
  causes: PauseCauseRow[];
  totals: {
    episodes: number;
    distinctJobs: number;
    openEpisodes: number;
    waitingMs: number;
  };
  episodes: PauseEpisode[];
}

export interface CorrectionRow {
  key:
    | 'missed_restriction'
    | 'reversed_exclusion'
    | 'edited_draft'
    | 'changed_ranking';
  label: string;
  source: 'passed_sample' | 'excluded_sample' | 'outreach_review';
  corrections: Count;
  /** Reviews actually completed for this source; selections never count. */
  reviewed: Count;
  rate: number | null;
  recordIds: string[];
}
export interface SampleGroupSummary {
  group: 'passed' | 'excluded';
  available: number;
  sampled: number;
  reviewed: number;
  skipped: number;
  deferred: number;
  pending: number;
  outcomes: Partial<Record<ReviewOutcome, number>>;
}
export interface CorrectionsChart {
  coverageLabel: string;
  rows: CorrectionRow[];
  samples: Record<'passed' | 'excluded', SampleGroupSummary>;
  outreach: {
    reviewed: Count;
    outcomes: Partial<Record<ReviewOutcome, number>>;
  };
}

export interface BottleneckRecord {
  jobId: string;
  title: string;
  employer: string;
  pauseId: string;
  ticketId: string;
  question: string | null;
  openedAt: string;
  closedAt: string | null;
  waitingMs: number;
  eventIds: string[];
}
export interface Bottleneck {
  rule: string;
  cause: PauseCategory;
  waitingMs: number;
  distinctJobs: number;
  episodes: number;
  records: BottleneckRecord[];
  ranking: { cause: PauseCategory; waitingMs: number; distinctJobs: number }[];
  /** Human-written in 013b; the report never generates it. */
  improvement: null;
}

export interface PilotReport {
  status: 'ready';
  generatedAt: string;
  coverage: ReportCoverage;
  funnel: FunnelChart;
  pauses: PausesChart;
  corrections: CorrectionsChart;
  intendedStops: {
    duplicate: number;
    capped: number;
    eligibilityExcluded: number;
  };
  bottleneck: Bottleneck | null;
  excludedFromWindow: {
    jobsBeforeClock: number;
    jobsAfterCutoff: number;
    eventsAfterCutoff: number;
  };
}
export interface ReportNotStarted {
  status: 'not_started';
  generatedAt: string;
  reason: string;
}
export type ReportResponse = PilotReport | ReportNotStarted;

export const reportQuery = z.object({
  clockStart: z.iso.datetime({ offset: true }).optional(),
});
export const sampleDrawInput = z.object({
  clockStart: z.iso.datetime({ offset: true }).optional(),
  seed: z.string().min(1).max(200).optional(),
});
export const sampleCompleteInput = z.object({
  outcome: z.enum(reviewOutcomes),
});
export const sampleIdParam = z.object({ sampleId: id });
/** Outcomes a sample reviewer may record for each group. */
export const sampleOutcomes = {
  passed: ['no_change', 'missed_restriction', 'skipped', 'deferred'],
  excluded: ['no_change', 'reversed_exclusion', 'skipped', 'deferred'],
} as const satisfies Record<'passed' | 'excluded', readonly ReviewOutcome[]>;

export interface ReviewSample {
  sampleId: string;
  jobId: string;
  group: 'passed' | 'excluded';
  title: string;
  employer: string;
  sampledAt: string;
  outcome: ReviewOutcome | null;
  completedAt: string | null;
}
