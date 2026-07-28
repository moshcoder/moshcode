// Verify the moshcode CLI's signed webhook: header "t=<ts>,v1=<hex>" over "<ts>.<rawBody>".
import crypto from "node:crypto";

export function verifySignature(header, rawBody, secret, toleranceSec = 300) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=").map((s) => s.trim())));
  const rawTs = parts.t;
  if (!/^\d+$/.test(rawTs || "")) return false;
  const ts = Number(rawTs);
  const v1 = parts.v1;
  if (!Number.isSafeInteger(ts) || !ts || !v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${rawTs}.${rawBody}`).digest("hex");
  const a = Buffer.from(v1);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
