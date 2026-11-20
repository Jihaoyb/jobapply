import React, { useEffect, useState } from 'react';
import type {
  EligibilityGateView,
  EligibilityView,
} from '../../shared/eligibility.js';
import { api } from '../api.js';
import './eligibility.css';

const decisionLabel = {
  passed: 'Passed',
  excluded: 'Excluded',
  review: 'Needs review',
} as const;
const provenanceLabel = { rule: 'Rule', sol: 'Sol', user: 'You' } as const;

/** Issue 005: eligibility decision, provenance and exact quote per job. */
export function EligibilityPanel({
  onChanged,
}: {
  onChanged?: () => Promise<void>;
}) {
  const [decisions, setDecisions] = useState<EligibilityView[]>([]),
    [gate, setGate] = useState<EligibilityGateView | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function refresh() {
    const data = await api<{
      decisions: EligibilityView[];
      gate: EligibilityGateView;
    }>('/api/eligibility');
    setDecisions(data.decisions);
    setGate(data.gate);
  }
  useEffect(() => {
    void refresh().catch((error) => setError(error.message));
  }, []);
  async function act(item: EligibilityView, path: string, body: object) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/eligibility/tickets/${item.ticketId}/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      await refresh();
      await onChanged?.();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="eligibility">
      <h2>Eligibility</h2>
      {gate && !gate.ok && (
        <p className="notice">
          Sol is gated until the eligibility replay is re-run: {gate.reason}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {!decisions.length ? (
        <p className="muted">No eligibility decisions yet.</p>
      ) : (
        <ul className="eligibility-list">
          {decisions.map((item) => (
            <li key={item.decisionId}>
              <h3>
                {item.title} <span className="muted">· {item.employer}</span>
              </h3>
              <p>
                <span className={`eligibility-badge ${item.decision}`}>
                  {decisionLabel[item.decision]}
                </span>{' '}
                <span className="muted">
                  {provenanceLabel[item.provenance]} · {item.source} ·{' '}
                  {item.reason.replaceAll('_', ' ')}
                  {item.model &&
                    ` · ${item.model} (${item.promptVersion}, ${item.inputTokens ?? '?'} in / ${item.outputTokens ?? '?'} out)`}
                </span>
              </p>
              {item.evidence ? (
                <blockquote className="eligibility-quote">
                  {item.evidence}
                </blockquote>
              ) : (
                <p className="muted">No restriction quoted.</p>
              )}
              {item.ticketOpen && (
                <div className="eligibility-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(item, 'decide', { decision: 'passed' })
                    }
                  >
                    Eligible — continue
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void act(item, 'decide', { decision: 'excluded' })
                    }
                  >
                    Not eligible — exclude
                  </button>
                  {item.ticketCause === 'provider_limit' && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void act(item, 'retry', {})}
                    >
                      Retry Sol
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
