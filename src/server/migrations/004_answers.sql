-- Issue 006: answer bank, approved aliases and resumable field resolution sessions.
CREATE TABLE answers (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL REFERENCES applicants(id),
  scope text NOT NULL CHECK (scope IN ('job','employer','global')),
  job_id uuid, canonical_employer_id uuid,
  question text NOT NULL, normalized_question text NOT NULL,
  choices jsonb NOT NULL DEFAULT '[]', answer text NOT NULL,
  source text NOT NULL CHECK (source IN ('seed','ticket','dashboard')),
  needs_review boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id),
  CHECK ((scope = 'job' AND job_id IS NOT NULL AND canonical_employer_id IS NULL)
    OR (scope = 'employer' AND canonical_employer_id IS NOT NULL AND job_id IS NULL)
    OR (scope = 'global' AND job_id IS NULL AND canonical_employer_id IS NULL)),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id),
  FOREIGN KEY (canonical_employer_id, applicant_id) REFERENCES employers(id, applicant_id)
);
CREATE UNIQUE INDEX answers_job_question ON answers(applicant_id, job_id, normalized_question) WHERE scope = 'job';
CREATE UNIQUE INDEX answers_employer_question ON answers(applicant_id, canonical_employer_id, normalized_question) WHERE scope = 'employer';
CREATE UNIQUE INDEX answers_global_question ON answers(applicant_id, normalized_question) WHERE scope = 'global';

CREATE TABLE answer_aliases (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL REFERENCES applicants(id),
  answer_id uuid NOT NULL, canonical_employer_id uuid,
  question text NOT NULL, normalized_question text NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed','approved','rejected')),
  score real, created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
  FOREIGN KEY (answer_id, applicant_id) REFERENCES answers(id, applicant_id) ON DELETE CASCADE,
  FOREIGN KEY (canonical_employer_id, applicant_id) REFERENCES employers(id, applicant_id)
);
CREATE UNIQUE INDEX answer_aliases_unique ON answer_aliases(applicant_id, answer_id, normalized_question,
  COALESCE(canonical_employer_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX answer_aliases_lookup ON answer_aliases(applicant_id, normalized_question) WHERE status = 'approved';

CREATE TABLE answer_sessions (
  id uuid PRIMARY KEY, applicant_id uuid NOT NULL, job_id uuid NOT NULL,
  fields jsonb NOT NULL, resume_index integer NOT NULL DEFAULT 0 CHECK (resume_index >= 0),
  resolved jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('running','paused','completed','deferred')),
  paused_field_id text, ticket_id uuid REFERENCES tickets(id), pause_detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'paused') = (ticket_id IS NOT NULL AND paused_field_id IS NOT NULL)),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id)
);
CREATE UNIQUE INDEX answer_sessions_open_ticket ON answer_sessions(ticket_id) WHERE ticket_id IS NOT NULL;
