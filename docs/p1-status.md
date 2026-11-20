# P1 implementation status

Implemented on November 9, 2026 against issue 001 and the build graph. No P2/P3 execution or real application submission has occurred.

| Scope | Status |
| --- | --- |
| TypeScript server, PostgreSQL migration and owner-isolated ledger | Implemented; integration-tested with embedded PostgreSQL |
| Private dashboard login, manual capture, pair/revoke controls, saved postings | Implemented; browser sign-in and capture verified |
| Manifest V3 Chrome extension with editable capture, Yes/No, restricted-site fallback | Implemented; request/decision core tested; unpacked Chrome flow remains manual |
| Hashed applicant-scoped tokens; missing/invalid/revoked/wrong-owner rejection | Integration-tested |
| Reporting event vocabulary, pause pairs, review enum, tickets and canonical employer UUID | Frozen v1 in contracts.md; pause lifecycle tested |
| Server-only model wrapper with configured IDs, validation and token accounting | Fixture-tested; no live provider request |
| Dockerfile, Railway config, health endpoint and hosted smoke script | Implemented; smoke script verified locally |
| Railway deployment and hosted smoke | Pending: no Railway CLI, account config or deployment token available |

Validation: `npm test` (eight integration tests), `npm run build`, extension JavaScript syntax checks, production dependency audit (zero findings at installation), and built-dashboard browser checks. Tests run the same versioned migration twice to cover restart idempotency. The browser check uses synthetic credentials and data in a separate temporary local database. The local HTTP smoke caught an empty-JSON DELETE bug in device revocation; the request helper is corrected and a regression test covers it.

Browser verification covered sign-in, manual posting capture with both links and text, and desktop/mobile layouts at 1440 and 390 pixels wide. The mobile document width matched its viewport (no horizontal overflow), and the final browser check reported no console warnings or errors. The temporary preview server was stopped after verification.

Remaining to close issue 001: run the unpacked extension in Chrome through pairing, Yes, No and revocation; provision Railway/Postgres and run `npm run smoke` against the HTTPS deployment. Provider secrets are structurally absent from the frontend/extension; verify Railway variables remain server-side during the hosted check. Leave the issue’s deployment acceptance checkbox unchecked until then.

Private object storage is not provisioned in P1: this issue stores posting text and URLs only. Document and screenshot storage is needed by later document/receipt work. The report’s seven-day clock starts with the first **live** P3 decision, not these synthetic P1 tests.
