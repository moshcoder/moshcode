---
description: What the stocks plugin can do, and the exact command names to type.
---

## Task

List what this plugin provides. Do not call any tool — everything needed is
below. Render it as a compact table, then the notes.

| command | what it does |
| --- | --- |
| `/stocks:report <SYMBOL>` | the full research report — score, technicals, fundamentals, thesis, signals, sources |
| `/stocks:quote <SYMBOL>` | the short answer — price, score, staleness |
| `/stocks:lookup <company>` | company name → ticker (`rivian` → `RIVN`) |
| `/stocks:signals <SYMBOL>` | what was actually said, quoted and sourced |
| `/stocks:research <words…>` | full-text search across every indexed transcript |
| `/stocks:reports` | every stored report, best score first |
| `/stocks:discover <topic>` | a ranked watchlist for a topic (slow — analyzes each candidate) |

## Notes to pass on

- **`report` and `reports` are different commands.** Singular takes a symbol and
  returns one write-up; plural takes nothing and lists the whole stored index.
- Every command name is namespaced `/stocks:…`. A bare `/report` is not a
  command — Claude Code always prefixes plugin commands with the plugin name.
- `crypto@moshcode` is the sibling plugin, and the four shared names mean the
  same thing there: `/crypto:report`, `/crypto:quote`, `/crypto:lookup`,
  `/crypto:help`. It adds `/crypto:book`, `/crypto:bars`, `/crypto:spark` and
  `/crypto:pairs` for things equities do not have.
- Everything here is a **stored snapshot** from advis0r.com, read-only and
  public. Nothing in this plugin can place an order — that is `moshcode trade`.

If the user asked for something no command covers, say so rather than
improvising one that does not exist.
