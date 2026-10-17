// Skips cleanly when the PWA dependencies are not installed: crypto.mjs imports
// config.mjs, which loads them. express alone is not a reliable probe — it can
// resolve from a node_modules above the repo — so the package config.mjs actually
// imports is checked too. Its exports are ESM-only, hence import.meta.resolve.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let hasDeps = true;
try {
  require("express");
  import.meta.resolve("@profullstack/notifications/server");
} catch {
  hasDeps = false;
}
const skip = hasDeps ? false : "PWA dependencies not installed";

test("verifyPassword accepts a matching scrypt password hash", { skip }, async () => {
  const { hashPassword, verifyPassword } = await import("../src/lib/crypto.mjs");
  const stored = hashPassword("correct horse");

  assert.equal(verifyPassword("correct horse", stored), true);
  assert.equal(verifyPassword("wrong horse", stored), false);
});

test("verifyPassword rejects malformed scrypt hashes", { skip }, async () => {
  const { verifyPassword } = await import("../src/lib/crypto.mjs");
  for (const stored of [
    "scrypt$00$",
    "scrypt$00$nothex",
    "scrypt$zz$aa",
    "scrypt$0$aa",
    "scrypt$00$aa$extra",
  ]) {
    assert.equal(verifyPassword("anything", stored), false, stored);
  }
});
