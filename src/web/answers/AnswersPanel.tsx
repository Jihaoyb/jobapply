import React, { useEffect, useState } from 'react';
import type {
  AnswerAlias,
  PendingQuestion,
  SavedAnswer,
} from '../../shared/answers.js';
import { api } from '../api.js';
import './answers.css';

const scopeLabel = (answer: SavedAnswer) =>
  answer.scope === 'global'
    ? 'Global'
    : answer.scope === 'employer'
      ? `Employer · ${answer.employerName ?? 'unnamed'}`
      : 'This job only';
const reasonLabel: Record<string, string> = {
  no_saved_answer: 'No saved answer yet',
  no_match: 'No equivalent saved answer',
  qualifier_mismatch: 'A close answer differs in a material way',
  multiple_matches: 'Several saved answers disagree',
  choices_incompatible: 'Saved answer is not one of the choices',
  luna_not_configured: 'Equivalence check is not configured',
  luna_failed: 'Equivalence check failed',
};

function Question({
  question,
  busy,
  onResolve,
}: {
  question: PendingQuestion;
  busy: boolean;
  onResolve: (action: string, answer?: string) => Promise<void>;
}) {
  const [answer, setAnswer] = useState('');
  const ready = answer.trim().length > 0;
  return (
    <article className="answer-question">
      <h3>{question.question}</h3>
      <p className="muted">
        {question.employer} · {question.role} ·{' '}
        {reasonLabel[question.reason] ?? question.reason}
      </p>
      {question.suggestion && (
        <p className="notice">
          Closest saved answer: “{question.suggestion.answer}” for “
          {question.suggestion.question}”
          {question.suggestion.blockedBy.length > 0 &&
            ` — differs in ${question.suggestion.blockedBy.join(', ').replaceAll('_', ' ')}`}
        </p>
      )}
      {question.choices.length ? (
        <fieldset className="answer-choices">
          <legend>Choose an answer</legend>
          {question.choices.map((choice) => (
            <label key={choice}>
              <input
                type="radio"
                name={`answer-${question.ticketId}`}
                checked={answer === choice}
                onChange={() => setAnswer(choice)}
              />
              {choice}
            </label>
          ))}
        </fieldset>
      ) : (
        <textarea
          aria-label="Answer"
          rows={3}
          maxLength={4000}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
        />
      )}
      <div className="answer-actions">
        <button
          disabled={busy || !ready}
          onClick={() => void onResolve('answer_once', answer)}
        >
          Answer once
        </button>
        <button
          className="secondary"
          disabled={busy || !ready || !question.canonicalEmployerId}
          title={
            question.canonicalEmployerId
              ? undefined
              : 'Resolve the employer identity first'
          }
          onClick={() => void onResolve('answer_employer', answer)}
        >
          Save for {question.employer}
        </button>
        <button
          className="secondary"
          disabled={busy || !ready}
          onClick={() => void onResolve('answer_global', answer)}
        >
          Save globally
        </button>
        <button
          className="text-button"
          disabled={busy}
          onClick={() => void onResolve('defer')}
        >
          Defer position
        </button>
      </div>
    </article>
  );
}

function AnswerRow({
  answer,
  busy,
  onSave,
  onDelete,
}: {
  answer: SavedAnswer;
  busy: boolean;
  onSave: (body: { answer?: string; reviewed?: boolean }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [value, setValue] = useState(answer.answer);
  useEffect(() => setValue(answer.answer), [answer.answer]);
  return (
    <li>
      <p className="answer-meta">
        <span className="scope">{scopeLabel(answer)}</span>
        {answer.needsReview && <span className="review">Needs review</span>}
      </p>
      <p>{answer.question}</p>
      <div className="answer-edit">
        {answer.choices.length ? (
          <select
            aria-label="Answer"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          >
            {!answer.choices.includes(value) && <option>{value}</option>}
            {answer.choices.map((choice) => (
              <option key={choice}>{choice}</option>
            ))}
          </select>
        ) : (
          <input
            aria-label="Answer"
            value={value}
            maxLength={4000}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        <button
          className="secondary"
          disabled={busy || !value.trim() || value === answer.answer}
          onClick={() => void onSave({ answer: value })}
        >
          Save
        </button>
        {answer.needsReview && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void onSave({ reviewed: true })}
          >
            Mark reviewed
          </button>
        )}
        <button
          className="text-button"
          disabled={busy}
          onClick={() => void onDelete()}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

/** Answer bank: pending questions, saved answers by scope, and alias approval. */
export function AnswersPanel() {
  const [questions, setQuestions] = useState<PendingQuestion[]>([]),
    [answers, setAnswers] = useState<SavedAnswer[]>([]),
    [aliases, setAliases] = useState<AnswerAlias[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function refresh() {
    const [pending, bank] = await Promise.all([
      api<{ questions: PendingQuestion[] }>('/api/answers/questions'),
      api<{ answers: SavedAnswer[]; aliases: AnswerAlias[] }>('/api/answers'),
    ]);
    setQuestions(pending.questions);
    setAnswers(bank.answers);
    setAliases(bank.aliases);
  }
  useEffect(() => {
    void refresh().catch((error) => setError(error.message));
  }, []);
  async function run(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError('');
    try {
      await api(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const proposed = aliases.filter((alias) => alias.status === 'proposed');
  return (
    <section className="answers">
      <h2>Answer bank</h2>
      {error && <p role="alert">{error}</p>}
      {questions.length > 0 && (
        <div className="answer-pending">
          <h3>Questions waiting for you</h3>
          {questions.map((question) => (
            <Question
              key={question.ticketId}
              question={question}
              busy={busy}
              onResolve={(action, answer) =>
                run(
                  `/api/answers/questions/${question.ticketId}/resolve`,
                  'POST',
                  action === 'defer' ? { action } : { action, answer },
                )
              }
            />
          ))}
        </div>
      )}
      {proposed.length > 0 && (
        <div className="answer-aliases">
          <h3>Approve reused wording</h3>
          <ul>
            {proposed.map((alias) => (
              <li key={alias.id}>
                <p>
                  “{alias.question}” reused “{alias.answer}” from “
                  {alias.answerQuestion}”
                  {alias.score !== null && (
                    <span className="muted">
                      {' '}
                      · score {alias.score.toFixed(2)}
                    </span>
                  )}
                </p>
                <div className="answer-actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        `/api/answers/aliases/${alias.id}/decision`,
                        'POST',
                        { status: 'approved' },
                      )
                    }
                  >
                    Approve alias
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        `/api/answers/aliases/${alias.id}/decision`,
                        'POST',
                        { status: 'rejected' },
                      )
                    }
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <h3>Saved answers</h3>
      {!answers.length ? (
        <p className="muted">No saved answers yet.</p>
      ) : (
        <ul className="answer-list">
          {answers.map((answer) => (
            <AnswerRow
              key={answer.id}
              answer={answer}
              busy={busy}
              onSave={(body) => run(`/api/answers/${answer.id}`, 'PATCH', body)}
              onDelete={() => run(`/api/answers/${answer.id}`, 'DELETE')}
            />
          ))}
        </ul>
      )}
      <button
        className="text-button"
        disabled={busy}
        onClick={() => void run('/api/answers/seed', 'POST', {})}
      >
        Add work-authorization seed answers (review before use)
      </button>
    </section>
  );
}
