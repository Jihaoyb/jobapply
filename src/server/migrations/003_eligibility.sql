-- Issue 005: one row per eligibility decision (append-only; latest row per job wins).
CREATE TABLE eligibility_decisions (
  id uuid PRIMARY KEY,
  applicant_id uuid NOT NULL REFERENCES applicants(id),
  job_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('posting','form')),
  route text NOT NULL CHECK (route IN ('exclusion_rule','sol','no_trigger','user')),
  decision text NOT NULL CHECK (decision IN ('passed','excluded','review')),
  provenance text NOT NULL CHECK (provenance IN ('rule','sol','user')),
  -- Verbatim evidence and its offsets in source_text; never a paraphrase.
  evidence text, evidence_start integer, evidence_end integer,
  rule_id text,
  reason text NOT NULL,
  rationale text,
  model_call_id uuid REFERENCES model_calls(id),
  prompt_version text,
  ticket_id uuid REFERENCES tickets(id),
  source_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((evidence IS NULL) = (evidence_start IS NULL) AND (evidence IS NULL) = (evidence_end IS NULL)),
  -- Automatic (rule/Sol) exclusions always carry a verified quote.
  CHECK (decision <> 'excluded' OR provenance = 'user' OR evidence IS NOT NULL),
  FOREIGN KEY (job_id, applicant_id) REFERENCES jobs(id, applicant_id)
);
CREATE INDEX eligibility_owner_job_time ON eligibility_decisions(applicant_id, job_id, created_at DESC);
CREATE INDEX eligibility_ticket ON eligibility_decisions(ticket_id) WHERE ticket_id IS NOT NULL;
