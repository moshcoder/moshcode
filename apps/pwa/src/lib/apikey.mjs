// API keys for the CLI / CI to ingest + poll approvals.
import { get, all, run } from "../db.mjs";
import { id, token, sha256 } from "./crypto.mjs";

// Returns { plaintext, row } — plaintext shown ONCE.
export async function createApiKey(userId, name = "cli") {
  const plaintext = "mck_" + token(24);
  const prefix = plaintext.slice(0, 12);
  const row = { id: id(), user_id: userId, name, token_hash: sha256(plaintext), prefix, created_at: Date.now() };
  await run(
    `INSERT INTO api_keys (id, user_id, name, token_hash, prefix, created_at) VALUES (?,?,?,?,?,?)`,
    [row.id, row.user_id, row.name, row.token_hash, row.prefix, row.created_at]
  );
  return { plaintext, row };
}

// Resolve a Bearer token to its owning user (or null). Updates last_used_at.
export async function userForApiKey(bearer) {
  if (!bearer) return null;
  const key = await get(`SELECT * FROM api_keys WHERE token_hash = ?`, [sha256(bearer)]);
  if (!key) return null;
  await run(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`, [Date.now(), key.id]);
  return get(`SELECT * FROM users WHERE id = ?`, [key.user_id]);
}

export const listApiKeys = (userId) =>
  all(`SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`, [userId]);

export const revokeApiKey = (userId, keyId) =>
  run(`DELETE FROM api_keys WHERE id = ? AND user_id = ?`, [keyId, userId]);

// Pull the Bearer token off a request.
export function bearer(req) {
  const h = req.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}
