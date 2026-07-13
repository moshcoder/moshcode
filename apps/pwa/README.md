# app.moshcode.sh — the moshcode PWA 🤘

Human-in-the-loop **approvals** + **usage credits** for your [moshscript](../../prd/0004-moshscript-run-programmable-moshcode.md) loops.

When an unattended `.mosh` script calls `ask("ship v2?")`, the moshcode CLI posts
an approval here. This app pings you (email / SMS / Slack / Telegram / push) with
a link to `/approve/:id`, you read the context and reply, and the script resumes
from your answer. Paid channels are metered against prepaid credits topped up via
CoinPay.

Zero-framework: **Express + libSQL (SQLite/Turso)**, server-rendered, punk/metal
brand. Auth via **email/password**, **passkey (WebAuthn)**, or **CoinPay**.

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

## Deploy (Railway + Turso)

- Service **root directory** = `apps/pwa`; Nixpacks builds it, `npm start` runs
  migrations then boots (`railway.json`).
- Set env from Doppler: `DATABASE_URL` + `DATABASE_AUTH_TOKEN` (Turso libSQL URL
  + token), `SESSION_SECRET`, `MOSHCODE_WEBHOOK_SECRET`, `RESEND_API_KEY`,
  `PUBLIC_ORIGIN=https://app.moshcode.sh`, and the `COINPAY_*` values.
- Point the domain **app.moshcode.sh** at the service. Root `moshcode.sh` stays a
  parked marketing site.

## Routes

| route | who | what |
|---|---|---|
| `GET /` | anyone | sign in / create account (email·pw, passkey, CoinPay) |
| `GET /app` | user | approvals dashboard + credits |
| `GET /settings` | user | channels, API keys, buy credits |
| `POST /api/approvals` | CLI (Bearer key) | ingest an approval → fan out + charge |
| `GET /api/approvals/:id` | CLI / cap token | poll status + response |
| `GET/POST /approve/:id` | human (session or `?t=cap`) | read context, submit reply |
| `POST /webhooks/coinpay` | CoinPay | confirm a top-up → credit balance |
| `GET /healthz` | Railway | health check |

## Wiring the CLI

In `~/.moshrc` (or the env), point the moshcode CLI at the app and give it a key
from **Settings → API keys**:

```sh
export MOSHCODE_API=https://app.moshcode.sh
export MOSHCODE_API_KEY=mck_...        # sent as Authorization: Bearer
```

## Status / TODO

Scaffold is functional end-to-end (register → API key → `ask()` ingest → approve
→ poll resolves → credits debit). Next:
- SMS / Slack / Telegram delivery providers (email via Resend is wired — needs a
  verified `moshcode.sh` sender domain in Resend).
- CoinPay OAuth client id + payments business id (routes are wired, awaiting creds).
- Web push subscriptions for the PWA.
- The CLI change to send `Authorization: Bearer` + target `MOSHCODE_API`.
