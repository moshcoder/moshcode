---
description: Compare recent moves across several crypto pairs at once.
argument-hint: <PAIR> [PAIR…]
allowed-tools: Bash(moshcode crypto:*), Bash(curl -sS https://advis0r.com/api/crypto/:*)
---

## Task

Compare recent price action across `$ARGUMENTS`.

```bash
moshcode crypto spark $ARGUMENTS --period 24h --json
```

`--period` is `24h` or `7d`. Up to 20 pairs per call. With no pairs given, ask
which ones — or offer the majors (BTC, ETH, SOL).

Fallback: `curl -sS "https://advis0r.com/api/crypto/sparklines?symbols=BTC-USD,ETH-USD&period=24h"`

## Reading the response

`series` is keyed by canonical symbol, each with `points[]` (closes, ascending),
`first`, `last`, `changePercent`, and the `start`/`end` of the window.

## Rules

- Lead with `changePercent` per pair and rank them — that is the question a
  multi-pair call is asking.
- **Each series is scaled to itself.** A dramatic-looking shape on one pair and
  a flat one on another can be the same percentage move; compare the numbers,
  not the shapes.
- Name the window (`start` → `end`) and the period. "Up 5%" over 24h and over 7d
  are different claims.
- Do not extrapolate a trend from 24 points, and do not call a direction
  "momentum" without the technicals to back it — `/crypto <PAIR>` has those.
- End with the response's own `disclaimer`.
