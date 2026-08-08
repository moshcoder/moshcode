---
description: Research one crypto pair — price, technicals, score, supply and order book.
argument-hint: <PAIR>
allowed-tools: Bash(moshcode crypto:*), Bash(curl -sS https://advis0r.com/api/crypto/:*)
---

## Task

Pull the full report for `$ARGUMENTS` and summarize it for the user.

Run:

```bash
moshcode crypto $ARGUMENTS --json
```

If `moshcode` is not installed, fall back to the API directly:

```bash
curl -sS "https://advis0r.com/api/crypto/report?symbol=$ARGUMENTS"
```

Pairs are accepted as `BTC`, `BTC-USD`, `BTC/USD` or `BTCUSD`. A bare asset
resolves to that asset's USD pair.

## Reading the response

- `snapshot` is the live read: `latestTrade`, `latestQuote` (bid/ask),
  `dailyBar`, `prevDailyBar`, and a `change` against yesterday's close.
- `technical` holds sma / ema / rsi14 / macd / bollinger / atr14 /
  `relativeVolume` / `momentum` / `trend` / `volatilityRegime`.
- `technicalScore.score` is 0–100 with a `breakdown`. It is **technical only** —
  there is no thesis, no transcript and no filing behind a crypto pair.
- `fundamentals` is CoinGecko supply data: market cap, rank, circulating and max
  supply, 24h volume, all-time high. It is absent for many pairs.
- `caveats` are per-response and specific. Read them before quoting the score.

## Rules

- **These prices are Alpaca's US crypto venue alone.** Say so. They can differ
  materially from Coinbase, Binance, or an aggregate index.
- Crypto trades 24/7 with no circuit breakers and no market close. Never
  describe a crypto price as "at the close" or "premarket".
- State `generatedAt` / `fetchedAt`. This is a live read, so it goes stale in
  seconds, not days — the opposite failure mode from a stored `/stocks:stocks` report.
- The score's liquidity component counts venue-local volume only, so it is
  **not comparable** to an equity's score from `/stocks:stocks`. Do not rank the two
  against each other.
- End with the response's own `disclaimer`. This is research, not advice.
- Link the shareable page: `https://advis0r.com/crypto/<PAIR>`.
