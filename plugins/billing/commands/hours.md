---
description: Tracked hours not yet on an invoice, priced at the client's rate.
argument-hint: --client <name> [--month|--week]
allowed-tools: Bash(billing hours:*), Bash(billing client:*), Bash(billing rate:*)
---

## Task

```bash
billing hours $ARGUMENTS --json
```

This is the preview of what `billing invoice new --from-timer` would bill. Same
filters, same grouping, same arithmetic — it writes nothing.

## Reading the response

- `items[]` — the line items, each with `description`, `quantity` (in the rate's
  own billing unit), `unitPriceMajor`, `amount`, `hours` and `timerIds`.
- `unit` — what `quantity` is measured in: `hours`, or `agent-hours` when the
  rate is priced per agent.
- `hours` / `units` / `subtotal` — the totals.
- `skipped` — `{ running, unbillable, alreadyBilled }`.

## Rules

- **Always read `skipped.running` back to the user.** Those hours are not
  missing, they are on a clock that is still ticking and become billable the
  moment it stops. "Nothing to bill" is misleading when the real answer is "stop
  the clock first".
- Exit 3 means no unbilled hours matched, or the client does not exist. Read the
  message; it distinguishes them.
- When `unit` is `agent-hours`, explain the multiplier if the user seems
  surprised: 3 hours with 2 agents is 6 agent-hours. `quantity * unitPrice`
  always equals `amount`.
- If there is no rate, the error says so and names the command that sets one.
  Do not invent a rate to get past it.
