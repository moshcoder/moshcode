// User creation + default channels + signup bonus.
import { get, run } from "../db.mjs";
import { id } from "./crypto.mjs";
import { grant, SIGNUP_BONUS } from "./credits.mjs";

async function seedDefaults(userId, email) {
  const now = Date.now();
  // Free channels on by default; paid ones off until configured.
  const defaults = [
    ["push", null, 1],
    ["email", email || null, email ? 1 : 0],
  ];
  for (const [kind, target, enabled] of defaults) {
    await run(`INSERT INTO channels (id, user_id, kind, target, enabled, created_at) VALUES (?,?,?,?,?,?)`,
      [id(), userId, kind, target, enabled, now]);
  }
  await grant(userId, SIGNUP_BONUS, "signup.bonus");
}

export async function createUserWithPassword(email, passwordHash, displayName) {
  const uid = id();
  await run(`INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?,?,?,?,?)`,
    [uid, email, passwordHash, displayName || email.split("@")[0], Date.now()]);
  await seedDefaults(uid, email);
  return get(`SELECT * FROM users WHERE id = ?`, [uid]);
}

export async function createUserForCoinpay(sub, displayName) {
  const uid = id();
  await run(`INSERT INTO users (id, coinpay_sub, display_name, created_at) VALUES (?,?,?,?)`,
    [uid, sub, displayName || "moshcoder", Date.now()]);
  await seedDefaults(uid, null);
  return get(`SELECT * FROM users WHERE id = ?`, [uid]);
}

// Passkey-first signup (no email/password yet).
export async function createUserPasskey(displayName) {
  const uid = id();
  await run(`INSERT INTO users (id, display_name, created_at) VALUES (?,?,?)`,
    [uid, displayName || "moshcoder", Date.now()]);
  await seedDefaults(uid, null);
  return get(`SELECT * FROM users WHERE id = ?`, [uid]);
}

export const userByEmail = (email) => get(`SELECT * FROM users WHERE email = ?`, [String(email).toLowerCase()]);
export const userByCoinpay = (sub) => get(`SELECT * FROM users WHERE coinpay_sub = ?`, [sub]);
export const userById = (uid) => get(`SELECT * FROM users WHERE id = ?`, [uid]);
