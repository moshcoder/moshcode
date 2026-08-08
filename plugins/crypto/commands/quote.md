---
description: The latest crypto trade and quote, with the bid/ask spread.
argument-hint: <PAIR>
allowed-tools: Bash(moshcode crypto:*), Bash(curl -sS https://advis0r.com/api/crypto/:*)
---

## Task

Get the current quote for `$ARGUMENTS`.

```bash
moshcode crypto quote $ARGUMENTS --json
```

Fallback: `curl -sS "https://advis0r.com/api/crypto/quote?symbol=$ARGUMENTS"`

## Reading the response

`quotes[]` each carry `latestTrade` (price, size, timestamp), `latestQuote`
(bidPrice/bidSize/askPrice/askSize), `spread`, `spreadBps`, and `mid`.

## Rules

- Give the price at the precision the pair trades at. SHIB near $0.000006
  rounded to two decimals is "$0.00", which is wrong, not concise.
- **`spreadBps` is the cost of crossing.** A wide spread means thin liquidity on
  this venue — report it alongside the price rather than burying it.
- `latestTrade.timestamp` and `latestQuote.timestamp` can differ. If the last
  trade is old, the mid is a quote, not evidence of a trade at that level.
- Prices are Alpaca's US crypto venue and trade 24/7 — never "at the close".
- End with the response's own `disclaimer`.
