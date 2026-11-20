-- P2 integration: the outreach worker logs when it defers to another lane's open ticket
-- (one open ticket per job) and when outreach for a position was deferred from the tickets list.
ALTER TABLE outreach_worker_log DROP CONSTRAINT outreach_worker_log_outcome_check;
ALTER TABLE outreach_worker_log ADD CONSTRAINT outreach_worker_log_outcome_check
  CHECK (outcome IN ('skipped_not_confirmed','skipped_already_shortlisted','skipped_deferred','deferred_open_ticket','paused_employer','paused_domain','paused_provider','no_candidates','shortlisted','review_opened'));

-- Events appended in one transaction (e.g. pause.opened + eligibility.decided, pause.closed +
-- outreach.reviewed) shared now() and were ordered by random id. clock_timestamp() keeps
-- append order, which readers use (ORDER BY occurred_at, id).
ALTER TABLE ledger_events ALTER COLUMN occurred_at SET DEFAULT clock_timestamp();
