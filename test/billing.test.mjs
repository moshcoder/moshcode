// The join: tracked time, a rate, an address, a rail.
//
// Two invariants are worth more than everything else in this file. Time is
// never billed twice, and money never settles to an address nobody chose.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { billingCommand, buildInvoice, coinpayArgs, settlementFor } from "../src/billing.mjs";
import { clientCommand } from "../src/clients.mjs";
import { isInstalled } from "../src/engines.mjs";
import { paymentsCommand } from "../src/payments.mjs";
import { rateCommand } from "../src/rates.mjs";
import { timerCommand } from "../src/timer.mjs";
import { loadBusiness, loadTimers } from "../src/business-store.mjs";

function sandbox(t) {
  const previous = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "moshcode-billing-"));
  t.after(() => { process.env.HOME = previous; });
  const lines = [];
  return { lines, write: (l) => lines.push(String(l)), said: () => lines.join("\n") };
}

/** A client with a rate, a payee, and some time against it. */
async function shop(io, { rate = "$100/hour/agent/upto:4" } = {}) {
  clientCommand(["create", "Acme"], io);
  clientCommand(["payee", "acme", "solana:9xQe"], io);
  rateCommand(["set", "acme", rate], io);
  await timerCommand(["add", "acme", "2h", "--task", "code review", "--agents", "2"], io);
  await timerCommand(["add", "acme", "1h", "--task", "batch payments", "--agents", "6"], io);
  io.lines.length = 0;
}

test("an invoice is charged per entry, then grouped by task", async (t) => {
  const io = sandbox(t);
  await shop(io);
  const invoice = buildInvoice({ business: loadBusiness(), timers: loadTimers(), clientId: "acme" });
  // 2h × 2 agents × $100 = $400, plus 1h × 6 agents capped at 4 = $400.
  assert.equal(invoice.total, 800);
  assert.equal(invoice.seconds, 3 * 3600);
  assert.deepEqual(invoice.lines.map((l) => l.what).sort(), ["batch payments", "code review"]);
  assert.equal(invoice.warnings.length, 1, "the capped entry is called out");
  assert.match(invoice.warnings[0], /6 agents ran, 4 billed/);
});

test("a preview writes nothing at all", async (t) => {
  const io = sandbox(t);
  await shop(io);
  assert.equal(billingCommand(["acme"], io), 0);
  assert.equal(Object.keys(loadBusiness().invoices).length, 0);
  assert.equal(loadTimers().entries.every((e) => !e.billed), true);
  assert.match(io.said(), /this is a preview/);
});

test("--mark claims the time exactly once", async (t) => {
  const io = sandbox(t);
  await shop(io);
  assert.equal(billingCommand(["acme", "--mark"], io), 0);
  const invoices = Object.values(loadBusiness().invoices);
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].total, 800);
  assert.equal(loadTimers().entries.every((e) => e.billed && e.invoice === invoices[0].id), true);

  // The second run has nothing left to bill — this is the double-billing guard.
  io.lines.length = 0;
  assert.equal(billingCommand(["acme", "--mark"], io), 0);
  assert.equal(Object.keys(loadBusiness().invoices).length, 1, "no second invoice");
  assert.match(io.said(), /nothing unbilled/);
});

test("--all re-reads billed time without re-claiming it", async (t) => {
  const io = sandbox(t);
  await shop(io);
  billingCommand(["acme", "--mark"], io);
  const invoice = buildInvoice({ business: loadBusiness(), timers: loadTimers(), clientId: "acme", all: true });
  assert.equal(invoice.total, 800, "the history is still readable");
  assert.equal(Object.keys(loadBusiness().invoices).length, 1);
});

test("void un-claims the time and keeps the record", async (t) => {
  const io = sandbox(t);
  await shop(io);
  billingCommand(["acme", "--mark"], io);
  const [id] = Object.keys(loadBusiness().invoices);
  assert.equal(billingCommand(["void", id], io), 0);
  assert.equal(loadBusiness().invoices[id].status, "void", "the number that was quoted is still on file");
  assert.equal(loadTimers().entries.every((e) => !e.billed), true, "the time is billable again");
});

test("a flat project fee is added once, not per entry", async (t) => {
  const io = sandbox(t);
  await shop(io, { rate: "$5000/project" });
  const invoice = buildInvoice({ business: loadBusiness(), timers: loadTimers(), clientId: "acme" });
  assert.equal(invoice.total, 5000);
  assert.equal(invoice.lines.filter((l) => l.what === "project fee").length, 1);
});

test("no rate is a refusal, not an invoice for nothing", async (t) => {
  const io = sandbox(t);
  clientCommand(["create", "Globex"], io);
  await timerCommand(["add", "globex", "3h"], io);
  io.lines.length = 0;
  assert.equal(billingCommand(["globex", "--mark"], io), 1);
  assert.match(io.said(), /no rate for/);
  assert.equal(Object.keys(loadBusiness().invoices).length, 0);
});

test("nothing settles to an address nobody chose", async (t) => {
  const io = sandbox(t);
  clientCommand(["create", "Globex"], io);
  rateCommand(["set", "globex", "$100/hour"], io);
  await timerCommand(["add", "globex", "1h"], io);
  io.lines.length = 0;
  assert.equal(billingCommand(["globex", "--mark"], io), 1, "no payee, no wallet, no invoice");
  assert.match(io.said(), /nothing to settle to/);
  assert.equal(Object.keys(loadBusiness().invoices).length, 0);

  // A wallet rail is a fallback for every client that has no payee of its own.
  paymentsCommand(["connect", "wallet", "--chain", "solana", "--address", "5wal"], io);
  assert.deepEqual(settlementFor(loadBusiness(), "globex"), { chain: "solana", address: "5wal", source: "wallet" });
  assert.equal(billingCommand(["globex", "--mark"], io), 0);
});

test("a client payee wins over the wallet rail", async (t) => {
  const io = sandbox(t);
  await shop(io);
  paymentsCommand(["connect", "wallet", "--chain", "solana", "--address", "5wal"], io);
  assert.equal(settlementFor(loadBusiness(), "acme").address, "9xQe");
  assert.equal(settlementFor(loadBusiness(), "acme").source, "client");
});

test("--send composes the CoinPay command and does not run it without --yes", async (t) => {
  const io = sandbox(t);
  await shop(io);
  const calls = [];
  const run = (...args) => { calls.push(args); return { status: 0 }; };
  paymentsCommand(["default", "coinpay"], { ...io, run: () => ({ status: 0 }) });
  // `default` needs the gateway connected first; connect records the choice.
  paymentsCommand(["connect", "wallet", "--chain", "solana", "--address", "5wal"], io);
  io.lines.length = 0;
  billingCommand(["acme", "--send", "--gateway", "coinpay"], { ...io, run });
  assert.equal(calls.length, 0, "an irreversible verb waits to be told twice");
  // Whether the command line gets composed at all depends on the CoinPay CLI
  // being on this machine, which is not something a test may assume. Both
  // outcomes are correct; running the gateway unasked is the one that is not.
  assert.match(io.said(), isInstalled("coinpay") ? /coinpay invoice create[\s\S]*--yes/ : /not on PATH/);
});

test("the CoinPay command line matches CoinPay's own grammar", () => {
  const invoice = {
    total: 1234.5,
    currency: "USDC",
    seconds: 3600,
    clientId: "acme",
    client: { name: "Acme Inc" },
    rate: { prefer: ["USDC"] },
    lines: [{ what: "code review" }],
  };
  const { ok, args } = coinpayArgs(invoice, { payee: { chain: "solana", address: "9xQe" }, dueDate: "2026-03-01" });
  assert.equal(ok, true);
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(args[0], "invoice");
  assert.equal(args[1], "create");
  // --currency is a three-letter fiat code in CoinPay's CLI; the settlement
  // ticker travels in --crypto-currency. USDC is a dollar, so a USDC-priced
  // invoice is a USD amount settled in USDC — that one is exact, not a guess.
  assert.equal(flag("--currency"), "USD");
  assert.equal(flag("--crypto-currency"), "USDC");
  assert.equal(flag("--amount"), "1234.50", "two decimals, which is what it validates");
  assert.equal(flag("--merchant-wallet-address"), "9xQe");
  assert.equal(flag("--due-date"), "2026-03-01");
  assert.match(flag("--notes"), /Acme Inc — 1h/);
});

test("a fiat rate with a crypto preference carries the preference over", () => {
  const invoice = { total: 100, currency: "USD", seconds: 3600, clientId: "acme", client: null, rate: { prefer: ["SOL", "fiat"] }, lines: [] };
  const { args } = coinpayArgs(invoice);
  assert.equal(args[args.indexOf("--crypto-currency") + 1], "SOL");
  const plain = coinpayArgs({ ...invoice, rate: { prefer: [] } });
  assert.equal(plain.args.includes("--crypto-currency"), false, "no preference, no flag");
});

test("a SOL-priced invoice is refused rather than sent as a dollar figure", () => {
  // 1.5 SOL is not $1.50 and not $150. Composing --amount 1.50 --currency USD
  // would put a number nobody computed in front of a client.
  const invoice = { total: 1.5, currency: "SOL", seconds: 3600, clientId: "acme", client: null, rate: {}, lines: [] };
  const composed = coinpayArgs(invoice);
  assert.equal(composed.ok, false);
  assert.match(composed.reason, /priced in SOL/);
  assert.equal(composed.args, undefined);
});

test("--send on a crypto-priced rate keeps the invoice and says why it stopped", async (t) => {
  const io = sandbox(t);
  clientCommand(["create", "Acme"], io);
  clientCommand(["payee", "acme", "solana:9xQe"], io);
  rateCommand(["set", "acme", "0.5 SOL/hour"], io);
  await timerCommand(["add", "acme", "3h"], io);
  io.lines.length = 0;
  const calls = [];
  const code = billingCommand(["acme", "--send", "--yes", "--gateway", "coinpay"], {
    ...io,
    run: (...args) => { calls.push(args); return { status: 0 }; },
  });
  assert.equal(calls.length, 0, "nothing was sent");
  assert.equal(code, 1);
  if (isInstalled("coinpay")) assert.match(io.said(), /priced in SOL/);
  // The time is still claimed and the invoice still recorded: the numbers were
  // right, only the rail could not carry them.
  assert.equal(Object.keys(loadBusiness().invoices).length, 1);
});
