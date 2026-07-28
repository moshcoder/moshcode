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

/**
 * Hold `amount` against a user's balance in a single statement, the same way
 * /cli/token and /webhooks/coinpay claim their rows. Reading the balance and
 * then inserting a charge is not enough on its own: against a remote (network)
 * database two concurrent requests both read a sufficient balance before either
 * insert lands, and both spend it. The `WHERE` runs inside the insert, so only
 * the first reservation a balance can cover is written.
 *
 * Returns the ledger row id when the hold landed, or null when it did not.
 */
export async function reserve(userId, amount, reason, meta = null) {
  const cost = Math.abs(amount);
  const rowId = id();
  const r = await run(
    `INSERT INTO credit_ledger (id, user_id, delta, reason, meta, created_at)
     SELECT ?,?,?,?,?,?
      WHERE (SELECT COALESCE(SUM(delta),0) FROM credit_ledger WHERE user_id = ?) >= ?`,
    [rowId, userId, -cost, reason, meta ? JSON.stringify(meta) : null, Date.now(), userId, cost]
  );
  return r.rowsAffected ? rowId : null;
}

/**
 * Settle a reservation down to what was actually used, so the ledger keeps
 * showing one row per delivery for exactly what went out. Settling to 0 releases
 * the hold entirely (nothing was delivered, so there is nothing to charge for).
 */
export async function settle(rowId, amount, meta = null) {
  const used = Math.abs(amount);
  if (!used) return run(`DELETE FROM credit_ledger WHERE id = ?`, [rowId]);
  return run(`UPDATE credit_ledger SET delta = ?, meta = ? WHERE id = ?`,
    [-used, meta ? JSON.stringify(meta) : null, rowId]);
}
