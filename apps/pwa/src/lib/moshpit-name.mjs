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
  // All-numeric would be ambiguous against an IPv4 literal in a hostname.
  if (/^\d+$/.test(label)) return null;
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
  return { label: normalizedLabel, tld: normalizedTld };
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

/** 1000 -> "1k". A ceiling is a rough promise and should read like one. */
export function shortCount(n) {
  return n >= 1000 && n % 1000 === 0 ? `${n / 1000}k` : String(n);
}

/**
 * The most a child name may cost per year.
 *
 * PRD 0005 §5 and §10.1, requirement R3: `me.whatever` is capped at $1.99/year.
 * An operator may go lower, including free. The cap is on the annual
 * registration/renewal price only — a one-time Buy Now resale is a transfer of
 * ownership, not a term, and §10.2.4 puts no ceiling on it.
 */
export const MAX_CHILD_PRICE_USD = 1.99;

/**
 * What names under a newly claimed ending cost unless you say otherwise.
 *
 * A default rather than a blank because an unpriced ending is invisible to
 * every buyer, and "I claimed forty and nobody could buy a name under any of
 * them" is the failure that costs something.
 *
 * $2 rather than MAX_CHILD_PRICE_USD: the cap in PRD 0005 R3 arrives with
 * terms and renewals, and until that lands this is an operator's asking price
 * with nothing enforcing a ceiling. A per-line price overrides this, upwards
 * or downwards, and clearing the field still means not for sale — the default
 * is an opinion, not a floor and not a limit.
 */
export const DEFAULT_TLD_PRICE_USD = 2;

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
    const tld = normalizeToken(fields[0]);
    if (!tld || seen.has(tld)) continue;
    seen.add(tld);

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
    entries.push({ tld, aliasOf, priceUsd });
  }

  // `tlds` alongside `entries` because most callers only want the names, and
  // making every one of them map over the records would be noise.
  return { entries, tlds: entries.map((e) => e.tld), skipped };
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
