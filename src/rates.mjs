// What an hour of agent time costs, written the way people say it out loud.
//
//   /rate set acme $100/hour/agent/upto:4
//
// One line that carries four decisions: the price, the period it is charged
// for, the thing that is multiplied (an agent, a seat, a person), and the point
// past which you stop charging. Rate cards get written down as prose in a
// contract and then re-derived by hand at invoice time; this makes the prose
// itself the machine-readable form, so `/billing` does the arithmetic from the
// same words the client agreed to.
//
// Settlement currency is deliberately separate from the price. "$100/hour paid
// in USDC" is one rate with a preference, not two rates — the number in the
// contract does not change because the rail did.
import { loadBusiness, updateBusiness } from "./business-store.mjs";
import { resolveClient } from "./clients.mjs";
import { acid, ash, bone, err, info, ok, table } from "./ui.mjs";

/** Periods a rate can be charged per. `project` and `task` are flat fees. */
export const PERIODS = ["hour", "day", "week", "month", "project", "task"];

/** What gets multiplied. `flat` means the price is not per-anything. */
export const UNITS = ["agent", "seat", "person", "team", "flat"];

/** Hours in each period, for converting tracked time into billable units. */
export const PERIOD_HOURS = { hour: 1, day: 8, week: 40, month: 160 };

/** Currency symbols worth understanding, and the code each means. */
const SYMBOLS = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };

/**
 * Codes that are money in the ISO sense — the ones Intl can format.
 *
 * The list matters because everything *not* on it is formatted as a bare
 * number and a ticker (`250 USDC`), which is how crypto amounts are read
 * everywhere else. Intl.NumberFormat would happily accept "USDC" and then
 * render "USDC 250.00", which is nobody's idea of a price.
 */
const FIAT = new Set(["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "SEK", "NOK", "NZD"]);

/** Tickers we accept without a symbol. Not exhaustive — an unknown code is kept as typed. */
const KNOWN_CRYPTO = new Set(["SOL", "USDC", "USDT", "BTC", "ETH", "MATIC", "BNB", "XRP", "DOGE", "LTC", "AVAX", "ADA"]);

/**
 * Stablecoins pegged 1:1 to the dollar.
 *
 * They matter because a gateway's invoice usually carries a fiat amount and a
 * separate settlement ticker. "250 USDC" is a $250 invoice settled in USDC and
 * can be expressed that way honestly; "1.5 SOL" is not $1.50 or $150 or any
 * other number we know, and pretending otherwise would put a wrong figure in
 * front of a client. So the peg is written down rather than assumed.
 */
const DOLLAR_PEGGED = new Set(["USDC", "USDT", "DAI", "PYUSD", "USDP", "TUSD"]);

export function isFiat(code) {
  return FIAT.has(String(code || "").toUpperCase());
}

export function isDollarPegged(code) {
  return DOLLAR_PEGGED.has(String(code || "").toUpperCase());
}

/**
 * Render an amount the way its currency is normally written.
 *
 * Fiat goes through Intl (symbol, grouping, two decimals); anything else is
 * `<amount> <TICKER>`, trimmed of trailing zeros — 0.5 SOL is 0.5 SOL, not
 * 0.50 SOL, and a USDC total of 1250 should not read as 1,250.00 USDC.
 */
export function formatMoney(amount, currency = "USD") {
  const code = String(currency || "USD").toUpperCase();
  const n = Number(amount);
  if (!Number.isFinite(n)) return `— ${code}`;
  if (isFiat(code)) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(n);
  }
  // Up to 8 decimals so a BTC figure survives, but no padding: crypto amounts
  // are read as quantities, and "0.10000000 BTC" hides the number in zeros.
  const fixed = n.toFixed(8).replace(/\.?0+$/, "");
  return `${fixed} ${code}`;
}

function parseAmount(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  // "$100", "100USD", "100 USD", "USDC250", "0.5 SOL" — one shape, read from
  // both ends, because all four spellings turn up in the same conversation.
  const symbol = SYMBOLS[raw[0]];
  const body = symbol ? raw.slice(1) : raw;
  const m = body.match(/^([a-z]{2,5})?\s*([0-9][0-9_,]*(?:\.[0-9]+)?)\s*([a-z]{2,5})?$/i);
  if (!m) return null;
  const amount = Number(m[2].replace(/[_,]/g, ""));
  if (!Number.isFinite(amount) || amount < 0) return null;
  const code = (m[1] || m[3] || "").toUpperCase();
  if (code && !isFiat(code) && !KNOWN_CRYPTO.has(code) && !/^[A-Z]{3,5}$/.test(code)) return null;
  return { amount, currency: code || symbol || "USD" };
}

/**
 * Parse a rate spec into `{ amount, currency, per, unit, cap, min }`, or throw.
 *
 * The grammar is positional only in its first segment (the price); everything
 * after it is recognised by what it says rather than where it sits, so
 * `$100/agent/hour` and `$100/hour/agent` mean the same thing. People do not
 * remember an order they were never told.
 */
export function parseRate(spec) {
  const text = String(spec ?? "").trim();
  if (!text) throw new Error("a rate looks like $100/hour/agent/upto:4");
  const parts = text.split("/").map((p) => p.trim()).filter(Boolean);
  const price = parseAmount(parts.shift());
  if (!price) throw new Error(`can't read a price out of ${JSON.stringify(text)} — try $100/hour/agent`);

  const rate = { ...price, per: "hour", unit: "flat", cap: null, min: null };
  let sawPeriod = false;
  for (const part of parts) {
    const [key, value] = part.split(":").map((s) => s.trim().toLowerCase());
    if (["upto", "up-to", "max", "cap"].includes(key)) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`upto: wants a whole number of units, got ${JSON.stringify(value ?? "")}`);
      rate.cap = n;
      continue;
    }
    if (["min", "minimum", "floor"].includes(key)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error(`min: wants a number, got ${JSON.stringify(value ?? "")}`);
      rate.min = n;
      continue;
    }
    const word = key.replace(/s$/, "");
    if (PERIODS.includes(word)) { rate.per = word; sawPeriod = true; continue; }
    if (word === "hr") { rate.per = "hour"; sawPeriod = true; continue; }
    if (word === "mo") { rate.per = "month"; sawPeriod = true; continue; }
    if (word === "yr" || word === "year") { rate.per = "month"; rate.amount /= 12; sawPeriod = true; continue; }
    if (UNITS.includes(word)) { rate.unit = word; continue; }
    if (word === "head" || word === "dev" || word === "engineer") { rate.unit = "person"; continue; }
    throw new Error(`don't know what ${JSON.stringify(part)} means in a rate — periods: ${PERIODS.join("/")}, units: ${UNITS.join("/")}, or upto:N`);
  }
  // A flat fee with no period stated is a project fee, not an hourly one: "$5000
  // for the project" is how it is written, and defaulting it to per-hour would
  // silently multiply the invoice by every hour tracked.
  if (!sawPeriod && rate.unit === "flat" && rate.cap === null) rate.per = "hour";
  if (rate.cap !== null && rate.unit === "flat") {
    throw new Error("upto: caps a unit, so say what it caps — $100/hour/agent/upto:4");
  }
  return rate;
}

/** The canonical spelling of a parsed rate — round-trips through parseRate. */
export function formatRate(rate) {
  if (!rate) return "—";
  const bits = [formatMoney(rate.amount, rate.currency), rate.per];
  if (rate.unit && rate.unit !== "flat") bits.push(rate.unit);
  if (rate.cap) bits.push(`upto:${rate.cap}`);
  if (rate.min) bits.push(`min:${rate.min}`);
  return bits.join("/");
}

/** How a rate reads in a sentence, for confirmations and invoices. */
export function describeRate(rate) {
  if (!rate) return "no rate set";
  const price = formatMoney(rate.amount, rate.currency);
  const per = rate.per === "project" || rate.per === "task" ? `per ${rate.per}` : `per ${rate.per}`;
  const unit = rate.unit && rate.unit !== "flat" ? ` per ${rate.unit}` : "";
  const cap = rate.cap ? `, billing at most ${rate.cap} ${rate.unit}${rate.cap === 1 ? "" : "s"}` : "";
  const settle = settlementNote(rate);
  return `${price} ${per}${unit}${cap}${settle ? ` (${settle})` : ""}`;
}

/** "prefers SOL or USDC, fiat accepted" — or "" when nothing was stated. */
export function settlementNote(rate) {
  const prefer = rate?.prefer || [];
  const accept = rate?.accept || [];
  if (!prefer.length && !accept.length) return "";
  const bits = [];
  if (prefer.length) bits.push(`prefers ${prefer.join(" or ")}`);
  if (accept.length) bits.push(`${accept.join(", ")} accepted`);
  return bits.join(", ");
}

/**
 * The rate that applies to a client: their own, else the default, else null.
 *
 * A default rate is the common case for a solo shop — one number, everybody
 * pays it — and a per-client override is what happens the first time somebody
 * negotiates. Neither should require restating the other.
 */
export function rateFor(business, clientId) {
  const rates = business?.rates || {};
  if (clientId && rates[clientId]) return { ...rates[clientId], source: clientId };
  if (rates.default) return { ...rates.default, source: "default" };
  return null;
}

/**
 * Which key a rate is filed under: `default`, or a real client id.
 *
 * Rates are looked up by client id, so a rate filed under a name that is not
 * one — `/rate set acme …` when the client is `acme-inc` — is a rate that never
 * applies to anything. It fails silently at exactly the wrong moment: the
 * invoice comes out at the default rate and looks fine. So the target is
 * resolved the same way `/timer on` and `/billing` resolve a client, and an
 * unknown one is refused rather than filed somewhere nothing will read it.
 */
export function resolveRateTarget(business, token) {
  const want = String(token ?? "").trim().toLowerCase();
  if (!want || want === "default" || want === "*") return { ok: true, id: "default" };
  return resolveClient(business, want);
}

/** Words that are categories rather than tickers, and stay lowercase. */
const SETTLEMENT_WORDS = new Set(["fiat", "crypto", "stablecoin", "any", "cash"]);

/** Split `--prefer sol,usdc --accept fiat` off an argv, returning both halves. */
export function splitSettlement(argv) {
  const rest = [];
  const out = { prefer: [], accept: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prefer" || arg === "--accept") {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        out[key] = value.split(",").map((s) => s.trim()).filter(Boolean)
          .map((s) => (SETTLEMENT_WORDS.has(s.toLowerCase()) ? s.toLowerCase() : s.toUpperCase()));
        i += 1;
      }
      continue;
    }
    rest.push(arg);
  }
  return { argv: rest, settlement: out };
}

const USAGE = [
  "usage: /rate set <client|default> <spec> [--prefer SOL,USDC] [--accept fiat]",
  "       /rate [list] [--json] · /rate show <client> · /rate rm <client>",
  "  spec: $100/hour/agent/upto:4 · 0.5 SOL/day · $5000/project · 250 USDC/task",
];

/**
 * `/rate` and `/rates`.
 *
 * `set:` with a colon is accepted because that is how it was first written down
 * (`/rates set: $100/hour/agent/upto:4`), and refusing punctuation somebody
 * already typed teaches them nothing.
 */
export function rateCommand(argv = [], { write = console.log } = {}) {
  const args = [...argv];
  const json = args.includes("--json");
  const positional = args.filter((a) => a !== "--json");
  const verb = (positional[0] || "list").replace(/:$/, "").toLowerCase();

  if (["list", "ls", ""].includes(verb) && positional.length <= 1) {
    const { rates } = loadBusiness();
    const names = Object.keys(rates).sort();
    if (json) { write(JSON.stringify(rates, null, 2)); return 0; }
    if (!names.length) {
      write(info("no rates yet."));
      write(`  ${acid("/rate set default $100/hour/agent/upto:4")}`);
      return 0;
    }
    write(table(
      names.map((name) => [bone(name), acid(formatRate(rates[name])), ash(settlementNote(rates[name]))]),
      { columns: ["who", "rate", "settlement"], indent: 2 },
    ));
    return 0;
  }

  if (verb === "set") {
    const { argv: words, settlement } = splitSettlement(positional.slice(1));
    if (!words.length) { USAGE.forEach(write); return 1; }
    // `/rate set $100/hour` with no target is the default rate — the shape
    // somebody types when they have exactly one price and no client list yet.
    let target = "default";
    let spec = words.join(" ");
    if (words.length > 1 && !parseSafely(words[0])) {
      const found = resolveRateTarget(loadBusiness(), words[0]);
      if (!found.ok) {
        write(err(`no client ${JSON.stringify(words[0])} — ${acid(`/client create ${words[0]}`)} first, or set the ${bone("default")} rate`));
        return 1;
      }
      target = found.id;
      spec = words.slice(1).join(" ");
    }
    let rate;
    try { rate = parseRate(spec); }
    catch (e) { write(err(String(e.message || e))); write(`  ${ash(USAGE[2])}`); return 1; }
    if (settlement.prefer.length) rate.prefer = settlement.prefer;
    if (settlement.accept.length) rate.accept = settlement.accept;
    updateBusiness((data) => { data.rates[target] = rate; });
    write(ok(`${bone(target)} → ${acid(formatRate(rate))}`));
    write(`  ${ash(describeRate(rate))}`);
    return 0;
  }

  if (["show", "get"].includes(verb)) {
    const business = loadBusiness();
    const found = resolveRateTarget(business, positional[1] || "default");
    const who = found.ok ? found.id : String(positional[1]).toLowerCase();
    const rate = rateFor(business, who);
    if (!rate) { write(err(`no rate for ${JSON.stringify(who)} and no default — /rate set ${who} $100/hour/agent`)); return 1; }
    if (json) { write(JSON.stringify(rate, null, 2)); return 0; }
    write(`  ${bone(who)} ${acid(formatRate(rate))}${rate.source !== who ? ash(`  (from ${rate.source})`) : ""}`);
    write(`  ${ash(describeRate(rate))}`);
    return 0;
  }

  if (["rm", "remove", "delete", "unset"].includes(verb)) {
    if (!positional[1]) { write(err("usage: /rate rm <client|default>")); return 1; }
    const found = resolveRateTarget(loadBusiness(), positional[1]);
    // A rate can outlive the client it was filed under (`/client rm` drops the
    // rate, but a hand-edited file need not have), so an unresolved name still
    // gets to name a key here — this verb only ever removes.
    const who = found.ok ? found.id : String(positional[1]).toLowerCase();
    const existed = updateBusiness((data) => {
      const had = Object.hasOwn(data.rates, who);
      delete data.rates[who];
      return had;
    });
    write(existed ? ok(`dropped the rate for ${bone(who)}`) : info(`no rate for ${JSON.stringify(who)}`));
    return existed ? 0 : 1;
  }

  // A bare `/rate $100/hour` reads as "set my rate", and that is the only other
  // thing the word can mean here.
  if (parseSafely(positional.join(" "))) return rateCommand(["set", ...positional], { write });

  write(err(`unknown /rate verb ${JSON.stringify(verb)}`));
  USAGE.forEach(write);
  return 1;
}

function parseSafely(spec) {
  try { return parseRate(spec); }
  catch { return null; }
}

/**
 * What one tracked stretch of work is worth: `{ hours, units, amount, currency, flat }`.
 *
 * The arithmetic everybody does in their head and gets wrong once a quarter.
 * Two things make it more than a multiplication:
 *
 *   - the cap. `$100/hour/agent/upto:4` means four agents cost four hundred an
 *     hour and *so do six* — the cap is the promise that made the client sign,
 *     and it has to be applied here rather than remembered at invoice time.
 *   - the floor. `min:1` bills a fifteen-minute call as an hour, which is the
 *     other half of the same contract.
 *
 * A flat fee (`$5000/project`) returns `flat: true` and no amount: it is not
 * earned per entry, so it is the invoice's job to add it once. Returning zero
 * here would quietly bill nothing for a project that was fully delivered.
 */
export function chargeFor({ seconds = 0, agents = 1 } = {}, rate) {
  if (!rate) return null;
  const currency = rate.currency || "USD";
  if (rate.per === "project") return { hours: seconds / 3600, units: 1, amount: null, currency, flat: true, per: rate.per };
  const units = rate.unit === "flat" ? 1 : Math.max(1, Math.min(Number(agents) || 1, rate.cap ?? Infinity));
  if (rate.per === "task") {
    return { hours: seconds / 3600, units, amount: rate.amount * units, currency, flat: false, per: rate.per };
  }
  const perHours = PERIOD_HOURS[rate.per] ?? 1;
  let hours = seconds / 3600;
  if (rate.min) hours = Math.max(hours, rate.min * perHours);
  const periods = hours / perHours;
  return { hours: seconds / 3600, billedHours: hours, units, amount: rate.amount * periods * units, currency, flat: false, per: rate.per };
}
