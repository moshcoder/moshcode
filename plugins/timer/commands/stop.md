---
description: Stop a running clock and report what it came to.
argument-hint: "[id]"
allowed-tools: Bash(timer stop:*), Bash(timer off:*), Bash(timer status:*)
---

## Task

Stop the clock for `$ARGUMENTS` (empty means the newest one).

```bash
timer stop $ARGUMENTS --json
```

Targets: nothing (the most recently started clock), an id or an unambiguous
prefix of one, `--project <p>`, or `--all`.

## Reading the response

`stopped[]` carries `seconds`, `hours` and `agents` for each entry closed.
`hours` is the figure an invoice uses.

## Rules

- **`stopped: []` with exit 0 means nothing was running.** That is an answer,
  not a failure — say so plainly and do not retry or treat it as an error.
- Do not pass `--all` unless the user asked to stop everything. Other clocks may
  belong to other agents.
- `--at` can backdate the stop, but a stop earlier than the start is refused
  rather than clamped to zero. If that happens, the entry is untouched.
