# billing

Slash commands for
[`@profullstack/billing`](https://github.com/profullstack/billing) — clients,
rates and invoices, built on the hours `@profullstack/timer` tracked.

```
/billing:rate set acme '$100/hour/agent/upto:4'
/billing:hours --client acme --month
/billing:invoice --client acme --from-timer --month
/billing:report
```

## Install the CLI

```sh
npm install -g @profullstack/billing
```

or, inside moshcode:

```
moshcode install billing
```

## What it is for

A rate is the sentence from the contract, parsed. `$100/hour/agent/upto:4` means
four agents cost four hundred an hour and so do six, and the invoice bills
**agent-hours** so the client can check the line by hand: `quantity × rate`
always equals `amount`.

Two rules the shape enforces. The same hour never reaches two invoices — each
invoice records the timer entry ids it covers, so voiding one releases them.
And creating an invoice is a proposal: `--dry-run` validates the whole thing and
writes nothing, a new invoice is a draft, and nothing is ever emailed.

## Coming from moshcode

moshcode used to keep this layer internally. `billing import` brings it across
from `~/.moshcode/business.json` and `timers.json`, shows the plan first, and
never modifies the originals.
