# Complete a Greenhouse application

## Parent PRD

[Job application and outreach pilot](prd.md)

## What to build

Deliver the first complete application with résumé upload, document tickets, final click and receipt reconciliation.

## Acceptance criteria

- [ ] Skip optional supplemental files. Show required field and formats, allow attachment or deferral, and resume.
- [ ] Replay selector plus acknowledgement text and persist screenshot, URL, text and time. Redirect alone creates a hold.
- [ ] Only a confirmed receipt emits the outreach event.
- [ ] Closes deferred checks: 004 cap change before submit blocks the click and an interrupted submit holds the employer; 005 form-revealed restriction reroutes; 006 resumes at the paused field.
- [ ] Closes 003 integration: import two historical rows through the CSV flow, confirm one new job, and verify the next queued job for that employer stops before Sol.
- [ ] The first live decision starts the seven-day clock. Emit `adapter.available` for Greenhouse.

## Blocked by

- [004-queue-cap.md](004-queue-cap.md)
- [005-eligibility.md](005-eligibility.md)
- [006-answer-bank.md](006-answer-bank.md)
- Soft: [003-import-history.md](003-import-history.md) for the import integration check below.

## User stories addressed

User story 1, User story 8, User story 9
