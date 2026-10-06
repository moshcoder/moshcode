---
openprd: "0.2"
id: "0020"
title: "The herd in your pocket: first-class mobile for moshcode, with no SSH, no Tailscale and no app-store wait"
status: Draft
authors:
  - anthony@profullstack.com
created: 2026-10-06
updated: 2026-10-06
repo: https://github.com/moshcoder/moshcode
discussion:
implementation: apps/pwa/src/routes/herd.mjs (new), apps/pwa/public/m/ (new), src/herd-relay.mjs (new), src/transcript.mjs (full reader), src/engines.mjs (approval keys), src/herd-cli.mjs (watch → relay), apps/pwa/public/sw.js, apps/pwa/public/manifest.webmanifest
tags: [mobile, pwa, herd, push, approvals, transcript, relay, share]
supersedes:
superseded-by:
---

## Problem

The way people run coding agents has changed. Nobody sits watching Claude Code
any more. They start four agents, walk away, and come back when one is stuck.
The point where the human is actually needed is a permission prompt or a
question, and it arrives while they are on the couch, on the train or in a
meeting. Whoever owns that moment owns the user.

[Melta](https://getmelta.app/#features) is built entirely around it. It is a
free iOS and Android app (waitlist only, as of 2026-10-06) that SSHes from the
phone into a box running Herdr, an agent multiplexer, and gives you:

| Melta feature | What it does |
|---|---|
| Panes across computers | One list of every agent pane on every saved machine |
| Chat view | Claude Code and Codex rendered as a conversation, including every edit and command, read from the agent's own session log |
| Tap approvals | Allow, Deny, or "Yes, allow all edits during this session" |
| Push | Sent when an agent is blocked or finished: the pane name plus the last lines of its screen |
| Terminal view | Full-screen terminal per pane, a reorderable key bar, one-tap prefix |
| Slash menu | `/model`, `/compact`, `/clear`, `/cost` |
| Jump To / Last pane | Search every pane on every machine; swap between the two most recent panes |
| Share | A read-only link to one agent conversation |
| Setup | Tailscale on the phone, plus `curl …/setup.sh \| sh -s -- --tailscale --key … --token …` |

**moshcode already has most of this engine, but none of the experience.**
The herd (PRD 0009, 0011) is our Herdr. It is tmux-backed. Claude Code hooks
give it `working`, `blocked` (`permission` / `question` / `menu`) and `done`
states, with screen rules as the fallback (`src/herd-state.mjs`).
`herd watch` already builds the exact payload Melta pushes: session name,
state, what it is blocked on, and the last 12 screen lines
(`src/herd-cli.mjs` `deliver`). app.moshcode.sh already has VAPID Web Push, passkeys, an
xterm.js session mirror over SSE with key input (`routes/sessions.mjs`), and
approvals with a text reply (`routes/approvals.mjs`).

What we lack is the phone *product*:

- **There is no roster.** You cannot see your herd from the phone, only
  individual mirrored sessions and individual approvals.
- **Approvals are generic.** "Approve & continue" types text. A Claude
  permission prompt needs `1` / `2` / `Esc`, and we never send them.
- **There is no chat view.** `readClaude` in `src/transcript.mjs` keeps text
  blocks and throws away `tool_use` and `tool_result`. Those are exactly the
  edits and commands someone on a phone wants to see before tapping Allow.
- **The terminal is a desktop terminal on a small screen.** There is no key
  bar, so no way to send Esc, Tab, arrows or Ctrl-C from a phone keyboard.
- **There are no public share links.** Sharing today is team-only.
- **No one would know it exists.** The manifest says "approvals". The site
  never says "phone".

## Why this is an extension, not a pivot

Melta is a thin client over someone else's runtime (Herdr). moshcode *is* the
runtime: engines, herd, swarm, cost and handoffs. A phone surface does not
change what moshcode is. It changes who can reach it, and when.
The Fleet SysOps Manifesto already says every build ships TUI + CLI + MCP + API.
This PRD adds **mobile** to that list for moshcode, as a first-class surface
held to the same standard: anything the herd can do, the phone can do.

We get to beat Melta on its own weakest point, which is setup:

| | Melta | moshcode mobile |
|---|---|---|
| Reach the box | SSH from the phone; Tailscale recommended | The box dials **out** to app.moshcode.sh (the mirror already works this way). No inbound port, no VPN, no SSH key on the phone |
| Install | Waitlist, then the stores | Installable PWA today; a store wrapper later |
| Login | Account + SSH key per machine | The passkey you already have on app.moshcode.sh |
| Setup on the box | curl a setup.sh with flags | `moshcode herd phone on` (one verb, nothing else to do) |
| Agents | Claude Code + Codex chat; everything else is terminal only | Chat view for every engine `transcript.mjs` reads (Claude, Codex, opencode, mimo); terminal for the rest |

The honest trade is that our default path goes **through our relay**. Melta's
headline is "no relay server". We answer that two ways (see Security): end-to-end
encryption of relay payloads, and an optional direct mode over `herd serve`
for anyone who already runs Tailscale.

## Goals

1. From a phone, a user sees every herd session on every machine they have
   paired, with live state, in under 2 seconds from opening the app.
2. A blocked Claude Code permission prompt can be resolved with one tap,
   starting from the push notification itself.
3. The chat view shows the edits and commands an agent made, not just its prose.
4. Pairing a machine takes one command and zero manual steps, in line with
   no-manual-setup-steps.
5. It works with no inbound connectivity to the box: no Tailscale, no port
   forward, no SSH.

## Non-goals

- A native SSH client. We are not building Termius.
- Running agents *on* the phone.
- Replacing the desktop TUI. The phone is for steering, not for long work.
- A native app in phase 1. Native is phase 4, and only if PWA push or
  backgrounding on iOS proves insufficient.

## Design

### 1. The relay channel (`src/herd-relay.mjs`)

`moshcode herd phone on` installs a user systemd unit (launchd on macOS)
running `moshcode herd relay`. It is the same long-lived process as `herd watch`,
plus three things:

- **Roster publish.** On every state transition, and every 30 s as a
  heartbeat, it POSTs `{machine, sessions:[{name, engine, state, blockedOn,
  confidence, cwd, lastLines, updatedAt}]}` to `POST /api/herd/roster`.
  Machine identity is `user@host` plus a stable machine id written on first
  run.
- **Command pull.** It long-polls `GET /api/herd/commands?machine=…`, the same
  pattern the session mirror already uses. Commands are `approve`, `deny`,
  `approve-all`, `prompt`, `keys`, `slash` and `open-stream`. Each one maps onto
  an existing herd verb (`herd send-keys`, `herd prompt`), so the relay adds
  no new pty code.
- **On-demand streams.** `open-stream` starts the existing mirror
  (`src/mirror.mjs`) for one session, plus a transcript tail (see §3). The
  stream stops 60 s after the phone stops reading. Nothing streams unless a
  phone is looking.

Auth reuses the CLI login token (device-code flow, `routes/cli.mjs`). Every
request is scoped to the token's user, and a machine can only publish into its
owner's roster.

### 2. Engine-aware approvals (`src/engines.mjs`)

Each engine gains an `approve` block. It maps the intent to the keys that
engine's current prompt needs:

```js
claude: { approve: { allow: ['1'], allowAll: ['2'], deny: ['Escape'] } }
codex:  { approve: { allow: ['y'], allowAll: ['a'], deny: ['n'] } }
```

Before sending, the relay re-captures the screen and re-runs `classify`. If the
session is no longer `blocked:permission`, it refuses with `stale`, and the
phone shows "already answered". This prevents a late tap from typing `1` into
whatever came next. Key maps are covered by fixture screens in
`test/fixtures/`, one per engine release we have seen, so a prompt change fails CI
rather than failing silently on a phone.

The push notification carries action buttons (`Allow`, `Deny`) through the
Web Push `actions` field. `sw.js` handles `notificationclick` with an action,
POSTs the command and never opens the app. On platforms without action
buttons (iOS Safari PWA), tapping opens straight onto the approval sheet.

### 3. The chat view (`src/transcript.mjs`)

Add `readSession(id, { full: true })`. It returns typed events:

```
{ kind: 'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result' | 'edit' | 'command', ... }
```

- `edit` is derived from Claude `Edit` / `Write` / `MultiEdit` tool uses and
  carries `{path, before, after}`, so the phone can render a compact diff.
- `command` is derived from `Bash` tool uses and carries `{cmd, exitCode, output}`, with
  the output truncated to 4 KB and expandable on demand.
- Codex (`rollout-*.jsonl`) and opencode map onto the same kinds.

The existing text-only reader stays the default, because handoffs and cost
depend on it. The relay tails the JSONL by byte offset and ships only new
events. Each pane remembers whether it was last viewed as chat or as terminal.

### 4. The phone UI (`apps/pwa/public/m/`, served at `app.moshcode.sh/m`)

The UI is plain ES modules plus xterm.js, already a dependency. There is no
framework.

- **Herd** (home): sessions grouped by machine. A state chip
  (`blocked` sorts first and is red, `working` pulses, `done` is muted), then the
  engine, cwd basename and last line. Pull to refresh; SSE keeps it live.
- **Jump**: a fuzzy search over `machine/session/cwd`, opened from a header button.
  Swiping right on the header goes to the last pane.
- **Pane**: a Chat ⇄ Terminal toggle.
  - *Chat*: the events from §3, with a composer at the bottom. A blocked
    permission pins an approval card above the composer, offering **Allow**,
    **Allow all this session** and **Deny**.
  - *Terminal*: the xterm mirror with a key bar showing `Esc` `Tab` `Ctrl` `↑` `↓`
    `←` `→` `⏎` `^C` and `/`. The bar can be reordered; the order is
    stored per user server-side, using synconfig.
  - The slash menu reads the engine's command list from `engines.mjs`
    (`/model /compact /clear /cost` for Claude, and each engine's own set).
- **Share**: on a chat, `Share read-only` creates a snapshot. See §5.
- **Machines**: lists paired machines with last-seen times, and shows "Pair a machine", which displays
  the one command.

`manifest.webmanifest` is renamed from "moshcode approvals" to "moshcode" and
`start_url` becomes `/m`. The landing page gets an "On your phone" section.

### 5. Share links

`POST /api/herd/share` freezes the current transcript events for one session
into a row: `{id, user, events, created, expires (default 7 d), revoked}`.
`GET /s/:id` renders it read-only, with no auth. Before storing, events pass
through the same secret redaction pass handoffs use. Every share is listed under
Machines → Shares with a revoke button. A share is a snapshot, never a live
link to the box.

### 6. Security

- **E2E relay payloads (phase 2).** When a phone first opens `/m`, it
  generates an X25519 keypair. The private key stays in IndexedDB, as a
  non-extractable WebCrypto key. Pairing a machine exchanges public keys
  through the authenticated account, and the user confirms a 6-digit code
  shown on both sides.
- After pairing, `lastLines`, transcript events and terminal bytes are sealed
  to the phone's key. app.moshcode.sh routes ciphertext and sees only
  `{machine, session, state, blockedOn, timestamps}`, which is enough to send a
  push that says *"api is blocked on a permission"* without knowing what it is.
- Push bodies containing screen text are opt-in, because they leave our
  control via Apple and Google.
- **Direct mode.** `moshcode herd phone on --direct` skips the relay. The
  phone talks to `herd serve` on a Tailscale IP. This needs `herd serve` to gain
  an SSE endpoint (`/events`), which A2A streaming already describes. It is
  for users who will not route through us.
- Approve commands are idempotent, carry the `blockedAt` timestamp they
  answer, and are refused if stale (§2).

### 7. CLI, MCP and API surfaces

The manifesto requires every surface:

- **CLI**:
  - `moshcode herd phone on|off|status` installs or removes the relay unit.
  - `moshcode herd phone pair` prints the pairing code.
  - `moshcode herd share <session>` prints a share URL.
- **MCP**: adds a `herd_share` tool to the existing herd tools, so an agent can
  hand a human a link to its own conversation.
- **API**: `/api/herd/*` is documented in `apps/pwa/docs/`. It is the same API
  the PWA uses, with nothing private.

## Phases

| Phase | Ships | Done when |
|---|---|---|
| **1. Roster + approvals** | herd-relay (roster + command pull), engine approve maps + stale guard, `/m` herd list + pane terminal with key bar, push with Allow/Deny actions, `herd phone on` | From an iPhone PWA and an Android Chrome PWA, a real blocked Claude permission is approved from the notification, with no Tailscale |
| **2. Chat view + E2E** | full transcript reader, chat UI, edit diffs, slash menu, Jump/Last pane, X25519 sealing | The chat for a live Claude and Codex session matches the TUI; the relay DB holds no plaintext screen text |
| **3. Share + direct mode** | `/s/:id`, redaction, revoke; `herd serve /events` + `--direct` | A share link opens logged-out; `--direct` works over Tailscale with the relay off |
| **4. Store wrapper (conditional)** | Capacitor shell around `/m` for App Store / Play: native push, Keychain/Keystore for the key, background reconnect | Only if phase 1 metrics show iOS PWA push delivery or retention falling short |

Each phase merges, releases and is promoted on its own, following the release
process and launch-announcements-via-myna.

## Success metrics

- The share of approvals resolved from a phone (from the `user_agent` on approve
  commands). Target: over 40% of all approvals within 30 days of phase 1.
- Median time from `blocked` to answered. Target: half of the pre-launch
  baseline. `herd tasks` already records both timestamps.
- Paired machines per active user. Target: over 1.5. This is the cross-machine roster
  being used.

## Open questions

1. **iOS Web Push action buttons.** Safari does not show `actions` today.
   Is a one-tap open into the approval sheet good enough, or is that the
   trigger for phase 4?
2. **Relay cost.** The roster heartbeat is cheap. Terminal streams are not.
   Do we cap concurrent streams on the free tier?
3. **Naming.** Do we keep it as `app.moshcode.sh/m`, or give it a vanity host
   (`m.moshcode.sh`) for the landing page and stores?
4. **Herdr compatibility.** Herdr users are Melta's base. A `herd` import, or
   a Herdr-compatible plugin, would let them try moshcode mobile without
   switching runtimes. Is that worth it?
