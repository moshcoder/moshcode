// What a short code may be, and what a redirect may point at.
//
// No database: normalizeLinkUrl is the whole of the validation between "someone
// typed /shorten" and "this server sends a browser somewhere", so it is worth
// checking on its own. The scheme rule is the one that matters — `/f/<code>`
// hands its column straight to res.redirect, and a `javascript:` target there
// would be stored XSS with a permalink.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_URL_BYTES,
  mintCode,
  normalizeCode,
  normalizeLinkUrl,
  shortLinkUrl,
} from "../src/lib/moshpit-links.mjs";

const PIT = "https://pit.moshcode.sh";
const ok = (raw) => {
  const result = normalizeLinkUrl(raw, { base: PIT });
  assert.equal(result.ok, true, result.error);
  return result.url;
};
const refused = (raw) => {
  const result = normalizeLinkUrl(raw, { base: PIT });
  assert.equal(result.ok, false, `${raw} should not be shortenable`);
  return result.error;
};

test("links: a code is drawn from the unambiguous alphabet only", () => {
  assert.ok(!CODE_ALPHABET.includes("0"), "0 reads as O");
  assert.ok(!CODE_ALPHABET.includes("1"), "1 reads as l");
  assert.ok(!CODE_ALPHABET.includes("o"));
  assert.ok(!CODE_ALPHABET.includes("l"));
  assert.ok(!CODE_ALPHABET.includes("i"));

  const code = mintCode();
  assert.equal(code.length, CODE_LENGTH);
  for (const ch of code) assert.ok(CODE_ALPHABET.includes(ch), `${ch} is not in the alphabet`);
});

test("links: mintCode draws every position independently", () => {
  // A stub that walks the alphabet proves each position is a fresh draw rather
  // than one draw repeated — the shape of bug that makes every code `aaaaaaa`.
  let n = 0;
  assert.equal(mintCode(4, () => n++), CODE_ALPHABET.slice(0, 4));
});

test("links: a code lookup folds case and refuses anything outside the alphabet", () => {
  assert.equal(normalizeCode("K7MQ2XD"), "k7mq2xd");
  assert.equal(normalizeCode("  k7mq2xd "), "k7mq2xd");
  // Not stripped to `k7mq2xd`: two URLs for one link is worse than a 404.
  assert.equal(normalizeCode("k7mq-2xd"), null);
  assert.equal(normalizeCode("hello world"), null);
  assert.equal(normalizeCode("l0l"), null, "0 and l are not in the alphabet");
  assert.equal(normalizeCode("ab"), null, "too short to mint or guess at");
  assert.equal(normalizeCode("a".repeat(64)), null);
  assert.equal(normalizeCode(""), null);
  assert.equal(normalizeCode(null), null);
});

test("links: http(s) only — every other scheme is refused, not repaired", () => {
  assert.equal(ok("https://example.com/a/b?c=d#e"), "https://example.com/a/b?c=d#e");
  assert.equal(ok("http://example.com/x"), "http://example.com/x");

  // The one that matters: this string must not come back as
  // `https://javascript:alert(1)`, which parses and passes a scheme check.
  assert.match(refused("javascript:alert(1)"), /javascript/);
  assert.match(refused("data:text/html,<script>alert(1)</script>"), /data/);
  assert.match(refused("file:///etc/passwd"), /file/);
});

test("links: a bare host gets https, because that is what a paste leaves off", () => {
  assert.equal(ok("example.com/x"), "https://example.com/x");
  assert.equal(ok("pit.moshcode.sh"), "https://pit.moshcode.sh/");
});

test("links: a short link cannot be shortened into itself", () => {
  assert.match(refused(`${PIT}/f/k7mq2xd`), /already a short link/);
  // Someone else's /f/ is a different server's business.
  assert.equal(ok("https://elsewhere.example/f/abc"), "https://elsewhere.example/f/abc");
  // And the rest of the pit is fine to shorten.
  assert.equal(ok(`${PIT}/n/blue.eggs`), `${PIT}/n/blue.eggs`);
});

test("links: empty and oversized inputs are refused with a reason", () => {
  assert.match(refused(""), /required/);
  assert.match(refused("   "), /required/);
  assert.match(refused(`https://example.com/${"x".repeat(MAX_URL_BYTES)}`), /longer than/);
  assert.match(refused("not a url at all"), /not a url/);
});

test("links: a code's public address is /f/<code> on the pit", () => {
  assert.equal(shortLinkUrl("k7mq2xd", PIT), "https://pit.moshcode.sh/f/k7mq2xd");
  assert.equal(shortLinkUrl("k7mq2xd", `${PIT}/`), "https://pit.moshcode.sh/f/k7mq2xd");
});
