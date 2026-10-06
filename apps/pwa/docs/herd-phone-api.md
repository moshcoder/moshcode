# The herd on a phone: `/m` and `/api/herd/*`

PRD 0020, phase 1. The same API the phone app uses; nothing private.

## Pairing

On the box running the agents, signed in to the same account:

```sh
moshcode herd phone on       # installs the relay as a user service (systemd / launchd)
moshcode herd phone status   # running? as which machine?
moshcode herd phone off
moshcode herd relay          # the same process in the foreground
```

The box dials out. Nothing listens on it.

## Box side (Bearer API key, the CLI login token)

| Method | Path | Body / query | Answer |
|---|---|---|---|
| POST | `/api/herd/roster` | `{machine:{id,name,platform,version}, sessions:[{name,engine,state,blockedOn,confidence,cwd,kind,lastLines,since,blockedAt,approval}]}` | `{ok, machine, watching:[names]}` |
| GET | `/api/herd/commands?machine=<id>` | long-poll, 25 s | `{commands:[{id,session,kind,args}]}` (each claimed once) |
| POST | `/api/herd/commands/:id` | `{ok, stale?, error?}` | `{ok}` |
| POST | `/api/herd/screen` | `{machine, session, screen}` | `{ok, watching}`; stop streaming when `watching` is false |

`machine.id` is the box's own id (`~/.moshcode/herd/machine-id`). The server scopes
it to the account, so two accounts on one box are two machines.

A push goes out on a transition **into** `blocked` (a new `blockedAt` counts as a
new one) or from `working`/`blocked` into `done`, never on a machine's first
publish. The push carries no screen text.

## Phone side (cookie session)

| Method | Path | Notes |
|---|---|---|
| GET | `/m` | the app (`public/herd/`); signed out, redirects to sign-in and back |
| GET | `/api/herd` | `{machines:[{id,name,online,lastSeen,sessions:[…]}], csrf}` |
| GET | `/api/herd/stream` | SSE: `{type:"roster"}`, `{type:"result",…}` |
| GET | `/api/herd/pane/stream?machine=&session=` | SSE: `{type:"screen", screen}`; asks the relay to stream |
| POST | `/api/herd/command` | header `x-csrf-token`; `{machine, session, kind, args}`; waits up to 8 s for the relay |
| GET | `/api/herd/command/:id` | status of one command |

Commands:

- `approve` `{intent: "allow"|"allowAll"|"deny", blockedAt}`. The relay re-reads the
  screen and refuses with `stale` unless the same blocked spell is still showing the
  engine's permission dialog at the bottom of the screen. Keys per engine live in
  `src/engines.mjs` (`approve`), with fixture screens in `test/fixtures/approve/`.
- `prompt` `{text}` types the text and presses Enter.
- `keys` `{keys:[…]}` sends key-bar names only: `esc tab shift-tab up down left right enter ctrl-c ctrl-d slash backspace y n 1 2 3`.

## Push buttons

`POST /api/herd/act {token, intent: "allow"|"deny"}` needs no cookie. The token is a
one-time capability minted for one blocked spell and delivered only inside the push.
The first tap spends it; a second tap, or a token for a session that moved on, is
`410 {stale:true}`.
