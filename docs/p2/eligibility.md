# P2 Lane B: eligibility (issue 005)

## What was built

- **Single entry point.** `decideEligibility(db, applicantId, jobId, text, source: 'posting' | 'form', deps?)` in `src/server/eligibility/decide.ts`. The worker calls it for posting text. 007 calls it again for any restriction text revealed on the form. Lane A decides whether to call it at all, and this module does not import lane A code. Defensively, it refuses (409) jobs that are not `captured`, `eligibility_pending` or `ready`, and it returns 404 when the job belongs to another owner. Both checks happen before any model call.
- **Route 1: narrow exclusion rules** (`rules.ts`, `EXCLUSION_RULES`). These cover citizen or green-card-only requirements, ITAR / U.S. person, a required clearance (including "must be able to obtain"), an explicit sponsorship bar, and an explicit OPT/CPT bar. A rule excludes only when the whole sentence carries no guard:
  - negation earlier in the same clause ("No security clearance is required", "does not require a clearance")
  - preference wording ("preferred", "a plus", …)
  - hedging ("may", "some", "at this time", "if", …)
  - a conflicting clause anywhere in the text ("do not sponsor TN, H-1B sponsorship is available", "do not sponsor visas. OPT candidates are welcome")

  "Without sponsorship" and "must not require sponsorship" exclude only when the sentence mentions the future, because the applicant is authorized now. The evidence is the full source sentence, stored with its offsets.

- **Route 2: Sol.** A separate broad vocabulary (`TRIGGERS`) covers visa, sponsor\*, authoriz/authoris\*, eligible-to-work / right to work, work permit, H-1B variants, OPT/CPT/EAD (case-sensitive), F-1, immigra\*, ITAR / export control, U.S. person, clearance, citizen\*, residen(t|cy) and green card. Any trigger without a conclusive rule sends the triggered sentences, each with one sentence of context on either side, through `configuredModelCaller` (purpose `eligibility`, so the configured `OPENAI_SOL_MODEL`, Responses API, `reasoning.effort: low`, `store: false`). The prompt is `PROMPT_VERSION = eligibility-sol-v1` in `sol.ts`, and it encodes the applicant profile: F-1 OPT, authorized now, needs future H-1B sponsorship. Sol returns `excluded | passed | unclear` with a quote.
  - `excluded` is accepted only when `verifyQuote` finds the quote literally in the source. Only whitespace runs may differ, and what gets stored is the original source substring. The quote must also contain a trigger term.
  - If verification fails, Sol says `unclear`, the gate is closed, or Sol is unavailable, the job gets a ticket instead of an exclusion.
- **Route 3: pass.** When no trigger is present, the job passes with no model call, and the provenance is `rule`.
- **Ledger and provenance.** Every decision appends a row to `eligibility_decisions` (migration `003_eligibility.sql`) and emits `eligibility.decided {decision, provenance rule|sol|user, evidence}`. The decision row, any job status change and the event are written in one transaction.
  - The row stores the route, rule ID, reason, evidence and offsets, the Sol rationale, `prompt_version`, and `model_call_id`. That ID links to the wrapper's `model_calls` row, which holds the served model and the input/output tokens.
  - Status changes: a posting pass moves `captured` to `ready`. Excluded moves the job to `eligibility_excluded`. A form pass leaves the in-progress status unchanged.
- **Tickets.** Tickets go through `openTicket`, with choices `passed` / `excluded`:
  - `eligibility_ambiguity` + `decide_eligibility` covers unclear wording, an unverified quote, and a closed replay gate.
  - `provider_limit` + `retry_provider` covers OpenAI not being configured or a failed or invalid call. A missing key never crashes the server; it only pauses the job.

  The domain handlers `resolveEligibilityTicket` and `retryEligibilityTicket` close the ticket and pause in the same transaction. The resolution emits `pause.closed` with outcome `approved` (or `no_change` for a retry) plus `eligibility.decided` with provenance `user`. A second resolution returns 409.

- **Routes** (`routes.ts`, registered by one line in `app.ts`, with a session required and Origin checked on mutations):
  - `GET /api/eligibility` returns the latest decision per job, plus the replay-gate status.
  - `POST /api/eligibility/tickets/:id/decide` takes `{decision: 'passed'|'excluded', note?}`.
  - `POST /api/eligibility/tickets/:id/retry`.

  No route starts screening for an arbitrary job.

- **Dashboard.** `src/web/eligibility/EligibilityPanel.tsx`, mounted by one line in `main.tsx`, shows each job's decision, provenance (Rule / Sol / You), source, reason, model, prompt version, tokens and the exact quote. It has Pass / Exclude buttons, and Retry Sol on outage tickets.

## Replay, metrics and the gate

- **Labeled set.** `tests/fixtures/eligibility/postings.json` holds 68 synthetic postings with fake employers.
  - By route: 23 rule, 35 Sol and 10 pass.
  - By expected decision: 26 passed, 30 excluded and 12 review.
  - They cover negation, preference, hedging, conflict, clearance, citizenship, ITAR, "currently authorized" phrasing, OPT-specific wording, benign trigger words, and form-source text.
  - Three are `fakeOnly`: Sol failure modes (a hallucinated quote, a quote without a trigger, invalid output) that the live replay skips.
- **Harness.** `runReplay` in `src/server/eligibility/replay.ts` and `npm run eligibility:replay` both run every fixture through `decideEligibility` in an in-memory PGlite database with real migrations. They report:
  - **false inclusions** (expected excluded or review, got passed), **false exclusions** (expected passed or review, got excluded), unexpected reviews, quote mismatches and route mismatches, each counted separately;
  - Sol call share, failed calls, and measured input/output tokens;
  - with rates supplied, the measured cost and an **all-Sol budget**: mean measured tokens per Sol call × rates, per posting and for `--projected-postings N`.
- **Fake transport.** `fakeSolTransport` answers with each fixture's label (or its scripted `fakeSol`) and reports deterministic token counts (characters ÷ 4). The fake replay therefore validates rules, routing, quote verification, ticketing and accounting. It does **not** measure Sol's accuracy. Only the live replay does that.
- **Gate.** `src/server/eligibility/baseline.ts` is generated by `--write-baseline`. It records `promptVersion`, a `promptFingerprint` (hash of the version and instructions), a `rulesFingerprint` (hash of every pattern and guard), the fixture hash, the Sol model and the metrics, in a `fake` and a `live` section.
  - `tests/eligibility-replay.test.ts` fails when the prompt, rules or fixtures change without a re-recorded baseline, when the fake replay metrics differ, or when a live baseline exists for a different prompt or rules.
  - At runtime, `replayGate()` blocks Sol calls when the configured `OPENAI_SOL_MODEL` has no baseline: the live model if a live baseline exists, otherwise the fake baseline's model. Blocked jobs go to review tickets instead. The dashboard shows when the gate is closed.

### Human-run commands

```sh
# Deterministic (no network); the test suite already runs this:
npm run eligibility:replay -- --fake
# After any prompt/rule/fixture change, re-record and commit the baseline:
npm run eligibility:replay -- --fake --write-baseline
# Live Sol replay (needs OPENAI_API_KEY and optionally OPENAI_SOL_MODEL in .env).
# Use the real configured Sol rates:
npm run eligibility:replay -- --input-usd-per-mtok <IN> --output-usd-per-mtok <OUT> --projected-postings 300 --write-baseline
```

The live run records the `live` baseline. After it exists, the server only calls Sol for the model that was replayed live. Review the false-inclusion and false-exclusion lists it prints before committing.

## Acceptance criteria

| AC                                                                                                       | Status / test                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replay all three routes, including negation and preference; verify exact spans or open a ticket          | `eligibility-replay.test.ts` (labeled set, zero mismatches on fake Sol); `eligibility.test.ts` (rule guards, quote verification, `quote_unverified` → `eligibility_ambiguity` ticket)                                                                                      |
| Persist provenance, model ID, prompt version, token usage; Responses API low reasoning                   | `eligibility.test.ts` "Sol route …": asserts `reasoning.effort=low`, `store=false`, configured Sol model, `model_calls` row (served model, prompt version, tokens) linked from the decision row, `eligibility.decided` provenance; rule and user provenance in other tests |
| False inclusions and exclusions measured separately; all-Sol budget; gate prompt/model changes on replay | `runReplay` metrics and cost; baseline/fingerprint gate test; runtime `replayGate` test. **Live accuracy and real cost are deferred to the human-run live replay**                                                                                                         |
| Verified in 007: form-revealed restriction reroutes through the same three routes before submit          | **Deferred.** `source: 'form'` path built and unit-tested (Sol pass keeps fill status, rule exclusion moves the job to `eligibility_excluded`). 007 must call `decideEligibility(…, 'form')` before the final click and stop on `excluded` / `review`                      |

## Notes and decisions to review

- No contract change. The design uses the existing event, status, cause and resolve-action names. User resolution of an ambiguity ticket emits `pause.closed` with outcome `approved` and puts the decision in the ticket resolution value. A retry closes with `no_change`.
- A replay-gate block is recorded as `review` with provenance `rule`, because no model was called. A Sol outage is recorded as `review` with provenance `sol` and evidence `null`.
- The applicant profile is fixed in the prompt and rules for this single-applicant pilot.
- Rates are not hard-coded. Supply them per run, because none are known for `gpt-6.1-sol`.
- 007 should wire `eligibility_pending` and its ordering against lane A's cap and hold checks.

## Fixture labels: ALL NEED HUMAN REVIEW

Claude wrote every label below from the PRD's rules and the applicant profile (F-1 OPT, authorized now, needs future sponsorship). None has been checked by a human. Pay particular attention to these judgment calls:

- "unable to sponsor … at this time" → review
- "No sponsorship required." → review
- "work without sponsorship" (no future mentioned) → review
- "support transfers of existing H-1B only" → review
- "authorized … on a permanent basis" → excluded
- "eligible to work for any employer … indefinitely" → excluded
- "cannot provide visa assistance" → excluded
- "must be able to obtain a clearance" → excluded by rule

The quote column is the phrase that the stored evidence must contain.

| Fixture                                 | Source  | Expected route | Expected decision | Expected quote                                                                               | Note      |
| --------------------------------------- | ------- | -------------- | ----------------- | -------------------------------------------------------------------------------------------- | --------- |
| `rule-citizen-must-be`                  | posting | exclusion_rule | excluded          | “Must be a U.S. citizen.”                                                                    |           |
| `rule-citizenship-required`             | posting | exclusion_rule | excluded          | “U.S. citizenship is required”                                                               |           |
| `rule-citizens-pr-only`                 | posting | exclusion_rule | excluded          | “open only to US citizens”                                                                   |           |
| `rule-citizen-or-lpr`                   | posting | exclusion_rule | excluded          | “Applicants must be U.S. citizens or lawful permanent residents”                             |           |
| `rule-only-citizens-gc`                 | posting | exclusion_rule | excluded          | “Only U.S. citizens or green card holders will be considered”                                |           |
| `rule-green-card-hold`                  | posting | exclusion_rule | excluded          | “Must hold a green card”                                                                     |           |
| `rule-itar-us-person`                   | posting | exclusion_rule | excluded          | “candidates must be U.S. persons”                                                            |           |
| `rule-itar-eligibility`                 | posting | exclusion_rule | excluded          | “This position requires ITAR eligibility.”                                                   |           |
| `rule-clearance-active-secret`          | posting | exclusion_rule | excluded          | “Active Secret clearance required.”                                                          |           |
| `rule-clearance-ts-sci`                 | posting | exclusion_rule | excluded          | “must hold an active TS/SCI clearance”                                                       |           |
| `rule-clearance-obtain`                 | posting | exclusion_rule | excluded          | “Must be able to obtain and maintain a U.S. government security clearance.”                  |           |
| `rule-clearance-top-secret`             | posting | exclusion_rule | excluded          | “Top Secret clearance is required to start.”                                                 |           |
| `rule-sponsor-will-not`                 | posting | exclusion_rule | excluded          | “We will not sponsor employment visas now or in the future.”                                 |           |
| `rule-sponsor-unable`                   | posting | exclusion_rule | excluded          | “unable to sponsor H-1B visas”                                                               |           |
| `rule-sponsor-not-eligible`             | posting | exclusion_rule | excluded          | “This position is not eligible for visa sponsorship.”                                        |           |
| `rule-sponsor-without-future`           | posting | exclusion_rule | excluded          | “without the need for sponsorship now or in the future”                                      |           |
| `rule-sponsor-requiring-not-considered` | posting | exclusion_rule | excluded          | “Candidates who require visa sponsorship now or in the future will not be considered.”       |           |
| `rule-sponsor-must-not-require`         | posting | exclusion_rule | excluded          | “Applicants must not require sponsorship now or in the future.”                              |           |
| `rule-sponsor-none-available`           | posting | exclusion_rule | excluded          | “No sponsorship is available for this position.”                                             |           |
| `rule-opt-not-accepted`                 | posting | exclusion_rule | excluded          | “We do not accept OPT or CPT candidates”                                                     |           |
| `rule-opt-not-considered`               | posting | exclusion_rule | excluded          | “OPT/CPT candidates will not be considered.”                                                 |           |
| `rule-form-citizenship`                 | form    | exclusion_rule | excluded          | “This position requires U.S. citizenship.”                                                   |           |
| `rule-form-cannot-sponsor`              | form    | exclusion_rule | excluded          | “We cannot sponsor work visas, now or in the future.”                                        |           |
| `sol-visa-assistance`                   | posting | sol            | excluded          | “We cannot provide visa assistance for this role.”                                           |           |
| `sol-permanent-basis`                   | posting | sol            | excluded          | “Must be authorized to work in the U.S. on a permanent basis.”                               |           |
| `sol-contingent-citizenship`            | posting | sol            | excluded          | “Employment is contingent on U.S. citizenship due to federal contract requirements.”         |           |
| `sol-limited-residency`                 | posting | sol            | excluded          | “Position limited to individuals holding U.S. permanent residency or citizenship.”           |           |
| `sol-eligible-indefinitely`             | posting | sol            | excluded          | “Applicants must be eligible to work for any employer in the US indefinitely.”               |           |
| `sol-export-control`                    | posting | sol            | excluded          | “Applicants must meet export control requirements and hold U.S. person status.”              |           |
| `sol-whitespace-quote`                  | posting | sol            | excluded          | “unable to file new H-1B petitions, including cap-subject cases.”                            |           |
| `sol-sponsorship-available`             | posting | sol            | passed            | “Visa sponsorship is available for qualified candidates.”                                    |           |
| `sol-sponsor-h1b-opt`                   | posting | sol            | passed            | “We sponsor H-1B visas and support employees on OPT and STEM OPT.”                           |           |
| `sol-legally-authorized`                | posting | sol            | passed            | —                                                                                            |           |
| `sol-currently-authorized`              | posting | sol            | passed            | —                                                                                            |           |
| `sol-negation-no-clearance`             | posting | sol            | passed            | —                                                                                            |           |
| `sol-negation-citizenship-not-required` | posting | sol            | passed            | —                                                                                            |           |
| `sol-preference-clearance`              | posting | sol            | passed            | —                                                                                            |           |
| `sol-preference-citizenship`            | posting | sol            | passed            | —                                                                                            |           |
| `sol-negation-does-not-require`         | posting | sol            | passed            | —                                                                                            |           |
| `sol-opt-encouraged`                    | posting | sol            | passed            | —                                                                                            |           |
| `sol-authorized-reseller`               | posting | sol            | passed            | —                                                                                            |           |
| `sol-immigration-practice`              | posting | sol            | passed            | —                                                                                            |           |
| `sol-residents-remote`                  | posting | sol            | passed            | —                                                                                            |           |
| `sol-conflict-tn-h1b`                   | posting | sol            | passed            | “H-1B sponsorship is available for this role.”                                               |           |
| `sol-form-future-sponsorship-question`  | form    | sol            | passed            | —                                                                                            |           |
| `sol-form-authorized-question`          | form    | sol            | passed            | —                                                                                            |           |
| `sol-no-sponsorship-required`           | posting | sol            | review            | “No sponsorship required.”                                                                   |           |
| `sol-unable-at-this-time`               | posting | sol            | review            | “We are unable to sponsor visas at this time.”                                               |           |
| `sol-may-require-clearance`             | posting | sol            | review            | “Some positions may require a security clearance.”                                           |           |
| `sol-transfer-only`                     | posting | sol            | review            | “We support transfers of existing H-1B visas only.”                                          |           |
| `sol-without-sponsorship`               | posting | sol            | review            | “Candidates must be able to work without sponsorship.”                                       |           |
| `sol-must-not-require-employer`         | posting | sol            | review            | “Must not require employer sponsorship to work in the US.”                                   |           |
| `sol-conflict-opt-welcome`              | posting | sol            | review            | “We do not sponsor visas.”                                                                   |           |
| `sol-depending-on-client`               | posting | sol            | review            | “U.S. citizenship or the ability to obtain a clearance may be required depending on client.” |           |
| `sol-form-revealed-hedge`               | form    | sol            | review            | “for some client assignments we may not be able to support future visa sponsorship.”         |           |
| `sol-hallucinated-quote`                | posting | sol            | review            | —                                                                                            | fake only |
| `sol-quote-without-trigger`             | posting | sol            | review            | —                                                                                            | fake only |
| `sol-invalid-output`                    | posting | sol            | review            | —                                                                                            | fake only |
| `pass-plain-backend`                    | posting | no_trigger     | passed            | —                                                                                            |           |
| `pass-opt-in-lowercase`                 | posting | no_trigger     | passed            | —                                                                                            |           |
| `pass-options-trading`                  | posting | no_trigger     | passed            | —                                                                                            |           |
| `pass-clear-communication`              | posting | no_trigger     | passed            | —                                                                                            |           |
| `pass-community-events`                 | posting | no_trigger     | passed            | —                                                                                            |           |
| `pass-security-engineering`             | posting | no_trigger     | passed            | —                                                                                            |           |
| `pass-us-remote`                        | posting | no_trigger     | passed            | —                                                                                            |           |
| `pass-form-benign`                      | form    | no_trigger     | passed            | —                                                                                            |           |
| `pass-form-salary`                      | form    | no_trigger     | passed            | —                                                                                            |           |
| `pass-equal-opportunity`                | posting | no_trigger     | passed            | —                                                                                            |           |
