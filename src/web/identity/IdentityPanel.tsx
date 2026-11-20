import React, { useEffect, useState } from 'react';
import type {
  EmployerView,
  MergeSuggestionView,
  QueueItemView,
} from '../../shared/identity.js';
import { api } from '../api.js';
import './identity.css';

interface IdentityTicket {
  ticketId: string;
  kind: 'conflict' | 'plausible' | 'unresolved' | 'import';
  employerName: string;
  keys: string[];
  candidates: { id: string; name: string; domain: string | null }[];
}
interface ImportResult {
  batchId: string | null;
  rows: { line: number; outcome: string; employer: string; title: string }[];
  errors: { line: number; column: string | null; message: string }[];
  repeated: { line: number; sameAsLine: number }[];
  summary: Record<string, number>;
}

function useAction(refresh: () => Promise<void>) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run };
}
const post = (path: string, body: unknown, method = 'POST') =>
  api(path, { method, body: JSON.stringify(body) });

function IdentityTickets({
  tickets,
  action,
}: {
  tickets: IdentityTicket[];
  action: ReturnType<typeof useAction>;
}) {
  if (!tickets.length) return null;
  const resolve = (ticketId: string, body: unknown) =>
    action.run(() => post(`/api/identity/tickets/${ticketId}/resolve`, body));
  return (
    <div className="identity-block">
      <h3>Employer questions</h3>
      {tickets.map((ticket) => (
        <article key={ticket.ticketId} className="identity-ticket">
          <p>
            <strong>{ticket.employerName}</strong>
            {ticket.keys.length > 0 && (
              <span className="muted"> · {ticket.keys.join(', ')}</span>
            )}
            <span className="muted">
              {' '}
              · {ticket.kind === 'import' ? 'imported history' : ticket.kind}
            </span>
          </p>
          <div className="identity-actions">
            {ticket.candidates.map((candidate) => (
              <button
                key={candidate.id}
                className="secondary"
                disabled={action.busy}
                onClick={() =>
                  void resolve(ticket.ticketId, {
                    action: ticket.kind === 'conflict' ? 'merge' : 'assign',
                    employerId: candidate.id,
                  })
                }
              >
                {ticket.kind === 'conflict' ? 'Merge into ' : 'Same as '}
                {candidate.name}
              </button>
            ))}
            {ticket.kind === 'conflict' &&
              ticket.candidates.map((candidate) => (
                <button
                  key={`only-${candidate.id}`}
                  className="secondary"
                  disabled={action.busy}
                  onClick={() =>
                    void resolve(ticket.ticketId, {
                      action: 'assign',
                      employerId: candidate.id,
                    })
                  }
                >
                  Only this job → {candidate.name}
                </button>
              ))}
            {ticket.kind !== 'conflict' && (
              <button
                className="secondary"
                disabled={action.busy}
                onClick={() =>
                  void resolve(ticket.ticketId, { action: 'create' })
                }
              >
                New employer
              </button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function ImportHistory({ onImported }: { onImported: () => Promise<void> }) {
  const [result, setResult] = useState<ImportResult | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get('file');
    if (!(file instanceof File) || !file.size) return;
    setBusy(true);
    setError('');
    try {
      setResult(
        await api<ImportResult>('/api/identity/imports', {
          method: 'POST',
          body: JSON.stringify({ filename: file.name, csv: await file.text() }),
        }),
      );
      await onImported();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="identity-block">
      <h3>Import confirmed history</h3>
      <p className="muted">
        CSV header <code>employer,title,date,source URL</code>; dates are ISO
        local dates (Los Angeles), e.g. 2026-08-09. Re-importing is safe.
      </p>
      <form className="identity-inline" onSubmit={submit}>
        <input name="file" type="file" accept=".csv,text/csv" required />
        <button disabled={busy}>{busy ? 'Importing…' : 'Import'}</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div role="status">
          <p>
            Counted {result.summary.counted}, linked to existing{' '}
            {result.summary.linked}, waiting for employer{' '}
            {result.summary.pending_employer}, already imported{' '}
            {result.summary.already_imported}, repeated in file{' '}
            {result.summary.repeated}, rows with errors {result.summary.errors}.
          </p>
          {result.errors.length > 0 && (
            <ul className="identity-errors">
              {result.errors.map((rowError, index) => (
                <li key={index}>
                  Line {rowError.line}
                  {rowError.column ? ` (${rowError.column})` : ''}:{' '}
                  {rowError.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Queue({
  items,
  action,
}: {
  items: QueueItemView[];
  action: ReturnType<typeof useAction>;
}) {
  if (!items.length) return null;
  return (
    <div className="identity-block">
      <h3>Queue and holds</h3>
      <ul className="identity-list">
        {items.map((item) => (
          <li key={item.jobId}>
            <strong>{item.title}</strong> · {item.employer}{' '}
            <span className="muted">
              · {item.state} · {item.jobStatus}
            </span>
            {item.holdReason && (
              <p className="notice">Held: {item.holdReason}</p>
            )}
            {item.nextAvailableDate && (
              <p className="notice">
                Capped · next eligible {item.nextAvailableDate}{' '}
                {item.jobStatus === 'capped' && (
                  <button
                    className="text-button"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(() =>
                        post(`/api/identity/jobs/${item.jobId}/requeue`, {}),
                      )
                    }
                  >
                    Requeue
                  </button>
                )}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Employer({
  employer,
  action,
}: {
  employer: EmployerView;
  action: ReturnType<typeof useAction>;
}) {
  const [alias, setAlias] = useState(''),
    [domain, setDomain] = useState(employer.domain ?? '');
  return (
    <li>
      <h4>{employer.name}</h4>
      <p className="muted">
        {employer.cap.count}/{employer.cap.limit} confirmed since{' '}
        {employer.cap.windowStart} (exclusive)
        {employer.cap.capped &&
          ` · capped until ${employer.cap.nextAvailableDate}`}
        {employer.cap.heldBy.length > 0 && ' · held for reconciliation'}
        {employer.mergedFrom.length > 0 &&
          ` · merged: ${employer.mergedFrom.join(', ')}`}
      </p>
      <ul className="identity-aliases">
        {employer.aliases.map((item) => (
          <li key={item.id}>
            <code>{item.key}</code>{' '}
            <span className="muted">{item.source.replace('_', ' ')}</span>{' '}
            <button
              className="text-button"
              aria-label={`Remove alias ${item.key}`}
              disabled={action.busy}
              onClick={() =>
                void action.run(() =>
                  api(`/api/identity/aliases/${item.id}`, { method: 'DELETE' }),
                )
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {employer.links.map((link, index) => (
        <p key={index} className="muted">
          {link.relation} · {link.status}:{' '}
          <a href={link.careersUrl} target="_blank" rel="noreferrer">
            careers ↗
          </a>{' '}
          →{' '}
          <a href={link.atsUrl} target="_blank" rel="noreferrer">
            {link.atsKey} ↗
          </a>
        </p>
      ))}
      <form
        className="identity-inline"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() =>
            post('/api/identity/aliases', {
              key: alias,
              employerId: employer.id,
            }).then(() => setAlias('')),
          );
        }}
      >
        <input
          aria-label={`Add alias for ${employer.name}`}
          placeholder="acme.example or greenhouse:acme"
          value={alias}
          onChange={(event) => setAlias(event.target.value)}
          required
        />
        <button className="secondary" disabled={action.busy}>
          Add alias
        </button>
      </form>
      <form
        className="identity-inline"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() =>
            post(
              `/api/identity/employers/${employer.id}`,
              { domain: domain.trim() || null },
              'PATCH',
            ),
          );
        }}
      >
        <input
          aria-label={`Company domain for ${employer.name}`}
          placeholder="Company domain (optional)"
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
        />
        <button className="secondary" disabled={action.busy}>
          Save domain
        </button>
      </form>
    </li>
  );
}

/** Lane A dashboard: employer identity, import, queue holds and cap settings. */
export function IdentityPanel() {
  const [employers, setEmployers] = useState<EmployerView[]>([]),
    [suggestions, setSuggestions] = useState<MergeSuggestionView[]>([]),
    [tickets, setTickets] = useState<IdentityTicket[]>([]),
    [queue, setQueue] = useState<QueueItemView[]>([]),
    [cap, setCap] = useState({ limit: 3, windowMonths: 3 });
  async function refresh() {
    const [list, open, items, settings] = await Promise.all([
      api<{ employers: EmployerView[]; suggestions: MergeSuggestionView[] }>(
        '/api/identity/employers',
      ),
      api<{ tickets: IdentityTicket[] }>('/api/identity/tickets'),
      api<{ items: QueueItemView[] }>('/api/identity/queue'),
      api<{ limit: number; windowMonths: number }>(
        '/api/identity/cap-settings',
      ),
    ]);
    setEmployers(list.employers);
    setSuggestions(list.suggestions);
    setTickets(open.tickets);
    setQueue(items.items);
    setCap(settings);
  }
  const action = useAction(refresh);
  useEffect(() => {
    void action.run(async () => undefined);
  }, []);
  return (
    <section className="identity">
      <h2>Employers and cap</h2>
      {action.error && <p role="alert">{action.error}</p>}
      <IdentityTickets tickets={tickets} action={action} />
      {suggestions.length > 0 && (
        <div className="identity-block">
          <h3>Possible duplicates</h3>
          {suggestions.map((suggestion) => (
            <p key={suggestion.employerIds.join()} className="identity-inline">
              {suggestion.names[1]} ↔ {suggestion.names[0]}{' '}
              <span className="muted">{suggestion.reason}</span>
              <button
                className="secondary"
                disabled={action.busy}
                onClick={() =>
                  void action.run(() =>
                    post(
                      `/api/identity/employers/${suggestion.employerIds[1]}/merge`,
                      { intoEmployerId: suggestion.employerIds[0] },
                    ),
                  )
                }
              >
                Merge into {suggestion.names[0]}
              </button>
              <button
                className="text-button"
                disabled={action.busy}
                onClick={() =>
                  void action.run(() =>
                    post(
                      `/api/identity/employers/${suggestion.employerIds[0]}/distinct`,
                      { otherEmployerId: suggestion.employerIds[1] },
                    ),
                  )
                }
              >
                Not the same
              </button>
            </p>
          ))}
        </div>
      )}
      <Queue items={queue} action={action} />
      <ImportHistory onImported={refresh} />
      <div className="identity-block">
        <h3>Cap</h3>
        <form
          className="identity-inline"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(() =>
              post('/api/identity/cap-settings', cap, 'PUT'),
            );
          }}
        >
          <label>
            Confirmed per employer
            <input
              type="number"
              min={1}
              max={50}
              value={cap.limit}
              onChange={(event) =>
                setCap({ ...cap, limit: Number(event.target.value) })
              }
            />
          </label>
          <label>
            Window (calendar months, Los Angeles)
            <input
              type="number"
              min={1}
              max={24}
              value={cap.windowMonths}
              onChange={(event) =>
                setCap({ ...cap, windowMonths: Number(event.target.value) })
              }
            />
          </label>
          <button className="secondary" disabled={action.busy}>
            Save cap
          </button>
        </form>
      </div>
      {employers.length > 0 && (
        <div className="identity-block">
          <h3>Employers</h3>
          <ul className="identity-list">
            {employers.map((employer) => (
              <Employer
                key={`${employer.id}:${employer.domain}`}
                employer={employer}
                action={action}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
