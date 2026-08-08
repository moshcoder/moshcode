# crypto — market data in your engine 🤘

Slash commands backed by [advis0r.com](https://advis0r.com/api/crypto): live
prices, technical scores, order books, OHLCV history and multi-pair sparklines
across Alpaca's US crypto venue.

| command | what it does |
| --- | --- |
| `/crypto BTC` | price, technicals, score, supply, order book |
| `/quote ETH-USD` | latest trade and quote, with the spread in bps |
| `/book BTC-USD` | top of the order book, both sides |
| `/bars ETH-USD` | historical OHLCV at any supported timeframe |
| `/spark BTC ETH SOL` | recent moves across pairs, ranked |
| `/pairs` | every supported pair, grouped by quote asset |
| `/coin bitcoin` | asset name → `BTC/USD` |

Pairs are accepted as `BTC`, `BTC-USD`, `BTC/USD` or `BTCUSD`. A bare asset
resolves to that asset's USD pair.

## Install

```bash
moshcode plugin install crypto
```

Or straight from Claude Code:

```bash
claude plugin marketplace add moshcoder/moshcode
claude plugin marketplace update moshcode   # `add` is a no-op if you already have it
claude plugin install crypto@moshcode
```

Restart the engine afterwards — a newly installed plugin is not live in a
session that is already running.

## How it works

Each command shells out to `moshcode crypto …`, which calls advis0r's public,
read-only API. No key, no login, no write routes. With `moshcode` absent, every
command falls back to `curl` against the same endpoints.

Point the commands at another instance with `MOSHCODE_ADVISOR_URL`.

## Why this is separate from `stocks`

They answer different questions from different data, and share only a hostname.
A `/stocks` report is a **stored snapshot** built from transcripts, SEC
fundamentals and extracted signals — its risk is a stale price read as a live
one. A `/crypto` report is a **live venue read** with no transcripts, no
filings and no signals — its risk is the opposite: a price that is accurate to
the second and stale by the time you act on it.

The scores are not comparable either. The crypto technical score counts
venue-local liquidity, so ranking a coin against an equity by score is
meaningless. Both surfaces ship their own `caveats`, and both commands are
instructed to print them.

## What this is not

A research aid, not advice. Prices are Alpaca's US crypto venue alone and can
differ materially from other exchanges. Crypto trades 24/7 with no circuit
breakers — there is no close, no premarket, and no halt.

Trading lives behind a different verb: `moshcode trade` wraps Alpaca, previews
orders by default, and requires an explicit `--submit`. Nothing in this plugin
can place an order.
