# Enforce the employer cap through submission

## Parent PRD

[Job application and outreach pilot](prd.md)

## What to build

Run a single active tab with capture, dequeue/resume and atomic pre-submit checks. Show holds and the next eligible date.

## Acceptance criteria

- [ ] Exercise month-end clamping, imported history and the open lower boundary in Los Angeles time.
- [ ] With two confirmed and five queued, one confirmation stops the other four before eligibility calls or tickets.
- [ ] Verified in 007: a cap change before submit prevents the click, and an interrupted submitting state holds the employer until reconciliation.

## Blocked by

- [002-employer-identity.md](002-employer-identity.md)
- Soft: [003-import-history.md](003-import-history.md) supplies imported rows for the cap test fixture only.

## User stories addressed

User story 3, User story 4, User story 9
