// Reaching the holder of a name without learning who they are.
//
// Every registry has this problem and most solve it badly. Publishing the
// holder's real address -- which is what /api/moshpit/tlds did for years, for
// every ending, to anyone who asked -- turns a namespace into a mailing list
// and gives the holder no say in it. Publishing nothing at all is the other
// failure: a name that resolves to a broken server, or one somebody wants to
// buy, has nobody to tell.
//
// A guard address is the way between. The registry publishes
// `k7m2xqbn3f@moshcode.sh`, which forwards to whatever address the holder
// actually reads. The real one is never in a response, a page, or the log. The
// holder can turn it off, and the token survives being turned off, because the
// published address ends up in other people's address books and on pages we do
// not control.
//
// Deliberately free of any database or network import, for the same reason
// moshpit-name and moshpit-twin are: these are the rules, and the rules have to
// be checkable without a libSQL connection or an API key. src/moshpit.mjs owns
// storage and src/lib/forwardemail.mjs owns the mail host.
import { randomBytes } from "node:crypto";

import { normalizeDomain } from "./moshpit-twin.mjs";

/**
 * What a contact may be showing, in the order of how much it gives away.
 *
 * `none` is a state rather than the absence of one: see the migration -- a
 * contact taken down and put back up has to come back at the same address.
 */
export const CONTACT_VISIBILITY = ["none", "guard", "public"];

export const DEFAULT_VISIBILITY = "guard";

/**
 * The alphabet a guard token is drawn from: digits and consonants, minus the
 * pairs that get misread.
 *
 * No `0`/`o`, no `1`/`l`/`i`, because these are read off a page and typed into
 * a mail client by hand. And no vowels at all, which is doing more work than it
 * looks: it means a token can never spell a word, so a minted address can never
 * collide with a mailbox a person holds at the same domain. `support`,
 * `abuse`, `notify` and every other role address are unreachable from here by
 * construction, rather than by a reserved list somebody has to remember to keep
 * up to date.
 */
const GUARD_ALPHABET = "23456789bcdfghjkmnpqrstvwxz";

/**
 * Ten characters, ~47 bits.
 *
 * The token is not a secret -- it is printed on a public page -- so this is not
 * sized against an attacker who wants to guess one. It is sized against someone
 * enumerating the whole space to harvest forwarding addresses, which 47 bits
 * makes pointless, and against collision, which the UNIQUE constraint catches
 * anyway.
 */
const TOKEN_LENGTH = 10;

const GUARD_TOKEN = new RegExp(`^[${GUARD_ALPHABET}]{${TOKEN_LENGTH}}$`);

/**
 * A fresh guard token.
 *
 * Rejection sampling rather than `% alphabet.length`: 256 is not a multiple of
 * 27, so modulo would make the first thirteen characters of the alphabet
 * measurably likelier than the rest. It costs nothing to do properly here and
 * the bias would be permanent in every address ever minted.
 */
export function mintGuardToken() {
  const limit = 256 - (256 % GUARD_ALPHABET.length);
  let out = "";
  while (out.length < TOKEN_LENGTH) {
    for (const byte of randomBytes(TOKEN_LENGTH)) {
      if (byte >= limit) continue;
      out += GUARD_ALPHABET[byte % GUARD_ALPHABET.length];
      if (out.length === TOKEN_LENGTH) break;
    }
  }
  return out;
}

/** Whether a string is shaped like a token this registry minted. */
export const isGuardToken = (value) => GUARD_TOKEN.test(String(value ?? ""));

/**
 * Normalise a contact address, or null when it could never be one.
 *
 * Forgiving about what arrives -- the field is typed by hand and people paste
 * `Anthony <a@b.c>` out of a mail client -- and strict about exactly two
 * things: one `@`, and a domain that could exist. The domain half reuses
 * normalizeDomain rather than a second regex, so a contact address and a
 * clearnet twin agree on what a hostname is.
 *
 * No attempt at deciding whether the mailbox is real. That is not knowable from
 * here, and the mail host answers it properly: an alias is created with
 * recipient verification, so the address has to confirm before anything is
 * forwarded to it.
 */
export function normalizeContactEmail(input) {
  const raw = String(input ?? "").trim()
    .replace(/^[^<]*<([^>]*)>.*$/, "$1")  // a pasted "Name <addr>"
    .replace(/^mailto:/i, "")
    .trim();
  if (!raw || raw.length > 254) return null;

  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return null;

  const local = raw.slice(0, at);
  // Lowercased whole. The local part is case-sensitive per RFC 5321 and case
  // insensitive at every mail host anybody actually uses; folding it keeps one
  // address from being stored twice and is what the mail host will do regardless.
  const domain = normalizeDomain(raw.slice(at + 1));
  if (!domain) return null;
  if (local.length > 64) return null;
  // No spaces, no angle brackets, no comma -- the characters that mean a header
  // was pasted rather than an address. Quoted local parts are legal and refused:
  // they are vanishingly rare and every one seen here so far has been a paste
  // that went wrong.
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i.test(local)) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;

  return `${local.toLowerCase()}@${domain}`;
}

/** `k7m2xqbn3f` + `moshcode.sh` -> `k7m2xqbn3f@moshcode.sh`. */
export function guardAddress(token, domain) {
  const host = normalizeDomain(domain);
  if (!isGuardToken(token) || !host) return null;
  return `${token}@${host}`;
}

/**
 * What a visitor is allowed to see, or null when the answer is nothing.
 *
 * The single place that decision is made. Every caller -- the name page, the
 * ending page, the resolve API -- goes through here rather than reading
 * `visibility` and deciding for itself, because there are two independent
 * reasons to publish nothing and a caller that checks only one of them leaks.
 *
 * The second reason is the one easy to miss: a `guard` contact whose alias is
 * not `live` yet has an address that does not exist. Publishing it would hand
 * out a bouncing address, which is worse than publishing none, so the alias
 * status gates it and not just the holder's choice.
 */
export function publishedContact(row, guardDomain) {
  if (!row) return null;
  if (row.visibility === "public") {
    const address = normalizeContactEmail(row.email);
    return address ? { kind: "public", address } : null;
  }
  if (row.visibility !== "guard") return null;
  if (row.alias_status !== "live") return null;
  const address = guardAddress(row.guard_token, guardDomain);
  return address ? { kind: "guard", address } : null;
}

/**
 * Whether a visibility string is one this registry understands.
 *
 * Returns the value rather than a boolean so callers read
 * `normalizeVisibility(x) ?? fail()` and cannot accidentally write an
 * unvalidated string into a CHECK-constrained column.
 */
export const normalizeVisibility = (input) => {
  const value = String(input ?? "").trim().toLowerCase();
  return CONTACT_VISIBILITY.includes(value) ? value : null;
};
