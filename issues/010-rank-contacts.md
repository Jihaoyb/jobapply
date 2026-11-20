# Resolve the company domain and rank contacts

## Parent PRD

[Job application and outreach pilot](prd.md)

## What to build

After confirmation, resolve the employer domain and display an evidence-backed shortlist.

## Acceptance criteria

- [ ] Verify Apollo key, endpoint access and credits at setup. Pause on limits.
- [ ] Use the employer website or name-based organization enrichment and confirm the domain once. Unknown domains pause lookup.
- [ ] Filter by domain and relevant titles, send at most ten people to Luna and show up to three scored recommendations with reasons, evidence and repeat-recipient flags.
- [ ] The confirmation event only wakes the worker. The worker reads the job's persisted status and calls Apollo only when it is confirmed. A confirmation event for a job still marked uncertain produces zero Apollo calls and a logged skip.
- [ ] Delivering the same confirmation event twice produces one shortlist (idempotency key: job ID).

## Blocked by

- [002-employer-identity.md](002-employer-identity.md)
- Soft: [007-greenhouse-receipt.md](007-greenhouse-receipt.md) replaces the fixture confirmation event with the live one.

## User stories addressed

User story 3, User story 10, User story 11
