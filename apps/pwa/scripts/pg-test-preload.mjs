// Run the test suite against a real Postgres instead of the per-test SQLite files.
//
//   PG_TEST_ADMIN_URL=postgres://postgres:pw@127.0.0.1:5432/postgres \
//     node --import ./scripts/pg-test-preload.mjs --test
//
// Every test file runs in its own process and points DATABASE_URL at a scratch
// `file:` database before importing src/config.mjs. This preload runs first in
// that process: it creates a throwaway database on the admin server, then
// registers a loader hook that appends one line to src/config.mjs so
// `config.db.url` is the Postgres URL whatever the test set. The database is
// dropped when the process exits. Tests that exercise SQLite itself
// (sqlite_master, the raw migrations/*.sql files) are skipped by the hook's
// sibling env flag, MOSHCODE_TEST_DIALECT=postgres, which those tests read.
import { register } from "node:module";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";

const admin = process.env.PG_TEST_ADMIN_URL;
if (!admin) throw new Error("PG_TEST_ADMIN_URL is not set");
const name = `moshtest_${randomBytes(6).toString("hex")}`;
const client = new pg.Client({ connectionString: admin });
await client.connect();
await client.query(`CREATE DATABASE "${name}"`);
await client.end();
const url = new URL(admin);
url.pathname = `/${name}`;
process.env.MOSHCODE_TEST_DIALECT = "postgres";
process.env.PG_TEST_URL = url.toString();

process.on("exit", () => {
  // Synchronous on purpose: nothing async runs during 'exit'.
  try {
    execFileSync(process.execPath, ["-e", `
      const pg = require("pg");
      const c = new pg.Client({ connectionString: process.argv[1] });
      c.connect().then(() => c.query('DROP DATABASE IF EXISTS "' + process.argv[2] + '" WITH (FORCE)')).then(() => c.end());
    `, admin, name], { stdio: "ignore", cwd: new URL("..", import.meta.url).pathname });
  } catch {}
});

register(new URL("data:text/javascript," + encodeURIComponent(`
  export async function load(url, context, next) {
    const out = await next(url, context);
    if (url.endsWith("/src/config.mjs") && out.format === "module") {
      const src = typeof out.source === "string" ? out.source : new TextDecoder().decode(out.source);
      return { ...out, source: src + "\\nconfig.db.url = process.env.PG_TEST_URL; config.db.authToken = undefined;\\n" };
    }
    return out;
  }
`)), import.meta.url);
