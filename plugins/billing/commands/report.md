---
description: What has been billed, collected, and what is still owed.
argument-hint: "[--client <name>] [--year|--month]"
allowed-tools: Bash(billing report:*), Bash(billing invoice:*)
---

## Task

```bash
billing report $ARGUMENTS --json
```

## Reading the response

- `totals` — `billed`, `collected`, `outstanding`, `overdue`, `draft`, all as
  decimal numbers in `currency`.
- `byClient[]` — the same figures per client, biggest outstanding first.

## Rules

- **`draft` is not money anybody owes you.** A draft invoice has not been
  issued, so keep it out of any "you are owed X" sentence and name it
  separately.
- `overdue` is derived from the due date at read time, never stored. It is a
  subset of `outstanding`, not an addition to it — do not sum them.
- Windows apply to the **issue date** here, not to when the work was done.
- For the invoices behind a figure, use `billing invoice list --overdue --json`
  or `--status sent`. Do not guess at which invoices make up a total.
