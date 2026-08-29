---
description: What is running right now, and what today adds up to.
allowed-tools: Bash(timer status:*), Bash(timer log:*)
---

## Task

```bash
timer status --json
```

## Reading the response

- `running[]` — every live clock, each with `seconds` counting up to now.
- `today` — totals for entries that *started* today: `hours` and `billableHours`.
- `dataFile` — where the timesheet lives, worth quoting if the user is surprised
  by what is or is not in it.

## Rules

- An empty `running` array is a normal answer. Exit status is 0 either way, so
  never report "nothing running" as a failure.
- `hours` and `billableHours` differ when something is marked `--no-billable`.
  If they differ, give both — "how long did this take" and "what can I charge
  for it" are different questions.
- A running clock's duration is still moving. Do not present it as a final
  figure, and note that billing will not invoice it until it is stopped.
