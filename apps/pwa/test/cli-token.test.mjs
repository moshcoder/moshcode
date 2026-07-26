// Integration tests for the CLI auth-code exchange (POST /cli/token).
//
// These boot the real router against a throwaway libsql file database. They
// skip cleanly when the PWA dependencies are not installed (a fresh repo
// clone only has the root CLI deps), so the root `npm test` stays green
// either way. Run `npm install` in apps/pwa to enable them.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
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
const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pwa-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, all, get, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { cliRouter } = await import("../src/routes/cli.mjs");

  const app = deps.express();
  app.use(deps.express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(cliRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const seedCode = async (code, verifier, { used = 0, ageMs = 0 } = {}) => {
    await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','demo',1)`);
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const now = Date.now();
    await run(
      `INSERT INTO cli_auth_codes (code,user_id,code_challenge,redirect_uri,name,created_at,expires_at) VALUES (?,?,?,?,?,?,?)`,
      [code, "u1", challenge, "http://127.0.0.1:9/callback", "test", now - ageMs, now - ageMs + 5 * 60 * 1000]
    );
  };
  const exchange = (code, verifier) => fetch(`${base}/cli/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  return { run, all, get, db, server, seedCode, exchange };
}

// One shared app/db for the whole file (db.mjs is a module-level singleton —
// closing it between tests would break the next boot).
let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

test("cli/token: a code exchanges exactly once, then is rejected", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { all, seedCode, exchange } = await app();

  const verifier = "verifier-" + crypto.randomBytes(16).toString("hex");
  await seedCode("code-once", verifier);

  const before = (await all(`SELECT id FROM api_keys`)).length;
  const first = await exchange("code-once", verifier);
  assert.equal(first.status, 200);
  assert.ok(first.body.access_token, "first exchange must mint an API key");
  assert.equal((await all(`SELECT id FROM api_keys`)).length, before + 1);

  // Replay with the same code + verifier must fail — the code is single-use.
  const replay = await exchange("code-once", verifier);
  assert.equal(replay.status, 400);
  assert.equal((await all(`SELECT id FROM api_keys`)).length, before + 1, "replay must not mint a second key");
});

test("cli/token: wrong PKCE verifier is rejected and does not consume the code", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { all, seedCode, exchange } = await app();

  const verifier = "verifier-" + crypto.randomBytes(16).toString("hex");
  await seedCode("code-pkce", verifier);

  const before = (await all(`SELECT id FROM api_keys`)).length;
  const bad = await exchange("code-pkce", "wrong-verifier");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "PKCE verification failed");
  assert.equal((await all(`SELECT id FROM api_keys`)).length, before, "failed PKCE must not mint a key");

  // The code was NOT consumed by the failed attempt — the real verifier works.
  const good = await exchange("code-pkce", verifier);
  assert.equal(good.status, 200);
  assert.equal((await all(`SELECT id FROM api_keys`)).length, before + 1);
});

test("cli/token: expired codes are rejected", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { seedCode, exchange } = await app();

  const verifier = "verifier-" + crypto.randomBytes(16).toString("hex");
  await seedCode("code-old", verifier, { ageMs: 10 * 60 * 1000 }); // 10min old, 5min TTL

  const res = await exchange("code-old", verifier);
  assert.equal(res.status, 400);
});
