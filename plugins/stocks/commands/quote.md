---
description: The fast read on one ticker — price, score, and how stale the snapshot is.
argument-hint: <SYMBOL>
allowed-tools: Bash(moshcode stocks:*), Bash(curl -sS https://advis0r.com/api/:*)
---

## Task

Give the short answer on `$ARGUMENTS` — price and score, not the full write-up.

```bash
moshcode stocks $ARGUMENTS --json
```

Fallback: `curl -sS "https://advis0r.com/api/ticker?symbol=$ARGUMENTS"`

This is the same document `/stocks:report` reads. The difference is what you do
with it: four lines, not a report. If the user wants the thesis, signals and
sources, that is `/stocks:report`.

## Reading the response

Take only: `lastPrice`, `priceTimestamp`, `delayed`, `overallScore`,
`classification`, and `companyName`.

## Rules

- **Four lines at most.** Price, score with classification, staleness, and one
  pointer to `/stocks:report <SYMBOL>` for the rest. Brevity is the feature.
- **This is a stored snapshot, not a live quote.** Print `priceTimestamp` and
  say `delayed` when it is — a stale price presented as a live one is the one
  failure here that costs money. Equities are not crypto: this number can be
  days old.
- A low score is the answer, not a failure to answer. Say it plainly.
- Keep the response's own `disclaimer` if the user is acting on the number.
- If the symbol 400s with `didYouMean`, they typed a company name — re-run
  against the suggestion and say you did, or point at `/stocks:lookup`.
