CREATE TABLE applicants (
  id uuid PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, applicant_id uuid NOT NULL REFERENCES applicants(id),
  expires_at timestamptz NOT NULL
);
CREATE TABLE pairing_tokens (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL REFERENCES applicants(id),
  token_hash text NOT NULL UNIQUE, label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE TABLE employers (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL REFERENCES applicants(id),
  name text NOT NULL, domain text, UNIQUE (id, applicant_id)
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL REFERENCES applicants(id),
  client_capture_id uuid NOT NULL, canonical_employer_id uuid,
  title text NOT NULL, employer text NOT NULL, discovery_url text NOT NULL,
  application_url text NOT NULL, posting_text text NOT NULL,
  source text NOT NULL CHECK (source IN ('extension', 'manual')),
  status text NOT NULL CHECK (status IN ('captured','duplicate','capped','eligibility_pending','eligibility_excluded','ready','paused','submitting','uncertain','confirmed','deferred')),
  application_host text NOT NULL, supported_host boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id), UNIQUE (applicant_id, client_capture_id),
  FOREIGN KEY (canonical_employer_id, applicant_id) REFERENCES employers(id, applicant_id)
);
CREATE INDEX jobs_owner_created ON jobs(applicant_id, created_at DESC);
CREATE TABLE ledger_events (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL REFERENCES applicants(id),
  job_id uuid, name text NOT NULL CHECK (name IN ('job.selected','job.duplicate','job.capped','eligibility.decided','application.submitting','application.uncertain','application.confirmed','pause.opened','pause.closed','review.sampled','review.completed','outreach.shortlisted','outreach.reviewed','email.accepted','email.uncertain','linkedin.recorded','adapter.available','model.called')),
  occurred_at timestamptz NOT NULL DEFAULT now(), schema_version integer NOT NULL CHECK (schema_version = 1),
  payload jsonb NOT NULL, CHECK (job_id IS NOT NULL OR name = 'adapter.available'),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id)
);
CREATE INDEX events_owner_job_time ON ledger_events(applicant_id, job_id, occurred_at);
CREATE TABLE tickets (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL, job_id uuid NOT NULL,
  pause_id uuid NOT NULL UNIQUE, question text NOT NULL, choices jsonb NOT NULL,
  employer text NOT NULL, role text NOT NULL, cause text NOT NULL,
  resolve_action text NOT NULL, status text NOT NULL CHECK (status IN ('open','resolved')),
  opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz, resolution jsonb,
  resume_status text NOT NULL,
  CHECK ((status = 'open' AND closed_at IS NULL AND resolution IS NULL) OR (status = 'resolved' AND closed_at IS NOT NULL AND resolution IS NOT NULL)),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id)
);
CREATE UNIQUE INDEX one_open_ticket_per_job ON tickets(job_id) WHERE status = 'open';
CREATE TABLE model_calls (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL, job_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'openai'), model text NOT NULL, prompt_version text NOT NULL,
  input_tokens integer CHECK (input_tokens >= 0), output_tokens integer CHECK (output_tokens >= 0),
  status text NOT NULL CHECK (status IN ('completed','failed')), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id)
);
