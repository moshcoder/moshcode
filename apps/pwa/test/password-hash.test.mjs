import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../src/lib/crypto.mjs";

test("verifyPassword accepts a matching scrypt password hash", () => {
  const stored = hashPassword("correct horse");

  assert.equal(verifyPassword("correct horse", stored), true);
  assert.equal(verifyPassword("wrong horse", stored), false);
});

test("verifyPassword rejects malformed scrypt hashes", () => {
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
