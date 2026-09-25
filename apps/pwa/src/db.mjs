// Database client + a tiny query helper.
//
// Production runs on Postgres through @profullstack/libsql-pg, which keeps the
// @libsql/client surface (execute / batch / transaction, rows, rowsAffected)
// and rewrites the SQLite idioms this code was written in per statement. A
// `file:` URL still opens a local SQLite database through @libsql/client, which
// is what development and the test suite use. A `libsql://` (Turso) URL is
// refused: the data left Turso, and a deploy that still carries the old URL
// should fail at boot rather than serve stale rows.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";

export const DB_URL = config.db.url;

/** 'postgres' for postgres:// and postgresql://, 'sqlite' for file:. Anything else throws. */
export function dialectFor(url = DB_URL) {
  if (/^postgres(ql)?:\/\//i.test(url)) return "postgres";
  if (url.startsWith("file:")) return "sqlite";
  if (/^(libsql|https?|wss?):\/\//i.test(url)) {
    throw new Error(
      `DATABASE_URL is ${url.split("://")[0]}://…, but app.moshcode.sh no longer runs on Turso/libSQL. ` +
      "Set DATABASE_URL to a postgres:// URL (production) or a file: path (development) and drop DATABASE_AUTH_TOKEN.",
    );
  }
  throw new Error(`DATABASE_URL must be postgres://… or file:…, got ${JSON.stringify(url)}`);
}

export const dialect = dialectFor();
export const isPostgres = dialect === "postgres";

async function open() {
  if (isPostgres) {
    const { createClient } = await import("@profullstack/libsql-pg");
    // dialect 'sqlite': the statements in this codebase are SQLite-flavoured
    // (INSERT OR IGNORE, strftime, datetime('now'), …) and are rewritten on
    // the way out. sslmode= in the URL is honoured (the shared cluster on dev2
    // uses a self-signed certificate: sslmode=require).
    return createClient({ url: DB_URL, dialect: "sqlite" });
  }
  const { createClient } = await import("@libsql/client");
  // For a local file: url, make sure the directory exists.
  const p = DB_URL.slice("file:".length);
  fs.mkdirSync(path.dirname(path.resolve(config.root, p)), { recursive: true });
  return createClient({ url: DB_URL });
}

export const db = await open();

/**
 * A second Postgres client that sends SQL exactly as written (dialect
 * 'postgres'), for the files in migrations-pg/: they are already Postgres DDL,
 * and the SQLite rewriter's schema converter is not idempotent (it mangles
 * `DEFAULT 'x' CHECK (...)` on a second pass). Null on SQLite. Callers close it.
 */
export async function openMigrationClient() {
  if (!isPostgres) return null;
  const { createClient } = await import("@profullstack/libsql-pg");
  return createClient({ url: DB_URL, dialect: "postgres", pool: { max: 1 } });
}

/**
 * Turn on foreign keys (SQLite only; Postgres always enforces them and the
 * PRAGMA is a no-op there).
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
if (!isPostgres) {
  db.execute("PRAGMA foreign_keys = ON")
    .catch((error) => console.error("[db] could not enable foreign keys:", error.message));
}

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
