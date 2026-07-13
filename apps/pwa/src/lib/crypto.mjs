// Password hashing (scrypt) + signed cookies + tokens — all node:crypto, no deps.
import crypto from "node:crypto";
import { config } from "../config.mjs";

// ---- passwords (scrypt) ----
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString("hex")}$${dk.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [, saltHex, hashHex] = stored.split("$");
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const dk = crypto.scryptSync(String(password), salt, expected.length);
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

// ---- ids / tokens ----
export const id = () => crypto.randomUUID();
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---- signed cookies (stateless ceremony state) ----
export function sign(value) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const mac = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function unsign(signed) {
  if (!signed || typeof signed !== "string" || !signed.includes(".")) return null;
  const [payload, mac] = signed.split(".");
  const expected = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
}
