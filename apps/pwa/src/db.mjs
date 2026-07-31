// libSQL (SQLite / Turso) client + a tiny query helper.
import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";

// For a local file: url, make sure the directory exists.
if (config.db.url.startsWith("file:")) {
  const p = config.db.url.slice("file:".length);
  const dir = path.dirname(path.resolve(config.root, p));
  fs.mkdirSync(dir, { recursive: true });
}

export const db = createClient({ url: config.db.url, authToken: config.db.authToken });

/**
 * Turn on foreign keys.
 *
 * SQLite ignores every REFERENCES clause unless this is set, per connection —
 * which means the `ON DELETE CASCADE` on moshpit_names.user_id,
 * moshpit_name_purchases.user_id, moshpit_name_pins.user_id and sessions.user_id
 * have all been decorative. Deleting a user left their names, purchases,
 * published keys and sessions behind, pointing at a row that no longer exists.
 *
 * Fired once at import and not awaited: every later statement goes through the
 * same client, and libSQL serialises on the connection, so the PRAGMA is on the
 * wire before anything that depends on it. A failure is logged rather than
 * thrown because the app is still usable without it — it just enforces less.
 */
db.execute("PRAGMA foreign_keys = ON")
  .catch((error) => console.error("[db] could not enable foreign keys:", error.message));

/** Run a statement; returns the raw result. */
export const run = (sql, args = []) => db.execute({ sql, args });

/** First row (or null). */
export async function get(sql, args = []) {
  const r = await db.execute({ sql, args });
  return r.rows[0] ?? null;
}

/** All rows. */
export async function all(sql, args = []) {
  const r = await db.execute({ sql, args });
  return r.rows;
}
