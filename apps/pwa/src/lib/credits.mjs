// Usage-based credit ledger + channel pricing.
import { get, all, run } from "../db.mjs";
import { id } from "./crypto.mjs";

// Credits per delivered approval, by channel. Local + own-device are free.
export const CHANNEL_COST = { push: 0, email: 1, webhook: 0, slack: 4, telegram: 4, sms: 12 };
export const SIGNUP_BONUS = 100; // free credits to start moshing

export async function balance(userId) {
  const row = await get(`SELECT COALESCE(SUM(delta),0) AS bal FROM credit_ledger WHERE user_id = ?`, [userId]);
  return Number(row?.bal || 0);
}

export async function ledger(userId, limit = 12) {
  return all(
    `SELECT delta, reason, meta, created_at FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit]
  );
}

export async function entry(userId, delta, reason, meta = null) {
  await run(
    `INSERT INTO credit_ledger (id, user_id, delta, reason, meta, created_at) VALUES (?,?,?,?,?,?)`,
    [id(), userId, delta, reason, meta ? JSON.stringify(meta) : null, Date.now()]
  );
  return balance(userId);
}

export const grant = (userId, amount, reason, meta) => entry(userId, Math.abs(amount), reason, meta);
export const charge = (userId, amount, reason, meta) => entry(userId, -Math.abs(amount), reason, meta);

/** Cost to deliver an approval to a set of channel kinds. */
export function costOf(kinds) {
  return kinds.reduce((sum, k) => sum + (CHANNEL_COST[k] ?? 0), 0);
}
