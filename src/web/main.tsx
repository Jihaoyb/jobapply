import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Job, Ticket } from '../shared/contracts.js';
import { api } from './api.js';
import { AnswersPanel } from './answers/AnswersPanel.js';
import { ReportPanel } from './report/ReportPanel.js';
import './style.css';

function Login({ onLogin }: { onLogin: () => void }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/login', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(form)),
      });
      onLogin();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <h1>Your job ledger</h1>
      <p>Sign in to capture postings and manage your paired extension.</p>
      <form onSubmit={submit}>
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {error && <p role="alert">{error}</p>}
      </form>
    </main>
  );
}
interface Pairing {
  id: string;
  label: string;
  revokedAt: string | null;
}
function Pairings() {
  const [pairings, setPairings] = useState<Pairing[]>([]),
    [bundle, setBundle] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function refresh() {
    setPairings((await api<{ pairings: Pairing[] }>('/api/pairings')).pairings);
  }
  useEffect(() => {
    void refresh().catch((error) => setError(error.message));
  }, []);
  async function pair(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setBundle('');
    const label = new FormData(event.currentTarget).get('label');
    try {
      const data = await api('/api/pairings', {
        method: 'POST',
        body: JSON.stringify({ label }),
      });
      setBundle(JSON.stringify(data));
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(pairingId: string) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/pairings/${pairingId}`, { method: 'DELETE' });
      setBundle('');
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="pairings">
      <h2>Pair your extension</h2>
      <form onSubmit={pair}>
        <input
          name="label"
          aria-label="Device name"
          placeholder="Device name (e.g., Work Laptop)"
          maxLength={100}
          required
        />
        <button disabled={busy}>Create pairing token</button>
      </form>
      <p className="muted">Tokens can be revoked at any time.</p>
      {bundle && (
        <label className="token">
          Paste this once into the extension’s pairing field.
          <textarea
            readOnly
            value={bundle}
            rows={5}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            className="text-button"
            onClick={() => setBundle('')}
          >
            Hide token
          </button>
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      <ul className="device-list">
        {pairings.map((pairing) => (
          <li key={pairing.id}>
            <span>{pairing.label}</span>
            {pairing.revokedAt ? (
              <span className="muted">Revoked</span>
            ) : (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void revoke(pairing.id)}
              >
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
function PostingForm({ onSaved }: { onSaved: () => Promise<void> }) {
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  // Retain the id after network failures, so a retry cannot duplicate a capture.
  const [captureId, setCaptureId] = useState(() => crypto.randomUUID());
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    const form = event.currentTarget;
    try {
      await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({
          ...Object.fromEntries(new FormData(form)),
          clientCaptureId: captureId,
        }),
      });
      form.reset();
      setCaptureId(crypto.randomUUID());
      setMessage('Posting saved.');
      await onSaved();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="add-posting">
      <h2>Add a posting</h2>
      <form className="posting-form" onSubmit={submit}>
        <label>
          Role
          <input
            name="title"
            placeholder="e.g., Software Engineer"
            maxLength={300}
            required
          />
        </label>
        <label>
          Employer
          <input
            name="employer"
            placeholder="e.g., Acme Inc."
            maxLength={300}
            required
          />
        </label>
        <label>
          Discovery URL
          <input
            name="discoveryUrl"
            type="url"
            placeholder="e.g., https://www.example.com/jobs/123"
            maxLength={4000}
            required
          />
        </label>
        <label>
          Application URL
          <input
            name="applicationUrl"
            type="url"
            placeholder="e.g., https://apply.example.com/123"
            maxLength={4000}
            required
          />
        </label>
        <label>
          Posting text
          <textarea
            name="postingText"
            placeholder="Paste the job posting text here…"
            rows={5}
            maxLength={150000}
            required
          />
        </label>
        <button disabled={busy}>{busy ? 'Saving…' : 'Save posting'}</button>
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
      </form>
    </section>
  );
}
function SavedJobs({ jobs }: { jobs: Job[] }) {
  return (
    <section className="saved-jobs">
      <h2>Saved jobs</h2>
      {!jobs.length ? (
        <div className="empty">
          <h3>No jobs captured yet.</h3>
          <p className="muted">
            Choose Yes in the extension or add a posting here.
          </p>
        </div>
      ) : (
        <ul className="jobs">
          {jobs.map((job) => (
            <li key={job.id}>
              <h3>{job.title}</h3>
              <p>
                {job.employer} <span className="muted">· {job.status}</span>
              </p>
              <p className="job-links">
                <a href={job.discoveryUrl} target="_blank" rel="noreferrer">
                  Discovery ↗
                </a>
                <a href={job.applicationUrl} target="_blank" rel="noreferrer">
                  Application ↗
                </a>
              </p>
              <p className="muted">
                {new Date(job.createdAt).toLocaleString()} ·{' '}
                {job.applicationHost}
              </p>
              {!job.supportedHost && (
                <p className="notice">Unsupported application host recorded</p>
              )}
              <details>
                <summary>Posting text</summary>
                <p className="posting-text">{job.postingText}</p>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
function Tickets({
  tickets,
  onChanged,
}: {
  tickets: Ticket[];
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function defer(ticket: Ticket) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/tickets/${ticket.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          outcome: 'deferred',
          value: 'Deferred from dashboard',
        }),
      });
      await onChanged();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!tickets.length) return null;
  return (
    <section className="tickets">
      <h2>Needs your attention</h2>
      {tickets.map((ticket) => (
        <article key={ticket.id}>
          <h3>
            {ticket.employer} · {ticket.role}
          </h3>
          <p>{ticket.question}</p>
          <p className="muted">
            {ticket.choices.join(' · ')} · {ticket.cause.replaceAll('_', ' ')}
          </p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void defer(ticket)}
          >
            Defer position
          </button>
        </article>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
function Dashboard() {
  const [jobs, setJobs] = useState<Job[]>([]),
    [tickets, setTickets] = useState<Ticket[]>([]),
    [error, setError] = useState('');
  async function refresh() {
    const [jobs, tickets] = await Promise.all([
      api<{ jobs: Job[] }>('/api/jobs'),
      api<{ tickets: Ticket[] }>('/api/tickets'),
    ]);
    setJobs(jobs.jobs);
    setTickets(tickets.tickets);
  }
  useEffect(() => {
    void refresh().catch((error) => setError(error.message));
  }, []);
  return (
    <main>
      <h1>Your job ledger</h1>
      <p className="intro">Capture a posting. Keep both routes to the role.</p>
      {error && <p role="alert">{error}</p>}
      <Tickets tickets={tickets} onChanged={refresh} />
      <div className="overview">
        <SavedJobs jobs={jobs} />
        <Pairings />
      </div>
      <PostingForm onSaved={refresh} />
      <AnswersPanel />
      <ReportPanel />
      <button
        className="text-button refresh"
        onClick={() => void refresh().catch((error) => setError(error.message))}
      >
        Refresh ledger
      </button>
    </main>
  );
}
function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    void api('/api/me')
      .then(() => setSignedIn(true))
      .catch(() => setSignedIn(false));
  }, []);
  async function logout() {
    try {
      await api('/api/logout', { method: 'POST', body: '{}' });
      setSignedIn(false);
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <>
      <header>
        <span className="wordmark">Jobapply</span>
        {signedIn && (
          <button className="text-button" onClick={() => void logout()}>
            Sign out
          </button>
        )}
      </header>
      {error && <p role="alert">{error}</p>}
      {signedIn === null ? (
        <main>
          <p role="status">Loading ledger…</p>
        </main>
      ) : signedIn ? (
        <Dashboard />
      ) : (
        <Login onLogin={() => setSignedIn(true)} />
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
