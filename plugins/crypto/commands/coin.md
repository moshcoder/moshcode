---
description: Find a crypto pair by asset name (bitcoin → BTC/USD).
argument-hint: <asset name>
allowed-tools: Bash(moshcode crypto:*), Bash(curl -sS https://advis0r.com/api/crypto/:*)
---

## Task

Resolve `$ARGUMENTS` to a tradable pair.

```bash
moshcode crypto lookup $ARGUMENTS --limit 10 --json
```

Fallback: `curl -sS "https://advis0r.com/api/crypto/lookup?q=<url-encoded>&limit=10"`

## Reading the response

`matches` is a list of `{ symbol, slug, base, quote, name }`.

## Rules

- One coin usually returns several pairs — `BTC/USD`, `BTC/USDC`, `BTC/USDT`.
  Show them all and say which quote asset each settles in; default to the USD
  pair unless the user asked otherwise.
- Watch for name collisions: a query can match a different coin whose name
  merely contains the words ("bitcoin" also returns Bitcoin Cash). Say which
  match is the one they meant.
- No match: say this venue lists no such pair, and do not invent a symbol. The
  coin may exist and simply not be listed here — those are different answers.
- Offer `/crypto <PAIR>` for the match you land on.
