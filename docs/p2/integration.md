# P2 integration (lanes A–E on `p2-core`)

This file covers the cross-lane fixes made after the five P2 lanes were merged, and the policies they set. Contracts v1 is unchanged: no new event names, job statuses, pause causes, review outcomes or resolve actions. Tests are in `tests/integration.test.ts`, with additions to the report and outreach tests.

## Shared ticket primitive (`src/server/ledger.ts`, `src/server/ticket-hooks.ts`)

- The ledger exports in-transaction variants, and its own `openTicket`/`resolveTicket` use them:
  - `openTicketTx(sql, …)`
  - `closeTicketTx(sql, applicantId, ticketRow, resolution, nextJobStatus)`
  - `lockOpenTicketTx`
  - `findOpenTicket`
- Lane copies have been removed:
  - Identity's `openTicketTx`/`closeTicketTx` copy is gone (`identity/tickets.ts` now keeps only the applicant lock).
  - Eligibility, answers and outreach close their tickets through `closeTicketTx` instead of hand-written SQL.
- `closeTicketTx` changes the job status only while the job is still `paused`, so a status that another writer set during the pause is left alone. A second close returns 409.
- **Queue follows tickets.** This logic moved from identity's private copy into `identity/queue-hooks.ts`, which `ticket-hooks.ts` calls:
  - Any ticket that opens pauses the job's `work_queue` item.
  - On close, the queue item follows the job's new status:
    - `captured`, `eligibility_pending` or `ready`: requeued, and `dequeueNext` gates the job again.
    - `deferred`, `eligibility_excluded`, `duplicate` or `capped`: stopped, with `stop_reason` set to that status.
    - Anything else: left alone.
- **Event order** (migration `006_integration.sql`): `ledger_events.occurred_at` now defaults to `clock_timestamp()`. Events appended in one transaction previously shared `now()` and were ordered by random ID. Merging the eligibility review ticket and its decision into one transaction made that visible as a flaky test.

## 1. One open ticket per job

The unique index `one_open_ticket_per_job` stays. **Policy:** when a lane's background work finds another lane's open ticket on the job, it defers. It does not throw, and it does no provider or model work while blocked. It runs again after that ticket closes.

- **The conflict is typed.** `openTicketTx` throws `OpenTicketConflict` (a 409 `HttpError` carrying the existing ticket ID). The job row lock serializes openers, so the check is authoritative. Use `isOpenTicketConflict(error)` to test for it.
- **Outreach.**
  - The worker checks for a foreign open ticket before any Apollo or Luna call. If it finds one, it logs `deferred_open_ticket` (this worker-log outcome was added in migration 006) and returns.
  - `openOutreachTicket` opens the ticket, writes the `outreach_tickets` tag and runs an optional `alsoTx` (the review row) **in one transaction**. On a conflict it returns `null` and logs.
  - The sweep skips jobs with an open ticket and retries them after the ticket closes.
  - `withJobLock` cleanup no longer creates a second, unobserved rejection. That rejection was the source of the "asynchronous activity after the test ended" error.
- **Eligibility.**
  - The review ticket and the `review` decision now commit in one transaction. On a conflict nothing is recorded and `OpenTicketConflict` propagates.
  - A paused job is already refused before rules or Sol run (the status gate).
  - The queue entry turns a mid-flight 409 into `{status:'deferred'}` (see item 6).
- **Answers.** `advanceFieldSession` returns immediately, with `blockedByTicketId` set, when the job has an open ticket. In that case it makes no Luna call. A conflict at pause time keeps the progress made so far and leaves the session `running` at the field. Advance it again after the blocking ticket closes; 007 owns that loop.
- **Identity** opens tickets inside its own capture/gate transactions. A conflict there aborts the savepoint at capture, which identity's existing fallback already handles.
- **The original failing test** was a fixture artifact: the job captured with an open identity ticket and was then forced to `confirmed`. The outreach fixture now resolves the identity ticket first, as a real position would. Two cross-lane facts came out of this:
  - Lane A fills `employers.domain` from an employer-owned application host (`careers.x.example` → `x.example`), and outreach treats that domain as known, so it skips domain confirmation. The "posting link" test now uses an ATS application URL plus a link in the posting text. **For review:** is lane A's derived domain good enough for people search, or should outreach confirm it once anyway? The latter would need a "confirmed" flag, which means a migration.
  - The new policy test simulates the race where a ticket opens after the job was read as confirmed.

## 2. Employer merge across lanes

`mergeEmployers` (identity) now calls `mergeEmployerAnswersTx` (`answers/merge.ts`) in the same transaction. Outreach tables store no employer IDs: `outreach_shortlists.domain` is text and `employers.domain` is merged by identity. Eligibility tables store none either.

- **Employer-scoped answers:**
  - An answer that exists only on the source employer moves to the target.
  - **Same answer on both sides** (case and whitespace ignored): the source answer folds into the target. Its aliases move to the target answer, a decided alias status wins over `proposed`, and the source row is deleted.
  - **Different answers:** both are kept and flagged `needs_review`. The target's answer stays in force for matching. The source's answer stays attached to the merged-away employer, so the dashboard lists both until the user keeps one.
- **Employer-specific `answer_aliases`** are re-pointed to the target, merging into identical twins. The exception is aliases of a conflicting answer, which stay with that answer.
- The test also covers rollback: an error after the merge leaves the answers where they were.
- **For review:**
  - Is "target wins for matching, both flagged" the rule you want? A stricter option is to pause matching on both answers until review.
  - When both employers have different domains, identity still keeps the target's domain silently.

## 3. Lane ownership of shared ticket kinds

- **Identity's resolve handler** requires an `identity_tickets` row, so it refuses outreach-tagged `resolve_employer` tickets (409).
- **Outreach's domain and retry routes** select only tickets tagged in `outreach_tickets`, so they refuse identity tickets (409).
- **The generic resolve route** refuses everything except `deferred`.
- **New guard in the answers handler:** it accepted any `unanswered_question` ticket, which included outreach review tickets. It now also requires `resolve_action` to be one of `answer_once`, `answer_employer` or `answer_global`.
- In every refused case above, the test checks that the ticket stays open.

## 4. Generic Defer, routed per lane

`resolveTicket` with outcome `deferred` calls `deferTicketTx` (`ticket-hooks.ts`) in the same transaction:

- **Outreach-tagged ticket:** the job returns to its `resume_status` (`confirmed`). The application went through; only outreach is deferred.
  - A review ticket also marks the review `skipped` with outcome `deferred` and appends `outreach.reviewed {ticketId, outcome:'deferred'}`. The report already keeps `deferred` out of the reviewed denominator.
  - After a domain, provider or employer pause is deferred, the worker skips that job (`skipped_deferred`) and the sweep never reopens it.
  - A deferred email reconciliation leaves the delivery `uncertain`, which is never resent automatically.
- **Answer-session ticket:** the session becomes `deferred` with no ticket, just as the answers handler's own defer does.
- **Every other ticket:** the job becomes `deferred` and its queue item stops (`stop_reason='deferred'`).

## 5. Report attribution

- **New pause row.** Pause rows are now the nine v1 causes plus `outreach_review` (label "outreach review"). A pause whose ticket has `resolve_action='review_outreach'` counts there, not under `unanswered_question`. The row is "absent" when outreach is not covered.
  - Episodes carry both the v1 `cause` and the report `category`.
  - The bottleneck and its ranking use the category.
  - `load.ts` now reads `tickets.resolve_action`.
- **Confirmations.** The funnel's confirmed stage was already counted from `application.confirmed`. A new test checks that a job paused on an open outreach review still counts as confirmed.
- **Fixture generator.** The `oreview` step can now model lane D's actual pause (`hours`, or `open`).

## 6. Queue → eligibility hand-off (`src/server/screening.ts`)

`screenQueuedJob(db, applicantId, jobId, deps)` is the eligibility entry that 007's single-tab loop calls on the job `dequeueNext` returned. It sits outside both lanes, so neither lane imports the other.

1. `gateBeforeEligibility`: a duplicate, capped, held or unresolved job returns `{status:'gated'}` without running any rule or calling Sol.
2. `captured` → `eligibility_pending`.
3. A `ready` job returns `already_screened`, so Sol is not called a second time after a user resolution.
4. `decideEligibility` on the posting text:
   - passed → `ready`, and the item stays active;
   - excluded → `eligibility_excluded`, and the item is stopped;
   - review → a ticket, with `resume_status` `eligibility_pending` and the item paused. Resolving the ticket moves the job to `ready` and requeues it.
5. A 409 during the decision (another lane paused the job) returns `{status:'deferred'}`.

`decideEligibility` also accepts an injected `queueGate`. `app.ts` passes it to the eligibility routes, so the Sol **retry** route is gated in the same way.

**Left for 007:**

- calling `screenQueuedJob` after `dequeueNext`, and `completeActive` after confirmation;
- form-source eligibility (`decideEligibility(…, 'form')`) before the final click;
- re-advancing answer sessions that report `blockedByTicketId`;
- calling `handleOutreachEvent` after `confirmSubmission` commits.

## 7. Duplicate ticket SQL

Covered under "Shared ticket primitive" above. Outreach's tag write and review-row insert are now atomic with the ticket.

## 8. Housekeeping

- `.env.example` lists every server variable read by `process.env`. Values are empty or safe defaults, with comments.
- `.gitignore` includes `.claude/worktrees/`.
- README:
  - The validation section lists `eligibility:replay`, `answers:calibrate` and the outreach verify CLI.
  - A short P2 status section was added.
