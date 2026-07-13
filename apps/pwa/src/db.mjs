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
