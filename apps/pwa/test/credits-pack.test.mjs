// Integration test for the credit-pack lookup in POST /credits/buy.
//
// PACKS is a plain object literal, so `PACKS[req.body.pack]` resolves names
// off Object.prototype too: pack=constructor (or toString, hasOwnProperty, …)
// is truthy, skips the starter fallback, and the CoinPay payment goes out
// with no amount and no credits.
//
// Boots the real router against a throwaway libsql file database plus a stub
// CoinPay API; skips cleanly when the PWA dependencies are not installed.
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

const CSRF = "test-csrf-token";
const SESSION = "test-session-token";

// What the stub CoinPay API last received on /api/payments/create.
const received = [];

async function boot() {
  // Stub CoinPay API first: config reads COINPAY_API_BASE once, at import time.
  const stub = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => {
        received.push(JSON.parse(data));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "pay_1", hosted_url: "http://coinpay.test/pay/pay_1" }));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const stubPort = stub.address().port;

  const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pwa-test-"));
  process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
  process.env.SESSION_SECRET = "test-secret";
  process.env.COINPAY_BUSINESS_ID = "biz_test";
  process.env.COINPAY_API_BASE = `http://127.0.0.1:${stubPort}`;

  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
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
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = `mc_sess=${SESSION}; mc_csrf=${CSRF}`;

  await run(`INSERT INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','demo',1)`);
  await run(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)`,
    [SESSION, "u1", Date.now(), Date.now() + 60_000]);

  const buy = (pack) => fetch(`${base}/credits/buy`, {
    method: "POST",
    headers: { cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
    body: `_csrf=${CSRF}&pack=${encodeURIComponent(pack)}`,
    redirect: "manual",
  });

  return { run, db, server, stub, base, cookies, buy, workdir };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, stub, db, workdir }) => { server.close(); stub.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

test("credits/buy: a named pack buys that pack", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { buy } = await app();
  const res = await buy("pro");
  assert.equal(res.status, 302);
  const sent = received.at(-1);
  assert.equal(sent.amount, 20);
  assert.equal(sent.metadata.credits, 5000);
});

test("credits/buy: an unknown pack falls back to starter", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { buy } = await app();
  const res = await buy("bogus");
  assert.equal(res.status, 302);
  const sent = received.at(-1);
  assert.equal(sent.amount, 5);
  assert.equal(sent.metadata.credits, 1000);
});

test("credits/buy: an Object.prototype name falls back to starter too", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { buy } = await app();
  const res = await buy("constructor");
  assert.equal(res.status, 302);
  const sent = received.at(-1);
  assert.equal(sent.amount, 5, "pack=constructor must not reach CoinPay with a missing amount");
  assert.equal(sent.metadata.credits, 1000);
});
