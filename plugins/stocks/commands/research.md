---
description: Full-text search across every indexed earnings transcript and article.
argument-hint: <words to search for>
allowed-tools: Bash(moshcode stocks:*), Bash(curl -sS https://advis0r.com/api/:*)
---

## Task

Search the transcript index for `$ARGUMENTS`.

```bash
moshcode stocks search $ARGUMENTS --limit 20 --json
```

Fallback: `curl -sS "https://advis0r.com/api/search?q=<url-encoded>&limit=20"`

## Reading the response

`results` is a list of segments: `text`, `speaker`, `ticker`, `event_date`.
The API tries full-text search first and falls back to a substring scan, so a
hit is a hit — but relevance is not ranked. Read before summarizing.

## Rules

- Cluster the hits by ticker and say which companies came up, with dates.
- Quote sparingly and attribute each quote to its speaker and ticker.
- If nothing matches, say the *index* has no match — this searches advis0r's
  indexed corpus, not the whole web. Suggest `/stocks:lookup` if the query looks like
  a company name.
