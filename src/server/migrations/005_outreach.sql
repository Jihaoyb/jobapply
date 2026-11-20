-- Lane D (issues 010-012): contact ranking, outreach review and delivery.
-- Every table is owner-scoped with composite foreign keys, like 001.

-- Every wake of the outreach worker leaves one row, including logged skips.
CREATE TABLE outreach_worker_log (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL, job_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('skipped_not_confirmed','skipped_already_shortlisted','paused_employer','paused_domain','paused_provider','no_candidates','shortlisted','review_opened')),
  detail text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id)
);
CREATE INDEX outreach_worker_log_job ON outreach_worker_log(applicant_id, job_id, created_at);

-- Marks tickets opened by this lane so only outreach handlers resolve them.
CREATE TABLE outreach_tickets (
  ticket_id uuid PRIMARY KEY REFERENCES tickets(id), applicant_id uuid NOT NULL, job_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('employer','domain','provider','review','uncertain_email')),
  proposed_domains jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id)
);

-- Idempotency key: one shortlist per job (owner-scoped).
CREATE TABLE outreach_shortlists (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL, job_id uuid NOT NULL,
  domain text NOT NULL, candidates_sent integer NOT NULL CHECK (candidates_sent BETWEEN 0 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (applicant_id, job_id), UNIQUE (id, applicant_id),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id)
);

CREATE TABLE outreach_candidates (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL, shortlist_id uuid NOT NULL,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 3),
  apollo_person_id text NOT NULL, name text NOT NULL, title text NOT NULL DEFAULT '',
  organization text NOT NULL DEFAULT '', linkedin_url text,
  score integer NOT NULL CHECK (score BETWEEN 1 AND 5), reason text NOT NULL, evidence text NOT NULL,
  prior_contact boolean NOT NULL DEFAULT false, prior_contact_detail text,
  -- Filled only for a recipient the applicant selected (people_match).
  business_email text, email_status text, enriched_at timestamptz,
  UNIQUE (shortlist_id, rank), UNIQUE (shortlist_id, apollo_person_id), UNIQUE (id, applicant_id),
  FOREIGN KEY (shortlist_id, applicant_id) REFERENCES outreach_shortlists(id, applicant_id)
);

CREATE TABLE outreach_reviews (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL, job_id uuid NOT NULL, shortlist_id uuid NOT NULL,
  ticket_id uuid NOT NULL REFERENCES tickets(id), candidate_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL CHECK (status IN ('drafting','ready','approved','skipped')),
  draft_error text,
  email_subject text, email_body text, linkedin_note text, drafts_candidate_id uuid,
  recipient_changed boolean NOT NULL DEFAULT false, drafts_edited boolean NOT NULL DEFAULT false,
  outcome text, approved_version integer, approved_at timestamptz, apollo_contact_id text,
  linkedin_recorded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'ready' OR (email_subject IS NOT NULL AND email_body IS NOT NULL AND linkedin_note IS NOT NULL AND drafts_candidate_id = candidate_id)),
  UNIQUE (applicant_id, job_id), UNIQUE (id, applicant_id),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id),
  FOREIGN KEY (shortlist_id, applicant_id) REFERENCES outreach_shortlists(id, applicant_id),
  FOREIGN KEY (candidate_id, applicant_id) REFERENCES outreach_candidates(id, applicant_id)
);

-- At most one approved email per position: the unique job key is the DB guard,
-- and conditional status transitions guard against a second SMTP attempt.
CREATE TABLE outreach_deliveries (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL, job_id uuid NOT NULL, review_id uuid NOT NULL,
  to_address text NOT NULL, subject text NOT NULL, body text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','sending','accepted','uncertain')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  smtp_message_id text, smtp_response text, reconciled boolean NOT NULL DEFAULT false,
  accepted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (applicant_id, job_id), UNIQUE (review_id),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id),
  FOREIGN KEY (review_id, applicant_id) REFERENCES outreach_reviews(id, applicant_id)
);
CREATE INDEX outreach_deliveries_accepted ON outreach_deliveries(applicant_id, accepted_at);
