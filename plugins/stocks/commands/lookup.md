---
description: Find a ticker symbol by company name (rivian → RIVN).
argument-hint: <company name>
allowed-tools: Bash(moshcode stocks:*), Bash(curl -sS https://advis0r.com/api/:*)
---

## Task

Resolve `$ARGUMENTS` to a ticker symbol.

```bash
moshcode stocks lookup $ARGUMENTS --limit 10 --json
```

Fallback: `curl -sS "https://advis0r.com/api/lookup?q=<url-encoded>&limit=10"`

## Reading the response

`matches` is a list of `{ symbol, name, exchange, hasReport }`.
`hasReport: true` means advis0r already has a stored research snapshot.

## Rules

- Show every match with its exchange — "Delta" is an airline and a faucet company.
- Mark which ones have a report, and offer `/stocks <SYMBOL>` for those.
- One unambiguous match: say the symbol and go straight to offering the report.
- No match: say the *directory* has no match, and do not invent a symbol.
