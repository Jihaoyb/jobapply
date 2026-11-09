# Capture a posting from a paired extension

## Parent PRD

[Job application and outreach pilot](prd.md)

## What to build

Select Yes or No on a discovery page and view saved jobs in the private hosted dashboard. Support manual posting input and record unsupported hosts.

## Acceptance criteria

- [ ] Yes persists both URLs and posting text. No dismisses.
- [ ] Pair from the authenticated dashboard. Missing, revoked and wrong-owner tokens cannot access the ledger.
- [ ] Deploy a pilot smoke test on Railway and verify provider credentials stay server-side.
- [ ] Freeze the shared contracts other lanes build on: ledger event names carrying job ID and timestamp, pause open/close pairs, review outcome enum, ticket primitive (question, choices, employer, role, resolve action), canonical employer ID shape, and one model-call wrapper that records provider, model, prompt version and token usage.

## Blocked by

None — can start immediately.

## User stories addressed

User story 1
