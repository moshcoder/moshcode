---
description: Every crypto pair advis0r can price, and which are trading.
allowed-tools: Bash(moshcode crypto:*), Bash(curl -sS https://advis0r.com/api/crypto/:*)
---

## Task

List the supported pairs.

```bash
moshcode crypto assets --json
```

Fallback: `curl -sS "https://advis0r.com/api/crypto/assets"`

## Reading the response

`assets[]` are `{ symbol, slug, base, quote, name, status }`. `slug` is the
URL-safe spelling (`BTC-USD`) used in paths; `symbol` is canonical (`BTC/USD`).
`status` is `live` or `idle`.

## Rules

- Group by `quote` asset. The same coin priced in USD, USDT and BTC are three
  different markets with three different liquidity profiles.
- **`idle` means listed but not currently printing trades** — it is not the same
  as unsupported. Show idle pairs, marked, rather than filtering them out.
- If the user was looking for a specific coin, use `/coin <name>` instead of
  scanning this list for them.
- This is the coverage of one venue, not of crypto. A coin missing here is
  missing *from Alpaca's US venue*.
