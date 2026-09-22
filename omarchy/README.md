# Moshcode Herd — an Omarchy bar widget

The agents you have running, the ones that are blocked waiting on you, and what
the last hour cost. On the bar, so you stop finding out by typing.

```
● 1 blocked · 4 agents · $38.20/h
```

Click it for the list: every session with its engine, state, swarm, age and
directory, then the burn over the last minute, fifteen minutes and hour.

## Why a bar widget

Everything [moshcode](https://github.com/moshcoder/moshcode) knows about a
running fleet is behind a prompt. `moshcode ps` says who is alive, `moshcode
cost` says what it burns, `moshcode fleet tree` says who started whom. All three
are true and none of them are on screen, so you learn what your machine is doing
by deciding to ask.

The state that costs the most is `blocked`: an agent that asked a question
twenty minutes ago, holding a pane and a context window, waiting for a human who
does not know it is waiting. This widget goes amber and pulses when that
happens. Everything else it shows is context around that one fact.

## Install

You need [moshcode](https://github.com/moshcoder/moshcode) 0.104 or newer on
your `PATH`:

```bash
curl -fsSL https://moshcoding.com/install.sh | bash
moshcode omarchy doctor     # what is present, and what that rules out
```

Then either let moshcode place the plugin:

```bash
moshcode omarchy install    # copies into ~/.config/omarchy/plugins and rescans
```

or install it the Omarchy way, from git:

```bash
omarchy plugin add https://github.com/moshcoder/omarchy-moshcode --enable
omarchy bar move sh.moshcode.herd --section right
```

## What it runs

One command, on a timer, one at a time:

```bash
moshcode omarchy status --json
```

That is the whole contract. The snapshot carries the agent rows, the counts, the
burn windows, the fleets and the alerts, and moshcode caches the expensive half
of it, so a poll that lands inside the cache window re-reads a small file rather
than re-reading a month of transcripts.

The widget polls every 10 seconds while the panel is closed and every 3 seconds
while it is open, backs off to a minute after three consecutive failures, and
never starts a second process while the first is running.

Those intervals are deliberately unambitious. Each poll is a `moshcode` process,
and node's start-up plus the CLI's measured between 0.66s and 4.2s on a
developer box busy running the agents the widget reports on. A one-second poll
would spend a visible slice of a core telling you how busy you are.

## What it will not do

It is read-only. It does not start agents, stop them, answer them, or attach to
them — those are writes from a process that runs unsandboxed inside your shell,
and the version that only looks has to be boring in the wild first.

It also refuses to guess. No moshcode on `PATH`, a snapshot older than the
plugin understands, an engine that logs nothing priceable: each of those reads
as itself, never as a zero.

## Settings

Set on the widget, in the bar's plugin configuration:

| Property | Default | What it does |
|---|---|---|
| `idleIntervalMs` | 10000 | poll while the panel is closed |
| `openIntervalMs` | 3000 | poll while the panel is open |
| `backoffIntervalMs` | 60000 | poll after three failures in a row |
| `staleAfterMs` | 30000 | how old a snapshot has to be before the widget dims |
| `moneyFloor` | 1.0 | hide `$/h` below this, so an idle machine shows no money |

## Development

```bash
moshcode omarchy validate            # manifest and layout, no Omarchy needed
omarchy plugin validate "$PWD"       # the real thing, on an Omarchy box
qmllint -I "$OMARCHY_PATH/shell" BarWidget.qml Panel.qml
omarchy-shell shell rescanPlugins
```

MIT. Issues and pull requests at
[moshcoder/moshcode](https://github.com/moshcoder/moshcode).
