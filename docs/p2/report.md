# P2 Lane E · 013a pilot report (fixture build)

013a builds the three report charts, the review sample and the bottleneck view against a synthetic fixture ledger. 013b (publishing the live report seven days after the first live decision, and writing the one improvement) is **not** part of this lane.

## What was built

| Piece                                                                              | Location                                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Pure report computation (clock, coverage, funnel, pauses, corrections, bottleneck) | `src/server/report/compute.ts`                          |
| Ledger loader (owner-scoped `ledger_events`, `jobs`, `tickets`)                    | `src/server/report/load.ts`                             |
| Review sampling and completion (`review.sampled`, `review.completed`)              | `src/server/report/sampling.ts`                         |
| Routes                                                                             | `src/server/report/routes.ts`                           |
| Report payload types and input schemas                                             | `src/shared/report.ts`                                  |
| Dashboard panel (SVG bars, host table, bottleneck, sample review)                  | `src/web/report/ReportPanel.tsx`, `report.css`          |
| Deterministic fixture generator, scenarios and hand-counted expectations           | `tests/fixtures/report/`                                |
| Tests                                                                              | `tests/report.test.ts`, `tests/report-sampling.test.ts` |

No migration, and no contract change. The report reads only v1 events, jobs and tickets. `model_calls` and `model.called` are not inputs to the three charts.

### API (dashboard session; POSTs need the dashboard Origin)

- `GET /api/report[?clockStart=ISO]`: returns the report, or `{status:'not_started', reason}`.
- `GET /api/report/samples`: lists sampled postings and their latest review outcome.
- `POST /api/report/samples {seed?, clockStart?}`: tops up to 10 passed + 10 excluded samples. It returns `{drawn}`, or 409 if the clock has not started.
- `POST /api/report/samples/:sampleId/complete {outcome}`: records one actual review.
  - Passed samples accept `no_change`, `missed_restriction`, `skipped` or `deferred`. Excluded samples accept `no_change`, `reversed_exclusion`, `skipped` or `deferred`.
  - A second non-deferred completion returns 409. Another owner's sample returns 404.

## Design decisions (review these)

**Clock start.** The clock can be pinned with `clockStart`. Otherwise it is derived as the first `job.selected` at or after the earliest `adapter.available`. 007 emits `adapter.available` for Greenhouse when it goes live, so synthetic P1 captures, which come earlier, never start the clock.

- The window is `[clockStart, clockStart + 7 d]`. The cutoff is `min(now, window end)`.
- Pilot jobs are those selected inside the window. Jobs selected earlier or later are excluded and counted in `excludedFromWindow`.
- Pipeline events after the cutoff are ignored. Exception: `review.sampled`/`review.completed` are kept whenever they occur, because sampling and review happen at publication, after the cutoff.
- Limitation: v1 has no synthetic/live flag. If a smoke capture happens after go-live but before the first real decision, pin the clock with `clockStart`.
- Open question: should the pinned start persist? Today it is a query parameter. Persisting it would need storage, which means a migration.

**Coverage.**

- **Hosts.** Each host is covered from its first `adapter.available`, clipped to the clock start. Repeated emissions are ignored.
- **Outreach.** Outreach, email delivery and LinkedIn recording are each covered from their first observed event. v1 has no `outreach.available` event, so "no records" means "absent". This is conservative: a live-but-idle step reads as absent.
- **Gaps.** A count is `null` (rendered "absent") when its source is not covered and nothing was observed. Submission stages need the job's host adapter; the "other" host never has one. Outreach stages need outreach coverage. The `uncertain_email` cause needs email coverage, and `uncertain_submission` needs at least one live host.
- **Labels.** Every chart carries a coverage label: hosts live with window and days, hosts not live, outreach steps, and days covered of 7.

**Funnel.** Each stage counts distinct jobs. Eligibility uses the job's latest decision. "Uncertain" means jobs with `application.uncertain` and no later confirmation. Email acceptance (SMTP) and LinkedIn (manual) are separate rows. Per-host counts appear with each host's coverage window. Duplicate, capped and eligibility-excluded are reported as **intended stops**, not failures.

**Pauses.**

- `pause.opened`/`pause.closed` are paired by job and pauseId. Open pauses, and pauses closed after the cutoff, accrue waiting time up to the cutoff.
- Episodes and distinct jobs are reported separately, along with open episodes, for all nine causes.

**Corrections.**

- Each correction is reported over the reviews actually completed, never over selections.
- Sample-review denominators exclude `skipped` and `deferred`, since nothing was reviewed. The latest completion per sampleId wins, so a review can be deferred and then completed.
- The outreach denominator is the distinct `outreach.reviewed` ticket IDs, excluding `deferred`. `skipped` counts, because the contract defines skips as a reviewed outcome.
- With no completed reviews, the rate is `null` ("no completed reviews"), not 0%.

**Sampling.**

- Samples are drawn from in-window jobs whose final decision is passed or excluded.
- The order is a seeded SHA-256 rank, with a random seed by default. Every sample ID is a UUIDv8 derived from owner + group + job, so it is stable.
- Redraws only top up; they never re-sample a job and never mint a second ID. All available postings are taken when a group has fewer than 10.

**Bottleneck.**

- The bottleneck is the pause cause with the greatest total waiting time. Ties go to distinct jobs, then cause name. Intended stops are never bottlenecks.
- The report links each record by job, pauseId, ticketId and the open/close event IDs, and includes the ticket question.
- The full ranking is included.
- `improvement` is always `null`: in 013b a human writes it from the linked records.

**UI.** Plain SVG bars with no chart library, plus semantic tables.

- Every number is in text; bars only encode magnitude. Absent values render as a dashed outline labeled "absent".
- The panel has its own light/dark tokens via `prefers-color-scheme`. It was checked at 375 px with no horizontal overflow.
- No inline styles, because the CSP forbids them.

## How the acceptance criteria are tested

| AC (013)                                                                                                   | Status                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reconcile exactly three charts against a fixture ledger, with reviewed denominators                        | `tests/report.test.ts` checks every funnel stage (total and per host), all pause causes and totals, all correction numerators and denominators, and sample summaries against hand-counted values in `scenarios.ts`. A second test re-derives the funnel and pause numbers with independent SQL. |
| Sample ten passed and ten excluded or all available; preserve IDs; track actual reviews                    | `tests/report-sampling.test.ts` covers 10 of 20 passed and 5 of 5 excluded, same seed giving the same picks, stable IDs, idempotent redraw, selections not counted, completions validated per group, owner isolation, 409 on repeat, and defer then complete.                                   |
| Identify the largest bottleneck and link its records                                                       | Tested: the cause, waiting time, record order, pause/ticket/event links and the ranking. **The improvement itself is deferred to 013b (human-written).**                                                                                                                                        |
| Clock starts at the first live decision; `adapter.available` per host; host coverage windows in the funnel | Tests cover the derived clock (synthetic pre-go-live captures excluded), an explicit override, `not_started`, a repeated adapter emission, per-host days, and the window clipped to the clock start. **The live clock start itself is verified in 007/013b.**                                   |
| Day seven publishes all three charts even with adapters or outreach unavailable; coverage labels           | The `greenhouseOnlyWeek` scenario: Lever, Ashby and every outreach step are `null` and labeled "absent, not zero" in all three charts. A mid-week case checks open-window labeling and accrual.                                                                                                 |

## Fixture scenarios

`tests/fixtures/report/generator.ts` turns per-job scripts into v1 rows with explicit timestamps and deterministic IDs. All employers and hosts are synthetic (`Fixture Employer …`, `*.example.com`, `fixture-*` ATS slugs); there are no real people. `scenarios.ts` holds two scenarios, each with its expected numbers and the arithmetic in comments:

- `fullWeek`: 31 pilot jobs across Greenhouse, Lever (live day 3), Ashby (live day 5) and an unsupported host.
  - Two pre-go-live synthetic jobs and one post-cutoff job are excluded, and two events fall after the cutoff.
  - 16 pause episodes on 15 jobs, 6 of them open. One job has two episodes of the same cause.
  - Samples include a skipped review and a deferred-then-completed review.
- `greenhouseOnlyWeek`: the day-seven gap case, with only Greenhouse live and no outreach at all.

## Deferred / for human review

- 013b: run on the real ledger at day seven, draw and complete the samples, and write the one improvement.
- Confirm the clock derivation rule and the conservative outreach-coverage rule above. Both are interpretations, because v1 has no live flag and no outreach availability event.
- Confirm the denominator exclusions: `skipped`/`deferred` for samples, `deferred` only for outreach.
