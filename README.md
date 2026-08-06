# moshcode 🤘

A metal wrapper CLI for agentic coding. moshcode doesn't reinvent the agent — it
**installs and drives** existing ones (opencode, Claude Code, codex) and adds a
tiny scripting toolkit (moshscript) on top. It also conducts adjacent native
workflow tools for finding work and getting paid.

## Install

```sh
curl -fsSL https://moshcoding.com/install.sh | sh
```

Zero-dependency ESM — all it needs is Node.js 18+. Later: `… | sh -s -- update`
to upgrade, `… | sh -s -- remove` to uninstall.

## Commands

`moshcode help <command>` drills into any of these — flags, examples and all.
`moshcode help --json` is the same thing for a machine.

This table is generated from the command table the CLI itself dispatches from
(`moshcode help --markdown`), so it cannot describe a verb that does not exist
or miss one that does. A test fails the build when it drifts.

<!-- COMMANDS:START -->
| command | group | what it does |
|---|---|---|
| `moshcode agents` | engines | list engines or launch one autonomously |
| `moshcode start` | engines | launch an engine with its native defaults |
| `moshcode install` | engines | install an engine or workflow tool |
| `moshcode uninstall` <br>`remove` | engines | take an engine or workflow tool off this machine |
| `moshcode upgrade` <br>`update` | engines | update moshcode, engines, or tools |
| `moshcode mcp` | extend | register and inspect MCP servers |
| `moshcode skill` <br>`skills` | extend | install and inspect agent skills |
| `moshcode prd` | script | publish or list product requirement documents |
| `moshcode login` | account | authenticate with app.moshcode.sh |
| `moshcode whoami` | account | show the logged-in account |
| `moshcode logout` | account | clear the logged-in account |
| `moshcode console` | account | serve or connect to the browser terminal |
| `moshcode dns` | hosting | resolve Moshpit names on this machine |
| `moshcode doh` | hosting | run the DNS-over-HTTPS resolver |
| `moshcode site` <br>`serve` | hosting | install web-server config for a Moshpit name |
| `moshcode template` <br>`templates` | hosting | scaffold a stack for a Moshpit-hosted service |
| `moshcode pwd` <br>`where` | system | show the current directory and git context |
| `moshcode engines` | engines | list engines and installation status |
| `moshcode tools` | tools | list workflow tools and installation status |
| `moshcode trade` | tools | look up markets and trade through Alpaca |
| `moshcode commands` | script | list built-in moshscript commands |
| `moshcode completion` | extend | print a shell completion script |
| `moshcode run` | script | run a moshscript |
| `moshcode help` <br>`--help` `-h` | system | show command help |
| `moshcode version` <br>`--version` `-v` | system | show the installed version |
<!-- COMMANDS:END -->

## Engines

```sh
moshcode engines            # list installable engines
moshcode engines --json     # machine-readable install status for automation
moshcode install opencode   # install opencode (curl … | bash)
moshcode install privacycode # curl -fsSL https://getprivacycode.com/install | sh
moshcode install claude     # npm i -g @anthropic-ai/claude-code
moshcode install codex      # npm i -g @openai/codex
moshcode install kimi       # curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
moshcode install qwen       # npm i -g @qwen-code/qwen-code
moshcode install deepseek   # npm i -g @serjm/deepseek-code
```

### Autonomous agents versus raw starts

`agents` opens the engine's native **agent view** when it has one, so you land on
your agent list. Engines without an agents view instead start an autonomous
session by injecting the engine's native bypass or auto-approval mode. Either way,
use this only in an isolated container, VM, or workspace you trust:

```sh
moshcode agents claude      # claude agents --dangerously-skip-permissions  (agent view)
moshcode agents opencode    # opencode --auto                              (autonomous)
moshcode agents privacycode # privacycode --auto                           (autonomous)
moshcode agents codex       # codex --dangerously-bypass-approvals-and-sandbox  (autonomous)
moshcode agents gemini      # gemini --approval-mode=yolo                       (autonomous)
moshcode agents kimi        # kimi --yolo                                       (autonomous)
moshcode agents qwen        # qwen --approval-mode=yolo                         (autonomous)
moshcode agents deepseek    # deepseek-code --turbo                             (autonomous)
moshcode agents aider       # aider --yes-always                                (autonomous)
```

`start` is the explicit raw path. It injects nothing, so the native engine keeps
its normal permission model and receives only your arguments:

```sh
moshcode start claude
moshcode start codex --sandbox workspace-write
```

Bare engine commands remain raw for backward compatibility, so `moshcode claude`
is shorthand for `moshcode start claude`. In the TUI, use `/agents <engine>` for
autonomous mode or `/start <engine>` for raw mode. Running `moshcode agents` or
`/agents` without an engine still lists engines and their install status.

### Parallel pit tabs

At the mosh prompt, `/new` opens and switches to another independent moshcode
tab. Run `/agents <engine>` in each tab and switch between them with tmux's
`Ctrl-b n`, `Ctrl-b p`, or `Ctrl-b <number>` keys. If moshcode is already inside
tmux, `/new` adds a window to that session and respects its configured window
keys. Otherwise the first `/new` opens an isolated two-tab workspace with those
default keys and its tab bar at the bottom.

Each tab is a separate moshcode process and provider CLIs still receive an
ordinary inherited terminal. Moshcode does not intercept or reinterpret their
input, output, full-screen UI, or provider-specific shortcuts. The feature
requires `tmux`; without it `/new` reports that requirement and leaves the
current pit untouched.

The modes are not identical across providers. In particular, OpenCode `--auto`
auto-approves permission requests but continues to enforce explicit deny rules.

## Workflow tools: UGig, CoinPay, and the cloud CLIs

These remain independent native CLIs with their own authentication,
configuration, command trees, output formats, and release cycles. MoshCode
installs them and passes control through without reimplementing their APIs.

The primary development toolchain runs through `moshcode` as a
[dev.profullstack.com](https://dev.profullstack.com/) user.

```sh
moshcode tools                    # list tools and native install status
moshcode tools --json             # machine-readable install status for automation
moshcode install ugig             # runs the vendor's official install script
moshcode install coinpay          # same — each tool owns its installer

moshcode ugig --json gigs list    # arguments/output go straight to ugig
moshcode coinpay wallet balance   # arguments/output go straight to coinpay
```

### Cloud + infra CLIs

```sh
moshcode install railway          # npm i -g @railway/cli
moshcode install gh               # GitHub release binary → ~/.local/bin
moshcode install supabase         # GitHub release binary (no global npm package exists)
moshcode install doppler          # official script, installed user-local (needs gpgv)
moshcode install doctl            # GitHub release binary → ~/.local/bin
moshcode install turso            # official script → ~/.turso (new shell to pick up PATH)
moshcode install tailscale        # official script; system daemon, so it needs root

moshcode gh pr list               # straight through to the native CLI
moshcode railway up
moshcode doctl compute droplet list
```

`gh`, `supabase`, and `doctl` publish no cross-platform install script, so
MoshCode resolves the latest GitHub release and drops the binary in
`$MOSHCODE_BIN` (default `~/.local/bin`) — no sudo, no package manager. Set
`MOSHCODE_BIN` to install elsewhere.

`tailscale` is the exception: it is a system daemon, so its official installer
goes through your distro's package manager and will ask for sudo (on macOS it
delegates to the App Store).

Top-level passthrough preserves stdin, stdout, stderr, environment variables,
the current directory, and the native exit result. That keeps JSON pipelines
usable:

```sh
moshcode ugig --json gigs list | jq .
```

Run `moshcode ugig --help` or `moshcode coinpay --help` for each tool's current
native setup and authentication commands. CoinPay currently requires Node.js
20+, while MoshCode itself remains compatible with Node.js 18+.

In the TUI, use `/tools`, `/ugig [args…]`, or `/coinpay [args…]`. The native CLI
owns the terminal until it exits, then MoshCode returns to the pit.

### Alpaca trading

Alpaca is a workflow tool, not a coding engine. Install its official Go CLI,
use `alpaca` for exact native passthrough, or use `trade` for the shorter market
and order vocabulary:

```sh
moshcode install alpaca            # go install github.com/alpacahq/cli/cmd/alpaca@latest
moshcode trade login               # Alpaca profile login; paper trading is the default
moshcode trade ticker AAPL         # asset get --symbol-or-asset-id AAPL
moshcode trade quote AAPL          # latest quote
moshcode trade analysis AAPL       # quote/trade/bar snapshot for analysis
moshcode trade watch               # list watchlists
moshcode trade positions           # list open positions
moshcode trade orders              # list open orders
```

`buy` and `sell` are safe previews unless `--submit` is explicit. Other Alpaca
order flags pass through, including limit prices and its separate live-trading
opt-in:

```sh
moshcode trade buy AAPL 1                          # adds --type market --dry-run
moshcode trade buy AAPL 1 --type limit --limit-price 185
moshcode trade buy AAPL --notional 100              # preview a $100 market buy
moshcode trade buy AAPL 1 --submit                 # places the paper order
moshcode trade raw data news --symbol AAPL         # any native Alpaca command
moshcode alpaca order submit --help                # exact native passthrough
```

The same facade is `/trade …` in the pit and `trade(…)` in moshscript.
Alpaca's CLI has no confirmation prompts; `--submit` intentionally removes
MoshCode's preview guard. Live trading additionally requires Alpaca's `--live`
opt-in or corresponding environment setting.

## Browser terminal (`moshcode console`)

A real terminal in the browser — arrow keys, history, full-screen TUIs — because
the thing on the other end is a real pty, not a log view. moshcode does not
implement the terminal: [ttyd](https://github.com/tsl0922/ttyd) does, and
moshcode puts an authenticating proxy in front of it so your `moshcode login` is
the way in.

Two processes on the box you want a shell on:

```sh
# 1. ttyd — bound to loopback ONLY. It must never be reachable directly.
ttyd -i 127.0.0.1 -p 7681 -W login

# 2. the gateway — verifies moshcode tokens, then proxies to ttyd
moshcode console serve --port 7682 --ttyd 127.0.0.1:7681
```

Then, from any machine where you have run `moshcode login`:

```sh
moshcode console --url https://dev.example.com/    # prints an authenticated URL
```

The token is verified once against `app.moshcode.sh/api/me`, swapped for a
short-lived HMAC cookie, and stripped from the URL by the redirect, so it does
not sit in browser history or travel with every request. The websocket carrying
the terminal is authenticated too — an unauthenticated upgrade is refused before
it reaches ttyd.

**This is a shell on the internet.** Treat it accordingly:

- Keep ttyd on `127.0.0.1`. The gateway is the only thing that should reach it.
- `--bind` defaults to `127.0.0.1`. Put the gateway on a **tailnet address**
  (`moshcode install tailscale`) or behind a reverse proxy with TLS. Binding
  `0.0.0.0` publishes a login prompt to the whole internet, and moshcode warns
  when you do it.
- The gateway's signing secret is per-process, so restarting it logs everyone out.

## MCP and Agent Skills

See which installed engines can handle MCP servers or Agent Skills. Add
`--json` when another tool needs the capability matrix:

```sh
moshcode mcp list --json
moshcode skill list --json
```

Each row reports `installed` and `supported` separately, so an installed engine
without that integration primitive remains visible rather than looking absent.

### Known MCP servers

Some MCP servers are worth remembering by name rather than by npx invocation:

```sh
moshcode mcp catalog              # what we know how to run
moshcode mcp add porkbun          # expands to: npx -y @porkbunllc/mcp-server
```

That registers it across every engine that supports MCP (claude, gemini, codex,
opencode, privacycode) in one go. Kimi is skipped with a reason: it runs MCP
servers but has no command to register one from a script — add those in-session
with its own `/mcp-config`, or in `~/.kimi-code/mcp.json`.

The catalog is a convenience, never a gate — an explicit command always wins, so
`moshcode mcp add porkbun -- node ./my-fork.js` runs your fork.

**Credentials are named, not registered.** `porkbun` needs `PORKBUN_API_KEY` and
`PORKBUN_SECRET_API_KEY`; moshcode prints which are missing rather than copying
them into five engines' config files, which would be five places to leak them
from and five to rotate. Porkbun's API access is off by default and enabled
per-domain — and its documentation tools work with no keys at all, which is a
sensible way to try the server before trusting it with DNS writes.

## Upgrade everything

```sh
moshcode upgrade            # moshcode + every installed engine and tool
moshcode upgrade claude     # just one engine (name any; alias ok)
moshcode upgrade ugig       # just one workflow tool
moshcode upgrade tools      # all installed workflow tools, no self/engines
moshcode upgrade self       # just moshcode itself
```

Each target is updated with its own native updater when it has one (e.g.
`opencode upgrade`, `aider --upgrade`) and re-run through its installer
otherwise — MoshCode never vendors it. In the TUI: `/upgrade [name…]`.

## Hosting at a Moshpit name (`moshcode template`)

Claim `foo.whatever` in [the Pit](https://pit.moshcode.sh/pit), then scaffold
something to put behind it:

```sh
moshcode template list                        # what there is
moshcode template list --json                 # machine-readable template metadata
moshcode template install bun-caddy-sqlite    # into the current directory
moshcode template install caddy-static --into /srv/site
moshcode template install owner/repo          # or a git URL, or a .tar.gz
moshcode template install caddy-static --dry-run # preview every file first
```

| template | what you get |
|---|---|
| `bun-caddy-sqlite` | Bun service + Caddy + SQLite — a local file in dev, Turso in prod, same client |
| `caddy-static` | Caddy and a directory of files. No runtime, nothing to keep alive. |

Each writes a Caddyfile, systemd units, and a README. **Nothing in a template is
executed on install** — including the bundled ones. `install <url>` takes a
stranger's URL, so the files are copied and what to run is yours to decide.
`--dry-run` labels every file as `create` or `overwrite` and leaves the target
directory unchanged; combine it with `--force` to preview an overwrite plan.

The one fact that catches everyone: **the machine serving the name never
resolves it, and every machine visiting it must.** Serving is a `Host` header
match and nothing more; visitors need `sudo moshcode dns enable` or the name
resolves to nothing.

Use JSON when a script needs to distinguish a live, parked, invalid, or
temporarily unreachable name without parsing terminal text:

```sh
moshcode dns resolve foo.whatever --json
```

A name points at an **IPv6 address** (bare — no scheme, brackets or port) or a
hostname. IPv4 literals are refused: an A record on a small host is usually
leased or NATed, and a name pointed at one goes stale silently.

Full walkthrough, including the layer-by-layer way to debug it and the limits
worth knowing before you build:
**[docs/hosting-a-moshpit-name.md](docs/hosting-a-moshpit-name.md)**.

## Shell completion

MoshCode can print context-aware completion scripts for its commands, engines,
workflow tools, options, and file arguments. Load the one for your current
shell:

```sh
# Bash (~/.bashrc)
source <(moshcode completion bash)

# Zsh (~/.zshrc, after any existing compinit/Oh My Zsh setup)
source <(moshcode completion zsh)

# Fish (~/.config/fish/config.fish)
moshcode completion fish | source

# PowerShell (add to $PROFILE for future sessions)
moshcode completion powershell | Out-String | Invoke-Expression
```

Put the matching line in your shell profile to enable it in future sessions.

## PRD — plan before you mosh

Write a product requirements doc *first*, then let your coding agents build to it.
`moshcode prd` publishes PRDs per [OpenPRD](https://github.com/profullstack/logicsrc/blob/master/docs/openprd.md) —
a **DIP-style** standard: a numbered, committed proposal collection in your repo
(like a BIP/EIP process), one file per decision.

```sh
moshcode prd "parked-domain service expansion"   # publish the next numbered PRD, then hand it to an engine
moshcode prd                                      # list existing PRDs
moshcode prd list --json                          # machine-readable listing; writes nothing
```

`moshcode prd <idea>` bootstraps `prd/` on first use (a `README.md` index +
`0000-template.md`), assigns the next four-digit number, writes
`prd/NNNN-slug.md` (status `Draft`), and hands it to a coding engine (Claude Code
by default) to author. PRDs are **committed** to the repo — they carry a lifecycle
(Draft → Review → Accepted → Final) in their front-matter.

```txt
prd/
  README.md              # index of PRDs
  0000-template.md       # the OpenPRD template
  0001-parked-domain-expansion.md
```

In the TUI shell it's `/prd [idea]`.

## moshscript

A metal scripting toolkit — **secretly all JS is legal**. The simple surface
stays dead-simple, but a `.mosh` file is real JavaScript under the hood with the
full moshcode command vocabulary injected as globals:

```js
// alive.mosh — the starter script (unchanged, still works)
while (alive) {
  code();
  mosh();
  notify();
  repeat();
} // no bugs, only features
```

The secret that it's all JS — no new syntax to learn:

```js
// deploy-agents.mosh — real work, still reads like the toy
const engines = ["claude", "codex"];
for (const e of engines) {
  install(e);                                  // → moshcode install <e>
}
mcp("install", "https://mcp.sentry.dev/mcp");  // fan out across engines
say(`ready to mosh with ${engines.length} engines`);
agents("claude");                              // drop into an autonomous session
```

### Run

```sh
moshcode run examples/alive.mosh              # run a script
moshcode run deploy.mosh --dry-run            # narrate without executing
moshcode run alive.mosh --max 5               # bound the while loop (default 3)
moshcode run deploy.mosh staging --fast       # extra args reach the script as argv
moshcode run deploy.mosh -- --max 5           # -- preserves option-like script args
moshcode run - < script.mosh                  # pipe/paste from stdin
moshcode commands                             # list the full vocabulary
moshcode commands --json                      # machine-readable command metadata
```

No install/build step — it's plain ESM. `node bin/moshcode.mjs …` works too.

### Shebang — self-running scripts

`.mosh` files support shebang lines, so `chmod +x` makes them run like shell
scripts. The `moshscript` executable is installed alongside `moshcode`:

```js
#!/usr/bin/env moshscript
// deploy.mosh — chmod +x it and run it like any shell script
install("claude");
agents("claude");
```

```sh
chmod +x deploy.mosh
./deploy.mosh                        # shebang → moshscript → moshcode run
./deploy.mosh --dry-run staging      # args after the file reach the script
```

### Commands

**Local verbs** (moshscript-only, in-process):

| verb | description |
|---|---|
| `code()` | compile features (no bugs) |
| `mosh()` | open the pit + blast the moshcoding playlist |
| `notify(msg)` | fire-and-forget ping + approval link on moshcode.sh |
| `ask(prompt)` | blocking gate — waits for human reply at moshcode.sh |
| `say("…")` | print a line |
| `sleep(ms)` | pause for N milliseconds (blocking) |
| `shell(cmd)` | run a shell command (blocking, `$SHELL -c`); returns `{ ok, code }` |
| `stop()` | end the loop (`alive = false`) |
| `repeat()` | back to the top of the loop |

**CLI verbs** (each shells out to `moshcode <name> ...args`):

| verb | description |
|---|---|
| `agents(engine)` | launch an autonomous agent session |
| `start(engine)` | raw-launch an engine |
| `install(target)` | install an engine or workflow tool |
| `upgrade(targets…)` | upgrade moshcode, engines, and tools |
| `mcp(args…)` | register/fan out an MCP server |
| `skill(args…)` | install a skill across engines |
| `prd(idea)` | publish/author an OpenPRD doc |
| `ugig(args…)` | drive the ugig workflow CLI |
| `coinpay(args…)` | drive the coinpay workflow CLI |
| `c0mpute(args…)` | drive the c0mpute workflow CLI |
| `secrets(args…)` | drive the logicsrc secrets CLI |
| `railway(args…)` | drive the Railway CLI |
| `gh(args…)` | drive the GitHub CLI |
| `supabase(args…)` | drive the Supabase CLI |
| `doppler(args…)` | drive the Doppler CLI |
| `doctl(args…)` | drive the DigitalOcean CLI |
| `turso(args…)` | drive the Turso CLI |
| `tailscale(args…)` | drive the Tailscale CLI |
| `pwd()` | print the current repo/location |
| `run(file)` | run another .mosh file (include/compose) |

**Specials** (injected globals, not commands):

| name | description |
|---|---|
| `alive` | `true` while the loop may continue; iterations bounded by `--max` |
| `argv` | positional args passed after the script file |
| `env` | `process.env` — parameterize scripts from the environment |

### Human-in-the-loop

- `notify(msg)` — fire-and-forget. Pings the operator across configured channels
  and surfaces an approval link at `app.moshcode.sh/approve/:id`. Returns `{ id, url }`.
- `ask(prompt)` — blocking gate. Same ping + link, then **blocks** until the
  operator opens the link, reads the context, types instructions, and submits.
  Resolves with their text (or `null` on timeout). Use with `await`:

```js
const task = await ask("what should I work on next?");
say(`got it: ${task}`);
```

### Error handling

CLI verbs and `shell()` return `{ ok, code }` instead of throwing on non-zero
exits, so scripts can branch on outcomes without `try/catch`:

```js
const r = install("claude");
if (!r.ok) {
  say(`install failed (exit ${r.code}), trying fallback…`);
  install("codex");
}

const test = shell("npm test");
if (!test.ok) notify("tests failed!");
```

Only truly fatal errors (e.g. `moshcode` binary not found) throw. This keeps
`while (alive)` loops resilient — a single failing verb doesn't crash the script.

### Dry run

`--dry-run` narrates every action without executing it — no engine spawns, no
installs, no network POSTs, no PRD writes:

```
$ moshcode run deploy.mosh --dry-run
🎸 moshcode — running moshscript (dry run)

  ▶ install(claude) → would run: moshcode install claude
  ▶ mcp(install, https://mcp.sentry.dev/mcp) → would run: moshcode mcp install …
  💬 ready to mosh with 2 engines
  ▶ agents(claude) → would run: moshcode agents claude

✓ 0 loop(s) — no bugs, only features. 🤘
```

### Add your own commands

The vocabulary is open for extension via the registry:

```js
import { moshVocabulary } from "moshcode/src/commands.mjs";
import { runScript } from "moshcode/src/runtime.mjs";

const commands = moshVocabulary();
commands.register({ name: "deploy", summary: "ship it", run: (ctx) => ctx.out("shipping…") });
await runScript(src, { commands });
```

## Env

| var | default | purpose |
|---|---|---|
| `MOSHCODE_API` | `https://moshcoding.com` | web-notifications endpoint host |
| `MOSHCODE_SITE` | `https://app.moshcode.sh` | approval URL base |
| `MOSHCODE_WEBHOOK_URL` | — | optional extra webhook for `notify()` |
| `MOSHCODE_WEBHOOK_SECRET` | — | signs notify() posts |
| `MOSHCODE_PLAYLIST` | — | what `mosh()` blasts in the browser |
