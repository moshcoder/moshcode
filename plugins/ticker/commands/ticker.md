---
description: Research one ticker — score, technicals, fundamentals, thesis, signals, and sources.
argument-hint: <SYMBOL>
allowed-tools: Bash(moshcode ticker:*), Bash(curl -sS https://advis0r.com/api/:*)
---

## Task

Pull the stored research report for `$ARGUMENTS` and summarize it for the user.

Run:

```bash
moshcode ticker $ARGUMENTS --json
```

If `moshcode` is not installed, fall back to the API directly:

```bash
curl -sS "https://advis0r.com/api/ticker?symbol=$ARGUMENTS"
```

## Reading the response

- `overallScore` (0–100), `confidence`, and `classification` are the headline. A
  low score is a *finding*, not a failure to report.
- `aiAnalysis.analysis.thesis` is a hosted-model take; `analysis.thesis` is a
  deterministic offline one. Say which you are quoting — they carry different weight.
- `technical` holds rsi14 / sma / macd / atr / relativeVolume.
- `facts` holds SEC fundamentals; `facts.source === "unavailable"` means the
  fundamentals section is missing, not that the company has none.
- `signals` are extracted quotes with `direction` and `source_url`.
- `sources` are the documents behind them.

## Rules

- **`reportGeneratedAt` is when this snapshot was built.** State it. The price in
  a stored report is not a live quote, and must never be presented as one.
- If the response is a 400 with `didYouMean`, the user typed a company name
  rather than a symbol — re-run against the suggested symbol and say you did.
- End with the response's own `disclaimer`. This is research, not advice.
- Link the shareable report: `https://advis0r.com/ticker/<SYMBOL>`.
