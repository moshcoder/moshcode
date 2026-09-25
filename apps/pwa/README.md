# app.moshcode.sh — the moshcode PWA 🤘

Human-in-the-loop **approvals** + **usage credits** for your [moshscript](../../prd/0004-moshscript-run-programmable-moshcode.md) loops.

When an unattended `.mosh` script calls `ask("ship v2?")`, the moshcode CLI posts
an approval here. This app pings you (email / SMS / Slack / Telegram / push) with
a link to `/approve/:id`, you read the context and reply, and the script resumes
from your answer. Paid channels are metered against prepaid credits topped up via
CoinPay.

Zero-framework: **Express + Postgres** (via [`@profullstack/libsql-pg`](https://github.com/profullstack/libsql-pg);
a local SQLite file for development), server-rendered, punk/metal brand. Auth via **email/password**, **passkey (WebAuthn)**, or **CoinPay**.

## Run locally

```sh
cp .env.example .env      # then fill in secrets (or pull from Doppler)
npm install
DATABASE_URL=file:./data/local.db npm run migrate
DATABASE_URL=file:./data/local.db npm run dev
# → http://localhost:8080
```

Secrets live in **Doppler** (`moshcode` project) for real envs. With the Doppler
CLI: `doppler run -- npm start`.

## Database

`DATABASE_URL` is either a `postgres://` URL (production: the shared cluster on
dev2, `?sslmode=require`) or a `file:` path (development, tests). The client is
`@profullstack/libsql-pg`, which keeps the `@libsql/client` surface this code
was written against and rewrites the remaining SQLite idioms per statement.
A `libsql://` (Turso) URL is refused at boot: the data moved off Turso on
2026-09-25, and `DATABASE_AUTH_TOKEN` is no longer read.

Migrations run at boot (`src/migrate.mjs`). They live in two directories with
identical file names, `src/migrations/` (SQLite) and `src/migrations-pg/`
(Postgres, converted with `npx libsql-pg convert-schema` and reviewed); a new
migration is written to both. The ledger `_migrations` is keyed by file name.

To run the test suite against a real Postgres as well as the SQLite files, point
`PG_TEST_ADMIN_URL` at a server where the runner may `CREATE DATABASE` (a local
`postgres:17-alpine` container will do; one throwaway database per test process):

```sh
PG_TEST_ADMIN_URL="$LOCAL_POSTGRES_URL" node --import ./scripts/pg-test-preload.mjs --test
```

## Deploy (dev2)

- `.github/workflows/deploy-dev2.yml` ships every merge to dev2; the root
  `Dockerfile` installs `apps/pwa`'s dependencies and runs `src/server.mjs`,
  which applies migrations then boots.
- Env (rendered into `app.env` on dev2 from the vault): `DATABASE_URL`
  (postgres://), `SESSION_SECRET`, `MOSHCODE_WEBHOOK_SECRET`, `RESEND_API_KEY`,
  `PUBLIC_ORIGIN=https://app.moshcode.sh`, `MCP_PUBLIC_ORIGIN=https://moshcode.sh`,
  and the `COINPAY_*` values.
- `ADMIN_EMAILS`: comma-separated account emails allowed to call `/api/admin/*`
  (the operator user export behind `moshcode export users`). Unset means
  nobody: every admin route answers 403.
- Point the domain **app.moshcode.sh** at the service. Root `moshcode.sh` stays a
  marketing site, but must proxy `/.well-known/oauth-*`, `/oauth/*`, `/device`,
  and `/api/v1/mcp/*` to this service so canonical MCP URLs work at the apex.

## Routes

| route | who | what |
|---|---|---|
| `GET /` | anyone | sign in / create account (email·pw, passkey, CoinPay) |
| `GET /app` | user | approvals dashboard + credits |
| `GET /settings` | user | channels, API keys, buy credits |
| `POST /api/approvals` | CLI (Bearer key) | ingest an approval → fan out + charge |
| `GET /api/approvals/:id` | CLI / cap token | poll status + response |
| `GET/POST /approve/:id` | human (session or `?t=cap`) | read context, submit reply |
| `POST /api/v1/mcp/shares` | CLI (Bearer key) | create an expiring share for one live session |
| `POST /api/v1/mcp/:shareId` | MCP client (OAuth Bearer) | Streamable HTTP MCP session tools |
| `GET/POST /oauth/authorize` | user | authorize one MCP client, share, and scope set |
| `POST /oauth/device_authorization` | MCP client | begin RFC 8628 device authorization |
| `POST /webhooks/coinpay` | CoinPay | confirm a top-up → credit balance |
| `GET /api/admin/users/export?format=csv\|json` | operator (Bearer key or session, `ADMIN_EMAILS`) | every account with an email: email, display_name, created_at, id, signup_method; counts of the rest |
| `GET /healthz` | Railway | health check |

## Wiring the CLI

In `~/.moshrc` (or the env), point the moshcode CLI at the app and give it a key
from **Settings → API keys**:

```sh
export MOSHCODE_API=https://app.moshcode.sh
export MOSHCODE_API_KEY=mck_...        # sent as Authorization: Bearer
```

## Organizations, teams, and shared sessions

Open **Teams** in the app to create an organization, then a team. Add people by
the email on their existing moshcode account. Membership defaults to `read`;
`writer` can send terminal input, `admin` can manage membership within its
organization or team, and `owner` can also change ownership. At least one owner
must remain. Organization admins and owners inherit access to their teams;
other organization members only access teams they have joined.

A session stays private until its owner opens **Share this session with a team**
on the session page. Teammates then see it in **Sessions** and on the team page.
They watch the same output and writers use the same command queue as the owner.
Only the owner's CLI key can publish output, claim commands, or end the session.
Removing access closes the shared stream on its next event or heartbeat, and
queued input from a removed or downgraded writer is cancelled before claim.

The same operations accept CLI API keys as Bearer tokens:

| Endpoint | Action |
| --- | --- |
| `GET/POST /api/organizations` | List or create your organizations |
| `GET /api/organizations/:id` | Organization and accessible teams |
| `POST /api/organizations/:id/teams` | Create a team (`name`) |
| `GET /api/teams/:id` | Team members and shared sessions |
| `POST /api/teams/:id/members` | Add an existing account (`email`, optional `role`) |
| `POST /api/teams/:id/members/:userId` | Change `role`, or set `remove: true` |
| `POST /api/organizations/:id/members/:userId` | Change organization role or remove a member |
| `GET /api/sessions` | Your sessions and sessions shared with your teams |
| `POST /api/sessions/:id/teams` | Share with `teamId`, or set `remove: true` to stop |

## Status / TODO

Scaffold is functional end-to-end (register → API key → `ask()` ingest → approve
→ poll resolves → credits debit). Next:
- SMS / Slack / Telegram delivery providers (email via Resend is wired — needs a
  verified `moshcode.sh` sender domain in Resend).
- CoinPay OAuth client id + payments business id (routes are wired, awaiting creds).
- Web push subscriptions for the PWA.
- The CLI change to send `Authorization: Bearer` + target `MOSHCODE_API`.
