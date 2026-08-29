// Tracked time × the rate they agreed to = the number you send them.
//
// This is the join, and it is the only file that touches all four of the other
// ones: the ledger from `/timer`, the rate from `/rate`, the address from
// `/client`, and the rail from `/payments`. It does the arithmetic nobody
// enjoys doing at the end of a month, and then it stops — moshcode composes an
// invoice, CoinPay (or Stripe, or a wallet) delivers it.
//
// Two rules the shape here exists to enforce:
//
//   Nothing is billed twice. An entry carries `billed` and the invoice id that
//   claimed it, and drafting is separate from claiming: `/billing acme` is a
//   preview you can run all day, `--mark` is the one that writes.
//
//   Nothing settles to an address nobody decided on. A client with no payee
//   and no default wallet gets a refusal, not a best guess, because the failure
//   mode of guessing is money arriving somewhere it cannot be recovered from.
import { spawnSync } from "node:child_process";

import { loadBusiness, loadTimers, newId, updateBusiness, updateTimers } from "./business-store.mjs";
import { clientLabel, parseFields, resolveClient } from "./clients.mjs";
import { captureSpec } from "./pty.mjs";
import { GATEWAYS, defaultGateway, gatewayState } from "./payments.mjs";
import { chargeFor, describeRate, formatMoney, isDollarPegged, isFiat, rateFor } from "./rates.mjs";
import { humanDuration, selectEntries, windowFrom } from "./timer.mjs";
import { acid, ash, bone, err, info, ok, table, warn } from "./ui.mjs";

/** A line is a task; entries against the same task collapse into one. */
function lineKeyFor(entry) {
  return entry.task || entry.note || "untracked";
}

/**
 * Turn a window of tracked time into an invoice draft.
 *
 * Charged per entry and then summed, not summed and then charged: the agent
 * count varies between entries, and an average would quietly bill a two-agent
 * afternoon at the four-agent rate (or the other way round, which is worse for
 * a different reason).
 */
export function buildInvoice({ business, timers, clientId, since = null, until = null, all = false }) {
  const client = business.clients?.[clientId] || null;
  const rate = rateFor(business, clientId);
  const entries = selectEntries(timers.entries || [], { client: clientId, since, until, unbilled: !all });

  const lines = new Map();
  const warnings = [];
  let total = 0;
  let seconds = 0;
  const currency = rate?.currency || "USD";

  for (const entry of entries) {
    seconds += entry.seconds || 0;
    const charge = chargeFor(entry, rate);
    const key = lineKeyFor(entry);
    const line = lines.get(key) || { what: key, seconds: 0, agents: 0, amount: 0, entries: [], flat: false };
    line.seconds += entry.seconds || 0;
    line.agents = Math.max(line.agents, entry.agents || 1);
    line.entries.push(entry.id);
    if (charge?.amount != null) { line.amount += charge.amount; total += charge.amount; }
    if (charge?.flat) line.flat = true;
    lines.set(key, line);
    if (rate?.cap && (entry.agents || 1) > rate.cap) {
      warnings.push(`${entry.id}: ${entry.agents} agents ran, ${rate.cap} billed (the cap)`);
    }
  }

  // A flat project fee is earned once, however many entries sit under it.
  if (rate?.per === "project" && entries.length) {
    lines.set("project fee", { what: "project fee", seconds: 0, agents: 0, amount: rate.amount, entries: [], flat: true });
    total += rate.amount;
  }

  return {
    clientId,
    client,
    rate,
    currency,
    lines: [...lines.values()],
    entries,
    entryIds: entries.map((e) => e.id),
    seconds,
    total,
    warnings,
  };
}

/**
 * Where this client's money should land: their payee, else the wallet rail.
 *
 * Per-client because the answer genuinely differs — one client pays a business
 * account, another pays a project wallet — and a single global address makes
 * that impossible to express without a second tool.
 */
export function settlementFor(business, clientId) {
  const client = business.clients?.[clientId];
  if (client?.payee?.address) return { ...client.payee, source: "client" };
  const wallet = business.payments?.gateways?.wallet;
  if (wallet?.address) return { chain: wallet.chain, address: wallet.address, source: "wallet" };
  return null;
}

/**
 * The CoinPay command line that turns a draft into a real invoice:
 * `{ ok, args }`, or `{ ok: false, reason }`.
 *
 * Built rather than run: the amount, the currency and the address are decisions
 * with consequences, and the last thing between them and a stranger's wallet
 * should be a line a person can read. `--yes` is what runs it, which is the
 * same convention CoinPay's own CLI uses for its irreversible verbs.
 *
 * The currency split is CoinPay's, not ours: `--currency` is a three-letter
 * fiat code and the settlement ticker travels in `--crypto-currency`. That
 * expresses a dollar-priced invoice settled in crypto exactly, and a
 * USDC-priced one honestly, because USDC is a dollar. It cannot express a rate
 * priced in SOL or BTC — the fiat amount would be a number nobody computed —
 * so that case is refused with its reason rather than converted by guesswork.
 */
export function coinpayArgs(invoice, { payee = null, dueDate = null } = {}) {
  const currency = invoice.currency;
  if (!isFiat(currency) && !isDollarPegged(currency)) {
    return {
      ok: false,
      reason: `this rate is priced in ${currency}, and a CoinPay invoice carries a fiat amount — `
        + `price it in a currency (--prefer ${currency} keeps the settlement) or send it yourself`,
    };
  }
  const priced = isFiat(currency) ? currency : "USD";
  const crypto = isFiat(currency)
    ? (invoice.rate?.prefer || []).find((c) => !isFiat(c)) || null
    : currency;
  const args = [
    "invoice", "create",
    "--amount", invoice.total.toFixed(2),
    "--currency", priced,
  ];
  if (crypto) args.push("--crypto-currency", crypto);
  if (dueDate) args.push("--due-date", dueDate);
  if (payee?.address) args.push("--merchant-wallet-address", payee.address);
  args.push("--notes", invoiceNote(invoice));
  return { ok: true, args };
}

function invoiceNote(invoice) {
  const who = invoice.client?.name || invoice.clientId || "work";
  const lines = invoice.lines.filter((l) => l.what !== "project fee").map((l) => l.what);
  const summary = lines.length ? `: ${lines.slice(0, 3).join(", ")}${lines.length > 3 ? `, +${lines.length - 3} more` : ""}` : "";
  return `${who} — ${humanDuration(invoice.seconds)}${summary}`;
}

const USAGE = [
  "usage: /billing <client> [--today|--week|--month|--since <date>] [--all] [--json]",
  "       /billing <client> --mark            claim the time and record an invoice",
  "       /billing <client> --send [--yes]    hand it to the connected gateway",
  "       /billing list · /billing show <id> · /billing void <id>",
];

export function billingCommand(argv = [], { write = console.log, run = spawnSync } = {}) {
  const verb = String(argv[0] ?? "").toLowerCase();
  if (["list", "ls", ""].includes(verb) && argv.length <= 1) return listInvoices(argv.includes("--json"), write);
  if (["show", "get"].includes(verb)) return showInvoice(argv[1], argv.includes("--json"), write);
  if (["void", "cancel"].includes(verb)) return voidInvoice(argv[1], write);
  return draftInvoice(argv, write, run);
}

function draftInvoice(argv, write, run) {
  const { fields, rest } = parseFields(argv);
  const business = loadBusiness();
  const timers = loadTimers();

  const found = resolveClient(business, rest[0]);
  if (!found.ok) {
    if (found.reason === "ambiguous") { write(err(`${JSON.stringify(rest[0])} matches ${found.matches.join(", ")} — say which`)); return 1; }
    write(err(`no client ${JSON.stringify(rest[0] ?? "")} — ${acid("/client list")}`));
    USAGE.forEach(write);
    return 1;
  }

  const invoice = buildInvoice({
    business,
    timers,
    clientId: found.id,
    since: windowFrom(fields),
    all: Boolean(fields.all),
  });

  if (fields.json) { write(JSON.stringify(invoice, null, 2)); return 0; }

  if (!invoice.entries.length) {
    write(info(`nothing unbilled for ${bone(found.id)}${fields.all ? "" : " — --all to include time already billed"}`));
    return 0;
  }
  if (!invoice.rate) {
    write(err(`no rate for ${bone(found.id)} — ${acid(`/rate set ${found.id} $100/hour/agent/upto:4`)}`));
    return 1;
  }

  write(`  ${clientLabel(found.id, invoice.client)} ${ash("·")} ${ash(describeRate(invoice.rate))}`);
  write(table(
    invoice.lines.map((l) => [
      l.what,
      l.seconds ? humanDuration(l.seconds) : ash("—"),
      l.agents > 1 ? `${l.agents}×` : "",
      acid(formatMoney(l.amount, invoice.currency)),
    ]),
    { columns: ["what", "time", "agents", "amount"], indent: 2 },
  ));
  write(`  ${ash("total")} ${bone(humanDuration(invoice.seconds))} ${ash("→")} ${acid(formatMoney(invoice.total, invoice.currency))}`);
  for (const note of invoice.warnings) write(`  ${ash(note)}`);

  const settlement = settlementFor(business, found.id);
  if (!settlement) {
    write(warn("no payee for this client and no wallet rail — nothing to settle to"));
    write(`  ${acid(`/client payee ${found.id} solana:<address>`)} ${ash("or")} ${acid("/payments connect wallet --chain solana --address <addr>")}`);
  } else {
    write(`  ${ash("settles to")} ${acid(`${settlement.chain}:${settlement.address}`)} ${ash(`(${settlement.source})`)}`);
  }

  if (!fields.mark && !fields.send) {
    write(`  ${ash("this is a preview —")} ${acid(`/billing ${found.id} --mark`)} ${ash("claims the time,")} ${acid("--send")} ${ash("hands it to the gateway")}`);
    return 0;
  }

  if (!settlement) return 1;

  const record = commitInvoice(invoice, settlement);
  const claimed = record.entryIds.length;
  write(ok(`invoice ${bone(record.id)} — ${acid(formatMoney(record.total, record.currency))} ${ash(`(${claimed} ${claimed === 1 ? "entry" : "entries"} claimed)`)}`));

  if (!fields.send) return 0;
  return handOff(record, invoice, business, fields, write, run);
}

/** Write the invoice and mark its entries, in that order. */
function commitInvoice(invoice, settlement) {
  const id = newId("inv-");
  const record = {
    id,
    client: invoice.clientId,
    createdAt: new Date().toISOString(),
    currency: invoice.currency,
    total: invoice.total,
    seconds: invoice.seconds,
    lines: invoice.lines,
    entryIds: invoice.entryIds,
    rate: invoice.rate,
    settlement,
    status: "draft",
    gateway: null,
    gatewayRef: null,
  };
  updateBusiness((data) => { data.invoices[id] = record; });
  updateTimers((data) => {
    for (const entry of data.entries) {
      if (record.entryIds.includes(entry.id)) { entry.billed = true; entry.invoice = id; }
    }
  });
  return record;
}

function handOff(record, invoice, business, fields, write, run) {
  const key = fields.gateway && fields.gateway !== true ? String(fields.gateway).toLowerCase() : defaultGateway(business);
  if (!key || !GATEWAYS[key]) {
    write(warn("no payment rail chosen — the invoice is recorded, but nothing was sent"));
    write(`  ${acid("/payments connect coinpay")}`);
    return 1;
  }
  if (key !== "coinpay") {
    // Every other rail is a passthrough moshcode has not been taught to speak.
    // Saying so is better than composing a command line from guesswork.
    write(info(`${bone(key)} is connected, but moshcode only composes CoinPay invoices`));
    write(`  ${ash("the numbers are above, and")} ${acid(`/billing show ${record.id}`)} ${ash("has them again whenever you need them")}`);
    return 0;
  }

  const state = gatewayState("coinpay", business);
  if (!state.installed) { write(err(`coinpay is not on PATH — ${acid("/install coinpay")}`)); return 1; }

  const composed = coinpayArgs({ ...invoice, total: record.total }, { payee: record.settlement, dueDate: fields.due && fields.due !== true ? String(fields.due) : null });
  if (!composed.ok) {
    write(warn(composed.reason));
    write(`  ${ash(`invoice ${record.id} is recorded either way —`)} ${acid(`/billing show ${record.id}`)}`);
    return 1;
  }
  const { args } = composed;
  const printable = `coinpay ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
  write(`  ${ash(printable)}`);
  if (!fields.yes) {
    write(`  ${ash("read it, then")} ${acid(`/billing ${record.client} --send --yes`)} ${ash("to run it")}`);
    return 0;
  }

  // Mirrored like every other hand-off: sending an invoice is exactly the kind
  // of thing you want to read back from the session page afterwards.
  const launch = captureSpec({ cmd: "coinpay", args });
  let result;
  try { result = run(launch.cmd, launch.args, { stdio: "inherit" }); }
  finally { launch.stop(); }
  if (result?.error) { write(err(String(result.error.message || result.error))); return 1; }
  if (result?.status) { write(err(`coinpay exited ${result.status} — invoice ${record.id} is still a local draft`)); return result.status; }
  updateBusiness((data) => {
    data.invoices[record.id].gateway = "coinpay";
    data.invoices[record.id].status = "handed-off";
  });
  write(ok(`handed to CoinPay — ${acid("coinpay invoice send <id>")} ${ash("emails it to the client")}`));
  return 0;
}

function listInvoices(json, write) {
  const { invoices } = loadBusiness();
  const ids = Object.keys(invoices).sort();
  if (json) { write(JSON.stringify(invoices, null, 2)); return 0; }
  if (!ids.length) { write(info("no invoices yet.")); write(`  ${acid("/billing <client> --mark")}`); return 0; }
  write(table(
    ids.map((id) => {
      const inv = invoices[id];
      return [
        bone(id),
        inv.client || "",
        ash(String(inv.createdAt || "").slice(0, 10)),
        humanDuration(inv.seconds),
        acid(formatMoney(inv.total, inv.currency)),
        ash(inv.status || "draft"),
      ];
    }),
    { columns: ["id", "client", "date", "time", "amount", "status"], indent: 2 },
  ));
  return 0;
}

function showInvoice(id, json, write) {
  const { invoices } = loadBusiness();
  const invoice = invoices[String(id ?? "")];
  if (!invoice) { write(err(`no invoice ${JSON.stringify(id ?? "")} — ${acid("/billing list")}`)); return 1; }
  if (json) { write(JSON.stringify(invoice, null, 2)); return 0; }
  write(`  ${bone(invoice.id)} ${ash(invoice.client || "")} ${ash(String(invoice.createdAt).slice(0, 10))}`);
  write(table(
    invoice.lines.map((l) => [l.what, l.seconds ? humanDuration(l.seconds) : ash("—"), acid(formatMoney(l.amount, invoice.currency))]),
    { columns: ["what", "time", "amount"], indent: 2 },
  ));
  write(`  ${ash("total")} ${acid(formatMoney(invoice.total, invoice.currency))} ${ash(`· ${invoice.status}`)}`);
  if (invoice.settlement) write(`  ${ash("settles to")} ${acid(`${invoice.settlement.chain}:${invoice.settlement.address}`)}`);
  return 0;
}

/**
 * Undo the claim, not the invoice.
 *
 * The entries go back to unbilled so they can be re-drafted; the invoice record
 * stays and is marked void. Deleting it would erase the fact that a number was
 * once quoted, which is exactly the fact somebody comes looking for.
 */
function voidInvoice(id, write) {
  const key = String(id ?? "");
  const { invoices } = loadBusiness();
  const invoice = invoices[key];
  if (!invoice) { write(err(`no invoice ${JSON.stringify(key)}`)); return 1; }
  if (invoice.status === "void") { write(info(`${key} is already void`)); return 0; }
  updateBusiness((data) => { data.invoices[key].status = "void"; data.invoices[key].voidedAt = new Date().toISOString(); });
  updateTimers((data) => {
    for (const entry of data.entries) {
      if (entry.invoice === key) { entry.billed = false; entry.invoice = null; }
    }
  });
  write(ok(`${bone(key)} void — ${invoice.entryIds.length} entries are billable again`));
  return 0;
}

export { USAGE as BILLING_USAGE };
