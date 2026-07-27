// Integration tests for the CoinPay payment webhook (POST /webhooks/coinpay).
//
// These boot the real router against a throwaway libsql file database. They
// skip cleanly when the PWA dependencies are not installed (a fresh repo
// clone only has the root CLI deps), so the root `npm test` stays green
// either way. Run `npm install` in apps/pwa to enable them.
import assert from "node:assert/strict";
import http from "node:http";
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
const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pwa-webhook-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, all, db } = await import("../src/db.mjs");
  // The local libsql driver resolves statements in microtasks, which fully
  // serializes concurrent request handlers and hides read-check-write races.
  // Production runs against a network database (Turso), where every statement
  // is a round trip. Defer each statement to a macrotask so two in-flight
  // handlers genuinely interleave, like they would against the remote DB.
  const execute = db.execute.bind(db);
  db.execute = (stmt) => new Promise((resolve, reject) => {
    setTimeout(() => execute(stmt).then(resolve, reject), 2);
  });
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { creditsRouter } = await import("../src/routes/credits.mjs");

  const app = deps.express();
  app.use(deps.express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(creditsRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address();

  const seedPurchase = async (payId, { userId = "u1", credits = 1000, usd = 5, status = "pending" } = {}) => {
    await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES (?,?,?,1)`,
      [userId, `${userId}@b.c`, "demo"]);
    await run(
      `INSERT INTO credit_purchases (id,user_id,credits,amount_usd,status,created_at) VALUES (?,?,?,?,?,?)`,
      [payId, userId, credits, usd, status, Date.now()]
    );
  };

  const granted = async (userId) => {
    const rows = await all(
      `SELECT delta FROM credit_ledger WHERE user_id = ? AND reason = 'topup.coinpay'`, [userId]);
    return { rows: rows.length, total: rows.reduce((s, r) => s + Number(r.delta), 0) };
  };

  // Raw http with a fresh connection per request: fetch()/undici would reuse a
  // keep-alive socket for same-origin calls and serialize the "concurrent"
  // deliveries, hiding the race this exercises.
  const deliver = (payId, type = "payment.confirmed") => new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: "/webhooks/coinpay", method: "POST", agent: false,
      headers: { "content-type": "application/json" },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ type, data: { id: payId } }));
  });

  return { run, all, db, server, seedPurchase, granted, deliver };
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

test("webhooks/coinpay: a confirmed payment credits the balance once", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { all, seedPurchase, granted, deliver } = await app();

  await seedPurchase("pay-once", { userId: "u-once" });
  const res = await deliver("pay-once");
  assert.equal(res.status, 200);

  assert.deepEqual(await granted("u-once"), { rows: 1, total: 1000 });
  const [p] = await all(`SELECT status FROM credit_purchases WHERE id = 'pay-once'`);
  assert.equal(p.status, "cleared");
});

test("webhooks/coinpay: a replayed delivery does not credit twice", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { seedPurchase, granted, deliver } = await app();

  await seedPurchase("pay-replay", { userId: "u-replay" });
  await deliver("pay-replay");
  await deliver("pay-replay"); // provider retries after a slow ack

  assert.deepEqual(await granted("u-replay"), { rows: 1, total: 1000 });
});

test("webhooks/coinpay: concurrent duplicate deliveries credit exactly once", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { seedPurchase, granted, deliver } = await app();

  // CoinPay retries an unacknowledged webhook, so the same confirmation can be
  // in flight twice. Both handlers read the purchase as pending before either
  // marks it cleared — only one may credit the ledger.
  await seedPurchase("pay-race", { userId: "u-race" });
  await Promise.all([deliver("pay-race"), deliver("pay-race")]);

  assert.deepEqual(await granted("u-race"), { rows: 1, total: 1000 });
});

test("webhooks/coinpay: an unrelated event type credits nothing", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { seedPurchase, granted, deliver, all } = await app();

  await seedPurchase("pay-other", { userId: "u-other" });
  const res = await deliver("pay-other", "payment.failed");
  assert.equal(res.status, 200);

  assert.deepEqual(await granted("u-other"), { rows: 0, total: 0 });
  const [p] = await all(`SELECT status FROM credit_purchases WHERE id = 'pay-other'`);
  assert.equal(p.status, "pending");
});
