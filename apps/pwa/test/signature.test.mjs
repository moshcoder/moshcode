import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { verifySignature } from "../src/lib/signature.mjs";

const secret = "test-secret";
const rawBody = JSON.stringify({ ok: true });

function sign(ts) {
  return crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
}

test("verifySignature accepts a valid decimal timestamp signature", () => {
  const ts = String(Math.floor(Date.now() / 1000));
  assert.equal(verifySignature(`t=${ts},v1=${sign(ts)}`, rawBody, secret), true);
});

test("verifySignature rejects scientific notation timestamps", () => {
  const ts = "1e9";
  const normalized = String(Number(ts));
  const sig = crypto.createHmac("sha256", secret).update(`${normalized}.${rawBody}`).digest("hex");
  assert.equal(verifySignature(`t=${ts},v1=${sig}`, rawBody, secret, 9_999_999_999), false);
});

test("verifySignature rejects fractional timestamps", () => {
  const ts = `${Math.floor(Date.now() / 1000)}.5`;
  assert.equal(verifySignature(`t=${ts},v1=${sign(ts)}`, rawBody, secret), false);
});
