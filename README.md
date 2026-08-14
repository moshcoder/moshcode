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
| `moshcode herd` | runtime | run agent sessions that outlive this terminal |
| `moshcode ps` | runtime | list herd sessions and what each one is doing |
| `moshcode attach` | runtime | attach this terminal to a herd session |
| `moshcode kill` | runtime | end a herd session |
| `moshcode wait` | runtime | block until a session is blocked, done, or idle |
| `moshcode restore` | runtime | rebuild the herd's sessions after a reboot |
| `moshcode install` | engines | install an engine or workflow tool |
| `moshcode uninstall` <br>`remove` | engines | take an engine or workflow tool off this machine |
| `moshcode upgrade` <br>`update` | engines | update moshcode, engines, or tools |
| `moshcode mcp` | extend | register and inspect MCP servers |
| `moshcode skill` <br>`skills` | extend | install and inspect agent skills |
| `moshcode prd` | script | publish or list product requirement documents |
| `moshcode login` | account | authenticate with app.moshcode.sh |
| `moshcode whoami` | account | show the logged-in account |
| `moshcode logout` | account | clear the logged-in account |
| `moshcode save` | account | save this machine's pit settings to your account |
| `moshcode load` | account | bring your saved pit settings onto this machine |
| `moshcode console` | account | serve or connect to the browser terminal |
| `moshcode dns` | hosting | resolve Moshpit names on this machine |
| `moshcode doh` | hosting | run the DNS-over-HTTPS resolver |
| `moshcode site` <br>`serve` | hosting | install web-server config for a Moshpit name |
| `moshcode template` <br>`templates` | hosting | scaffold a stack for a Moshpit-hosted service |
| `moshcode games` <br>`game` `arcade` | arcade | the moshcode arcade — twenty-two games, no menus |
| `moshcode pwd` <br>`where` | system | show the current directory and git context |
| `moshcode engines` | engines | list engines and installation status |
| `moshcode tools` | tools | list workflow tools and installation status |
| `moshcode trade` | tools | look up markets and trade through Alpaca |
| `moshcode stocks` <br>`advisor` | tools | equity research from advis0r.com |
| `moshcode crypto` <br>`coins` | tools | crypto market data from advis0r.com |
| `moshcode news` | tools | headlines from your feeds, or a search |
| `moshcode rss` | tools | read the same headlines in a full-screen reader |
| `moshcode plugin` <br>`plugins` | extend | install moshcode's slash commands into Claude Code |
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
moshcode install openagents # curl -fsSL https://openagents.org/install.sh | bash
```

`openagents` is the odd one out: a launcher that supervises the engines above
rather than a coding agent itself. Its installer ends by offering to pair the
machine with a workspace — press Enter to skip that.

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
moshcode agents openagents  # openagents                                        (dashboard)
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

## The herd — sessions that outlive your terminal

Every launch above hands an engine the whole terminal and waits. That is why
they feel native, and it is also why the pit can only do one thing at a time and
why closing the lid kills the work.

The herd inverts it. Add `-d` and the session runs in a runtime that outlives
the pit, so you get your prompt back immediately:

```sh
moshcode start claude -d --name api      # runs in the background, prompt returns
moshcode agents codex -d                 # autonomous, and still detached
moshcode ps                              # who is running, and who wants you
moshcode attach api                      # step in; Ctrl-b d steps back out
moshcode kill api                        # end it
```

### Everything on screen at once

```sh
moshcode herd tile
```

```
┌─ work ──────────────────┬─ logs ──────────────────┐
│ $ npm test              │ tailing deploy.log      │
│ ✓ 1492 passing          │ 12:04 build ok          │
├─ api ───────────────────┴─────────────────────────┤
│ claude — Do you want to proceed?                  │
│ ❯ 1. Yes    2. No                                 │
└───────────────────────────────────────────────────┘
 herd            S:shell A:agent X:stop B:pop out z:zoom
```

Every member becomes a tile in one window. Click a tile to focus it, `Ctrl-b z`
to blow it up full-screen and again to come back, `Ctrl-b d` to leave the lot
running. Start and stop without leaving:

| key | |
|---|---|
| `Ctrl-b S` | new shell tile |
| `Ctrl-b A` | new claude tile |
| `Ctrl-b X` | stop the focused tile |
| `Ctrl-b B` | pop it out into its own session |
| `Ctrl-b z` | zoom / unzoom |

`moshcode herd untile` puts them all back in their own sessions. Tiling is just
a view — the processes never restart, and a tiled member stays on `moshcode ps`
and answers `read`, `prompt` and `wait` exactly as before.

Needs tmux. The `script(1)` fallback gives each session its own pty with no way
to lay them out together, so it says so and points at the list instead.

### The workspace

```sh
moshcode herd ui
```

```
┌ herd ──────┬─ api ─────────────────────────────┐
│ herd       │                                   │
│            │  claude                           │
│ MAIN       │  Do you want to proceed?          │
│ ▸ ! api    │  ❯ 1. Yes                         │
│   · work   │    2. No                          │
│ SCRATCH    │                                   │
│   · logs   │                                   │
│            │                                   │
│ ACTIONS    │                                   │
│   + shell  │                                   │
│   + agent  │                                   │
│   ✕ stop   │                                   │
│   ⊞ tile   │                                   │
│   ← detach │                                   │
│            │                                   │
│ enter ▸ …  │                                   │
│ F12 ▸ …    │                                   │
├────────────┴───────────────────────────────────┤
│ mosh ▸ ps · start claude · show <n> · detach   │
└────────────────────────────────────────────────┘
```

Members and actions down the left, the selected member's **real terminal** on
the right. Click a member to show it; click an action to start a shell, start an
agent, or stop the selected one. `q` detaches and leaves everything running.

Click the member that is already on screen — or press Enter — and the keyboard
goes to it, so you are typing at the agent itself.

### The mosh bar

The row along the bottom is a mosh prompt, and it is always there. **F12** jumps
to it from anywhere, including from inside an agent that has taken the keyboard,
which makes it the way out of a session you cannot otherwise leave. Esc goes
back to the session; `detach` leaves with everything still running.

It takes any `moshcode herd` verb, so you can start a second agent without
leaving the first:

```
mosh ▸ start claude          # another agent, now on screen
mosh ▸ show api              # put a different member up
mosh ▸ ps                    # the roster, over the session, then out of the way
```

`attach` means `show` here — in a workspace the word means "put it in the
content pane", and the real attach would be a tmux client inside a tmux client.
Output grows the bar over the content for as long as you are reading it, then it
collapses back to one row.

**`moshcode attach <name>` gets the bar too.** A session you attach to directly
grows the same one-line prompt along the bottom for as long as you are there,
and it is taken away again when you detach — so a member is a plain member when
nobody is looking at it. `show <name>` from that bar switches you to another
member (and gives that one a bar before you land in it). The bar is the bottom
row either way, which is why one key finds it in both places.

The right-hand pane is not a picture of a session — it *is* the session's pane,
moved in. tmux's model is session → window → pane, so moving between *windows*
cannot keep anything on screen; but `join-pane` moves a running pane into an
existing window, so swapping only the content pane leaves the sidebar untouched.
Both panes keep their process and their scrollback because tmux is moving the
real thing, not redrawing it.

Group sessions with `--herd <name>` when you start them; anything without one is
in `main`. Without tmux there is nothing to swap panes with, so `herd ui` falls
back to a plain clickable list.

### A workspace: a few shells and an agent

This is what most people actually want — a couple of shells to work in and an
agent or two running beside them, none of which die when the terminal does:

```sh
cd ~/src/coinpay
moshcode herd shell --name work          # a plain $SHELL
moshcode herd shell --name logs          # another
moshcode agents claude -d --name api     # and an agent
```

```sh
$ moshcode ps
  api    claude  blocked   ~/src/coinpay   3m
  logs   shell   idle      ~/src/coinpay   3m
  work   shell   idle      ~/src/coinpay   3m

⚠ 1 waiting on you — moshcode attach api
```

`moshcode attach work` puts you in one; `Ctrl-b s` hops between all three;
`Ctrl-b d` leaves the lot running. Close the laptop and they are still there.

### Agents moshcode does not ship

`start` only knows the engines moshcode installs. `run` takes anything —
an agent with no install spec here, a build, a script:

```sh
moshcode herd run --name cur -- cursor-agent
moshcode herd run --name build -- npm run watch
```

Everything after `--` is the command, flags and all. These get a roster entry
and the same state detection as a known engine: the shared rules match what a
terminal *draws* — a y/n prompt, a numbered menu, "esc to interrupt" — not
anything engine-specific, so an agent moshcode has never heard of still shows up
`blocked` when it stops to ask you something.

Close the terminal, drop the SSH link, come back tomorrow — `moshcode ps` still
answers, and `moshcode attach` puts you back inside. In the pit the same verbs
are `/ps`, `/attach`, `/kill`, and the roster prints on the way in.

### Switching between them without leaving

Every session lives in one tmux server that moshcode owns, so once you are
attached to any of them you can move around the whole herd without going back to
the pit:

| key | |
|---|---|
| `Ctrl-b s` | pick from a list of every session |
| `Ctrl-b )` / `Ctrl-b (` | next / previous session |
| `Ctrl-b L` | back to the one you were just in |
| `Ctrl-b d` | detach — the session keeps running |

That server is started without your `~/.tmux.conf`, so these are the stock
bindings whatever your own tmux does with the prefix. Under the no-tmux fallback
there is no switcher: detach with `Ctrl-]` and `moshcode attach <name>` the next
one.

### Which one needs you

Every session carries a state: `working`, `blocked`, `done`, `idle`, or
`unknown`. `blocked` means a human decision is the only thing missing.

```
  api       claude  blocked   ~/src/coinpay        12m
  web       codex   working   ~/src/ugig.net        4m
  audit     opencode  done    ~/src/moshpit-dns     1h
```

State comes from one authority per session, never two. An engine that reports
through a lifecycle hook (`moshcode herd report <name> <state>`) is believed and
its screen is not second-guessed; everything else is classified from the bottom
of its screen. Nothing recognisable reads `unknown`, which is a safe answer —
detection never gates a launch. Patterns that go stale can be fixed in
`~/.moshcode/herd/rules.json` without waiting for a release.

Blocked can also come and find you, using the same notification fan-out as
`notify()`/`ask()`:

```sh
moshcode herd notify on --ask            # email/SMS/Slack/Telegram/push
moshcode herd start claude --name watch  # then run `moshcode herd watch` in the herd
```

With `--ask`, whatever you reply is typed into the session that was waiting.

### Driving it from a script or another agent

There is no second API — every verb takes `--json`, and that is what a machine
reads. `wait` exists to be branched on: exit `0` matched, `2` timed out, `3` no
such session.

```sh
moshcode herd start claude --name api --json
moshcode herd prompt api "port the auth routes" --wait
moshcode herd read api --lines 40
moshcode wait api --state blocked --timeout 1h
```

moshscript gets the same surface as values rather than exit codes, which is what
makes fan-out practical:

```js
herdStart("claude", { name: "api" });
herdStart("codex",  { name: "web" });
herdPrompt("api", "port the auth routes");
herdPrompt("web", "port the dashboard");
await herdWait("api"); await herdWait("web");
say(herdRead("api", { lines: 20 }));
```

### After a reboot

```sh
moshcode restore --dry-run       # what would come back
moshcode restore --resume        # and ask each engine to reopen its conversation
```

This brings back the *shape* — the sessions, in their directories, on their
engines. The processes are new. Work that was in flight is not still running,
and `--resume` only reaches engines that have a resume flag of their own.

### What it runs on

`tmux` when the box has it: real resizing, scrollback, native attach. Without
tmux, sessions run under `script(1)` with their input on a FIFO — they work and
they persist, but their size is fixed when they start. With neither, launches
stay in the foreground and say so once. moshcode does not turn a soft dependency
into a hard one, so `-d` never fails; at worst it degrades and tells you what
would fix it.

The session manifest and every transcript are written `0600`: engine argv and
engine output both carry secrets.

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
moshcode install coral            # official script → ~/.local/bin (checksum-verified)

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

### Equity research (`moshcode stocks`)

Where `trade` is Alpaca's order book, `stocks` is the research desk:
[advis0r.com](https://advis0r.com/api)'s public read-only API, rendered in the
pit. No key, no login, no write routes, no binary to install:

```sh
moshcode stocks NVDA               # score, technicals, fundamentals, thesis, signals
moshcode stocks lookup rivian      # company name → RIVN
moshcode stocks signals AAPL       # what was said, quoted and sourced
moshcode stocks search "data center"  # across every indexed transcript
moshcode stocks reports --limit 10 # the stored index, best score first
moshcode stocks discover fusion    # a ranked watchlist (slow — analyzes each candidate)
moshcode stocks open NVDA          # the shareable report page
```

Add `--json` to any of them for the raw response. The same facade is `/stocks …`
in the pit, and `MOSHCODE_ADVISOR_URL` points it at another instance.

Reports are **stored snapshots**, not live quotes: every response carries
`reportGeneratedAt` and every renderer prints it, alongside whether the price is
delayed and which feed produced it. Scores labelled `offline` come from
deterministic rules rather than a model. It is a research aid, not advice, and
nothing under `stocks` can place an order.

### Crypto market data (`moshcode crypto`)

`crypto` is `stocks`'s sibling on the same host: advis0r's read-only crypto
routes over Alpaca's US crypto venue, which trades 24/7 and needs no extra
subscription.

```sh
moshcode crypto BTC                     # price, technicals, score, supply, order book
moshcode crypto lookup bitcoin          # asset name → BTC/USD
moshcode crypto quote ETH-USD           # latest trade + quote, spread in bps
moshcode crypto spark BTC ETH SOL       # recent moves across pairs, as sparklines
moshcode crypto bars ETH-USD --timeframe 1Hour   # historical OHLCV
moshcode crypto book BTC-USD --depth 5  # top of book, both sides
moshcode crypto assets                  # every supported pair
moshcode crypto open BTC                # the shareable page
```

Pairs are accepted as `BTC`, `BTC-USD`, `BTC/USD` or `BTCUSD` — a bare asset
resolves to that asset's USD pair. `--json` gives the raw response, `/crypto …`
is the same facade in the pit, and `MOSHCODE_ADVISOR_URL` points it elsewhere.

Unlike a `stocks` report, this is a **live venue read**, not a stored snapshot —
there are no transcripts, no filings and no signals behind a crypto pair, and
the failure mode runs the other way: the price is accurate to the second and
stale by the time you act on it. Every response stamps when it was fetched.

The technical score counts venue-local liquidity, so it is **not comparable** to
an equity's score, and each response ships the `caveats` that say so. Prices are
Alpaca's US venue alone and can differ materially from other exchanges. Research
aid, not advice — and like `stocks`, nothing under `crypto` can place an order.

### Aliases (`/alias`)

The pit is a prompt you sit at all day, so it lets you name the lines you keep
retyping. An alias runs in `$SHELL` unless it starts with `/`, in which case it
is a pit command:

```text
/alias set gs "git status"        # then /gs — and /gs -sb appends to it
/alias set cx "/agents codex"     # a pit command, not a shell one
/alias                            # what is defined
/alias rm gs
```

They live in `~/.moshcode/aliases.json` (owner-only, like the history file) and
survive between sessions. A name that is already a pit command, an engine, or a
tool is refused rather than shadowed — built-ins are dispatched first, so such
an alias would never run.

### Social posting from the pit

The pit can hand a prepared post to Bluesky or Nostr without storing either
account's credentials in MoshCode:

```text
/socials
/post bsky "shipped it 🤘"
/post nostr "shipped it 🤘"
```

Bluesky opens its official compose intent. Nostr opens the MoshCode composer,
connects to a NIP-07 browser signer (or a NIP-46 bunker through
[`window.nostr.js`](https://github.com/fiatjaf/window.nostr.js)), signs a kind-1
event, and publishes it to the displayed relays. Both flows leave the final
confirmation in the browser. If the pit is remote or headless, `/post` prints
the composer URL instead.

## The arcade (`/games`)

Twenty-two games, in the pit or straight from a shell. There are no menus, no options
screens and no difficulty prompts — `/games tetris` is already playing.

```sh
moshcode games                # the cabinet (pit: /games)
moshcode games tetris         # play one   (pit: /games tetris)
moshcode games --json         # the roster, for a machine
```

```
  TETRIS       score 1200 · lines 12
  ┌────────────────────────────────┐
  │ · · · · ████· · · ·   NEXT     │
  │ · · · · ████· · · ·            │
  │ · · · · · · · · · ·   ████████ │
  │ · · · · · · · · · ·            │
  │ · · · ████· · · · ·   LVL 2    │
  │ ████████████· ██████           │
  └────────────────────────────────┘
  ← → move · ↑ rotate · ↓ drop one · space slam · q quit
```

| game | |
|---|---|
| `tetris` | stack the bricks, clear the lines, outrun gravity |
| `snake` | eat, grow, and try not to eat yourself |
| `pacman` | eat the dots, dodge the ghosts, `✳` makes them edible |
| `invaders` | forty of them, and the last one moves fastest |
| `centipede` | shoot it in the middle and now there are two of them |
| `asteroids` | turn, thrust, shoot — every rock you break becomes two |
| `breakout` | dig a channel up the side and let the ball do the rest |
| `pong` | first to seven, and the angle is all in where you hit it |
| `tank` | two tanks, one yard, five hits — line it up and let go |
| `digdug` | dig the tunnels, pump the monsters, drop rocks on the rest |
| `frogger` | the road kills what it touches, the river kills what it doesn't |
| `kong` | five girders, four ladders, and a barrel with your name on it |
| `pitfall` | jump the logs, swing the pits, and get the gold before dark |
| `choplifter` | fly out, land, fill the back, and get them home |
| `spyhunter` | keep it on the tarmac, shoot the ones shooting back |
| `outrun` | a road that bends, traffic that doesn't, and a clock that always wins |
| `excitebike` | turbo until it cooks, and land the way you took off |
| `stagedive` | run the barricade, hop the gear, duck the crowd, take the picks |
| `tictactoe` | three in a row against an opponent that cannot be beaten |
| `blackjack` | hit, stand, double, split — dealer stands on 17, and pays 3:2 |
| `chess` | full rules — castling, en passant, promotion — and it plays back |
| `hangman` | six wrong letters and you are done for |

Every one of them works the same way: arrows move, `q` quits, `r` starts
another, and the controls are written along the bottom of the game itself. Each
draws in place rather than on the alternate screen, so the board you finished on
stays in your scrollback.

The two games that read letters — `blackjack`, where `h` is hit, and `hangman`,
where it is a guess — keep their letters: `h j k l` are not arrows there, and `r`
only starts another once the game is over.

Playing needs a real terminal, because they read single keypresses — `moshcode
games` on its own lists them anywhere, including a pipe.

## Settings sync (`/save` and `/load`)

Your pit becomes yours by accretion — a dozen aliases, herd rules you tuned until
the roster stopped lying to you. All of it lives in `~/.moshcode` on one machine,
which is why every new laptop, container and droplet used to feel like someone
else's prompt.

`/save` pushes that configuration to your `app.moshcode.sh` account. `/load`
brings it down onto any machine you have run `/login` on.

```sh
moshcode save                 # push this machine's settings (pit: /save)
moshcode save --dry-run       # what would go up, and stop

# on the new box
moshcode login
moshcode load                 # pull them down (pit: /load)
moshcode load --dry-run       # the per-file plan, changing nothing
```

What syncs is an allowlist, not a directory walk:

| file | what it is |
|---|---|
| `~/.moshcode/aliases.json` | your pit aliases (`/alias`) |
| `~/.moshcode/herd/rules.json` | herd state-detection overrides |

What never syncs, by name: `credentials.json` (the account token this very
feature authenticates with), `herd/sessions.json` (live state pinned to one tmux
server), `sync.json`, and the `pkg/` binary cache. Engine configuration
(`~/.claude.json` and friends) is deliberately left alone — those files carry
provider API keys.

Nothing is overwritten quietly:

- Each save is a numbered **revision**. `/save` sends the revision it last agreed
  on, and the app refuses the write if another machine has saved since — you get
  told, with `/load` and `/save --force` as the two ways out.
- `/load` refuses to replace a settings file you edited since this machine last
  synced, and names it. `--force` overrides.
- The last ten revisions are kept. See them, and which machine each came from, at
  [app.moshcode.sh/settings/sync](https://app.moshcode.sh/settings/sync) — where
  you can also promote an older revision or delete the lot.

Both verbs take `--json`, so a provisioning script can act on the result.

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

## Claude Code plugins

MoshCode publishes its own plugin marketplace, so the pit's slash commands work
inside your engine too:

```sh
moshcode plugin list              # what the marketplace ships, and who can take it
moshcode plugin install           # add the marketplace + install `stocks`
moshcode plugin install crypto    # add the marketplace + install `crypto`
moshcode plugin remove stocks     # take it back off
```

The two plugins share the four names for the questions both markets answer, and
differ only where the markets do. Either one's `/…:help` prints its own list.

| | `stocks@moshcode` | `crypto@moshcode` |
|---|---|---|
| shared | `help` `report` `quote` `lookup` | `help` `report` `quote` `lookup` |
| its own | `signals` `research` `list` `discover` | `book` `bars` `spark` `pairs` |

So `/stocks:report NVDA` and `/crypto:report BTC` are the same question asked of
different markets, while `/stocks:signals` (what an executive said on a call)
and `/crypto:book` (live order book depth) have no counterpart on the other
side. They ship separately because they are different surfaces, not modes of one
another: stored snapshots versus live venue reads, and a crypto score that must
not be ranked against an equity's.

Restart the engine after installing either; a newly installed plugin is not live
in a session that is already running.

Updating an installed plugin is its own step, and upgrading moshcode does not do
it: an engine only pulls a new copy when the *plugin's* own version moves.

```sh
claude plugin update stocks@moshcode
claude plugin update crypto@moshcode
```

Plugin commands are namespaced `/<plugin>:<command>` — always, not only when two
plugins collide — so it is `/stocks:signals AAPL`, and a bare `/signals` answers
`Unknown command`. Typing `/` and picking from the menu inserts the right form.
This is the one place the two surfaces differ: inside the moshcode pit the same
research is plain `/stocks …` and `/crypto …`, because those are moshcode's own
commands rather than a plugin's.

The equivalent by hand:

```sh
claude plugin marketplace add moshcoder/moshcode
claude plugin marketplace update moshcode   # `add` is a no-op if you already have it
claude plugin install stocks@moshcode
claude plugin install crypto@moshcode
```

The `update` line matters if you have ever installed from this marketplace
before: `add` declines to do anything for a marketplace already on disk, so
without a refresh the install reads a stale copy and fails with "not found in
any marketplace". `moshcode plugin install` runs both steps for you.

### Upgrading from `ticker@moshcode`

`stocks` was called `ticker` before v0.29.0. Installing the new id does **not**
replace the old one — engines install plugins side by side, so `/stocks:report` would
come from two plugins at once. Remove the old id first:

```sh
moshcode plugin remove ticker
moshcode plugin install stocks
```

`remove ticker` keeps working for exactly that reason, even though
`install ticker` no longer does.

Claude Code is currently the only engine with a plugin primitive. The others are
reported as skipped with a reason, the same way they are for skills, rather than
being left out of the summary. `MOSHCODE_PLUGIN_SOURCE=.` installs from a local
checkout instead of GitHub, which is how you try an unreleased plugin.

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
| `c0upons(args…)` | drive the c0upons workflow CLI |
| `secrets(args…)` | drive the logicsrc secrets CLI |
| `railway(args…)` | drive the Railway CLI |
| `gh(args…)` | drive the GitHub CLI |
| `supabase(args…)` | drive the Supabase CLI |
| `doppler(args…)` | drive the Doppler CLI |
| `doctl(args…)` | drive the DigitalOcean CLI |
| `turso(args…)` | drive the Turso CLI |
| `tailscale(args…)` | drive the Tailscale CLI |
| `coral(args…)` | drive the Coral CLI (SQL over APIs, databases, internal systems) |
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
