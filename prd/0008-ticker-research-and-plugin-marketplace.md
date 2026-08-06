---
openprd: "0.2"
id: "0008"
title: "Bring equity research into the pit, and ship the pit's slash commands as a plugin"
status: Draft
authors:
  - anthony@profullstack.com
created: 2026-08-06
updated: 2026-08-06
repo: https://github.com/moshcoder/moshcode
discussion:
implementation:
tags:
  - research
  - plugins
  - advis0r
supersedes:
superseded-by:
---

## Problem

`moshcode trade` can look up a quote and place an order. It cannot answer the
question that comes before either one — *is this worth buying?* Everything that
would inform that lives in [advis0r.com](https://advis0r.com/api): indexed
earnings transcripts and news, extracted signals with sources, SEC fundamentals,
technicals, and a composite score. Today that means leaving the pit for a
browser, and it means an agent working in a session has no path to it at all.

Two separate gaps, one cause:

1. **In the pit.** There is no research verb. `/trade quote AAPL` returns a
   price and nothing about why it is that price.
2. **In the engine.** moshcode already fans MCP servers and Agent Skills out
   across engines, but it publishes no commands of its own. A slash command that
   exists at the mosh prompt does not exist inside Claude Code, and there is no
   mechanism by which it could.

## Goals

- Research a ticker without leaving the terminal, in one short command.
- An agent mid-session can pull sourced evidence about a company rather than
  recalling it from training data.
- moshcode's own slash commands become installable into the engines it drives,
  through the engines' native plugin mechanism rather than a moshcode-specific one.
- A stored snapshot is never mistaken for a live quote.

## Non-Goals

- Placing orders. `trade` owns that, with its preview-by-default guard; nothing
  under `ticker` writes anything anywhere.
- Reimplementing advis0r. Every route used is public, read-only, and unauthenticated;
  scoring, ingestion, and analysis stay server-side.
- Authentication. The routes that need a sign-in (`/api/digest`,
  `/api/report/regenerate`) are deliberately out of scope — adding credentials
  would make this the first moshcode verb that holds one.
- A general plugin framework. One marketplace, one plugin, extended by adding a
  directory.

## Users

- Someone in the pit deciding what to look at before opening the trading CLI.
- A coding agent asked about a company, which should cite indexed sources rather
  than assert from memory.

## Requirements

- R1 [P0] `moshcode ticker <SYMBOL>` prints the stored report: score, confidence,
  classification, technicals, fundamentals, thesis, recent signals, and sources.
- R2 [P0] Verbs for the rest of the surface: `signals`, `search`, `lookup`,
  `reports`, `discover`, `tickers`, `stats`, `open`. A first argument that is not
  a verb is a symbol; `report` is the unambiguous spelling for a symbol that
  collides with one.
- R3 [P0] Every rendered report states `reportGeneratedAt`, whether the price is
  delayed, and which feed produced it. A stored price must never render as a live one.
- R4 [P0] Every substantive response carries the API's own `disclaimer` through
  to the output.
- R5 [P0] `--json` on any verb prints the raw response, so scripts and agents get
  the full document rather than the rendered subset.
- R6 [P0] The same surface is `/ticker …` at the mosh prompt.
- R7 [P1] A non-symbol argument is refused with the `lookup` that resolves it,
  and a 400 carrying `didYouMean` surfaces the suggestion.
- R8 [P0] `.claude-plugin/marketplace.json` publishes a `ticker` plugin providing
  `/ticker`, `/signals`, `/research`, `/lookup`, `/reports`, `/discover`.
- R9 [P0] `moshcode plugin install` adds the marketplace and installs the plugin,
  fanning out across engines and reporting every engine without a plugin
  primitive as skipped — the same contract as 0003 R8 for skills.
- R10 [P1] `MOSHCODE_ADVISOR_URL` and `MOSHCODE_PLUGIN_SOURCE` redirect the API
  and the marketplace, so both are testable against a checkout.
- R11 [P1] The verb table in the schema and the parser's own list are checked
  against each other, so a verb cannot complete and then fail.

## UX Notes

`ticker` renders in-process rather than handing the terminal to a tool, because
unlike every other entry in `tools`, there is no advis0r binary — only an HTTP
API. That makes it the first moshcode verb that formats a remote response itself,
so the rendering rules matter more than usual:

- Direction is colour: acid for positive signals, red for negative.
- A model-written thesis is labelled with its provider and model; a
  deterministic one is labelled `offline`. They carry different weight and must
  not look alike.
- Optional sections (fundamentals, technicals, analysis) are genuinely absent
  when SEC or the market feed rate-limits. A missing section degrades the report;
  it never prevents one.
- `discover` ranks by analyzing each candidate and legitimately takes minutes. It
  gets a longer timeout than the row-read routes, and says so up front.

## Success Metrics

- `/ticker <SYMBOL>` answers in one line of input, with sources.
- The plugin installs into Claude Code and its six commands appear, verified by
  `claude plugin validate` and an end-to-end install.
- No rendered output anywhere presents a stored price as a live quote.

## Risks & Open Questions

- **Scored equity research one verb away from an order-placing CLI.** The
  mitigation is structural rather than advisory: `ticker` has no write path,
  `trade` keeps its preview guard, and the disclaimer travels with the data.
- **Snapshot staleness.** advis0r rebuilds a report when it is missing or when a
  watchlist member asks; moshcode cannot trigger a rebuild without
  authentication. Printing the generated-at stamp is the honest answer, not a
  workaround.
- Single upstream: if advis0r is down, the verb is down. Acceptable — it is a
  research aid, not a dependency of anything else in moshcode.
- Open: whether `plugin` should later fan out to other engines as they gain
  plugin primitives, or stay Claude-specific. The plan structure already allows
  the first without a rewrite.
