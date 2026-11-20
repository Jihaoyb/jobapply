-- Lane A (issues 002, 003, 004): employer identity, dedupe keys, import history, cap and queue.
ALTER TABLE employers ADD COLUMN merged_into uuid;
ALTER TABLE employers ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE employers ADD CONSTRAINT employers_merged_into_fk
  FOREIGN KEY (merged_into, applicant_id) REFERENCES employers(id, applicant_id);
ALTER TABLE employers ADD CONSTRAINT employers_not_self_merged CHECK (merged_into IS NULL OR merged_into <> id);
CREATE INDEX employers_owner_active ON employers(applicant_id) WHERE merged_into IS NULL;

-- Editable alias table: domain key (`acme.example`) or ATS key (`greenhouse:acme`) -> canonical employer.
CREATE TABLE employer_aliases (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL REFERENCES applicants(id),
  alias_key text NOT NULL, kind text NOT NULL CHECK (kind IN ('domain','ats')),
  employer_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('capture','careers_link','manual','import','ticket')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (applicant_id, alias_key),
  FOREIGN KEY (employer_id, applicant_id) REFERENCES employers(id, applicant_id)
);
-- Careers redirect/embed evidence: both URLs are recorded, whether linked or in conflict.
CREATE TABLE employer_links (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL REFERENCES applicants(id),
  employer_id uuid, job_id uuid, domain_key text NOT NULL, ats_key text NOT NULL,
  relation text NOT NULL CHECK (relation IN ('redirect','embed')),
  careers_url text NOT NULL, ats_url text NOT NULL,
  status text NOT NULL CHECK (status IN ('linked','conflict','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (employer_id, applicant_id) REFERENCES employers(id, applicant_id),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id)
);
CREATE TABLE employer_merges (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL REFERENCES applicants(id),
  source_employer_id uuid NOT NULL, target_employer_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_employer_id, applicant_id) REFERENCES employers(id, applicant_id),
  FOREIGN KEY (target_employer_id, applicant_id) REFERENCES employers(id, applicant_id)
);
-- "Not the same employer" decisions that silence a display-name merge suggestion.
CREATE TABLE employer_distinct (
  applicant_id uuid NOT NULL REFERENCES applicants(id),
  employer_a uuid NOT NULL, employer_b uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (applicant_id, employer_a, employer_b), CHECK (employer_a < employer_b),
  FOREIGN KEY (employer_a, applicant_id) REFERENCES employers(id, applicant_id),
  FOREIGN KEY (employer_b, applicant_id) REFERENCES employers(id, applicant_id)
);

-- Dedupe keys per job. Primary records have duplicate_of NULL.
CREATE TABLE job_identity (
  job_id uuid PRIMARY KEY, applicant_id uuid NOT NULL,
  canonical_employer_id uuid, identity_key text, requisition_id text,
  title_key text NOT NULL, location_key text NOT NULL, url_key text,
  duplicate_of uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (duplicate_of IS NULL OR duplicate_of <> job_id),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id),
  FOREIGN KEY (duplicate_of, applicant_id) REFERENCES jobs(id, applicant_id),
  FOREIGN KEY (canonical_employer_id, applicant_id) REFERENCES employers(id, applicant_id)
);
CREATE UNIQUE INDEX job_identity_unique_requisition ON job_identity(applicant_id, canonical_employer_id, requisition_id)
  WHERE requisition_id IS NOT NULL AND canonical_employer_id IS NOT NULL AND duplicate_of IS NULL;
CREATE INDEX job_identity_employer ON job_identity(applicant_id, canonical_employer_id);

-- Context for employer_identity and import_ambiguity tickets handled by this lane.
CREATE TABLE identity_tickets (
  ticket_id uuid PRIMARY KEY, applicant_id uuid NOT NULL, job_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('conflict','plausible','unresolved','import')),
  candidate_employer_ids jsonb NOT NULL, unmapped_keys jsonb NOT NULL,
  employer_name text NOT NULL, group_key text,
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id)
);

CREATE TABLE cap_settings (
  applicant_id uuid PRIMARY KEY REFERENCES applicants(id),
  cap_limit integer NOT NULL DEFAULT 3 CHECK (cap_limit BETWEEN 1 AND 50),
  window_months integer NOT NULL DEFAULT 3 CHECK (window_months BETWEEN 1 AND 24),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One submission record per job; confirmed rows count toward the cap on local_date (Los Angeles).
-- submitting/uncertain rows hold their employer until reconciled.
CREATE TABLE submissions (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL, job_id uuid NOT NULL,
  canonical_employer_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('live','imported')),
  state text NOT NULL CHECK (state IN ('submitting','uncertain','confirmed','not_submitted')),
  local_date date NOT NULL, receipt_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id),
  FOREIGN KEY (canonical_employer_id, applicant_id) REFERENCES employers(id, applicant_id)
);
CREATE INDEX submissions_employer ON submissions(applicant_id, canonical_employer_id, state, local_date);

CREATE TABLE import_batches (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL REFERENCES applicants(id),
  filename text NOT NULL, summary jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id)
);
CREATE TABLE import_rows (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL, batch_id uuid NOT NULL,
  line integer NOT NULL, row_hash text NOT NULL,
  employer_name text NOT NULL, title text NOT NULL, local_date date NOT NULL, source_url text NOT NULL,
  status text NOT NULL CHECK (status IN ('counted','linked','pending_employer')),
  job_id uuid, ticket_id uuid, submission_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (applicant_id, row_hash),
  FOREIGN KEY (batch_id, applicant_id) REFERENCES import_batches(id, applicant_id),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id)
);

-- Single active tab: at most one active item per applicant.
CREATE TABLE work_queue (
  job_id uuid PRIMARY KEY, applicant_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','active','paused','done','stopped')),
  hold_reason text, stop_reason text,
  enqueued_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id)
);
CREATE UNIQUE INDEX work_queue_one_active ON work_queue(applicant_id) WHERE state = 'active';
CREATE INDEX work_queue_owner_state ON work_queue(applicant_id, state, enqueued_at);
