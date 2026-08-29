// The rail an invoice goes out on.
//
// moshcode does not move money. It connects to something that does, and it is
// deliberately not opinionated about which: CoinPay is the one it knows best,
// and Stripe, PayPal, Coinbase and a bare wallet address are all first-class
// here because "which processor" is a decision a business already made, usually
// years ago, and usually not for reasons a CLI gets to relitigate.
//
// Three ways to be connected, because there are three kinds of gateway:
//
//   cli     the gateway ships a command line that owns its own OAuth session
//           (`coinpay login`, `stripe login`). Nothing is stored here — the
//           tool holds the credential, we hold the fact that you chose it.
//   oauth   the gateway wants an app registered in a dashboard. We record
//           where the credentials live and NOT what they are.
//   wallet  no gateway at all: a chain and an address. The fallback for when
//           the answer to "can we use CoinPay" is no.
//
// The thing this file will not do is hold a secret. There is a vault for that
// (`/secrets`, LogicSRC) and a rule behind it: keys belong somewhere they can
// be rotated and shared, not in a dotfile in one person's home directory. So
// `/payments connect stripe` records a *reference* — vault and key name — and
// says out loud where the secret should go.
import { spawnSync } from "node:child_process";
import { captureSpec } from "./pty.mjs";

import { loadBusiness, updateBusiness } from "./business-store.mjs";
import { parseFields } from "./clients.mjs";
import { isInstalled } from "./engines.mjs";
import { acid, ash, bone, err, info, ok, table, warn } from "./ui.mjs";

export const GATEWAYS = {
  coinpay: {
    desc: "CoinPay — crypto and fiat settlement, escrow, x402",
    kind: "cli",
    bin: "coinpay",
    tool: "coinpay",
    connect: ["login"],
    currencies: ["USDC", "SOL", "BTC", "ETH", "USD"],
    // The one gateway moshcode can hand a finished invoice to without the
    // operator retyping it — see src/billing.mjs.
    invoice: true,
  },
  stripe: {
    desc: "Stripe — cards, invoices, subscriptions (fiat)",
    kind: "cli",
    bin: "stripe",
    connect: ["login"],
    currencies: ["USD", "EUR", "GBP", "CAD", "AUD"],
    install: "https://docs.stripe.com/stripe-cli",
  },
  paypal: {
    desc: "PayPal — invoices and checkout (fiat)",
    kind: "oauth",
    dashboard: "https://developer.paypal.com/dashboard/applications",
    keys: ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"],
    currencies: ["USD", "EUR", "GBP"],
  },
  coinbase: {
    desc: "Coinbase Commerce / CDP — crypto checkout and onchain payouts",
    kind: "oauth",
    dashboard: "https://portal.cdp.coinbase.com/",
    keys: ["COINBASE_API_KEY", "COINBASE_API_SECRET"],
    currencies: ["USDC", "BTC", "ETH", "SOL"],
  },
  wallet: {
    desc: "a bare wallet address — no gateway, no fees, no dispute process",
    kind: "wallet",
    currencies: ["USDC", "SOL", "BTC", "ETH"],
  },
};

/** Resolve a gateway name to `[key, gateway]`, or null. */
export function resolveGateway(token) {
  const key = String(token ?? "").trim().toLowerCase();
  return Object.hasOwn(GATEWAYS, key) ? [key, GATEWAYS[key]] : null;
}

/**
 * What is connected, and how, for one gateway.
 *
 * "Connected" means something different per kind, and saying so plainly beats a
 * green tick that means four things. A CLI gateway is connected when the binary
 * is here AND somebody chose it — the binary alone only means it is installed,
 * which is not a decision.
 */
export function gatewayState(key, business = loadBusiness()) {
  const gateway = GATEWAYS[key];
  const record = business.payments?.gateways?.[key] || null;
  const installed = gateway.kind === "cli" ? isInstalled(gateway.bin) : null;
  const connected = Boolean(record) && (gateway.kind !== "cli" || installed);
  return { key, gateway, record, installed, connected, isDefault: business.payments?.default === key };
}

/** The gateway an invoice should go out on, or null. */
export function defaultGateway(business = loadBusiness()) {
  const chosen = business.payments?.default;
  if (chosen && GATEWAYS[chosen]) return chosen;
  const connected = Object.keys(GATEWAYS).filter((key) => gatewayState(key, business).connected);
  return connected.length === 1 ? connected[0] : null;
}

const USAGE = [
  "usage: /payments [list] · /payments status",
  "       /payments connect <gateway> [--vault <name>] [--chain solana --address <addr>]",
  "       /payments default <gateway> · /payments disconnect <gateway>",
  `  gateways: ${Object.keys(GATEWAYS).join(", ")}`,
];

export function paymentsCommand(argv = [], { write = console.log, run = spawnSync } = {}) {
  const verb = String(argv[0] ?? "list").toLowerCase();
  const args = argv.slice(1);

  if (["list", "ls", "status", ""].includes(verb)) return listGateways(argv.includes("--json"), write);
  if (["connect", "add", "login"].includes(verb)) return connectGateway(args, write, run);
  if (["disconnect", "rm", "remove", "logout"].includes(verb)) return disconnectGateway(args, write);
  if (["default", "use", "prefer"].includes(verb)) return setDefault(args, write);

  // `/payments coinpay` is "connect coinpay" — the only thing that word can
  // mean when it is a gateway name and nothing else was said.
  if (resolveGateway(verb)) return connectGateway([verb, ...args], write, run);

  write(err(`unknown /payments verb ${JSON.stringify(verb)}`));
  USAGE.forEach(write);
  return 1;
}

function listGateways(json, write) {
  const business = loadBusiness();
  const states = Object.keys(GATEWAYS).map((key) => gatewayState(key, business));
  if (json) {
    write(JSON.stringify(states.map((s) => ({
      key: s.key, kind: s.gateway.kind, connected: s.connected, installed: s.installed,
      default: s.isDefault, currencies: s.gateway.currencies, record: s.record,
    })), null, 2));
    return 0;
  }
  write(table(
    states.map((s) => [
      s.isDefault ? acid(`${s.key} ★`) : bone(s.key),
      ash(s.gateway.kind),
      statusWord(s),
      ash(s.gateway.currencies.join(" ")),
    ]),
    { columns: ["gateway", "how", "state", "settles in"], indent: 2 },
  ));
  const chosen = defaultGateway(business);
  write(chosen
    ? `  ${ash("invoices go out on")} ${acid(chosen)}`
    : `  ${ash("no default rail —")} ${acid("/payments connect coinpay")}`);
  return 0;
}

function statusWord(state) {
  if (state.connected) return acid("connected");
  if (state.gateway.kind === "cli" && state.record && !state.installed) return warn(`chosen, ${state.gateway.bin} missing`);
  if (state.gateway.kind === "cli" && state.installed) return ash("installed, not chosen");
  return ash("—");
}

function connectGateway(args, write, run) {
  const { fields, rest } = parseFields(args);
  const resolved = resolveGateway(rest[0]);
  if (!resolved) {
    write(err(`unknown gateway ${JSON.stringify(rest[0] ?? "")} — one of ${Object.keys(GATEWAYS).join(", ")}`));
    return 1;
  }
  const [key, gateway] = resolved;

  if (gateway.kind === "wallet") return connectWallet(key, fields, write);
  if (gateway.kind === "oauth") return connectOauth(key, gateway, fields, write);

  // A CLI gateway: the binary owns the session, so the honest connect is to run
  // its own login and record which rail was chosen.
  if (!isInstalled(gateway.bin)) {
    write(err(`${bone(gateway.bin)} is not on PATH`));
    if (gateway.tool) write(`  ${acid(`/install ${gateway.tool}`)}`);
    else if (gateway.install) write(`  ${ash(gateway.install)}`);
    return 1;
  }
  write(info(`handing you to ${bone(gateway.bin)} — it owns its own session`));
  const launch = captureSpec({ cmd: gateway.bin, args: gateway.connect });
  let result;
  try { result = run(launch.cmd, launch.args, { stdio: "inherit" }); }
  finally { launch.stop(); }
  if (result?.error) { write(err(String(result.error.message || result.error))); return 1; }
  if (result?.status) {
    write(err(`${gateway.bin} ${gateway.connect.join(" ")} exited ${result.status} — nothing recorded`));
    return result.status;
  }
  record(key, { via: "cli", bin: gateway.bin });
  write(ok(`${bone(key)} connected ${ash(`(${gateway.bin} holds the credential, not moshcode)`)}`));
  return 0;
}

function connectOauth(key, gateway, fields, write) {
  const vault = fields.vault && fields.vault !== true ? String(fields.vault) : null;
  record(key, { via: "oauth", vault, keys: gateway.keys });
  write(ok(`${bone(key)} recorded as your rail`));
  write(`  ${ash("register an app:")} ${gateway.dashboard}`);
  write(`  ${ash("then put the credentials in the vault, not in a dotfile:")}`);
  const where = vault ? ` --vault ${vault}` : "";
  for (const name of gateway.keys) write(`    ${acid(`/secrets set ${name}${where}`)}`);
  if (!vault) write(`  ${ash("no --vault given — say which one so this record points somewhere")}`);
  return 0;
}

function connectWallet(key, fields, write) {
  const address = fields.address && fields.address !== true ? String(fields.address) : null;
  const chain = fields.chain && fields.chain !== true ? String(fields.chain).toLowerCase() : null;
  if (!address || !chain) {
    write(err("a wallet needs both: /payments connect wallet --chain solana --address <addr>"));
    return 1;
  }
  record(key, { via: "wallet", chain, address });
  write(ok(`paid straight to ${acid(`${chain}:${address}`)}`));
  write(`  ${ash("no gateway means no chargeback, no dispute, and no invoice status — it is on you to reconcile")}`);
  return 0;
}

function record(key, details) {
  updateBusiness((data) => {
    data.payments.gateways ||= {};
    data.payments.gateways[key] = { ...details, connectedAt: new Date().toISOString() };
    // First rail wins the default, because somebody who connected exactly one
    // gateway has already answered "which one".
    if (!data.payments.default) data.payments.default = key;
  });
}

function disconnectGateway(args, write) {
  const resolved = resolveGateway(args[0]);
  if (!resolved) { write(err(`unknown gateway ${JSON.stringify(args[0] ?? "")}`)); return 1; }
  const [key, gateway] = resolved;
  const had = updateBusiness((data) => {
    const existed = Boolean(data.payments?.gateways?.[key]);
    if (data.payments?.gateways) delete data.payments.gateways[key];
    if (data.payments?.default === key) delete data.payments.default;
    return existed;
  });
  if (!had) { write(info(`${key} was not connected`)); return 1; }
  write(ok(`${bone(key)} disconnected`));
  if (gateway.kind === "cli") {
    // Forgetting the choice is not the same as ending the session, and saying
    // so is the difference between a clean disconnect and a surprise later.
    write(`  ${ash(`${gateway.bin} is still logged in —`)} ${acid(`${gateway.bin} logout`)} ${ash("if you meant that too")}`);
  }
  return 0;
}

function setDefault(args, write) {
  const resolved = resolveGateway(args[0]);
  if (!resolved) { write(err(`unknown gateway ${JSON.stringify(args[0] ?? "")}`)); return 1; }
  const [key] = resolved;
  const state = gatewayState(key);
  if (!state.record) { write(err(`${key} is not connected — ${acid(`/payments connect ${key}`)}`)); return 1; }
  updateBusiness((data) => { data.payments.default = key; });
  write(ok(`invoices go out on ${bone(key)}`));
  return 0;
}

export { USAGE as PAYMENTS_USAGE };
