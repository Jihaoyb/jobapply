# Send approved email and track manual invitations

## Parent PRD

[Job application and outreach pilot](prd.md)

## What to build

Send the approved message over Gmail SMTP with TLS and provide a copyable LinkedIn note and profile link.

## Acceptance criteria

- [ ] Verify app-password setup and account limits. Send at most one approved email per position.
- [ ] A timeout creates a reconciliation ticket before retry. SMTP acceptance and manual LinkedIn completion have distinct ledger events.

## Blocked by

- [011-review-outreach.md](011-review-outreach.md)

## User stories addressed

User story 11, User story 12
