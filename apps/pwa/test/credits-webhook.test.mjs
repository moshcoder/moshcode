// Integration tests for the CoinPay payment webhook (POST /webhooks/coinpay).
//
// These boot the real router against a throwaway libsql file database. They
// skip cleanly when the PWA dependencies are not installed (a fresh repo
// clone only has the root CLI deps), so the root `npm test` stays green
// either way. Run `npm install` in apps/pwa to enable them.
import assert from "node:assert/strict";
import crypto from "node:crypto";
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

// CoinPay signs t=<unix>,v1=<hmac-sha256 hex of "t.rawBody">.
const WEBHOOK_SECRET = "whsec_test_secret";
process.env.COINPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
function signature(raw, secret = WEBHOOK_SECRET) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
}

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
    const body = JSON.stringify({ type, data: { id: payId } });
    const req = http.request({
      host: "127.0.0.1", port, path: "/webhooks/coinpay", method: "POST", agent: false,
      headers: { "content-type": "application/json", "x-coinpay-signature": signature(body) },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(body);
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

// Post any body, signed (default) or with the given signature header.
async function postRaw(obj, sig) {
  const { server } = await app();
  const body = JSON.stringify(obj);
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json" };
    const s = sig === undefined ? signature(body) : sig;
    if (s) headers["x-coinpay-signature"] = s;
    const req = http.request({
      host: "127.0.0.1", port: server.address().port, path: "/webhooks/coinpay", method: "POST", agent: false, headers,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const nested = (sessionId, status = "confirmed", type = `payment.${status}`) => ({
  id: "evt_pay-real_1761040000",
  type,
  data: {
    payment_id: "pay-real", status, checkout_session_id: sessionId,
    customer_email: "a@b.c", account_id: "u-cs", property: "app.moshcode.sh", metadata: { kind: "credits" },
  },
});

test("webhooks/coinpay: an unsigned delivery is refused and credits nothing", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { seedPurchase, granted } = await app();
  await seedPurchase("cs_unsigned", { userId: "u-unsigned" });
  const res = await postRaw(nested("cs_unsigned"), "");
  assert.equal(res.status, 401);
  assert.deepEqual(await granted("u-unsigned"), { rows: 0, total: 0 });
});

test("webhooks/coinpay: a wrong-secret signature is refused", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { seedPurchase, granted } = await app();
  await seedPurchase("cs_badsig", { userId: "u-badsig" });
  const body = nested("cs_badsig");
  const res = await postRaw(body, signature(JSON.stringify(body), "not-the-secret"));
  assert.equal(res.status, 401);
  assert.deepEqual(await granted("u-badsig"), { rows: 0, total: 0 });
});

test("webhooks/coinpay: a nested confirmed event settles the purchase keyed by checkout_session_id", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { seedPurchase, granted, all } = await app();
  await seedPurchase("cs_nested", { userId: "u-cs" });
  const res = await postRaw(nested("cs_nested"));
  assert.equal(res.status, 200);
  assert.equal(res.body.settled, true);
  assert.deepEqual(await granted("u-cs"), { rows: 1, total: 1000 });
  const [p] = await all(`SELECT status FROM credit_purchases WHERE id = 'cs_nested'`);
  assert.equal(p.status, "cleared");
});

test("webhooks/coinpay: forwarded counts as paid; the top-level event id is never used", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { seedPurchase, granted } = await app();
  await seedPurchase("cs_fwd", { userId: "u-fwd" });
  // A purchase keyed by the event id must never match.
  await seedPurchase("evt_pay-real_1761040000", { userId: "u-evt" });
  await postRaw(nested("cs_fwd", "forwarded"));
  assert.deepEqual(await granted("u-fwd"), { rows: 1, total: 1000 });
  assert.deepEqual(await granted("u-evt"), { rows: 0, total: 0 });
});

test("webhooks/coinpay: an expired session settles nothing", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { seedPurchase, granted } = await app();
  await seedPurchase("cs_expired", { userId: "u-expired" });
  const res = await postRaw(nested("cs_expired", "expired"));
  assert.equal(res.status, 200);
  assert.deepEqual(await granted("u-expired"), { rows: 0, total: 0 });
});
