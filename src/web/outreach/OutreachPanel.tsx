import React, { useEffect, useState } from 'react';
import type { OutreachPosition, OutreachView } from '../../shared/outreach.js';
import { api } from '../api.js';
import './outreach.css';

interface SetupResult {
  apollo: {
    ok: boolean;
    checks: { name: string; detail: string; ok: boolean }[];
  };
  smtp: {
    ok: boolean;
    checks: { name: string; detail: string; ok: boolean }[];
    dailyEmailLimit: number;
    note: string;
  };
}

function Position({
  position,
  run,
  busy,
}: {
  position: OutreachPosition;
  run: (path: string, body?: unknown, method?: string) => Promise<void>;
  busy: boolean;
}) {
  const { review, ticket, shortlist, delivery } = position;
  const base = `/api/outreach/jobs/${position.jobId}`;
  const [domain, setDomain] = useState(ticket?.proposedDomains[0] ?? '');
  const [drafts, setDrafts] = useState({
    emailSubject: review?.emailSubject ?? '',
    emailBody: review?.emailBody ?? '',
    linkedinNote: review?.linkedinNote ?? '',
  });
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setDrafts({
      emailSubject: review?.emailSubject ?? '',
      emailBody: review?.emailBody ?? '',
      linkedinNote: review?.linkedinNote ?? '',
    });
  }, [
    review?.version,
    review?.emailSubject,
    review?.emailBody,
    review?.linkedinNote,
  ]);
  const selected = shortlist?.candidates.find(
    (c) => c.id === review?.candidateId,
  );
  const reviewOpen =
    review &&
    ['ready', 'drafting'].includes(review.status) &&
    ticket?.kind === 'review';
  const edited =
    review &&
    (drafts.emailSubject !== review.emailSubject ||
      drafts.emailBody !== review.emailBody ||
      drafts.linkedinNote !== review.linkedinNote);
  async function copyNote() {
    await navigator.clipboard.writeText(review?.linkedinNote ?? '');
    setCopied(true);
  }
  return (
    <article className="outreach-position">
      <h3>
        {position.employer} · {position.title}
      </h3>
      {position.worker && (
        <p className="muted">
          Worker: {position.worker.outcome.replaceAll('_', ' ')}
          {position.worker.detail ? ` (${position.worker.detail})` : ''}
        </p>
      )}
      {ticket && ticket.kind !== 'review' && (
        <p className="notice">{ticket.question}</p>
      )}
      {ticket?.kind === 'domain' && (
        <form
          className="outreach-inline"
          onSubmit={(event) => {
            event.preventDefault();
            void run(`${base}/domain`, { domain });
          }}
        >
          <input
            aria-label="Company domain"
            placeholder="company.com"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            required
          />
          <button disabled={busy}>Confirm domain</button>
        </form>
      )}
      {(ticket?.kind === 'provider' || ticket?.kind === 'employer') && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void run(`${base}/retry`, {})}
        >
          Retry
        </button>
      )}
      {ticket?.kind === 'uncertain_email' && (
        <div className="outreach-actions">
          <button
            disabled={busy}
            onClick={() => void run(`${base}/reconcile`, { sent: true })}
          >
            It was sent
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void run(`${base}/reconcile`, { sent: false })}
          >
            Not sent: retry once
          </button>
        </div>
      )}
      {shortlist && (
        <fieldset className="outreach-shortlist" disabled={!reviewOpen || busy}>
          <legend>
            Recommended recipients ({shortlist.candidatesSent} candidates ranked
            at {shortlist.domain})
          </legend>
          {!shortlist.candidates.length && (
            <p className="muted">No suitable contacts found.</p>
          )}
          {shortlist.candidates.map((candidate) => (
            <label key={candidate.id} className="outreach-candidate">
              <input
                type="radio"
                name={`recipient-${position.jobId}`}
                checked={review?.candidateId === candidate.id}
                onChange={() =>
                  void run(`${base}/recipient`, { candidateId: candidate.id })
                }
              />
              <span>
                <strong>
                  {candidate.name} · {candidate.title}
                </strong>{' '}
                <span className="outreach-score">{candidate.score}/5</span>
                {candidate.priorContact && (
                  <span className="outreach-flag">
                    Contacted before: {candidate.priorContactDetail}
                  </span>
                )}
                <br />
                {candidate.reason}
                <br />
                <span className="muted">Evidence: {candidate.evidence}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {review?.draftError && (
        <p role="alert">
          {review.draftError}{' '}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void run(`${base}/redraft`, {})}
          >
            Retry drafts
          </button>
        </p>
      )}
      {review?.status === 'drafting' && !review.draftError && (
        <p role="status">Preparing drafts…</p>
      )}
      {reviewOpen && review.status === 'ready' && (
        <div className="outreach-drafts">
          <p className="muted">
            To:{' '}
            {selected?.emailStatus === 'verified' && selected.businessEmail
              ? selected.businessEmail
              : 'no verified business email (LinkedIn only)'}
          </p>
          <label>
            Subject
            <input
              value={drafts.emailSubject}
              maxLength={200}
              onChange={(event) =>
                setDrafts({ ...drafts, emailSubject: event.target.value })
              }
            />
          </label>
          <label>
            Email
            <textarea
              rows={6}
              value={drafts.emailBody}
              maxLength={5000}
              onChange={(event) =>
                setDrafts({ ...drafts, emailBody: event.target.value })
              }
            />
          </label>
          <label>
            LinkedIn note ({drafts.linkedinNote.length}/300)
            <textarea
              rows={3}
              value={drafts.linkedinNote}
              maxLength={300}
              onChange={(event) =>
                setDrafts({ ...drafts, linkedinNote: event.target.value })
              }
            />
          </label>
          <div className="outreach-actions">
            {edited ? (
              <button
                disabled={busy}
                onClick={() =>
                  void run(
                    `${base}/drafts`,
                    { ...drafts, version: review.version },
                    'PUT',
                  )
                }
              >
                Save edits
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() =>
                  void run(`${base}/approve`, { version: review.version })
                }
              >
                Approve
                {selected?.emailStatus === 'verified' ? ' and send email' : ''}
              </button>
            )}
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void run(`${base}/skip`, {})}
            >
              Skip outreach
            </button>
          </div>
        </div>
      )}
      {review && ['approved', 'skipped', 'closed'].includes(review.status) && (
        <p className="muted">
          Review: {(review.outcome ?? review.status).replaceAll('_', ' ')}
        </p>
      )}
      {delivery && (
        <p className="muted">
          Email to {delivery.toAddress}: {delivery.status}
          {delivery.reconciled ? ' (reconciled)' : ''}
        </p>
      )}
      {review?.status === 'approved' && (
        <div className="outreach-linkedin">
          <label>
            LinkedIn note
            <textarea
              readOnly
              rows={3}
              value={review.linkedinNote ?? ''}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <div className="outreach-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => void copyNote()}
            >
              {copied ? 'Copied' : 'Copy note'}
            </button>
            {selected?.linkedinUrl && (
              <a href={selected.linkedinUrl} target="_blank" rel="noreferrer">
                Open profile ↗
              </a>
            )}
            {review.linkedinRecordedAt ? (
              <span className="muted">Invitation recorded</span>
            ) : (
              <button
                disabled={busy}
                onClick={() => void run(`${base}/linkedin`, {})}
              >
                Mark invitation sent
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

/** Outreach after confirmed submission: domain, shortlist, review, delivery and LinkedIn record. */
export function OutreachPanel() {
  const [view, setView] = useState<OutreachView>({ positions: [] }),
    [setup, setSetup] = useState<SetupResult | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function refresh() {
    setView(await api<OutreachView>('/api/outreach'));
  }
  useEffect(() => {
    void refresh().catch((error) => setError(error.message));
  }, []);
  async function run(path: string, body: unknown = {}, method = 'POST') {
    setBusy(true);
    setError('');
    try {
      await api(path, { method, body: JSON.stringify(body) });
      await refresh();
    } catch (error) {
      setError((error as Error).message);
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    setBusy(true);
    setError('');
    try {
      setSetup(
        await api<SetupResult>('/api/outreach/setup/verify', {
          method: 'POST',
          body: '{}',
        }),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="outreach">
      <h2>Outreach</h2>
      <p className="muted">
        Starts only after a confirmed submission. Nothing is sent until you
        approve.
      </p>
      <button
        className="text-button"
        disabled={busy}
        onClick={() => void verify()}
      >
        Verify Apollo and Gmail setup
      </button>
      {setup && (
        <ul className="outreach-setup">
          {[
            ...setup.apollo.checks.map((c) => ({
              ...c,
              name: `Apollo ${c.name}`,
            })),
            ...setup.smtp.checks.map((c) => ({
              ...c,
              name: `Gmail ${c.name}`,
            })),
          ].map((check) => (
            <li key={check.name}>
              {check.ok ? '✓' : '✗'} {check.name}: {check.detail}
            </li>
          ))}
          <li className="muted">
            Daily email cap {setup.smtp.dailyEmailLimit}. {setup.smtp.note}
          </li>
        </ul>
      )}
      {error && <p role="alert">{error}</p>}
      {!view.positions.length ? (
        <p className="muted">No confirmed applications in outreach yet.</p>
      ) : (
        view.positions.map((position) => (
          <Position
            key={`${position.jobId}-${position.review?.version ?? 0}`}
            position={position}
            run={run}
            busy={busy}
          />
        ))
      )}
    </section>
  );
}
