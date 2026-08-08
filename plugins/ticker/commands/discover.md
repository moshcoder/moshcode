---
description: Build a ranked watchlist for a topic (slow — it analyzes each candidate).
argument-hint: "[topic]"
allowed-tools: Bash(moshcode stocks:*), Bash(curl -sS https://advis0r.com/api/:*)
---

## Task

Rank candidates for `$ARGUMENTS` (no topic → the default watchlist).

```bash
moshcode stocks discover $ARGUMENTS --limit 10 --json
```

Fallback: `curl -sS --max-time 180 "https://advis0r.com/api/discover?topic=<url-encoded>&provider=offline&horizon=2&limit=10"`

**This route runs an analysis per candidate and can take minutes.** Tell the
user it is working before you start, and do not retry on a timeout — re-running
it costs the same minutes again.

## Reading the response

`candidates` is ranked, each with `rank`, `ticker`, `companyName`, `lastPrice`,
`overallScore`, `confidence`, `classification`, `thesis`, `primaryCatalyst`,
`mainRisk`, `independentConfirmation`, plus liquidity fields
(`bidAskSpreadPercent`, `avgVolume`, `float`, `marketCap`).

## Rules

- Lead with `rank`, `ticker`, `overallScore`, and `classification`.
- **Print `mainRisk` next to every thesis.** A ranked list that shows only the
  bull case is a pitch, not research.
- `provider: offline` means these scores are deterministic rules, not a model.
  Say which provider produced the ranking.
- Flag illiquidity: a wide `bidAskSpreadPercent` or thin `avgVolume` matters
  more than the score for anything small-cap.
- End with the response's own `disclaimer`.
