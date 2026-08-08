---
description: Top of the crypto order book, both sides, with the spread.
argument-hint: <PAIR>
allowed-tools: Bash(moshcode crypto:*), Bash(curl -sS https://advis0r.com/api/crypto/:*)
---

## Task

Show the order book for `$ARGUMENTS`.

```bash
moshcode crypto book $ARGUMENTS --depth 10 --json
```

Fallback: `curl -sS "https://advis0r.com/api/crypto/orderbook?symbol=$ARGUMENTS&depth=10"`

## Reading the response

`orderbooks[]` each carry a `timestamp`, `bids[]` and `asks[]`, every level a
`{ price, size }`. Bids descend from the best bid; asks ascend from the best ask.

## Rules

- Report the spread in basis points, not just in dollars — a $50 spread means
  something different on BTC than on ETH.
- **Size is depth on one venue, not the market.** Do not describe the book as
  "the market's" depth, and do not extrapolate what a large order would fill at.
- A book is a snapshot of an instant. Timestamp it.
- If one side is much thinner than the other, say so plainly rather than
  reading it as a directional signal — it is a liquidity observation.
- End with the response's own `disclaimer`.
