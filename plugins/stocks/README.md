# stocks — equity research in your engine 🤘

Slash commands backed by [advis0r.com](https://advis0r.com/api): scored research
reports, extracted signals with sources, transcript search, company-name lookup,
and ranked watchlists.

| command | what it does |
| --- | --- |
| `/stocks:stocks NVDA` | score, technicals, fundamentals, thesis, signals, sources |
| `/stocks:signals AAPL` | what was actually said, quoted and sourced |
| `/stocks:research data center` | full-text search across every indexed transcript |
| `/stocks:lookup rivian` | company name → `RIVN` |
| `/stocks:reports` | every stored report, best score first |
| `/stocks:discover fusion` | a ranked watchlist for a topic (slow) |

The `stocks:` prefix is not optional. Claude Code namespaces every plugin
command as `/<plugin>:<command>` — always, not only when two plugins collide —
so a bare `/stocks` answers `Unknown command`. Typing `/` and picking from the
menu inserts the right form for you.

(Inside the moshcode pit itself, `/stocks …` *is* bare — that is moshcode's own
command, not this plugin's.)

## Upgrading from `ticker@moshcode`

This plugin used to be called `ticker`. Both it and its headline command were
renamed so the name says which market it covers, now that `/crypto:crypto` sits beside
it.

Installing the new one does **not** replace the old one — engines install
plugins side by side, so `/stocks:stocks` would come from two plugins at once. Remove
the old id first:

```bash
moshcode plugin remove ticker
moshcode plugin install stocks
```

`moshcode plugin remove ticker` keeps working for exactly this reason, even
though `moshcode plugin install ticker` no longer does.

## Install

```bash
moshcode plugin install
```

Or straight from Claude Code:

```bash
claude plugin marketplace add moshcoder/moshcode
claude plugin marketplace update moshcode   # `add` is a no-op if you already have it
claude plugin install stocks@moshcode
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
