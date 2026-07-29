// Regression tests for which CoinPay event types count as a payment
// confirmation (POST /webhooks/coinpay).
//
// The guard used to be a substring test, so it answered "does this event name
// contain a success word anywhere" rather than "is this a success event". Any
// status that embeds one as a substring — including its own negation
// ("payment.unpaid" contains "paid", "payment.unconfirmed" contains
// "confirmed") — was read as a confirmation and granted the full credit pack
// for money that never arrived.
//
// Same harness as credits-webhook.test.mjs: the real router against a
// throwaway libsql file database, skipping cleanly when the PWA dependencies
// are not installed. Run `npm install` in apps/pwa to enable them.
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
const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pwa-event-match-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, all } = await import("../src/db.mjs");
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

  const seedPurchase = async (payId, { userId = "u1", credits = 1000, usd = 5 } = {}) => {
    await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES (?,?,?,1)`,
      [userId, `${userId}@b.c`, "demo"]);
    await run(
      `INSERT INTO credit_purchases (id,user_id,credits,amount_usd,status,created_at) VALUES (?,?,?,?,?,?)`,
      [payId, userId, credits, usd, "pending", Date.now()]
    );
  };

  const granted = async (userId) => {
    const rows = await all(
      `SELECT delta FROM credit_ledger WHERE user_id = ? AND reason = 'topup.coinpay'`, [userId]);
    return { rows: rows.length, total: rows.reduce((s, r) => s + Number(r.delta), 0) };
  };

  const deliver = (payId, type) => new Promise((resolve, reject) => {
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

  return { all, server, seedPurchase, granted, deliver };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server }) => server.close())
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

// A status that negates a success word must not be read as a confirmation.
// "unpaid" ends in "paid" and "unconfirmed" ends in "confirmed", so a
// substring test grants the pack for a payment that did not land.
for (const type of ["payment.unpaid", "payment.unconfirmed"]) {
  test(`webhooks/coinpay: "${type}" credits nothing`, { skip: !deps && "apps/pwa deps not installed" }, async () => {
    const { seedPurchase, granted, deliver, all } = await app();
    const payId = `pay-${type.replace(/\W/g, "-")}`;
    const userId = `u-${type.replace(/\W/g, "-")}`;

    await seedPurchase(payId, { userId });
    const res = await deliver(payId, type);
    assert.equal(res.status, 200);

    assert.deepEqual(await granted(userId), { rows: 0, total: 0 },
      `${type} must not grant credits`);
    const [p] = await all(`SELECT status FROM credit_purchases WHERE id = '${payId}'`);
    assert.equal(p.status, "pending", `${type} must leave the purchase pending`);
  });
}

// Controls: the confirmation paths the app actually depends on must keep
// working. These pass both before and after the fix — they prove the fix
// tightened the guard rather than disabling the webhook.
for (const type of ["payment.confirmed", "payment.completed", "payment.paid", "PAYMENT.CONFIRMED"]) {
  test(`webhooks/coinpay: "${type}" still credits the balance`, { skip: !deps && "apps/pwa deps not installed" }, async () => {
    const { seedPurchase, granted, deliver, all } = await app();
    const payId = `pay-ok-${type.replace(/\W/g, "-")}`;
    const userId = `u-ok-${type.replace(/\W/g, "-")}`;

    await seedPurchase(payId, { userId });
    const res = await deliver(payId, type);
    assert.equal(res.status, 200);

    assert.deepEqual(await granted(userId), { rows: 1, total: 1000 },
      `${type} must grant the pack exactly once`);
    const [p] = await all(`SELECT status FROM credit_purchases WHERE id = '${payId}'`);
    assert.equal(p.status, "cleared");
  });
}
