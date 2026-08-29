---
description: Read or set what your time costs, written the way the contract says it.
argument-hint: "[set <client|default> '$100/hour/agent/upto:4']"
allowed-tools: Bash(billing rate:*), Bash(billing client:*)
---

## Task

```bash
billing rate $ARGUMENTS --json
```

With no arguments this lists every rate. `set`, `show` and `rm` take a target,
which is either a client handle or `default`.

## The spec

A price, then any of these in any order:

- a period: `hour`, `day` (8h), `week` (40h), `month` (160h), `project`, `task`
- a unit that gets multiplied: `agent`, `seat`, `person`, `team`
- `upto:N` to cap the multiplier, `min:N` for a minimum billed period

`$100/hour/agent/upto:4` means four agents cost four hundred an hour, and so do
six. `0.5 SOL/day`, `250 USDC/task` and `$5000/project` all parse too.

## Rules

- **Do not set or change a rate unless the user asked.** This is the number in
  somebody's contract.
- Read `describes` back to them when confirming — it is the rate as a sentence,
  and it is how you catch a spec that parsed differently from how it was meant.
- Settlement (`--prefer SOL --accept fiat`) is deliberately separate from the
  price. The number in the contract does not change because the rail did, so do
  not "convert" a rate to a preferred ticker.
- A price given in a ticker invoices in that ticker. Do not turn `0.5 SOL` into
  a dollar figure: nobody computed that number.
- If a spec is rejected, the error names the words that are allowed. Fix the
  spec rather than falling back to a bare number, which would silently mean
  "per hour, flat".
