---
description: Historical crypto OHLCV for one pair, at any supported timeframe.
argument-hint: <PAIR> [timeframe]
allowed-tools: Bash(moshcode crypto:*), Bash(curl -sS https://advis0r.com/api/crypto/:*)
---

## Task

Pull historical bars for `$ARGUMENTS`.

```bash
moshcode crypto bars $ARGUMENTS --timeframe 1Day --limit 30 --json
```

Timeframes: `1Min`, `5Min`, `15Min`, `1Hour`, `1Day`, `1Week`. Add
`--start`/`--end` (ISO dates) to pin a window.

Fallback: `curl -sS "https://advis0r.com/api/crypto/bars?symbol=<PAIR>&timeframe=1Day&limit=30"`

## Reading the response

`bars` is keyed by canonical symbol (`"BTC/USD"`), each value an ascending array
of `{ timestamp, open, high, low, close, volume, vwap }`.

## Rules

- **`limit` is upstream's page size, not a cap on what returns.** The response
  can hold more bars than you asked for. If you show a subset, say which subset
  — "the 5 most recent of 17", never a silent truncation.
- Bars are ascending by time. Confirm the direction before calling a move.
- `volume` is base-asset units on Alpaca's US venue alone, not aggregate market
  volume. Do not compare it to a CoinGecko or exchange-aggregate figure.
- Crypto bars are calendar-based and continuous — no gaps, no sessions, no
  weekends. A "20-day" window here is not 20 trading sessions.
- End with the response's own `disclaimer`.
