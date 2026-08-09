---
description: List every ticker with a stored report, best score first.
argument-hint: "[--limit n] [--sort recent|score|ticker]"
allowed-tools: Bash(moshcode stocks:*), Bash(curl -sS https://advis0r.com/api/:*)
---

## Task

List every ticker advis0r has a stored report for.

```bash
moshcode stocks list $ARGUMENTS --json
```

Fallback: `curl -sS "https://advis0r.com/api/reports?sort=score&limit=25"`

## Reading the response

`reports` is a list of `{ ticker, companyName, lastPrice, overallScore,
confidence, classification, aiProvider, aiModel, sourceCount, signalCount,
generatedAt }`, and `total` is how many exist.

## Rules

- Render as a table: ticker, score, classification, price, generated-at.
- **`generatedAt` per row, always.** These are snapshots taken at different
  times; a table that hides that reads as one consistent as-of date.
- A row with no `aiProvider` was scored deterministically, not by a model.
- Offer `/stocks:report <SYMBOL>` for anything worth a closer look.
- This is a coverage list, not a recommendation list. Rank order is score order.
