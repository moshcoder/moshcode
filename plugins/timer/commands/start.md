---
description: Start the clock on a project, optionally recording how many agents are working.
argument-hint: <project> [task words…]
allowed-tools: Bash(timer start:*), Bash(timer status:*), Bash(timer on:*)
---

## Task

Start a clock for `$ARGUMENTS`.

```bash
timer start $ARGUMENTS --json
```

The first word is the project; everything after it is the task, so no quoting is
needed. Useful flags:

- `--agents N` — how many engines are working. An agent-priced rate multiplies
  by this, so it is the difference between a $400 afternoon and a $1,600 one.
- `--at 09:15` or `--at -20m` — the clock you meant to start earlier.
- `--tag`, `--note`, `--no-billable`.

## Rules

- **Do not pass `--switch` unless the user asked to stop their other clocks.**
  Several clocks running at once is normal here: parallel agents each track
  their own work, and stopping someone else's is not recoverable from the log.
- If `started.alsoRunning` comes back non-empty, mention how many other clocks
  are running. Do not stop them.
- Report the entry id — `timer stop --id <id>` needs it, and so does the user if
  they want to correct the entry later.
- If the command exits 2, the command line was wrong; read the error and fix it
  rather than retrying the same thing.
