---
openprd: "0.2"
id: "0012"
title: "Bake billing into the agent CLI — timer, clients, teams, rates, invoices, rails"
status: Draft
authors:
  - anthony@profullstack.com
created: 2026-08-29
updated: 2026-08-29
repo: https://github.com/moshcoder/moshcode
discussion:
implementation: src/timer.mjs · src/clients.mjs · src/teams.mjs · src/rates.mjs · src/billing.mjs · src/payments.mjs · src/business-store.mjs
tags: business, billing, payments, time-tracking, permissions
supersedes:
superseded-by:
---

## Problem

Every agentic CLI helps you do the work. None of them help you get paid for it.

That gap is not small. An agency running moshcode has the whole engagement in
this terminal — the engines, the herd, the repos, the deploys — and then leaves
it to bill: hours reconstructed from memory into a spreadsheet, a rate that
lives in a signed PDF nobody opens, an invoice retyped into a processor's web
form. The one system that actually knows how long four agents ran on Acme's
repo last Tuesday is the one system with nothing to say about it.

It is worse than clerical. Agent work prices differently from human work and the
existing tools cannot express it: an hour of moshcode is an hour times however
many engines were running in it, capped at whatever the client was promised.
"$100/hour/agent, up to 4" is a real sentence in a real contract, and there is
nowhere to write it down except prose.

The same terminal has a second unanswered question. A devops shop puts moshcode
on machines its own people and its clients sit at, and "Preshy can use the
CoinPay tool, the client can read invoices and nothing else" has no expression
anywhere — not in moshcode, not in the tools it wraps.

## Goals

- Somebody who bills nobody still wants the timer, and gets it: `/timer on`,
  `/timer off`, and a ledger, with no client, no rate and no gateway.
- The rate card is written in the words of the contract and read by the machine
  — including the cap, which is the clause that made the client sign.
- The hours behind an invoice are the hours that were tracked, not the hours
  somebody remembered on the last day of the month.
- Time is never billed twice, and money never settles to an address nobody
  chose.
- Which processor a business already uses is their decision, not moshcode's.
- The split between an operator, an employee and a client is something an
  operator can write down, and something the pit then respects.

## Non-Goals

- Moving money. moshcode composes an invoice; a gateway delivers it. There is no
  wallet, no key and no signing in this layer.
- Being an accounting system. No ledgers, no tax, no reconciliation, no
  multi-currency FX at settlement time.
- Being a security boundary. The team gate stops the wrong command; it does not
  stop a person with a shell. That is an OS account or a container, and this
  PRD says so out loud rather than implying otherwise.
- Server-side state. Everything here is two JSON files under `~/.moshcode`.
  A shared, multi-machine business record is a later question.

## Users

- **The solo operator.** Bills a handful of clients hourly, wants the invoice to
  be the time that was actually tracked.
- **The agency.** Several clients, several people, several rates, and a promise
  about agent caps that has to survive contact with a busy month.
- **The employee or contractor.** Sits at a machine somebody else set up, needs
  the engines and the timer and nothing that touches money.
- **The client.** Occasionally handed a pit; should see what they are being
  billed and the time behind it, and touch nothing.

## Requirements

- R1 [P0] `/timer on|off` tracks time to a local ledger, with no dependency on
  a client, a rate or a gateway.
- R2 [P0] A timer records how many agents were running, and `--agents auto`
  reads that from the herd rather than asking.
- R3 [P0] `/client create` accepts contact details as they arrive — a comma
  form for what is pasted, `--a.b` dotted flags for anything else — with no
  fixed field list.
- R4 [P0] `/rate set <who> <spec>` parses the contract sentence, including
  period, unit, `upto:N` cap and `min:N` floor, in any order after the price.
- R5 [P0] `/billing <client>` previews without writing; `--mark` claims the
  time exactly once; `--send` composes the gateway command and only `--yes`
  runs it.
- R6 [P0] An invoice refuses to settle when there is no client payee and no
  wallet rail.
- R7 [P1] `/payments` connects a rail — CLI (CoinPay, Stripe), OAuth (PayPal,
  Coinbase) or a bare wallet — and stores no secret, only a vault reference.
- R8 [P1] `/team` records people, roles and grants; `MOSHCODE_MEMBER` makes the
  pit act as one of them, and the gate refuses commands they have no grant for.
- R9 [P1] A permission is written however it is said — `tools:coinpay`,
  `tools/coinpay`, `allow(tools/coinpay)` — and means the same thing.
- R10 [P2] `/business`, `/merchant` and `/customer` are the same command as
  `/client`; `/rates`, `/teams` and `/invoice` likewise.

## UX Notes

The five words are `/timer`, `/client`, `/rate`, `/billing`, `/payments`, plus
`/team` for who may run them. Each is useful alone, which is the test each one
had to pass: the timer with no rate, the rate with no gateway, the client with
no invoice.

Aliases are not synonyms in general English — a merchant is not a customer — but
they are the same party in every conversation this is for, and the word somebody
reaches for depends on which product taught it to them. Three doors, one room.

The gate refuses by naming the permission and the command that would grant it,
because the person who hits it is not the person who can fix it, and "ask an
owner for `/team grant acme preshy tools:coinpay`" is a message they can paste.

## Open Questions

- Should the business record sync to app.moshcode.sh the way settings do (PRD
  0010)? An agency's client list on one laptop is the same problem 0010 solved
  for aliases — but a client list is a different kind of data, and the answer
  may be that it belongs on the account rather than in a sync.
- Should `/team` grants travel with `/load`, so a machine handed to a contractor
  is configured by logging into it? That is the version where this stops being a
  personal record and starts being an operator tool.
- Beyond CoinPay, `--send` prints numbers rather than composing a command line.
  Stripe's CLI is the obvious next one to teach it.
- Member rates are recorded but not yet used: cost-per-person alongside
  price-per-client is what turns an invoice into a margin.
