// Apply SQL migrations in order. Idempotent — tracks applied files in _migrations.
//
// Two parallel sets, one per dialect, with identical file names:
//   migrations/     SQLite (development, tests)
//   migrations-pg/  Postgres (production) — converted from the SQLite files
//                   with `libsql-pg convert-schema` and reviewed by hand.
// A new migration is written to both directories under the same name; the
// ledger (_migrations) is keyed by that name, so a database moved from one
// dialect to the other with its ledger intact is already up to date.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { db, run, all, isPostgres, openMigrationClient } from "./db.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SQLITE_DIR = path.join(HERE, "migrations");
export const POSTGRES_DIR = path.join(HERE, "migrations-pg");
const DIR = isPostgres ? POSTGRES_DIR : SQLITE_DIR;

/** A migration file, as the list of statements it holds. */
export function statementsOf(sql) {
  // One statement per call — split on semicolons at line ends. Nothing in these
  // files carries a `;` inside a string, a comment or a $$ body.
  return sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

export async function migrate() {
  // Bootstrap the tracking table (the first migration also declares it IF NOT EXISTS).
  await run(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at ${isPostgres ? "BIGINT" : "INTEGER"} NOT NULL)`);
  const done = new Set((await all(`SELECT name FROM _migrations`)).map((r) => r.name));

  // Postgres files go out verbatim on their own client; SQLite files through
  // the ordinary one. The ledger row is written through the ordinary client
  // either way.
  const raw = await openMigrationClient();
  const apply = raw ? (stmt) => raw.execute(stmt) : (stmt) => run(stmt);
  try {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) { console.log(`· ${file} (already applied)`); continue; }
      const sql = fs.readFileSync(path.join(DIR, file), "utf8");
      for (const stmt of statementsOf(sql)) await apply(stmt);
      await run(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`, [file, Date.now()]);
      console.log(`✓ ${file}`);
    }
  } finally {
    await raw?.close();
  }
  console.log(`migrations up to date (${isPostgres ? "postgres" : "sqlite"}) 🤘`);
}

// Run directly (npm run migrate) — not when imported by the server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => db.close?.())
    .catch((e) => { console.error(e); process.exit(1); });
}
