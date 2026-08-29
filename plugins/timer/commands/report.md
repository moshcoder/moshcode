---
description: Totals for a period, grouped by project, task, day, tag or agent.
argument-hint: "[--week|--month] [--group project|task|day|tag|agent]"
allowed-tools: Bash(timer report:*), Bash(timer log:*), Bash(timer projects:*)
---

## Task

```bash
timer report $ARGUMENTS --json
```

Windows: `--today`, `--yesterday`, `--week` (from Monday), `--month`, `--year`,
or explicit `--since` / `--until`. Groups: `project` (default), `task`, `day`,
`tag`, `agent`, `none`.

## Reading the response

`rows[]` each carry `key`, `entries`, `hours` and `billableHours`. `totals` has
the same figures for the whole window.

## Rules

- **A window compares against the entry's start, and `--until` is exclusive.**
  An entry that ran past midnight belongs to the day it began on. Say so if the
  user questions a boundary rather than guessing at a bug.
- Report `hours` and `billableHours` separately whenever they differ.
- `timer log` is the command for the entries behind a number. Reach for it when
  the user asks why a total looks the way it does.
- Do not convert hours into money here. The rate lives in
  `@profullstack/billing`, which knows about agent multipliers and caps; a
  hours-times-rate figure invented here will disagree with the invoice.
