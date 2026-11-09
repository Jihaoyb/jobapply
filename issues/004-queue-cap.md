# Enforce the employer cap through submission

## Parent PRD

[Job application and outreach pilot](prd.md)

## What to build

Run a single active tab with capture, dequeue/resume and atomic pre-submit checks. Show holds and the next eligible date.

## Acceptance criteria

- [ ] Exercise month-end clamping, imported history and the open lower boundary in Los Angeles time.
- [ ] With two confirmed and five queued, one confirmation stops the other four before eligibility calls or tickets.
- [ ] A cap change before submit prevents the click. An interrupted submitting state holds the employer until reconciliation.

## Blocked by

- [003-import-history.md](003-import-history.md)

## User stories addressed

User story 3, User story 4, User story 9
