import {
  pauseCauses,
  type EventName,
  type EventPayload,
} from '../../shared/contracts.js';
import {
  REPORT_WINDOW_DAYS,
  funnelHosts,
  funnelStages,
  pilotHostOf,
  pilotHosts,
  type Bottleneck,
  type CorrectionRow,
  type Count,
  type CoverageWindow,
  type FunnelHost,
  type FunnelStage,
  type FunnelStageKey,
  type PauseCause,
  type PauseCauseRow,
  type PauseEpisode,
  type PilotHost,
  type PilotReport,
  type ReportCoverage,
  type ReportResponse,
  type ReviewOutcome,
  type SampleGroupSummary,
} from '../../shared/report.js';

/** Ledger rows as read from v1 tables; nothing else feeds the report. */
export interface ReportEvent {
  id: string;
  jobId: string | null;
  name: EventName;
  occurredAt: string;
  payload: any;
}
export interface ReportJob {
  id: string;
  title: string;
  employer: string;
  applicationHost: string;
}
export interface ReportTicket {
  id: string;
  jobId: string;
  pauseId: string;
  question: string;
}
export interface ReportLedger {
  events: ReportEvent[];
  jobs: ReportJob[];
  tickets: ReportTicket[];
}
export interface ReportOptions {
  now: Date;
  /** Explicit clock start. When omitted the clock is derived; see `deriveClockStart`. */
  clockStart?: Date;
}

const DAY = 86_400_000;
const round2 = (value: number) => Math.round(value * 100) / 100;
const iso = (ms: number) => new Date(ms).toISOString();
const time = (event: ReportEvent) => Date.parse(event.occurredAt);
const payloadOf = <N extends EventName>(event: ReportEvent, _name: N) =>
  event.payload as EventPayload<N>;
function chronological(events: ReportEvent[]) {
  return [...events].sort(
    (a, b) => time(a) - time(b) || a.id.localeCompare(b.id),
  );
}

/**
 * The seven-day clock starts at the first live decision (issue 007): the first
 * `job.selected` at or after the earliest `adapter.available`. Synthetic P1
 * captures predate any adapter going live and therefore never start the clock.
 * An explicit start always wins, so the operator can pin the clock if a
 * synthetic capture slipped in after go-live.
 */
export function deriveClockStart(
  events: ReportEvent[],
): { at: number; eventId: string } | null {
  const ordered = chronological(events);
  const firstAdapter = ordered.find((e) => e.name === 'adapter.available');
  if (!firstAdapter) return null;
  const first = ordered.find(
    (e) => e.name === 'job.selected' && time(e) >= time(firstAdapter),
  );
  return first ? { at: time(first), eventId: first.id } : null;
}

function windowFrom(
  start: ReportEvent | undefined,
  clockStart: number,
  cutoff: number,
): CoverageWindow {
  if (!start || time(start) > cutoff)
    return { live: false, from: null, to: null, days: 0, sourceEventId: null };
  const from = Math.max(time(start), clockStart);
  return {
    live: true,
    from: iso(from),
    to: iso(cutoff),
    days: round2((cutoff - from) / DAY),
    sourceEventId: start.id,
  };
}

const hostNames: Record<FunnelHost, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  other: 'Other hosts',
};
const day = (value: string | null) => (value ? value.slice(0, 10) : '');
function hostsLabel(coverage: ReportCoverage) {
  const live = coverage.hostsLive.map(
    (host) =>
      `${hostNames[host]} from ${day(coverage.hosts[host].from)} (${coverage.hosts[host].days} d)`,
  );
  const absent = coverage.hostsAbsent.map((host) => hostNames[host]);
  return `Hosts live: ${live.length ? live.join(', ') : 'none'}${absent.length ? `; not live (absent, not zero): ${absent.join(', ')}` : ''}`;
}
function stepLabel(name: string, window: CoverageWindow) {
  return window.live
    ? `${name} observed from ${day(window.from)} (${window.days} d)`
    : `${name}: no records (absent, not zero)`;
}
function daysLabel(coverage: ReportCoverage) {
  return `Days covered: ${coverage.daysCovered} of ${REPORT_WINDOW_DAYS}${coverage.complete ? '' : ' (window still open)'}`;
}

export function computeReport(
  ledger: ReportLedger,
  options: ReportOptions,
): ReportResponse {
  const now = options.now.getTime();
  const generatedAt = iso(now);
  const events = chronological(ledger.events);
  let clockStart: number, clockSource: 'explicit' | 'derived';
  if (options.clockStart) {
    clockStart = options.clockStart.getTime();
    clockSource = 'explicit';
  } else {
    const derived = deriveClockStart(events);
    if (!derived)
      return {
        status: 'not_started',
        generatedAt,
        reason:
          'No live decision yet: the clock starts at the first job.selected at or after the first adapter.available.',
      };
    clockStart = derived.at;
    clockSource = 'derived';
  }
  if (clockStart > now)
    return {
      status: 'not_started',
      generatedAt,
      reason: 'The clock start is in the future.',
    };
  const windowEnd = clockStart + REPORT_WINDOW_DAYS * DAY;
  const cutoff = Math.min(now, windowEnd);

  // Pilot jobs: selected inside [clockStart, cutoff]. Earlier (synthetic) and later jobs are excluded.
  const selectedAt = new Map<string, ReportEvent>();
  let jobsBeforeClock = 0,
    jobsAfterCutoff = 0;
  for (const event of events) {
    if (event.name !== 'job.selected' || !event.jobId) continue;
    if (selectedAt.has(event.jobId)) continue;
    if (time(event) < clockStart) jobsBeforeClock++;
    else if (time(event) > cutoff) jobsAfterCutoff++;
    else selectedAt.set(event.jobId, event);
  }
  const pilotJobs = [...selectedAt.keys()];
  const hostOf = new Map<string, FunnelHost>(
    pilotJobs.map((jobId) => [
      jobId,
      pilotHostOf(
        payloadOf(selectedAt.get(jobId)!, 'job.selected').applicationHost,
      ),
    ]),
  );
  // Review sampling and completion happen at publication (after the cutoff)
  // and describe in-window jobs, so they are not cut off by time.
  const reviewNames = new Set<EventName>([
    'review.sampled',
    'review.completed',
  ]);
  let eventsAfterCutoff = 0;
  const inWindow: ReportEvent[] = [];
  for (const event of events) {
    if (!event.jobId || !selectedAt.has(event.jobId)) continue;
    if (time(event) > cutoff && !reviewNames.has(event.name)) {
      eventsAfterCutoff++;
      continue;
    }
    inWindow.push(event);
  }
  const byName = (name: EventName) => inWindow.filter((e) => e.name === name);

  // Coverage: hosts from the first adapter.available at or before the cutoff;
  // outreach steps from their first observed event.
  const adapters = events.filter(
    (e) => e.name === 'adapter.available' && time(e) <= cutoff,
  );
  const hosts = Object.fromEntries(
    pilotHosts.map((host) => [
      host,
      windowFrom(
        adapters.find((e) => payloadOf(e, 'adapter.available').host === host),
        clockStart,
        cutoff,
      ),
    ]),
  ) as Record<PilotHost, CoverageWindow>;
  const firstOf = (...names: EventName[]) =>
    inWindow.find((e) => names.includes(e.name));
  const coverage: ReportCoverage = {
    clockStart: iso(clockStart),
    clockSource,
    windowEnd: iso(windowEnd),
    cutoff: iso(cutoff),
    daysCovered: round2((cutoff - clockStart) / DAY),
    complete: cutoff >= windowEnd,
    hosts,
    outreach: windowFrom(
      firstOf(
        'outreach.shortlisted',
        'outreach.reviewed',
        'email.accepted',
        'email.uncertain',
        'linkedin.recorded',
      ),
      clockStart,
      cutoff,
    ),
    email: windowFrom(
      firstOf('email.accepted', 'email.uncertain'),
      clockStart,
      cutoff,
    ),
    linkedin: windowFrom(firstOf('linkedin.recorded'), clockStart, cutoff),
    hostsLive: pilotHosts.filter((host) => hosts[host].live),
    hostsAbsent: pilotHosts.filter((host) => !hosts[host].live),
  };

  // ---- Funnel: distinct jobs per stage ----
  const jobsWith = (name: EventName) =>
    new Set(byName(name).map((e) => e.jobId!));
  const finalDecision = new Map<string, 'passed' | 'excluded' | 'review'>();
  for (const event of byName('eligibility.decided'))
    finalDecision.set(
      event.jobId!,
      payloadOf(event, 'eligibility.decided').decision,
    );
  const confirmed = jobsWith('application.confirmed');
  const decided = (decision: string) =>
    new Set(
      [...finalDecision].filter(([, d]) => d === decision).map(([j]) => j),
    );
  const stageJobs: Record<FunnelStageKey, Set<string>> = {
    selected: new Set(pilotJobs),
    duplicate: jobsWith('job.duplicate'),
    capped: jobsWith('job.capped'),
    eligibilityExcluded: decided('excluded'),
    eligibilityReview: decided('review'),
    eligibilityPassed: decided('passed'),
    submitting: jobsWith('application.submitting'),
    confirmed,
    uncertain: new Set(
      [...jobsWith('application.uncertain')].filter((j) => !confirmed.has(j)),
    ),
    outreachShortlisted: jobsWith('outreach.shortlisted'),
    outreachReviewed: jobsWith('outreach.reviewed'),
    emailAccepted: jobsWith('email.accepted'),
    linkedinRecorded: jobsWith('linkedin.recorded'),
  };
  const covered = (
    group: (typeof funnelStages)[number]['group'],
    host: FunnelHost,
  ) => {
    switch (group) {
      case 'intake':
        return true;
      case 'submission':
        return host !== 'other' && hosts[host].live;
      case 'outreach':
        return coverage.outreach.live;
      case 'email':
        return coverage.email.live;
      case 'linkedin':
        return coverage.linkedin.live;
    }
  };
  const stages: FunnelStage[] = funnelStages.map((stage) => {
    const ids = [...stageJobs[stage.key]].sort();
    const byHost = Object.fromEntries(
      funnelHosts.map((host) => {
        const count = ids.filter((j) => hostOf.get(j) === host).length;
        return [host, covered(stage.group, host) || count ? count : null];
      }),
    ) as Record<FunnelHost, Count>;
    const anyCovered = funnelHosts.some((host) => covered(stage.group, host));
    return {
      key: stage.key,
      label: stage.label,
      group: stage.group,
      total: anyCovered || ids.length ? ids.length : null,
      byHost,
      jobIds: ids,
    };
  });
  const hostCoverage = Object.fromEntries(
    funnelHosts.map((host) => [
      host,
      {
        ...(host === 'other'
          ? { live: false, from: null, to: null, days: 0, sourceEventId: null }
          : hosts[host]),
        selectedJobs: pilotJobs.filter((j) => hostOf.get(j) === host).length,
      },
    ]),
  ) as PilotReport['funnel']['hostCoverage'];

  // ---- Pauses: paired by owner, job and pauseId; open pauses accrue to the cutoff ----
  const episodes = new Map<string, PauseEpisode>();
  for (const event of inWindow) {
    if (event.name === 'pause.opened') {
      const p = payloadOf(event, 'pause.opened');
      episodes.set(`${event.jobId}:${p.pauseId}`, {
        pauseId: p.pauseId,
        ticketId: p.ticketId,
        jobId: event.jobId!,
        cause: p.cause,
        openedAt: iso(time(event)),
        closedAt: null,
        open: true,
        waitingMs: 0,
        outcome: null,
        openedEventId: event.id,
        closedEventId: null,
      });
    } else if (event.name === 'pause.closed') {
      const p = payloadOf(event, 'pause.closed');
      const episode = episodes.get(`${event.jobId}:${p.pauseId}`);
      if (!episode || !episode.open) continue;
      episode.open = false;
      episode.closedAt = iso(time(event));
      episode.outcome = p.outcome;
      episode.closedEventId = event.id;
    }
  }
  const episodeList = [...episodes.values()];
  for (const episode of episodeList)
    episode.waitingMs =
      (episode.closedAt ? Date.parse(episode.closedAt) : cutoff) -
      Date.parse(episode.openedAt);
  const causeCovered = (cause: PauseCause) =>
    cause === 'uncertain_email'
      ? coverage.email.live
      : cause === 'uncertain_submission'
        ? coverage.hostsLive.length > 0
        : true;
  const causes: PauseCauseRow[] = pauseCauses.map((cause) => {
    const list = episodeList.filter((e) => e.cause === cause);
    const absent = !causeCovered(cause) && !list.length;
    const value = (n: number) => (absent ? null : n);
    return {
      cause,
      episodes: value(list.length),
      distinctJobs: value(new Set(list.map((e) => e.jobId)).size),
      openEpisodes: value(list.filter((e) => e.open).length),
      waitingMs: value(list.reduce((sum, e) => sum + e.waitingMs, 0)),
      episodeIds: list.map((e) => e.pauseId),
    };
  });

  // ---- Corrections: reviewed denominators, never selections ----
  const sampleGroup = new Map<string, 'passed' | 'excluded'>();
  for (const event of byName('review.sampled')) {
    const p = payloadOf(event, 'review.sampled');
    if (!sampleGroup.has(p.sampleId)) sampleGroup.set(p.sampleId, p.group);
  }
  const sampleOutcome = new Map<string, ReviewOutcome>();
  for (const event of byName('review.completed')) {
    const p = payloadOf(event, 'review.completed');
    if (sampleGroup.has(p.sampleId)) sampleOutcome.set(p.sampleId, p.outcome);
  }
  const notReviewed = new Set<ReviewOutcome>(['skipped', 'deferred']);
  function summarize(group: 'passed' | 'excluded'): SampleGroupSummary {
    const ids = [...sampleGroup].filter(([, g]) => g === group).map(([s]) => s);
    const outcomes: Partial<Record<ReviewOutcome, number>> = {};
    for (const s of ids) {
      const outcome = sampleOutcome.get(s);
      if (outcome) outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    const completed = ids.filter((s) => sampleOutcome.has(s));
    return {
      group,
      available: decided(group).size,
      sampled: ids.length,
      reviewed: completed.filter((s) => !notReviewed.has(sampleOutcome.get(s)!))
        .length,
      skipped: outcomes.skipped ?? 0,
      deferred: outcomes.deferred ?? 0,
      pending: ids.length - completed.length,
      outcomes,
    };
  }
  const samples = {
    passed: summarize('passed'),
    excluded: summarize('excluded'),
  };
  const outreachOutcome = new Map<string, ReviewOutcome>();
  for (const event of byName('outreach.reviewed')) {
    const p = payloadOf(event, 'outreach.reviewed');
    outreachOutcome.set(p.ticketId, p.outcome);
  }
  // A skipped outreach is a reviewed decision; a deferred one is not yet reviewed.
  const outreachReviewed = [...outreachOutcome].filter(
    ([, o]) => o !== 'deferred',
  );
  const outreachAbsent = !coverage.outreach.live && !outreachOutcome.size;
  const outreachOutcomes: Partial<Record<ReviewOutcome, number>> = {};
  for (const [, o] of outreachOutcome)
    outreachOutcomes[o] = (outreachOutcomes[o] ?? 0) + 1;
  function sampleRow(
    key: 'missed_restriction' | 'reversed_exclusion',
    label: string,
    group: 'passed' | 'excluded',
  ): CorrectionRow {
    const recordIds = [...sampleGroup]
      .filter(([s, g]) => g === group && sampleOutcome.get(s) === key)
      .map(([s]) => s)
      .sort();
    const reviewed = samples[group].reviewed;
    return {
      key,
      label,
      source: group === 'passed' ? 'passed_sample' : 'excluded_sample',
      corrections: recordIds.length,
      reviewed,
      rate: reviewed ? recordIds.length / reviewed : null,
      recordIds,
    };
  }
  function outreachRow(
    key: 'edited_draft' | 'changed_ranking',
    label: string,
  ): CorrectionRow {
    const recordIds = outreachReviewed
      .filter(([, o]) => o === key)
      .map(([t]) => t)
      .sort();
    const reviewed = outreachReviewed.length;
    return {
      key,
      label,
      source: 'outreach_review',
      corrections: outreachAbsent ? null : recordIds.length,
      reviewed: outreachAbsent ? null : reviewed,
      rate: reviewed ? recordIds.length / reviewed : null,
      recordIds,
    };
  }

  // ---- Bottleneck: pause cause with the most waiting time ----
  const ranking = causes
    .filter((c) => c.episodes)
    .map((c) => ({
      cause: c.cause,
      waitingMs: c.waitingMs!,
      distinctJobs: c.distinctJobs!,
    }))
    .sort(
      (a, b) =>
        b.waitingMs - a.waitingMs ||
        b.distinctJobs - a.distinctJobs ||
        a.cause.localeCompare(b.cause),
    );
  const jobs = new Map(ledger.jobs.map((j) => [j.id, j]));
  const tickets = new Map(ledger.tickets.map((t) => [t.id, t]));
  let bottleneck: Bottleneck | null = null;
  if (ranking.length) {
    const top = ranking[0]!;
    const row = causes.find((c) => c.cause === top.cause)!;
    bottleneck = {
      rule: 'Pause cause with the greatest total waiting time (open pauses accrue to the cutoff); ties by distinct jobs, then cause name. Intended stops (duplicate, capped, eligibility excluded) are never bottlenecks.',
      cause: top.cause,
      waitingMs: top.waitingMs,
      distinctJobs: top.distinctJobs,
      episodes: row.episodes!,
      ranking,
      improvement: null,
      records: episodeList
        .filter((e) => e.cause === top.cause)
        .sort(
          (a, b) =>
            b.waitingMs - a.waitingMs || a.pauseId.localeCompare(b.pauseId),
        )
        .map((e) => ({
          jobId: e.jobId,
          title: jobs.get(e.jobId)?.title ?? '',
          employer: jobs.get(e.jobId)?.employer ?? '',
          pauseId: e.pauseId,
          ticketId: e.ticketId,
          question: tickets.get(e.ticketId)?.question ?? null,
          openedAt: e.openedAt,
          closedAt: e.closedAt,
          waitingMs: e.waitingMs,
          eventIds: [e.openedEventId, e.closedEventId].filter(
            (x): x is string => !!x,
          ),
        })),
    };
  }

  const stageTotal = (key: FunnelStageKey) =>
    stages.find((s) => s.key === key)!.total ?? 0;
  return {
    status: 'ready',
    generatedAt,
    coverage,
    funnel: {
      coverageLabel: [
        hostsLabel(coverage),
        stepLabel('Outreach', coverage.outreach),
        stepLabel('Email delivery', coverage.email),
        stepLabel('LinkedIn recording', coverage.linkedin),
        daysLabel(coverage),
      ].join(' · '),
      hostCoverage,
      stages,
    },
    pauses: {
      coverageLabel: [
        hostsLabel(coverage),
        stepLabel('Email delivery', coverage.email),
        daysLabel(coverage),
        'Open pauses accrue waiting time to the cutoff',
      ].join(' · '),
      causes,
      totals: {
        episodes: episodeList.length,
        distinctJobs: new Set(episodeList.map((e) => e.jobId)).size,
        openEpisodes: episodeList.filter((e) => e.open).length,
        waitingMs: episodeList.reduce((sum, e) => sum + e.waitingMs, 0),
      },
      episodes: episodeList,
    },
    corrections: {
      coverageLabel: [
        `Samples: ${samples.passed.sampled} of ${samples.passed.available} passed and ${samples.excluded.sampled} of ${samples.excluded.available} excluded selected; ${samples.passed.reviewed + samples.excluded.reviewed} reviewed`,
        stepLabel('Outreach review', coverage.outreach),
        hostsLabel(coverage),
        daysLabel(coverage),
      ].join(' · '),
      rows: [
        sampleRow(
          'missed_restriction',
          'Missed restrictions (passed sample)',
          'passed',
        ),
        sampleRow(
          'reversed_exclusion',
          'Reversed exclusions (excluded sample)',
          'excluded',
        ),
        outreachRow('edited_draft', 'Edited drafts (outreach review)'),
        outreachRow('changed_ranking', 'Changed rankings (outreach review)'),
      ],
      samples,
      outreach: {
        reviewed: outreachAbsent ? null : outreachReviewed.length,
        outcomes: outreachOutcomes,
      },
    },
    intendedStops: {
      duplicate: stageTotal('duplicate'),
      capped: stageTotal('capped'),
      eligibilityExcluded: stageTotal('eligibilityExcluded'),
    },
    bottleneck,
    excludedFromWindow: { jobsBeforeClock, jobsAfterCutoff, eventsAfterCutoff },
  };
}
