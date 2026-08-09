---
description: What the crypto plugin can do, and the exact command names to type.
---

## Task

List what this plugin provides. Do not call any tool — everything needed is
below. Render it as a compact table, then the notes.

| command | what it does |
| --- | --- |
| `/crypto:report <PAIR>` | the full report — price, technicals, score, supply, order book |
| `/crypto:quote <PAIR>` | the short answer — latest trade, bid/ask, spread |
| `/crypto:lookup <name>` | asset name → pair (`bitcoin` → `BTC/USD`) |
| `/crypto:book <PAIR>` | top of the order book, both sides |
| `/crypto:bars <PAIR>` | historical OHLCV at any supported timeframe |
| `/crypto:spark <PAIR…>` | recent moves across several pairs, ranked |
| `/crypto:pairs` | every supported pair, grouped by quote asset |

## Notes to pass on

- Pairs are accepted as `BTC`, `BTC-USD`, `BTC/USD` or `BTCUSD`. A bare asset
  resolves to that asset's USD pair.
- Every command name is namespaced `/crypto:…`. A bare `/report` is not a
  command — Claude Code always prefixes plugin commands with the plugin name.
- `stocks@moshcode` is the sibling plugin, and the four shared names mean the
  same thing there: `/stocks:report`, `/stocks:quote`, `/stocks:lookup`,
  `/stocks:help`. It adds `/stocks:signals`, `/stocks:research`,
  `/stocks:reports` and `/stocks:discover` — transcript and filing work that
  has no crypto equivalent.
- **These are live venue reads, not stored snapshots** — the opposite of the
  stocks plugin. Prices are Alpaca's US crypto venue alone and can differ
  materially from other exchanges. Crypto trades 24/7: no close, no halt.
- The crypto technical score counts venue-local liquidity, so it is **not
  comparable** to a `/stocks:report` score. Do not rank the two against
  each other.

If the user asked for something no command covers, say so rather than
improvising one that does not exist.
