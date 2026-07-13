---
openprd: "0.2"
id: "0005"
title: moshcode.sh web app — PWA, auth, human-in-the-loop approvals, CoinPay usage credits
status: Draft
authors:
  - anthony@chovy.com
created: 2026-07-13
updated: 2026-07-13
repo: https://github.com/moshcoder/moshcoding
discussion:
implementation:
tags:
  - web
  - pwa
  - auth
  - billing
  - coinpay
  - credits
  - approvals
supersedes:
superseded-by:
---

## Problem

moshscript ([[0004-moshscript-run-programmable-moshcode]]) makes the moshcode CLI
scriptable and adds a human-in-the-loop gate: a running script calls `notify()` /
`ask()`, which pings the operator across their channels and links them to
`moshcode.sh/approve/:id`, where they read the context and submit instructions
that flow back into the waiting script. The CLI ships the *client* half of that
contract. Nothing serves the other half: there is no page to approve on, no inbox
to store approvals, no channel fan-out, no accounts, and no way to meter or pay
for the parts that cost real money (SMS, agent minutes, notifications).

moshcode.sh needs to be a proper web app — a PWA with auth and CoinPay
usage-based credits — matching how the other Profullstack projects are built, so
the approval loop is real and the paid surfaces (notifications, agent runs) are
metered and billable.

## Goals

- Serve the human-in-the-loop approval flow end to end: a shareable
  `moshcode.sh/approve/:id` page that shows the script's context and accepts a
  submitted response, and an inbox/API the CLI long-polls.
- Be an installable PWA (offline shell, home-screen install, push-capable) so an
  operator can approve from their phone.
- Authenticate operators and scope approvals + credits to their account.
- Fan a `notify()`/`ask()` event out to the operator's configured channels —
  email, SMS, Telegram, Slack, generic webhook.
- Meter the paid actions and charge them against a prepaid credit balance topped
  up via CoinPay (crypto + card), consistent with the other projects' billing.
- Never block the free/local path: scripts that don't touch paid channels keep
  working without an account.

## Non-Goals

- Building moshscript or the CLI (that is [[0004-moshscript-run-programmable-moshcode]]).
- A full team/RBAC org model in v1 (single-operator accounts first; teams later).
- Replacing CoinPayPortal — this app is a CoinPay *merchant/consumer*, not a new
  payment rail.
- Hosting or executing scripts server-side; scripts run on the developer's
  machine and only call out for notifications/approvals.
- A marketplace/sharing directory for scripts (possible later).

## Users

- The **operator** running unattended moshscript loops who wants to approve /
  redirect them from their phone while away from the machine.
- The **developer** wiring `notify()`/`ask()` into scripts and needing an account
  + credits to send SMS/Telegram and to run metered agent actions.
- **CI/cron** identities that authenticate non-interactively (API key/token) to
  create approvals and spend credits.

## Requirements

- R1 [P0] The app MUST be an installable PWA: web manifest, service worker with an
  offline app shell, home-screen install, and HTTPS — matching the standard
  Profullstack PWA setup.
- R2 [P0] Auth MUST scope every approval and credit balance to an account, with
  the same auth pattern used across the other projects (email/OAuth sign-in for
  humans; API key/token for CI/cron). Sessions MUST work in the PWA.
- R3 [P0] An approvals store MUST back the CLI contract from
  [[0004-moshscript-run-programmable-moshcode]] R15:
  - `POST` ingest (from the CLI's `notify`/`ask` delivery) creating an approval
    `{ id, message, context, status:"pending", owner }`.
  - `GET /api/approvals/:id` returning `{ status, response? }` for the CLI's
    long-poll (pending → submitted).
  - `GET /approve/:id` (on app.moshcode.sh) — the human page showing context + an
    input to submit a response; submitting sets `status:"submitted", response`.
- R4 [P0] Approvals MUST be owner-scoped: only the authenticated owner (or a
  holder of a per-approval capability token embedded in the link) may view/submit,
  so an approval URL is safe to receive over SMS/Slack.
- R5 [P0] Channel fan-out MUST deliver a `notify()`/`ask()` event to the operator's
  configured channels — email, SMS, Telegram, Slack, and generic webhook — each
  carrying the `moshcode.sh/approve/:id` link. Channels are per-account settings.
- R6 [P0] The PWA SHOULD support web push so an approval can arrive as a push
  notification, in addition to the external channels.
- R7 [P0] Billing MUST be prepaid **usage-based credits**: an account holds a
  credit balance; metered actions debit it; a zero/negative balance blocks paid
  actions (free/local actions continue). Every debit MUST be a ledgered entry.
- R8 [P0] Credits MUST be topped up via **CoinPay** (crypto + card) as a CoinPay
  merchant/consumer, mirroring the other projects' checkout: create a payment,
  redirect to the hosted pay page, and credit the balance on the confirmed
  webhook. No card/crypto handling lives in this app beyond CoinPay's flow.
- R9 [P0] The metered actions and their unit prices MUST be defined and shown
  before spend. Candidate meters: an `ask()`/`notify()` delivery (esp. SMS, which
  has real carrier cost), an approval retained/stored, and any server-assisted
  agent/notification minute. Free tier: web-push + email approvals up to a quota.
- R10 [P1] An account dashboard MUST show the credit balance, the ledger
  (top-ups + debits), pending/historical approvals, and channel settings.
- R11 [P1] A metering API MUST let the CLI (authenticated) check balance and
  record a debit atomically with creating an approval, so a script can fail fast
  when out of credits rather than sending an undeliverable ping.
- R12 [P1] Idempotency + signing: approval ingest MUST verify the CLI's signed
  webhook (the existing `x-moshcode-signature` scheme) and be idempotent on
  approval id, so retries don't double-charge or duplicate approvals.
- R13 [P0] The app is served at **app.moshcode.sh**; the root **moshcode.sh**
  stays a parked marketing site (easier for marketing) and is NOT touched. All
  approval links and APIs (`/approve/:id`, `/api/approvals/:id`) are on the app
  subdomain.
- R14 [P1] Deploy on **Railway** with **SQLite / Turso** as the datastore
  (libSQL). If a single Railway service holds the DB on a volume it MUST follow
  the usual one-volume-per-service constraint; Turso (hosted libSQL) avoids the
  volume entirely and is the likely default. Keep it a single service where
  possible.

## UX Notes

The loop, from the operator's phone:

```
1. Script (unattended):  ask("deploy v2 to prod?")
2. moshcode.sh fans out: 📱 SMS + Slack: "moshcode needs you → moshcode.sh/approve/ab12"
3. Operator taps link → PWA (already signed in) shows the context + an input box
4. Types "yes, and bump the version tag", hits Submit
5. moshcode.sh marks the approval submitted; the script's ask() resolves with the text
6. Script continues:     code(reply); mosh(); repeat();
```

Billing is prepaid and boring: a balance + a **Buy credits** button that runs the
standard CoinPay checkout; a ledger lists top-ups and per-action debits. SMS
sends cost more credits than email/web-push (they cost us more). Running purely
local scripts (no paid channel, no server approval) needs no account or credits.

## Success Metrics

- A `.mosh` `ask()` on one machine resolves from a phone approval on another,
  end to end, through the deployed app.
- The PWA installs to a phone home screen and can receive/approve while the
  developer is away from the machine.
- A CoinPay top-up increments the credit balance via the confirmed webhook, and a
  metered `ask()` over SMS debits the ledger by the published unit price.
- Paid actions are refused (clearly) at a zero balance; free actions still work.

## Risks & Open Questions

- **What exactly is metered, and at what price?** SMS/Telegram have real per-message
  cost and are the obvious meters; whether to also meter approvals-at-rest or any
  "agent minute" needs a pricing pass. Over-metering kills the free-feeling local
  loop that makes moshscript fun.
- **Link capability vs. login.** An approval link sent over SMS must be usable
  without a full login on the phone, yet not world-approvable. A per-approval
  capability token in the URL (short-lived) vs. requiring PWA session is a
  security/UX trade-off to decide.
- **Which repo/stack.** moshcoding.com already exists (Express app); this may
  extend it or be a fresh PWA. Reuse of the existing auth/CoinPay wiring from
  sibling projects should be maximized rather than rebuilt.
- **Long-poll vs. push/websocket** for the CLI waiting on `ask()`: v1 long-polls
  `GET /api/approvals/:id`; a push/websocket upgrade reduces latency and cost but
  is deferred.
- **Abuse/cost control.** Unauthenticated or runaway scripts spamming SMS could
  burn money; rate limits + the prepaid-credit gate are the primary defenses and
  MUST be in from day one.
- **CoinPay account.** Requires a CoinPay business/merchant for moshcode with
  wallets/card configured, like the other projects — a setup dependency before
  real top-ups work.
