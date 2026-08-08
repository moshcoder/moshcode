# ticker — equity research in your engine 🤘

Slash commands backed by [advis0r.com](https://advis0r.com/api): scored research
reports, extracted signals with sources, transcript search, company-name lookup,
and ranked watchlists.

| command | what it does |
| --- | --- |
| `/stocks NVDA` | score, technicals, fundamentals, thesis, signals, sources |
| `/signals AAPL` | what was actually said, quoted and sourced |
| `/research data center` | full-text search across every indexed transcript |
| `/lookup rivian` | company name → `RIVN` |
| `/reports` | every stored report, best score first |
| `/discover fusion` | a ranked watchlist for a topic (slow) |

The headline command is `/stocks`, not `/ticker` — it was renamed so the verb
says what it covers, now that `/crypto` sits beside it. **The plugin itself is
still `ticker@moshcode`**, deliberately: renaming the plugin would force
everyone who already installed it to uninstall and reinstall, and an id is not
worth that. Existing installs pick `/stocks` up on the next plugin update.

## Install

```bash
moshcode plugin install
```

Or straight from Claude Code:

```bash
claude plugin marketplace add moshcoder/moshcode
claude plugin install ticker@moshcode
```

Restart the engine afterwards — a newly installed plugin is not live in a
session that is already running.

## How it works

Each command shells out to `moshcode stocks …`, which calls advis0r's public,
read-only API. No key, no login, no write routes. With `moshcode` absent, every
command falls back to `curl` against the same endpoints.

Point the commands at another instance with `MOSHCODE_ADVISOR_URL`.

## What this is not

A research aid, not advice. Reports are **stored snapshots** — every response
carries `reportGeneratedAt`, and every command is instructed to print it, because
a stale price presented as a live one is the one failure mode that actually costs
someone money. Scores marked `offline` come from deterministic rules, not a model.

Trading lives behind a different verb: `moshcode trade` wraps Alpaca, previews
orders by default, and requires an explicit `--submit`. Nothing in this plugin
can place an order.
