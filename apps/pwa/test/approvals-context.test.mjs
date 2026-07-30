// The approve page's context grid is a label→value map, so it must only build
// cells from a real object. POST /api/approvals stores whatever the client
// sent, and Object.entries() on a string indexes it per character.
//
// These boot the real router against a throwaway libsql file database. They
// skip cleanly when the PWA dependencies are not installed (a fresh repo clone
// only has the root CLI deps), so the root `npm test` stays green either way.
// Run `npm install` in apps/pwa to enable them.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = { express: require("express"), cookieParser: require("cookie-parser") };
} catch {
  deps = null; // pwa dependencies not installed — tests below skip
}

// Point the app at a throwaway database BEFORE importing its modules (config
// reads the environment once, at import time).
const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pwa-context-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { approvalsRouter } = await import("../src/routes/approvals.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");
  const { id } = await import("../src/lib/crypto.mjs");

  const app = deps.express();
  app.use(deps.express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(approvalsRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const userId = id();
  await run(`INSERT INTO users (id, email, display_name, created_at) VALUES (?,?,?,?)`,
    [userId, `${userId}@b.c`, "demo", Date.now()]);
  const { plaintext } = await createApiKey(userId, "cli");

  // POST an approval carrying `context`, then read the page the operator opens
  // and pull out the (label, value) pairs of the context grid.
  const cellsFor = async (context) => {
    const res = await fetch(`${base}/api/approvals`, {
      method: "POST",
      headers: { authorization: `Bearer ${plaintext}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "ship it?", kind: "ask", script: "ship.mosh", context }),
    });
    assert.equal(res.status, 201);
    const { id: approvalId, url } = await res.json();
    const cap = new URL(url).searchParams.get("t");
    const page = await fetch(`${base}/approve/${approvalId}?t=${cap}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    return [...html.matchAll(/<div class="label" style="font-size:.6rem">([^<]*)<\/div><div class="mono" style="margin-top:3px">([^<]*)</g)]
      .map((m) => [m[1], m[2]]);
  };

  return { cellsFor, close: () => server.close() };
}

test("an object context still renders one cell per key", { skip: !deps && "pwa deps not installed" }, async () => {
  const app = await boot();
  try {
    assert.deepEqual(await app.cellsFor({ env: "prod", sha: "a1b2c3" }), [["env", "prod"], ["sha", "a1b2c3"]]);
  } finally { app.close(); }
});

test("a string context is one cell, not one cell per character", { skip: !deps && "pwa deps not installed" }, async () => {
  const app = await boot();
  try {
    // Before the fix this was 21 cells labelled 0…20, one letter each.
    assert.deepEqual(await app.cellsFor("deploy failed on prod"), [["context", "deploy failed on prod"]]);
  } finally { app.close(); }
});

test("a number or boolean context is shown, not silently dropped", { skip: !deps && "pwa deps not installed" }, async () => {
  const app = await boot();
  try {
    // Object.entries(42) and Object.entries(true) are both [], so the value the
    // caller sent never reached the page at all.
    assert.deepEqual(await app.cellsFor(42), [["context", "42"]]);
    assert.deepEqual(await app.cellsFor(true), [["context", "true"]]);
  } finally { app.close(); }
});

test("an array context keeps its index-labelled cells", { skip: !deps && "pwa deps not installed" }, async () => {
  const app = await boot();
  try {
    // An array is an object, so it is left exactly as it rendered before.
    assert.deepEqual(await app.cellsFor(["first", "second"]), [["0", "first"], ["1", "second"]]);
  } finally { app.close(); }
});

test("no context renders no grid at all", { skip: !deps && "pwa deps not installed" }, async () => {
  const app = await boot();
  try {
    assert.deepEqual(await app.cellsFor(undefined), []);
  } finally { app.close(); }
});
