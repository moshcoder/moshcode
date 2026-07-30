import assert from "node:assert/strict";
import test from "node:test";
import { sign, unsign } from "../src/lib/crypto.mjs";

test("unsign accepts an untouched signed cookie value", () => {
  const signed = sign({ step: "passkey", nonce: "abc" });

  assert.deepEqual(unsign(signed), { step: "passkey", nonce: "abc" });
});

test("unsign rejects signed cookie values with extra segments", () => {
  const signed = sign({ step: "passkey", nonce: "abc" });

  assert.equal(unsign(`${signed}.junk`), null);
});
