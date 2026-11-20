# P2 Lane C · Answer bank (issue 006)

This lane covers the matching core, scoped saves, guarded Luna equivalence, the calibration harness and a resumable field-resolution session. Binding to real form inputs and the live resume check land in 007.

## What was built

| Piece                                                                                                                                                                                                    | Where                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Migration: `answers` (scope `job`/`employer`/`global`), `answer_aliases` (proposed/approved/rejected), `answer_sessions` (fields, resume pointer, paused field, ticket). Owner-scoped with composite FKs | `src/server/migrations/004_answers.sql`                                                          |
| Normalization, deterministic guards (polarity, time horizon, location, numbers, material qualifiers) and choice mapping                                                                                  | `src/server/answers/normalize.ts`                                                                |
| Luna equivalence through the shared wrapper (`purpose: 'answer_equivalence'`, prompt `answer-equivalence-v1`), the pair rule and candidate selection                                                     | `src/server/answers/equivalence.ts`                                                              |
| Bank CRUD, alias proposal/approval, profile seed                                                                                                                                                         | `src/server/answers/bank.ts`, `seed.ts`                                                          |
| Field resolution, sessions, `unanswered_question` ticket handler                                                                                                                                         | `src/server/answers/session.ts`                                                                  |
| Dashboard routes                                                                                                                                                                                         | `src/server/answers/routes.ts` (one registration line in `app.ts`)                               |
| Calibration/evaluation harness                                                                                                                                                                           | `src/server/answers/calibration.ts`, `scripts/answers-calibrate.ts`, `npm run answers:calibrate` |
| Dashboard panel: pending questions with the three saves and defer, saved answers by scope (edit, mark reviewed, delete), alias approval, seed button                                                     | `src/web/answers/` (one mount in `main.tsx`)                                                     |
| Lane schemas                                                                                                                                                                                             | `src/shared/answers.ts`                                                                          |

## Resolution tiers

1. **Scoped exact match** on the normalized question (lossless key and deterministic guards on the raw texts since the review fixes; `needs_review` answers are only suggested, never reused — see integration.md, "Review fixes"). Precedence runs one-time (this job), then employer (canonical employer ID), then global. The answer must map to one of the form's choices: an exact match, or a bare Yes/No mapped to the single choice that starts with it. An exact match whose answer is not a valid choice pauses (`choices_incompatible`).
2. **Approved aliases** for the normalized question. Employer-specific aliases come before global ones, and they are still limited to in-scope answers and valid choices.
3. **Guarded Luna equivalence.** Up to 10 in-scope candidates go to Luna in one call: one per normalized question, keeping the most specific scope, ranked by word overlap. Only questions are sent, never saved answers. A candidate is reusable only if all of these hold:
   - Luna says it is equivalent with a score at or above the threshold.
   - Luna reports the same polarity, time horizon and location, and does not flag it as ambiguous.
   - The deterministic guards find no polarity, time-horizon, location, number or material-qualifier difference.
   - The answer maps to one of the form's choices.

   If several candidates are accepted, they must agree on the mapped choice; otherwise the field pauses (`multiple_matches`). A high-scoring candidate that fails any guard pauses the field (`qualifier_mismatch`), so ambiguity pauses even when the score is high. When Luna accepts reuse of an employer or global answer, the system records a **proposed alias**. Once the user approves it, tier 2 answers that question without a model call.

Time horizon is a set over {now, future}, so "now or in the future", "in the future" and an unqualified question are all different. This is deliberately conservative: when an employer asks about future sponsorship, only an answer approved for that framing is reused. An answer approved for current authorization or current sponsorship is never used.

If Luna is not configured (no `OPENAI_API_KEY`) or the call fails, the field pauses with an `unanswered_question` ticket (`luna_not_configured` or `luna_failed`). The server boots without credentials, and the wrapper records failed attempts. When there are no candidates at all, the model call is skipped.

Threshold: `DEFAULT_EQUIVALENCE_THRESHOLD = 0.85` is a **placeholder**. Set `ANSWER_EQUIVALENCE_THRESHOLD` from the live calibration run described below.

## Field resolution session (resume hook for 007)

- `startFieldSession(db, owner, jobId, fields)` stores `{fieldId, question, choices, required}[]`.
- `advanceFieldSession(db, deps, owner, sessionId)` walks forward from `resume_index` and saves each resolved field as it goes, so a restart resumes where it stopped.
  - Optional fields without a reusable answer are skipped.
  - The first required field without a reusable answer opens an `unanswered_question` ticket (question, choices, employer display name, role) through `openTicket`. The same transaction marks the session `paused` and records `paused_field_id`, `ticket_id` and the reason/suggestion.
  - Advancing a paused session is a no-op.

`resolveAnswerTicket` is served by `POST /api/answers/questions/:ticketId/resolve`. The body is `{action: 'answer_once'|'answer_employer'|'answer_global', answer}` or `{action:'defer'}`. In one transaction, the handler:

1. Validates the answer against the ticket's choices.
2. Upserts the answer at the chosen scope. Employer scope requires a resolved canonical employer; otherwise it returns 409.
3. Writes the answer into the session for exactly the paused field (`tier: 'ticket'`, with ticket and answer IDs).
4. Sets the session back to `running`, with the pointer still at that field.
5. Closes the ticket with outcome `approved`. The resolution value is JSON `{action, answerId, fieldId}`.
6. Restores the job to the ticket's `resume_status` and emits the paired `pause.closed`.

A second resolution returns 409 and emits no second event. Defer closes with outcome `deferred` and marks both the job and the session deferred. The ticket row's `resolve_action` is stored as `answer_once`. The handler accepts all three answer actions for `unanswered_question` tickets, so no contract change was needed.

Routes require a dashboard session, mutations require the dashboard Origin, and every query is owner-scoped:

- `GET/POST /api/answers`
- `PATCH/DELETE /api/answers/:id`
- `POST /api/answers/seed`
- `POST /api/answers/aliases/:id/decision`
- `GET /api/answers/questions`
- `POST /api/answers/questions/:id/resolve`

The extension credential has no access to these routes. 007 decides how the adapter drives sessions.

## Acceptance criteria

| AC                                                                     | Status / test                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offer one-time, employer and global saves                              | Dashboard buttons and the ticket handler. `tests/answers.test.ts`: "one-time, employer and global saves reach exactly their scopes" and "scoped exact matches prefer one-time over employer over global…"                                                                                                                                                                                                                                          |
| Respect choices, polarity, time horizon and location                   | Guards and choice mapping. Tests: "normalization and deterministic guards…", the choice-incompatibility pause, and "ambiguity pauses despite a high score…". In that test the fake Luna claims 0.99 equivalence; current-authorization and current-sponsorship answers are still not reused for future sponsorship, a polarity flip is refused, and Luna's own ambiguity flag blocks reuse                                                         |
| Calibrate on 30–50 handwritten pairs and evaluate on held-out examples | 42 calibration pairs and 21 held-out pairs in `tests/fixtures/answers/`. `tests/answers-calibration.test.ts` checks set sizes, disjointness and categories, and the threshold selection rule. It runs the harness through the real wrapper with the deterministic fake transport: calibration P=1.000 R=0.650 at threshold 0.571; held-out P=1.000 R=0.400. The fake is lexical and naive by design, so the low recall reflects the fake, not Luna |
| Ambiguity pauses despite a high score                                  | Same tests; the harness reports `pausedDespiteHighScore`                                                                                                                                                                                                                                                                                                                                                                                           |
| Verified in 007: a ticket answer resumes the form at the paused field  | **Deferred.** The session state and handler are built. The unit test "a field session pauses at the unanswered field and resolving its ticket yields the answer for exactly that field" covers the pointer, ticket fields, pause pair and job-status restore, and checks that only that field gets the ticket answer. 007 binds `fields` to adapter inputs and checks the live resume                                                              |

Threshold selection maximizes calibration recall while keeping precision at or above the target. The default target is 1.0, because a wrong reuse is worse than a pause. Ties keep the higher threshold. The harness exits 1 if held-out precision misses the target.

## Human-run live calibration

```sh
# server env only; uses OPENAI_LUNA_MODEL through the shared wrapper against a throwaway in-memory DB
OPENAI_API_KEY=... npm run answers:calibrate -- --live
# optional: --min-precision=0.95
```

The command prints:

- TP/FP/FN for each set
- false positives and false negatives by pair ID
- pairs paused despite a high score
- token usage
- the threshold to set as `ANSWER_EQUIVALENCE_THRESHOLD`

Run it before launch and again before changing the model or prompt, then refine it with reviewed pilot tickets (per the PRD). Without `--live`, `npm run answers:calibrate` runs offline with the fake.

## Needs human review

- **Every work-authorization seed answer.** They live in `src/server/answers/seed.ts`, are stored with `needs_review=true`, and show as "Needs review" in the dashboard. Assumed profile: F-1 OPT, currently authorized to work in the US, will require H-1B sponsorship in the future. Confirm each one:

  | Seed question                                                                          | Seeded answer                                                                 |
  | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
  | "Do you currently require visa sponsorship…?"                                          | **No**                                                                        |
  | "Are you able to work in the United States without sponsorship now and in the future?" | **No**                                                                        |
  | "Will you now or in the future require sponsorship…?"                                  | **Yes**                                                                       |
  | "Will you in the future require sponsorship…?"                                         | **Yes**                                                                       |
  | Legal or current authorization to work in the US                                       | **Yes**                                                                       |
  | U.S. citizen or permanent resident                                                     | **No**                                                                        |
  | Work authorization status (free text)                                                  | "F-1 student with Optional Practical Training (OPT) employment authorization" |

- **Every fixture label** in `tests/fixtures/answers/calibration.json` and `heldout.json`. Each pair carries `needsHumanReview: true`. These pairs are judgment calls worth checking:
  - c12 and h08 are labeled equivalent, though a "current" qualifier trips the horizon guard.
  - h02 is labeled equivalent, though "obtain/maintain authorization" trips the qualifier guard.
  - n04 (future vs now-or-future) is labeled not equivalent, even though this applicant's answer would be the same for both.
  - n15 and n17.
- The 0.85 default threshold, until a live calibration run replaces it.

## Notes for other lanes / 007

- Employer-scoped answers and aliases reference `employers(id, applicant_id)`. If 002's merge deletes or re-points employer rows, it must also re-point (or merge) `answers.canonical_employer_id` and `answer_aliases.canonical_employer_id` in the same transaction.
- The generic `/api/tickets/:id/resolve` defer still works on these tickets, but it leaves the session `paused` on a closed ticket. The dashboard uses the answers handler instead. 007 may treat a paused session whose ticket is resolved as deferred.
- This lane's UI was not checked in a browser; build and type checks pass.
