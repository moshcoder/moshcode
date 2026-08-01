// One client for both shapes of the same database.
//
// Local development wants a file with nothing to sign up for; production wants
// Turso. `@libsql/client` speaks both, so the only difference is the URL — and
// keeping that difference in an env var rather than in a branch means the code
// that runs against your laptop is the code that runs in production.

import { createClient, type Client } from "@libsql/client";

const remote = process.env.TURSO_DATABASE_URL?.trim();

// A remote URL without a token fails at the first query with an auth error
// several layers from the cause. Better to say so while the reason is obvious.
if (remote && /^libsql:|^https:/i.test(remote) && !process.env.TURSO_AUTH_TOKEN?.trim()) {
  throw new Error("TURSO_DATABASE_URL is set but TURSO_AUTH_TOKEN is not");
}

export const db: Client = createClient(
  remote
    ? { url: remote, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: `file:${process.env.DB_PATH || "./data/app.db"}` },
);

/** Bring the schema up. Idempotent, so it is safe on every boot. */
export async function migrate(): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS visits (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      name   TEXT    NOT NULL,
      path   TEXT    NOT NULL,
      seen_at INTEGER NOT NULL
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS visits_name ON visits (name)`);
}

export async function recordVisit(name: string, path: string): Promise<number> {
  await db.execute({
    sql: `INSERT INTO visits (name, path, seen_at) VALUES (?, ?, ?)`,
    args: [name, path, Date.now()],
  });
  const counted = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM visits WHERE name = ?`,
    args: [name],
  });
  return Number(counted.rows[0]?.n ?? 0);
}
