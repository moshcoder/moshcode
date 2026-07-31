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

/**
 * Normalise user input into a bare TLD label, or null when it could never be
 * one. Accepts ".eggs", "eggs", " .EGGS " -- people type the dot.
 */
export function normalizeTld(input) {
  const raw = String(input ?? "").trim().toLowerCase().replace(/^\.+/, "");
  if (!raw || raw.length > 63) return null;
  // A dot means they gave a domain, not a TLD. Say so rather than silently
  // registering the wrong thing.
  if (raw.includes(".")) return null;
  if (!LABEL.test(raw)) return null;
  // All-numeric would be ambiguous against an IPv4 literal in a hostname.
  if (/^\d+$/.test(raw)) return null;
  return raw;
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
  // Both halves are hostname labels, and normalizeTld already encodes exactly
  // that rule -- so reuse it rather than keeping a second copy that can drift.
  if (!normalizeTld(label) || !normalizeTld(tld)) return null;
  return { label, tld };
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
