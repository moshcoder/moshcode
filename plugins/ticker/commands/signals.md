---
description: What was actually said about a ticker — extracted signals with quotes and sources.
argument-hint: <SYMBOL>
allowed-tools: Bash(moshcode ticker:*), Bash(curl -sS https://advis0r.com/api/:*)
---

## Task

List the extracted signals for `$ARGUMENTS`.

```bash
moshcode ticker signals $ARGUMENTS --json
```

Fallback: `curl -sS "https://advis0r.com/api/signals?ticker=$ARGUMENTS"`

## Reading the response

Each signal carries `signal_type`, `direction` (positive/negative/neutral),
`strength`, `specificity`, `quote`, `event_date`, `speaker`, `speaker_title`,
`source_url`, and `source_tier`.

## Rules

- Group by direction and lead with the most recent. Note the positive/negative split.
- **Every claim keeps its `source_url`.** These are extracted quotes from
  transcripts and articles — a signal repeated without its source is a rumor.
- `strength` and `specificity` are the extractor's confidence, not the market's.
  A strong signal from a low `source_tier` is still a low-tier source; say so.
- End with the response's own `disclaimer`.
