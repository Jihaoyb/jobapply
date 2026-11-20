import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  funnelHosts,
  sampleOutcomes,
  type Count,
  type FunnelHost,
  type PilotReport,
  type ReportResponse,
  type ReviewSample,
} from '../../shared/report.js';
import './report.css';

const hostName: Record<FunnelHost, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  other: 'Other hosts',
};
const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
const pct = (rate: number) => `${Math.round(rate * 100)}%`;
const label = (value: string) => value.replaceAll('_', ' ');
const show = (value: Count) => (value === null ? 'absent' : String(value));

interface Bar {
  key: string;
  label: string;
  /** Null renders as a labeled gap, never as a zero-length bar. */
  value: number | null;
  text: string;
}
/** Lightweight horizontal bars: the text carries every number, the SVG only magnitude. */
function Bars({ rows, max, name }: { rows: Bar[]; max: number; name: string }) {
  return (
    <ul className="bars" aria-label={name}>
      {rows.map((row) => (
        <li key={row.key} className={row.value === null ? 'absent' : ''}>
          <span className="bar-label">{row.label}</span>
          <svg
            className="bar-track"
            viewBox="0 0 100 10"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {row.value === null ? (
              <rect className="bar-gap" x="0.5" y="0.5" width="99" height="9" />
            ) : (
              <rect
                className="bar-fill"
                x="0"
                y="0"
                height="10"
                width={
                  max ? Math.max((row.value / max) * 100, row.value ? 1 : 0) : 0
                }
              />
            )}
          </svg>
          <span className="bar-value">{row.text}</span>
        </li>
      ))}
    </ul>
  );
}

function Coverage({ text }: { text: string }) {
  return <p className="coverage">{text}</p>;
}

function Funnel({ report }: { report: PilotReport }) {
  const { stages, hostCoverage } = report.funnel;
  const max = stages[0]?.total ?? 0;
  return (
    <section className="chart" aria-labelledby="funnel-title">
      <h3 id="funnel-title">Application funnel (distinct jobs)</h3>
      <Coverage text={report.funnel.coverageLabel} />
      <Bars
        name="Funnel stages"
        max={max}
        rows={stages.map((s) => ({
          key: s.key,
          label: s.label,
          value: s.total,
          text: s.total === null ? 'absent: not live' : String(s.total),
        }))}
      />
      <table>
        <caption>By host, with each host’s coverage window</caption>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            {funnelHosts.map((host) => (
              <th scope="col" key={host}>
                {hostName[host]}
                <span className="muted">
                  {host === 'other'
                    ? 'no adapter'
                    : hostCoverage[host].live
                      ? `from ${hostCoverage[host].from!.slice(0, 10)} · ${hostCoverage[host].days} d`
                      : 'not live'}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stages.map((s) => (
            <tr key={s.key}>
              <th scope="row">{s.label}</th>
              {funnelHosts.map((host) => (
                <td key={host} className={s.byHost[host] === null ? 'gap' : ''}>
                  {show(s.byHost[host])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Intended stops (not failures): {report.intendedStops.duplicate}{' '}
        duplicate, {report.intendedStops.capped} capped,{' '}
        {report.intendedStops.eligibilityExcluded} eligibility excluded.
      </p>
    </section>
  );
}

function Pauses({ report }: { report: PilotReport }) {
  const { causes, totals } = report.pauses;
  const max = Math.max(0, ...causes.map((c) => c.waitingMs ?? 0));
  return (
    <section className="chart" aria-labelledby="pauses-title">
      <h3 id="pauses-title">Pauses by cause (waiting time)</h3>
      <Coverage text={report.pauses.coverageLabel} />
      <Bars
        name="Waiting time by pause cause"
        max={max}
        rows={causes.map((c) => ({
          key: c.cause,
          label: label(c.cause),
          value: c.waitingMs,
          text:
            c.waitingMs === null
              ? 'absent: source not live'
              : `${hours(c.waitingMs)} · ${c.distinctJobs} jobs · ${c.episodes} pauses${c.openEpisodes ? ` (${c.openEpisodes} open)` : ''}`,
        }))}
      />
      <p className="muted">
        Total: {hours(totals.waitingMs)} across {totals.episodes} pauses on{' '}
        {totals.distinctJobs} distinct jobs; {totals.openEpisodes} still open.
      </p>
    </section>
  );
}

function Corrections({ report }: { report: PilotReport }) {
  const { rows, samples, outreach } = report.corrections;
  return (
    <section className="chart" aria-labelledby="corrections-title">
      <h3 id="corrections-title">Corrections over reviewed denominators</h3>
      <Coverage text={report.corrections.coverageLabel} />
      <Bars
        name="Correction rates"
        max={1}
        rows={rows.map((r) => ({
          key: r.key,
          label: r.label,
          value: r.reviewed === null ? null : (r.rate ?? 0),
          text:
            r.reviewed === null
              ? 'absent: not live'
              : r.rate === null
                ? 'no completed reviews'
                : `${pct(r.rate)} · ${r.corrections} of ${r.reviewed} reviewed`,
        }))}
      />
      <p className="muted">
        Passed sample: {samples.passed.sampled} selected of{' '}
        {samples.passed.available}, {samples.passed.reviewed} reviewed,{' '}
        {samples.passed.pending} pending. Excluded sample:{' '}
        {samples.excluded.sampled} selected of {samples.excluded.available},{' '}
        {samples.excluded.reviewed} reviewed, {samples.excluded.pending}{' '}
        pending. Outreach reviewed: {show(outreach.reviewed)}.
      </p>
    </section>
  );
}

function BottleneckCard({ report }: { report: PilotReport }) {
  const b = report.bottleneck;
  return (
    <section className="chart bottleneck" aria-labelledby="bottleneck-title">
      <h3 id="bottleneck-title">Largest observed bottleneck</h3>
      {!b ? (
        <p className="muted">No pauses recorded in the window.</p>
      ) : (
        <>
          <p>
            <strong>{label(b.cause)}</strong>: {hours(b.waitingMs)} waiting
            across {b.distinctJobs} jobs ({b.episodes} pauses).
          </p>
          <p className="muted">{b.rule}</p>
          <ul className="records">
            {b.records.map((r) => (
              <li key={r.pauseId}>
                <span>
                  {r.employer} · {r.title}
                </span>
                <span className="muted">
                  {hours(r.waitingMs)}
                  {r.closedAt ? '' : ' (open)'} · ticket{' '}
                  {r.ticketId.slice(0, 8)} · job {r.jobId.slice(0, 8)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="notice">
        One improvement: written by you when the report is published (013b).
      </p>
    </section>
  );
}

function Samples({ onChanged }: { onChanged: () => Promise<void> }) {
  const [samples, setSamples] = useState<ReviewSample[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function refresh() {
    setSamples(
      (await api<{ samples: ReviewSample[] }>('/api/report/samples')).samples,
    );
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await Promise.all([refresh(), onChanged()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const pending = samples.filter(
    (s) => s.outcome === null || s.outcome === 'deferred',
  );
  return (
    <section className="chart" aria-labelledby="samples-title">
      <h3 id="samples-title">Review sample</h3>
      <p className="muted">
        Ten passed and ten excluded postings, or all available. Only completed
        reviews count toward the corrections chart.
      </p>
      <button
        className="secondary"
        disabled={busy}
        onClick={() =>
          void run(() =>
            api('/api/report/samples', { method: 'POST', body: '{}' }),
          )
        }
      >
        Draw sample
      </button>
      <ul className="records">
        {pending.map((s) => (
          <li key={s.sampleId}>
            <span>
              {s.employer} · {s.title}{' '}
              <span className="muted">({s.group})</span>
            </span>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const outcome = new FormData(event.currentTarget).get(
                  'outcome',
                );
                void run(() =>
                  api(`/api/report/samples/${s.sampleId}/complete`, {
                    method: 'POST',
                    body: JSON.stringify({ outcome }),
                  }),
                );
              }}
            >
              <select name="outcome" aria-label="Review outcome">
                {sampleOutcomes[s.group].map((o) => (
                  <option key={o} value={o}>
                    {label(o)}
                  </option>
                ))}
              </select>
              <button className="text-button" disabled={busy}>
                Record review
              </button>
            </form>
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function ReportPanel() {
  const [report, setReport] = useState<ReportResponse | null>(null),
    [error, setError] = useState('');
  async function refresh() {
    setReport(await api<ReportResponse>('/api/report'));
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  return (
    <section className="report" aria-labelledby="report-title">
      <h2 id="report-title">Seven-day pilot report</h2>
      {error && <p role="alert">{error}</p>}
      {!report ? (
        !error && <p role="status">Loading report…</p>
      ) : report.status !== 'ready' ? (
        <p className="muted">{report.reason}</p>
      ) : (
        <>
          <p className="muted">
            Clock {report.coverage.clockSource} from{' '}
            {new Date(report.coverage.clockStart).toLocaleString()} · cutoff{' '}
            {new Date(report.coverage.cutoff).toLocaleString()}
          </p>
          <Funnel report={report} />
          <Pauses report={report} />
          <Corrections report={report} />
          <BottleneckCard report={report} />
          <Samples onChanged={refresh} />
        </>
      )}
    </section>
  );
}
