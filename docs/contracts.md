# Shared contracts v1

Frozen for the P2 lanes in the [build graph](build-graph.md). The executable contract is `src/shared/contracts.ts`; all timestamps are persisted as PostgreSQL `timestamptz` and serialized in UTC ISO 8601. Calendar cap calculations in P2 still use `America/Los_Angeles`.

## Ownership, identity and capture

All IDs are UUIDs. `CanonicalEmployerId` is an opaque, stable UUID, **not** a domain, display name, or ATS slug. `jobs.canonical_employer_id` is nullable during capture. The `employers` primitive reserves `id`, `applicant_id`, `name`, and nullable `domain`. Issue 002 adds alias resolution and domain confirmation; no automatic merge exists in P1.

Every data query includes the authenticated applicant ID. Composite foreign keys prevent jobs, employers, tickets, events and model calls from crossing owners. Extensions authenticate with a revocable random bearer token hashed at rest. The owner in `/api/extension/:ownerId/...` must match the token owner; caller-provided IDs never grant authority. Pairing tokens can only verify pairing and write captures. Dashboard login uses a separate hashed session cookie. Mutation routes require the configured dashboard Origin.

`CaptureInput`: `clientCaptureId`, `title`, `employer`, `discoveryUrl`, `applicationUrl`, `postingText`. Capture retries with the same owner and client ID return the same job, emit no second event and reject changed content with 409. This is transport idempotency, not P2 requisition deduplication.

`supportedHost` identifies a recognized pilot ATS host (Greenhouse, Lever, Ashby); it does **not** imply that an adapter is live. Report adapter availability only from `adapter.available`. Other hosts remain captured with their hostname and `supportedHost=false`. Posting URLs are HTTP(S), without embedded credentials. The server never fetches a supplied posting URL.

## Ledger envelope and event vocabulary

Every event carries `id`, `applicantId`, `jobId`, `name`, `occurredAt`, `schemaVersion=1`, and typed `payload`. Only the owner-wide `adapter.available` event permits a null job ID. Events are append-only through `appendEvent`; insert domain changes and events in the same database transaction. Do not rewrite earlier events to correct a result; append a reviewed outcome instead.

| Event | Payload |
| --- | --- |
| `job.selected` | source (`extension`/`manual`), applicationHost, supportedHost |
| `job.duplicate` | existingJobId |
| `job.capped` | nextAvailableDate (ISO local date) |
| `eligibility.decided` | decision (`passed`/`excluded`/`review`), provenance (`rule`/`sol`/`user`), nullable verbatim evidence |
| `application.submitting` | empty object; atomically coupled to pre-submit transition in 004/007 |
| `application.uncertain` | reason |
| `application.confirmed` | receiptId; emitting an event alone is not proof of persisted confirmation |
| `pause.opened` | pauseId, ticketId, cause |
| `pause.closed` | same pauseId, ticketId, cause; outcome |
| `review.sampled` | sampleId, group (`passed`/`excluded`) |
| `review.completed` | sampleId, outcome |
| `outreach.shortlisted` | shortlistId |
| `outreach.reviewed` | ticketId, outcome |
| `email.accepted`, `email.uncertain` | deliveryId |
| `linkedin.recorded` | contactId |
| `adapter.available` | host (`greenhouse`/`lever`/`ashby`) |
| `model.called` | callId, provider, model, promptVersion, nullable inputTokens/outputTokens, status |

Capture emits only `job.selected`. The remaining event names are reserved for their respective issue implementations, not fabricated outcomes. P1 synthetic captures do not start the pilot clock. In 007, the first real `job.selected` starts that clock; synthetic jobs must be excluded from the live fixture/report dataset.

## Pause and ticket primitive

`openTicket(db, applicantId, jobId, input)` creates a ticket, pauses the job and emits `pause.opened` atomically. One open ticket per job prevents concurrent active pauses in the single-worker pilot. Input fields: `question`, `choices`, `employer`, `role`, `cause`, `resolveAction`. Ticket fields add `id`, `applicantId`, `jobId`, `pauseId`, `status`, `openedAt`, `closedAt`, and nullable `resolution={outcome,value}`.

Causes: `employer_identity`, `import_ambiguity`, `unanswered_question`, `required_file`, `eligibility_ambiguity`, `unsupported_form`, `provider_limit`, `uncertain_submission`, `uncertain_email`.

Resolve actions: `resolve_employer`, `resolve_import`, `answer_once`, `answer_employer`, `answer_global`, `attach_file`, `decide_eligibility`, `reconcile_submission`, `retry_provider`, `review_outreach`, `reconcile_email`, `defer`.

The P1 generic handler supports **defer only**. Domain lanes must implement the corresponding state change (save scoped answer, resolve employer, attach file, reconcile receipt, etc.) and close the ticket/pause in that same transaction before resuming. Merely clicking approve cannot perform those actions. Ticket records reserve `resume_status` for lane-specific resume handling. A second resolution returns 409 and emits no second close event.

Waiting time is `pause.closed.occurredAt - pause.opened.occurredAt`, paired by owner, job and pauseId. An open pause accrues until the report’s cutoff. Count distinct affected jobs separately from pause episodes. Keep resolved tickets and both events for reporting.

## Review outcomes and reporting

Outcome enum: `approved`, `edited_draft`, `changed_ranking`, `missed_restriction`, `reversed_exclusion`, `no_change`, `skipped`, `deferred`.

Persist selected sample IDs with `review.sampled`, then completed results with `review.completed`. A selected sample does not increase the completed-review denominator. `outreach.reviewed` is the outreach denominator; its outcome distinguishes approvals, edits, ranking changes and skips. Reconcile chart counts to events by distinct job or review ID as appropriate; separate SMTP acceptance from manual LinkedIn completion. Receipt, sample, shortlist and delivery storage arrive in their owning lanes.

## Single model boundary

Use `configuredModelCaller(db)` from `src/server/model.ts` on the server. Requests carry owner/job, purpose, promptVersion, instructions, input and a Zod output schema. Purposes: `eligibility` → configured Sol; `answer_equivalence`, `contact_ranking`, `outreach_draft` → configured Luna. The wrapper uses the [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create), low reasoning, JSON output, no provider response storage, a timeout and output validation. Prompts must explicitly request JSON.

Every attempted provider request writes one `model_calls` row and `model.called` event with provider, served model when available, prompt version, token usage and completed/failed status. Unknown usage is **null**, never a fabricated zero. Received usage is preserved even when output validation fails. Credentials, raw prompts and raw provider errors are never ledger payloads. Missing setup and invalid owner/job fail before a provider attempt. The wrapper performs no retries; each lane decides whether to pause or retry. API transport is injectable for fixture tests. No live OpenAI call is part of P1 verification.

Version changes must update executable schemas, SQL migrations and this document together. Do not silently rename events or change denominator semantics while other lanes consume v1.
