// Short links — what a code looks like, and what a redirect is allowed to
// follow to.
//
// Kept apart from the SQL and the route for the reason every other lib here is:
// the two rules worth being sure about — a code a person can read off a screen,
// and a target that cannot be turned into an attack — are rules that can be
// tested without a database or an HTTP server in front of them.
//
// The dangerous half is the target. `/f/<code>` is a redirect this server hands
// a browser, which means whatever is in that column is a scheme the browser
// will act on: `javascript:` there is stored XSS with a permalink, and `file:`
// or `data:` are the same idea with a different payload. So the scheme is an
// allow-list of http(s) and nothing else, checked here, on the way in, once.
//
// Note what this deliberately does NOT do: it does not check the target against
// the private address ranges the way the gateway does (see moshpit-gateway.mjs).
// That check exists there because the gateway *fetches* the target from inside
// this network — an SSRF. A redirect is fetched by the visitor's browser, from
// wherever they are, so pointing one at 10.0.0.1 reaches their network and not
// ours, and refusing it would only break the person shortening a link to their
// own LAN printer.

import { randomInt } from "node:crypto";

/**
 * The alphabet a code is drawn from.
 *
 * Crockford's idea rather than base62: someone reads one of these off a
 * terminal, a slide or a sticker and types it back in, so the pairs that get
 * misread are simply absent — no `0`/`O`, no `1`/`l`/`I`. Lowercase only,
 * because a code that is case-sensitive is a code that gets typed wrong in the
 * one place it matters.
 */
export const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/**
 * How long a minted code is.
 *
 * 7 characters of a 31-symbol alphabet is ~2.8e10 codes. At a million links the
 * odds of any collision at all are a couple of percent, and a collision is
 * handled rather than fatal (the insert retries), so this is chosen for the
 * length of the URL it produces — `pit.moshcode.sh/f/k7mq2xd` — rather than for
 * the birthday bound.
 */
export const CODE_LENGTH = 7;

/** A code is at least this long, so `/f/a` can never be minted or guessed at. */
export const MIN_CODE_LENGTH = 3;

/** And at most this, which is the ceiling on what a lookup will even try. */
export const MAX_CODE_LENGTH = 32;

/**
 * The longest URL that may be shortened.
 *
 * Well past what a browser bar holds and well short of what would make this
 * table a document store. A URL longer than this is being used as storage, and
 * the honest answer to that is no.
 */
export const MAX_URL_BYTES = 2048;

/** The most links one account may hold. A shortener, not a redirect farm. */
export const MAX_LINKS_PER_USER = 1000;

/**
 * Mint a code.
 *
 * randomInt() rather than `bytes[i] % alphabet.length`: 256 is not a multiple
 * of 31, so the modulo would make the first nine symbols measurably likelier
 * than the rest. Nobody would notice, which is exactly why it is worth not
 * doing — a biased code space is a smaller code space.
 *
 * @param {number} [length]
 * @param {(max: number) => number} [rand] injected in tests
 */
export function mintCode(length = CODE_LENGTH, rand = (max) => randomInt(max)) {
  let code = "";
  for (let i = 0; i < length; i += 1) code += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
  return code;
}

/**
 * A code as it will be looked up, or null when it could never match one.
 *
 * Case is folded rather than refused — a code read off a slide and typed back
 * in uppercase is the same link, and there is nothing to protect by insisting
 * otherwise. Anything outside the alphabet is refused rather than stripped:
 * `/f/k7mq-2xd` silently becoming `k7mq2xd` would mean two URLs for one link
 * and a redirect that appears to tolerate typos right up until it does not.
 *
 * @param {unknown} input
 * @returns {string | null}
 */
export function normalizeCode(input) {
  const code = String(input ?? "").trim().toLowerCase();
  if (code.length < MIN_CODE_LENGTH || code.length > MAX_CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/**
 * The URL a short link will point at, or `{ error }` saying why it will not.
 *
 * A bare `example.com/x` gets `https://` put on the front, because that is what
 * someone pasting out of a browser bar leaves off and refusing it teaches
 * nothing. Everything else is checked rather than repaired.
 *
 * @param {unknown} raw
 * @param {{ base?: string | null }} [opts] `base` is this server's own origin,
 *   used to refuse shortening a short link into itself
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
export function normalizeLinkUrl(raw, { base = null } = {}) {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: false, error: "a url is required" };
  if (Buffer.byteLength(value, "utf8") > MAX_URL_BYTES) {
    return { ok: false, error: `that url is longer than ${MAX_URL_BYTES} bytes` };
  }

  // Only prepend a scheme when there is none. Testing for one rather than
  // catching a parse failure keeps `javascript:alert(1)` from becoming
  // `https://javascript:alert(1)` — a string that parses, passes the scheme
  // check, and is not what anybody typed.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;

  let url;
  try { url = new URL(candidate); } catch { return { ok: false, error: `not a url: ${value}` }; }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `${url.protocol.replace(":", "")} links cannot be shortened — http(s) only` };
  }
  if (!url.hostname) return { ok: false, error: `not a url: ${value}` };

  if (base) {
    let mine = null;
    try { mine = new URL(base); } catch { mine = null; }
    // A short link pointing at a short link is a redirect chain this server is
    // both ends of, and the first thing anyone does with one is point it at
    // itself. Refused rather than followed, so the loop cannot be minted at all.
    if (mine && url.origin === mine.origin && /^\/f\//.test(url.pathname)) {
      return { ok: false, error: "that is already a short link" };
    }
  }

  return { ok: true, url: url.toString() };
}

/**
 * Where a code lives on the clearnet.
 *
 * @param {string} code
 * @param {string} base the pit's origin
 */
export function shortLinkUrl(code, base) {
  return `${String(base).replace(/\/+$/, "")}/f/${encodeURIComponent(code)}`;
}
