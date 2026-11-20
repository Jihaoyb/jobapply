# P2 Lane D: outreach (issues 010, 011, 012)

Lane D builds contact ranking, one-recipient review and delivery on fixtures. No test makes a live call. Apollo, Gmail SMTP and the Luna transport are injectable, and the in-memory fakes count every call.

## Layout

| Path                                                                       | Purpose                                                                                                   |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/server/migrations/005_outreach.sql`                                   | Owner-scoped tables: worker log, outreach ticket tags, shortlists, candidates, reviews, deliveries        |
| `src/server/outreach/worker.ts`                                            | 010: event wake, status gate, domain resolution, Apollo search, Luna ranking, idempotent shortlist, sweep |
| `src/server/outreach/review.ts`                                            | 011: enrich selected recipient, Luna drafts, recipient change, edit, approve, skip                        |
| `src/server/outreach/delivery.ts`                                          | 012: one email per position, timeout reconciliation, LinkedIn record                                      |
| `src/server/outreach/apollo.ts`                                            | `ApolloClient` interface and HTTP adapter, including setup verification                                   |
| `src/server/outreach/smtp.ts`                                              | `SmtpSender` interface and the Gmail SMTP client (implicit TLS on 465, `node:tls`, no new dependency)     |
| `src/server/outreach/deps.ts`                                              | Dependency wiring from server env, outreach ticket open/close handlers, provider pause                    |
| `src/server/outreach/routes.ts`                                            | Dashboard routes, domain confirm, retry                                                                   |
| `src/server/outreach/verify-cli.ts`                                        | Human-run live checks                                                                                     |
| `src/shared/outreach.ts`                                                   | View types for the dashboard                                                                              |
| `src/web/outreach/OutreachPanel.tsx`                                       | Dashboard panel                                                                                           |
| `tests/outreach-{rank,review,deliver}.test.ts`, `tests/fixtures/outreach/` | Tests, fakes and synthetic people                                                                         |

Shared-file edits: one import and one `registerOutreachRoutes(app, db, dashboardOwner, config)` line in `src/server/app.ts`, plus one import and one `<OutreachPanel />` in `src/web/main.tsx`. Contracts v1 is unchanged.

## Server environment (all optional at boot)

| Variable                              | Default                  | Use                                                                                                        |
| ------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `APOLLO_API_KEY`                      | none                     | Apollo master API key. If unset, outreach opens a `provider_limit` ticket.                                 |
| `GMAIL_SMTP_USER`                     | none                     | Gmail address that sends mail (also the From address).                                                     |
| `GMAIL_APP_PASSWORD`                  | none                     | 16-character Google app password. Requires 2-Step Verification.                                            |
| `GMAIL_SMTP_HOST` / `GMAIL_SMTP_PORT` | `smtp.gmail.com` / `465` | Implicit TLS, minimum TLS 1.2.                                                                             |
| `GMAIL_SMTP_TIMEOUT_MS`               | `30000`                  | Whole-session timeout. If the server has not replied after the message data, delivery is marked uncertain. |
| `OUTREACH_DAILY_EMAIL_LIMIT`          | `20`                     | Rolling 24-hour cap, well below Gmail's limit of about 500 recipients per day for personal accounts.       |
| `OPENAI_LUNA_MODEL`                   | `gpt-6-luna`             | Model for ranking and drafting, called through `src/server/model.ts`.                                      |

These variables should be added to `.env.example` at merge. Lane D did not edit that shared file.

## 010: rank contacts

- **The event only wakes the worker.** Wake paths are `handleOutreachEvent(deps, event)`, which 007 should call after commit; a production-only sweep every 60 s over jobs that have an `application.confirmed` event; and dashboard retry. Every path calls `runOutreachWorker`, which reads `jobs.status`. If the status is not `confirmed`, the worker logs a skip (an `outreach_worker_log` row `skipped_not_confirmed` with `status=…`, plus a log line) and makes no Apollo or model call.
- **Idempotency.** The key is the job: `UNIQUE (applicant_id, job_id)` on `outreach_shortlists`. Runs for one job are also serialized in-process, so a concurrent duplicate cannot repeat Apollo calls. A duplicate event that arrives after review opens sees `paused` and logs a skip.
- **Domain.** Resolution checks these sources in order:
  1. `employers.domain` (via `jobs.canonical_employer_id`).
  2. The employer website link from the posting: the application URL, the discovery URL, then URLs in the posting text, excluding job boards and ATS hosts.
  3. Apollo name search on `mixed_companies/search`, used only when the posting has no employer link.

  Proposals from sources 2 and 3 open a domain ticket with cause `employer_identity` and action `resolve_employer`. `POST /api/outreach/jobs/:id/domain` confirms the domain once by writing `employers.domain`, closes the pause and resumes. Later jobs at the same employer skip confirmation. An unknown domain opens the same ticket with no proposal. If the employer already has a different domain, the dispute is refused with 409. A null `canonical_employer_id` opens an `employer_identity` pause. Lane A resolves the employer, then **Retry** resumes.

- **Search and rank.** Apollo `mixed_people/api_search` uses `q_organization_domains_list=[domain]`, relevant titles (recruiter, talent acquisition, hiring and engineering managers, plus a role-based manager title) and `per_page=10`. The worker also enforces at most 10 itself. Luna (`contact_ranking`, prompt `contact-ranking-v1`) returns up to 3 people with a score from 1 to 5, a reason and evidence. Unknown IDs and duplicates are dropped. The worker stores `outreach.shortlisted {shortlistId}`.
- **Repeat-recipient flag.** A candidate is flagged when the same Apollo person was the approved recipient for another of the applicant's positions. The flag shows on the shortlist with that job's title and employer.
- **Limits.** These open a `provider_limit` ticket with action `retry_provider`: Apollo 429, 402, 401 or 403, a 422 credits response, transport failure, a missing key, a model failure or missing OpenAI setup. **Retry** closes the pause and resumes the step that paused. A retry never creates a second shortlist.
- **Setup verification.** `ApolloClient.verify()` checks the key (`/auth/health`), people search access (`mixed_people/api_search`), the people_match rate limit (`usage_stats/api_usage_stats`, master key) and email credits (`users/api_profile`). Each check reports pass or fail. The dashboard calls it from **Verify Apollo and Gmail setup** (`POST /api/outreach/setup/verify`).

## 011: review outreach

- After shortlisting, only the recommended recipient (rank 1) is enriched, with one `people/match` call. `reveal_personal_emails`, `reveal_phone_number`, `run_waterfall_email` and `run_waterfall_phone` are all `false`. A test asserts the request body. The enrichment is cached on the candidate, so re-selecting that recipient never pays again. Unselected candidates are never enriched.
- Luna (`outreach_draft`, prompt `outreach-draft-v1`) drafts the email subject, the email body and a LinkedIn note of at most 300 characters. Then one `review_outreach` ticket opens per position. The panel shows the shortlist (selectable), the To address and both drafts together.
- **Changing the recipient** bumps `version`, clears drafts, enriches the new recipient and redrafts. Approval requires the current `version`, so a stale approval or edit gets 409. Editing saves only and bumps the version. Skipping closes the ticket. Neither sends anything, and tests assert zero SMTP sends.
- **Approval** saves the contact to Apollo first. An existing contact is found via `contacts/search` and receives a `PUT` with `label_ids` = existing ∪ Job Search, and nothing else, so sales fields and lists are preserved. Otherwise a new contact is created with `label_names: ['Job Search']` and `run_dedupe: true`. If the Apollo save fails, the request returns 503 and nothing changes. Approval then closes the ticket and appends `outreach.reviewed {ticketId, outcome}`. The outcome is `changed_ranking` if the recipient differs from rank 1, otherwise `edited_draft` if the wording changed, otherwise `approved`. Skip appends `skipped`. A delivery row is created only when Apollo marks the business email `verified`. Otherwise outreach is LinkedIn-only.

## 012: deliver outreach

- **One email per position.** `outreach_deliveries` has `UNIQUE (applicant_id, job_id)`. Sending first claims the row with a conditional `pending → sending` update, so duplicate approvals, sweeps and retries cannot reach SMTP twice.
- **Outcomes.**

  | Outcome                                                                     | Delivery status   | Ledger event                  | Ticket                                |
  | --------------------------------------------------------------------------- | ----------------- | ----------------------------- | ------------------------------------- |
  | Accepted                                                                    | `accepted`        | `email.accepted {deliveryId}` | none                                  |
  | Timeout or no reply after data                                              | `uncertain`       | `email.uncertain`             | `uncertain_email` / `reconcile_email` |
  | Refused before acceptance (auth, recipient, quota, unconfigured, daily cap) | back to `pending` | none                          | `provider_limit`                      |

  On a timeout, the reconciliation ticket opens before any retry is possible. Nothing claims an `uncertain` row. **It was sent** marks the delivery accepted and reconciled. **Not sent: retry once** returns it to `pending` and sends again. A `sending` row left by a crashed process becomes `uncertain` with a ticket (`recoverInterruptedSends`). It is never resent automatically.

- **LinkedIn.** After approval, the panel shows the copyable note, the profile link and **Mark invitation sent**. That control appends `linkedin.recorded {contactId}` once. It is separate from `email.accepted`.
- **SMTP verification.** `SmtpSender.verify()` connects over TLS, sends EHLO and AUTH PLAIN, then QUIT. Gmail's documented limit is about 500 recipients per rolling 24 hours for personal accounts. This pilot caps at `OUTREACH_DAILY_EMAIL_LIMIT`, and quota replies (`4.7.0`, `5.4.5`) map to `SmtpLimitError`, which opens a `provider_limit` pause.

## AC to test map

| AC                                                                              | Test                                                                                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 010 verify Apollo setup; pause on limits                                        | `outreach-rank`: setup verification…, HTTP Apollo adapter…, Apollo limits and missing setup…                   |
| 010 domain via website or name enrichment, confirm once; unknown pauses         | `outreach-rank`: posting employer link…, without a posting link…, missing canonical employer…                  |
| 010 at most 10 to Luna, up to 3 with reasons, evidence and repeat flags         | `outreach-rank`: duplicate confirmation events…, a person contacted for an earlier position…                   |
| 010 uncertain job: zero Apollo calls and a logged skip                          | `outreach-rank`: a confirmation event for an uncertain job…                                                    |
| 010 duplicate event produces one shortlist                                      | `outreach-rank`: duplicate confirmation events… (concurrent and late duplicates)                               |
| 011 enrich only the selected recipient; personal email, phone and waterfall off | `outreach-review`: changing the recipient…; `outreach-rank`: HTTP Apollo adapter (flags)                       |
| 011 preserve Apollo fields and memberships                                      | `outreach-review`: changing the recipient… (fake); `outreach-rank`: HTTP Apollo adapter (PUT `label_ids` only) |
| 011 recipient change invalidates; edit or skip sends nothing                    | `outreach-review`: changing the recipient…, editing drafts…, skipping…                                         |
| 012 verify app password and limits; one email per position                      | `outreach-deliver`: Gmail SMTP client…, approval sends exactly one…, missing SMTP setup…                       |
| 012 timeout reconciliation before retry; distinct events                        | `outreach-deliver`: an SMTP timeout…, reconciling…, a crash mid-send…, manual LinkedIn completion…             |

## Human-run live checks (deferred; consume real credits and send real mail)

Run these with server env in `.env`, never in tests:

```sh
# 1. Apollo key, endpoint access, rate limit and credits (no credits used)
node --env-file-if-exists=.env --import tsx src/server/outreach/verify-cli.ts apollo
# 2. Pick one real person at a company you applied to (names and titles only, no credits)
node --env-file-if-exists=.env --import tsx src/server/outreach/verify-cli.ts search <company-domain>
# 3. Exactly one enrichment (uses one Apollo credit); expect email + email_status, no phone or personal email
node --env-file-if-exists=.env --import tsx src/server/outreach/verify-cli.ts enrich <apollo-person-id>
# 4. Gmail app-password login over TLS
node --env-file-if-exists=.env --import tsx src/server/outreach/verify-cli.ts smtp
# 5. One test email to yourself (GMAIL_SMTP_USER → GMAIL_SMTP_USER)
node --env-file-if-exists=.env --import tsx src/server/outreach/verify-cli.ts send-self
```

While doing these checks, also confirm the following in Apollo's UI, because endpoint shapes were written from the docs and not exercised live:

- `users/api_profile` reports credits.
- The **Job Search** label exists with modality `contacts`.
- Updating an existing contact's `label_ids` keeps its other labels and fields.

The same checks are available from the dashboard button, except `enrich` and `send-self`.

## Design decisions and items for human review

- **Contract gap: review ticket cause.** v1 has no pause cause for an outreach review, and the ticket primitive always pauses. `review_outreach` tickets therefore use cause `unanswered_question`. Lane E should exclude `resolve_action='review_outreach'` from the unanswered-questions pause count, or v2 should add a cause. The contract was not edited.
- **Pause outcomes.** For outreach tickets, `pause.closed` carries these outcomes:

  | Ticket                     | Outcome                     |
  | -------------------------- | --------------------------- |
  | Domain, proposal accepted  | `approved`                  |
  | Domain, typed instead      | `no_change`                 |
  | Provider or employer retry | `no_change`                 |
  | Email reconciliation       | `no_change`                 |
  | Review                     | Same as `outreach.reviewed` |

- **One outcome per review.** `outreach.reviewed` carries a single outcome, with precedence `changed_ranking` > `edited_draft` > `approved`. Edits made together with a recipient change therefore count only as a ranking change. Lane E should note this for the corrections denominators.
- **Job status during outreach.** While an outreach ticket is open, the job is `paused` with `resume_status='confirmed'`. Closing the ticket restores `confirmed`. Funnel reporting should count confirmations from `application.confirmed`, not from the current status.
- **Generic Defer.** The generic **Defer position** button works on outreach tickets, but it sets the job to `deferred` and emits no `outreach.reviewed`.
- **Lane A ownership of `resolve_employer`.** Domain and employer tickets use `resolve_employer` and are tagged in `outreach_tickets`. Lane A's resolve handler should leave tagged tickets to `/api/outreach/jobs/:id/{domain,retry}`.
- **Tagging is not atomic.** `openTicket` runs in its own transaction, so writing the `outreach_tickets` tag immediately afterward is a separate statement.
- **Single-process assumptions.** The pilot assumes a single worker, so the per-job lock and in-flight send tracking are in-process. Cross-process safety comes from the unique shortlist and delivery keys and the conditional claim.
- **Prior contact.** Prior contact is detected from this ledger only (approved reviews). Contact history inside Apollo is not consulted.
- **Synthetic fixtures.** People in `tests/fixtures/outreach/people.json` are fictional (`syn-p01`…) at `northwind.example`.
