---
description: Draft an invoice from tracked time or fixed line items, for a person to approve.
argument-hint: --client <name> --from-timer --month
allowed-tools: Bash(billing invoice:*), Bash(billing hours:*), Bash(billing client:*), Bash(billing rate:*)
---

## Task

Propose an invoice for `$ARGUMENTS`. **Always dry-run first:**

```bash
billing invoice new $ARGUMENTS --dry-run --json
```

Show the user what it would create. Only run it again without `--dry-run` when
they have said to.

Line items come from `--from-timer` (tracked hours), from `--item
"Description|quantity|price"`, or both on the same invoice.

## Rules

- **Creating an invoice is a business action. Do not write one unprompted.**
  `--dry-run` builds and validates the entire invoice — the rate lookup and the
  double-billing check included — so a dry run that succeeds means the real one
  will. There is no reason to skip it.
- A new invoice is a **draft**. `billing invoice mark <n> sent` is a separate,
  deliberate step and this tool never emails anything. Do not mark an invoice
  sent or paid unless the user asked.
- Read `amounts` (decimal) when talking to a person; the bare `total` is in
  minor units.
- Exit 3 on `--from-timer` means there were no unbilled hours. Check
  `billing hours` and report `skipped.running` rather than concluding there is
  nothing to bill.
- The same hour cannot reach two invoices: each invoice records the timer entry
  ids it covers. If the user wants to re-bill something, voiding the old invoice
  releases those hours.
- Prefer `billing invoice render <n> --format html --out <file>` when they want
  something to send: it is one self-contained file that prints to PDF.
