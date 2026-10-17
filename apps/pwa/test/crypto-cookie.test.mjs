// Same shape as the other PWA tests: crypto.mjs loads config.mjs, which pulls in
// the PWA dependencies at load time, so probe for them first and skip cleanly
// when they aren't installed — that keeps the root `pnpm test` green in a fresh
// clone.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let hasDeps = true;
try {
  require("express");
  // crypto.mjs -> config.mjs imports this one directly. Its exports map has
  // only an "import" condition, so resolve it the ESM way; and express alone is
  // not proof, since Node also finds it in any ancestor node_modules directory.
  import.meta.resolve("@profullstack/notifications/server");
} catch {
  hasDeps = false;
}

const skip = hasDeps ? false : "PWA dependencies are not installed";

test("unsign accepts an untouched signed cookie value", { skip }, async () => {
  const { sign, unsign } = await import("../src/lib/crypto.mjs");
  const signed = sign({ step: "passkey", nonce: "abc" });

  assert.deepEqual(unsign(signed), { step: "passkey", nonce: "abc" });
});

test("unsign rejects signed cookie values with extra segments", { skip }, async () => {
  const { sign, unsign } = await import("../src/lib/crypto.mjs");
  const signed = sign({ step: "passkey", nonce: "abc" });

  assert.equal(unsign(`${signed}.junk`), null);
});
