# Jobapply

P1 foundation for the [build graph](docs/build-graph.md): private capture dashboard, paired Chrome extension, PostgreSQL ledger, shared contracts and a Railway deployment configuration. No applications are submitted and no model call runs during capture. P2 core lanes are built on fixtures (see [P2 status](#p2-status)).

## Run locally

Requires Node **22.12+**. Install packages and build the dashboard:

```sh
npm ci
cp .env.example .env
npm run build
```

Set `PILOT_EMAIL` in `.env`. Generate a password hash without putting the password in shell history (zsh):

```sh
read -s 'pilot_password?Pilot password (12+ characters): '
printf '%s' "$pilot_password" | npm run --silent password:hash
unset pilot_password
```

Put the resulting `scrypt:…` hash in `PILOT_PASSWORD_HASH` in `.env`. Keep `.env` private; it is ignored by Git and Docker. Then choose either:

```sh
# Embedded PostgreSQL; persists under .data/postgres, no Docker needed.
npm run dev:local

# Or full PostgreSQL (start Docker Desktop first):
docker compose up -d
npm run dev
```

Open [the local dashboard](http://localhost:3000), sign in, and add a posting. Both commands serve the built dashboard; rerun `npm run build` after frontend changes. For frontend hot reload, run `npm run dev:web` alongside the server, open port 5173, and set `APP_ORIGIN=http://localhost:5173` in `.env` before restarting the API. Use the single-origin built dashboard for extension pairing.

## Pair the Chrome extension

1. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose this repository’s `extension/` folder.
2. In the signed-in dashboard, enter a device name and select **Create pairing token**. The full pairing JSON is shown once.
3. Open the Jobapply toolbar popup on an HTTP(S) posting, select **Pairing**, and paste the JSON. Grant access only to your dashboard origin when Chrome requests it.
4. Review the role, employer, both URLs and posting text. **Yes** saves; **No** dismisses locally without a request. Restricted sites can be entered manually in the popup or dashboard. Capture never navigates to the application or bypasses a restriction.
5. Revoke the device in the dashboard to reject subsequent requests immediately. **Forget this device** removes the local copy; server revocation is separate.

The extension uses `activeTab` to read only the page you invoke it on. Its only persistent secret is its revocable pairing token, held in extension-local storage. Unsent drafts and dismissals are session-local. A failed save retains its capture ID for idempotent retries. Editing already-persisted content under that ID returns a conflict rather than silently overwriting it.

## Validation

```sh
npm test
npm run build
```

Tests run the real SQL migration against embedded PostgreSQL and exercise Fastify HTTP boundaries with synthetic fixtures: capture persistence and retries, unsupported hosts, missing/invalid/revoked/wrong-owner tokens, CSRF, owner isolation, paired pauses, model provenance/usage and extension Yes/No. No external credentials or live applications are needed. P2 tests use fakes for OpenAI, Apollo and SMTP; no test makes a network call.

Offline harnesses (also run by the test suite) and their human-run live variants:

````sh
npm run eligibility:replay -- --fake   # eligibility labeled set; live run records the Sol baseline (docs/p2/eligibility.md)
npm run answers:calibrate              # answer-equivalence calibration; add -- --live for the threshold (docs/p2/answers.md)
# Live Apollo/Gmail checks (spend credits / send mail; see docs/p2/outreach.md):
node --env-file-if-exists=.env --import tsx src/server/outreach/verify-cli.ts apollo|smtp
``` Browser-check the unpacked Chrome popup separately; the test suite covers its decision/request core, not the Chrome permission UI.

## Deploy the pilot to Railway

1. Create a Railway project with a PostgreSQL service and a service from this repository. The checked-in `Dockerfile` and `railway.json` build the dashboard and server.
2. Set the app service’s `DATABASE_URL` to the Postgres service reference `${{Postgres.DATABASE_URL}}` (adjust the service name if renamed).
3. Set `NODE_ENV=production`, `PILOT_EMAIL`, `PILOT_PASSWORD_HASH`, and `APP_ORIGIN=https://<your-public-domain>` (no trailing slash). Railway supplies `PORT`. The server runs its versioned SQL migration before listening. Password changes invalidate existing dashboard sessions.
4. Keep provider credentials in Railway service variables only. Capture does not require them. Future lanes consume `OPENAI_API_KEY`, `OPENAI_SOL_MODEL` and `OPENAI_LUNA_MODEL` through the shared server wrapper. Do not add provider credentials to Vite variables, extension files, or pairing JSON. Outreach reads `APOLLO_API_KEY` and the `GMAIL_*` variables (see `.env.example`); private object storage belongs to a later issue.
5. Wait for `/healthz` to pass, sign in, pair Chrome and capture a synthetic posting. HTTPS is required outside localhost; production cookies are HttpOnly, Secure and SameSite=Strict.
6. For a repeatable HTTP smoke test, set `APP_ORIGIN`, `SMOKE_EMAIL`, and `SMOKE_PASSWORD` locally and run `npm run smoke`. It checks pairing, capture, retries and missing/wrong-owner/revoked credentials. It leaves **one clearly labeled synthetic capture**, revokes its temporary pairing token and logs out. It never submits a job application.

The Railway deployment and unpacked Chrome acceptance checks are **not yet verified**. This environment has no Railway CLI, account configuration, or deployment token. See [P1 status](docs/p1-status.md) for completed checks and remaining acceptance work. Deployment references: [Railway health checks](https://docs.railway.com/deployments/healthchecks), [Railway PostgreSQL](https://docs.railway.com/databases/postgresql).

## Contracts for P2

Read [contracts v1](docs/contracts.md) before implementing a lane. Runtime schemas and types live in `src/shared/contracts.ts`; SQL invariants are in `src/server/migrations/`. Employer identity resolution and queue dispatch begin in P2. A captured job has a nullable canonical employer ID until resolved; it cannot enter a live application flow in P1.

## P2 status

P2 core lanes are merged on fixtures: employer identity, history import and cap (002–004), eligibility (005), answer bank (006), outreach (010–012) and the pilot report (013a). Lane notes are in `docs/p2/`; cross-lane policies (one open ticket per job, merges, Defer, queue → eligibility hand-off) are in [docs/p2/integration.md](docs/p2/integration.md). Live application flows (007–009) and live-credential checks are still pending.
````
