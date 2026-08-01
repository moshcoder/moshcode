// Validation, policy and resolution precedence for Moshpit names.
//
// Deliberately free of any database import so it can be tested -- and reused by
// a client, such as the tronbrowser.dev extension -- without a libSQL
// connection. src/moshpit.mjs owns the storage.

/**
 * Names nobody may claim, whatever the first-come-first-served rule says.
 *
 * The moment a namespace sells `.bank` or `.apple` it has a phishing and
 * trademark problem, and neither is cheap to unwind after the fact. A static
 * list is a blunt instrument, but it is the one that works on day one.
 */
export const RESERVED_TLDS = new Set([
  // trades on trust in money
  "bank", "banking", "paypal", "visa", "mastercard", "amex", "stripe", "coinbase",
  // trades on trust in a company
  "apple", "google", "microsoft", "amazon", "meta", "facebook", "netflix", "openai",
  "anthropic", "github", "x", "twitter", "tesla",
  // trades on trust in an institution
  "gov", "police", "nhs", "irs", "fbi", "army", "navy",
  // ours: the network's own names are not for sale
  "moshpit", "moshcode", "moshcoding", "profullstack", "logicsrc",
  // collide with the legacy internet in ways that would only ever confuse
  "com", "net", "org", "edu", "mil", "int", "arpa", "localhost", "local", "onion", "test", "invalid", "example",
]);

/** A TLD label: lowercase letters, digits and dashes; no leading/trailing dash. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A hostname label. Unlike a TLD, an all-numeric label is valid. */
export function normalizeLabel(input) {
  const raw = String(input ?? "").trim().toLowerCase();
  return raw && raw.length <= 63 && LABEL.test(raw) ? raw : null;
}

/**
 * Normalise user input into a bare TLD label, or null when it could never be
 * one. Accepts ".eggs", "eggs", " .EGGS " -- people type the dot.
 */
export function normalizeTld(input) {
  const raw = String(input ?? "").trim().toLowerCase().replace(/^\.+/, "");
  // A dot means they gave a domain, not a TLD. Say so rather than silently
  // registering the wrong thing.
  const label = normalizeLabel(raw);
  if (!label) return null;
  // All-numeric endings are fine: `.420`, `.187`, `.911` are names people want,
  // and an ending on its own is never mistaken for an address. The ambiguity
  // with an IPv4 literal belongs to the whole hostname — `1.420` reads as one,
  // `blue.420` cannot — so parseMoshpitName rejects that case and this does not.
  return label;
}

/** Why a TLD cannot be registered, or null when it is fine. */
export function tldRejection(tld) {
  if (RESERVED_TLDS.has(tld)) return "that name is reserved";
  if (tld.length < 2) return "a TLD needs at least 2 characters";
  return null;
}

/**
 * Split "foo.agentic" into its label and TLD.
 *
 * Only one dot is allowed: the namespace is one level deep, so "a.b.c" is not a
 * deeper name, it is a malformed one, and guessing which part was meant would
 * resolve someone to a place they never asked for.
 */
export function parseMoshpitName(input) {
  const raw = String(input ?? "").trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [label, tld] = parts;
  const normalizedLabel = normalizeLabel(label);
  const normalizedTld = normalizeTld(tld);
  if (!normalizedLabel || !normalizedTld) return null;

  // `1.420` is indistinguishable from an abbreviated IPv4 literal — several
  // parsers read a two-part dotted number as an address — so a name whose every
  // label is numeric is refused. `blue.420` and `420.blue` are unambiguous and
  // allowed; it takes both halves being numbers to create the collision.
  if (/^\d+$/.test(normalizedLabel) && /^\d+$/.test(normalizedTld)) return null;

  return { label: normalizedLabel, tld: normalizedTld };
}

/**
 * Labels worth offering under an ending that has nothing under it yet.
 *
 * A new ending's page is empty by definition, and "nothing lives here yet" is a
 * true sentence that gives its holder nothing to do. These are the names a
 * person reaches for first when they point an ending at something real.
 *
 * A starting point, not a taxonomy: what people actually take under other
 * endings outranks this list wherever the registry has enough of it to say.
 */
export const STARTER_LABELS = [
  "www", "app", "api", "docs", "blog", "home", "shop", "mail", "dev", "status", "hello", "go",
];

/**
 * What to suggest someone take under an ending.
 *
 * `popular` is what the rest of the registry has already taken, most-used
 * first — a real signal about what this namespace is for, and better than any
 * list written up front. STARTER_LABELS fills the gap while the registry is
 * young, which is exactly when an ending's page is emptiest and the suggestion
 * matters most.
 *
 * Anything already taken under this ending is dropped: suggesting a name whose
 * only outcome is "already taken" wastes the one click the page is asking for.
 *
 * Every suggestion is checked as a whole name rather than as a label, because
 * whether it is usable depends on the ending — `1.420` is refused as an IPv4
 * literal where `1.eggs` is fine, and only parseMoshpitName knows that.
 */
export function suggestedLabels({ tld, taken = [], popular = [], limit = 12 } = {}) {
  const ending = normalizeTld(tld);
  if (!ending) return [];

  const used = new Set();
  for (const label of taken) {
    const normalized = normalizeLabel(label);
    if (normalized) used.add(normalized);
  }

  const out = [];
  for (const candidate of [...popular, ...STARTER_LABELS]) {
    if (out.length >= limit) break;
    const label = normalizeLabel(candidate);
    if (!label || used.has(label)) continue;
    // The name has to be one the registry would actually accept.
    if (!parseMoshpitName(`${label}.${ending}`)) continue;
    used.add(label);
    out.push(label);
  }
  return out;
}

/* ---- resolution precedence (tronbrowser.dev) ---- */

/** The two ways a resolver can be configured to treat a moshpit answer. */
export const RESOLVE_MODES = new Set(["clearnet", "moshpit"]);

/**
 * Which resolution mode a caller asked for. Defaults to "clearnet": a resolver
 * that silently outranked real DNS the first time it was switched on would
 * hijack names its operator never intended to touch, so overriding the legacy
 * internet has to be something you opt into.
 */
export function normalizeMode(input) {
  const raw = String(input ?? "").trim().toLowerCase();
  return RESOLVE_MODES.has(raw) ? raw : "clearnet";
}

/**
 * What the client should do with the moshpit answer.
 *
 *   "clearnet" -- ignore it; there is nothing registered here
 *   "fallback" -- use it only when clearnet DNS does not answer
 *   "moshpit"  -- use it even when clearnet DNS does answer
 *
 * Whether clearnet actually answers is deliberately NOT decided here. The
 * browser extension already knows -- it is the thing doing the DNS lookup --
 * and an ICANN TLD list baked into this server would be stale the week after it
 * shipped. So the server states the rule and the client applies it.
 *
 * "fallback" is what makes the default safe: an unregistered name never
 * displaces DNS, and a registered one only fills a gap. Mode "moshpit" is the
 * opt-in that lets `profullstack.ai` in the pit outrank a squatted
 * `profullstack.ai` in clearnet.
 */
export function resolutionPreference({ registered, mode }) {
  if (!registered) return "clearnet";
  return normalizeMode(mode) === "moshpit" ? "moshpit" : "fallback";
}

/**
 * The most endings one paste may claim.
 *
 * A ceiling rather than no ceiling because this runs one INSERT per ending
 * against a remote database, and a pasted spreadsheet column is exactly the
 * shape of input that turns into ten thousand of them by accident.
 *
 * It is not the thing that usually stops a paste, though — BULK_TIME_BUDGET_MS
 * is. A count cannot know how slow the database is today, and the failure it
 * guards against is a request that dies halfway with no report of what landed.
 */
export const MAX_BULK_TLDS = 1000;

/**
 * How long claiming may run before it stops and reports.
 *
 * Stopping on the clock rather than on a count adapts to the database: a fast
 * one gets through hundreds, a slow one stops early, and neither ends as a
 * timed-out request whose result nobody ever sees. Whatever is left is named
 * so it can be pasted again.
 */
export const BULK_TIME_BUDGET_MS = 20_000;

/**
 * How many endings go into one round trip.
 *
 * Claiming used to cost six or seven trips per ending — insert, log, read
 * back, then read-check-write for the price — which is why a 300-ending paste
 * spent its whole time budget on 54 of them. Batched, the cost is a handful of
 * trips for the entire paste, so the chunk exists to bound request size rather
 * than to ration anything.
 */
export const BULK_CHUNK = 100;

/** 1000 -> "1k". A ceiling is a rough promise and should read like one. */
export function shortCount(n) {
  return n >= 1000 && n % 1000 === 0 ? `${n / 1000}k` : String(n);
}

/**
 * The most a child name should cost per year.
 *
 * This is the `me.whatever` price — what a buyer pays to mint a name under an
 * ending someone else holds. It is not the price of `.whatever` itself, which
 * is a separate thing the registry does not charge for yet.
 *
 * $2 flat. PRD 0005 R3 wrote this as $1.99; the extra cent buys nothing but a
 * price tag that looks like a supermarket shelf, and every number a person has
 * to reason about here — a default, a cap, a per-line override — reads better
 * round. The PRD number is superseded by this one.
 *
 * The ceiling is on the annual registration/renewal price only. A one-time
 * Buy Now resale transfers ownership rather than starting a term, and §10.2.4
 * puts no ceiling on that.
 */
export const MAX_CHILD_PRICE_USD = 2;

/** Alias, for code that reads better naming the thing than the ceiling. */
export const CHILD_PRICE_USD = MAX_CHILD_PRICE_USD;

/**
 * What a direct ending costs per year: `.whatever` itself.
 *
 * Nothing charges this yet — `registerTld` inserts a row and claiming is free.
 * It lives here anyway so the two prices sit together and the number is settled
 * before the checkout that will read it, rather than being invented at the
 * point someone builds that and having to be reconciled afterwards.
 *
 * $5 flat, for the same reason the child price is $2: PRD 0005 §10.1 wrote
 * these as $4.99 and $1.99, and the trailing cents buy nothing but a price tag
 * shaped like a supermarket shelf.
 */
export const ENDING_PRICE_USD = 5;

/**
 * What names under a newly claimed ending cost unless you say otherwise.
 *
 * A default rather than a blank because an unpriced ending is invisible to
 * every buyer, and "I claimed forty and nobody could buy a name under any of
 * them" is the failure that costs something.
 *
 * The cap itself, not a number under it: $2 is already the round, memorable
 * price this namespace is meant to have, so there is nothing to shade off it
 * for. A per-line price overrides this in either direction, and clearing the
 * field still means not for sale — the default is an opinion, not a floor.
 */
export const DEFAULT_TLD_PRICE_USD = MAX_CHILD_PRICE_USD;

/**
 * Pull a list of endings out of whatever someone pasted.
 *
 * Deliberately forgiving about shape, because the source is a text field and
 * people paste columns, comma-separated exports, and hand-typed lines with the
 * dot already on. Splitting on any run of whitespace, commas or semicolons
 * covers all three without asking anyone to reformat first.
 *
 * `#` starts a comment to end of line, so a list can be annotated and re-pasted
 * with the rejects commented out rather than deleted.
 *
 * Deduplicated on the normalised form, so `.Eggs`, `eggs` and `EGGS` in one
 * paste are one claim rather than one claim and two "already taken" errors
 * against yourself.
 *
 * Both halves of the namespace come through the same field. `eggs` and `.eggs`
 * are the ending; `blue.eggs` and `.blue.eggs` are a name under it. The leading
 * dot is decoration in either case — people type the shape they saw written
 * down, and refusing one spelling of the thing they already own would be a
 * distinction without a difference. Which one a line meant is recorded on the
 * entry rather than resolved here, because parsing is not the place that knows
 * who holds `.eggs`.
 */
export function parseTldList(input, limit = MAX_BULK_TLDS) {
  // Records split on newlines, commas and semicolons; fields inside a record
  // split on whitespace. That keeps `eggs, yeah, oranges` meaning three
  // endings while letting one line carry settings for the ending it names.
  const records = String(input ?? "")
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n")
    .split(/[\n,;]+/)
    .map((r) => r.trim())
    .filter(Boolean);

  const seen = new Set();
  const entries = [];
  let skipped = 0;

  for (const record of records) {
    const fields = record.split(/\s+/).filter(Boolean);
    const target = parseListToken(fields[0]);
    if (!target) continue;
    // Keyed on the whole thing, so `.eggs` and `blue.eggs` in one paste are two
    // entries rather than one swallowing the other.
    const key = target.label ? `${target.label}.${target.tld}` : target.tld;
    if (seen.has(key)) continue;
    seen.add(key);

    // Counted rather than silently dropped: "I pasted 300 and got 200" needs to
    // be visible, or the missing hundred look like they failed for some other
    // reason.
    if (entries.length >= limit) { skipped++; continue; }

    let priceUsd = null;
    let aliasOf = null;
    for (const field of fields.slice(1)) {
      const price = parsePriceToken(field);
      // A price is unambiguous — it is the only field that can start with `$`
      // or be all digits, and an all-numeric ending is rejected anyway. So
      // anything that is not a price is the ending this one points at.
      if (price !== null) priceUsd = price;
      else aliasOf = normalizeToken(field);
    }
    entries.push({ tld: target.tld, label: target.label, aliasOf, priceUsd });
  }

  // `tlds` alongside `entries` because most callers only want the names, and
  // making every one of them map over the records would be noise. `names` is
  // the same courtesy for the other half, and the two are disjoint: an entry is
  // an ending or a name under one, never both.
  return {
    entries,
    tlds: entries.filter((e) => !e.label).map((e) => e.tld),
    names: entries.filter((e) => e.label).map((e) => ({ tld: e.tld, label: e.label })),
    skipped,
  };
}

/**
 * One pasted token, as the ending or the name it was written as.
 *
 * A token that reads as neither comes back as an ending carrying its own bad
 * text — `a.b.c` is not silently dropped, it is handed on so the caller can
 * reject it by name and say why. Losing it here would turn "you pasted
 * something wrong" into a line that never appears in the report at all.
 */
function parseListToken(value) {
  const raw = normalizeToken(value);
  if (!raw) return null;
  if (!raw.includes(".")) return { tld: raw, label: null };
  const name = parseMoshpitName(raw);
  return name ? { tld: name.tld, label: name.label } : { tld: raw, label: null };
}

function normalizeToken(value) {
  return String(value ?? "").trim().toLowerCase().replace(/^\.+/, "") || null;
}

/**
 * `$2`, `$2.00USD`, `2.00`, `USD 2` — a price if it reads as one, else null.
 *
 * Forgiving because it is typed by hand in a textarea next to a dollar sign,
 * and strict about the shape because the alternative reading of a stray token
 * is "the ending this one points at", which would silently mis-route a name.
 */
function parsePriceToken(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/^usd/, "").replace(/usd$/, "").replace(/^\$/, "").trim();
  if (!raw || !/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const price = Number(raw);
  return Number.isFinite(price) && price > 0 ? price : null;
}
