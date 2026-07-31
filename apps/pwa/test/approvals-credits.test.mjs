// Integration tests for credit accounting on approval ingest (POST /api/approvals).
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
const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pwa-approvals-test-"));
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
  const { approvalsRouter } = await import("../src/routes/approvals.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");
  const { balance } = await import("../src/lib/credits.mjs");
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
  const { port } = server.address();
  const webhookDeliveries = [];
  const webhookServer = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => {
        webhookDeliveries.push({
          contentType: req.headers["content-type"],
          body: JSON.parse(data),
        });
        res.writeHead(204).end();
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const webhookUrl = `http://127.0.0.1:${webhookServer.address().port}/hook`;

  // A user with the given enabled channels and a starting balance. Returns the
  // plaintext API key the CLI would send.
  const seedUser = async (userId, { credits = 0, channels = [] } = {}) => {
    await run(`INSERT INTO users (id, email, display_name, created_at) VALUES (?,?,?,?)`,
      [userId, `${userId}@b.c`, "demo", Date.now()]);
    for (const [kind, target] of channels) {
      await run(`INSERT INTO channels (id,user_id,kind,target,enabled,created_at) VALUES (?,?,?,?,?,?)`,
        [id(), userId, kind, target ?? null, 1, Date.now()]);
    }
    if (credits) {
      await run(`INSERT INTO credit_ledger (id,user_id,delta,reason,created_at) VALUES (?,?,?,?,?)`,
        [id(), userId, credits, "test.seed", Date.now()]);
    }
    const { plaintext } = await createApiKey(userId, "test");
    return plaintext;
  };

  const charges = (userId) =>
    all(`SELECT delta FROM credit_ledger WHERE user_id = ? AND reason = 'approval.delivered'`, [userId]);

  // Raw http with a fresh connection per request: fetch()/undici would reuse a
  // keep-alive socket for same-origin calls and serialize the "concurrent"
  // ingests, hiding the race this exercises.
  const ingest = (key, message) => new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: "/api/approvals", method: "POST", agent: false,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ message }));
  });

  return {
    run, all, db, server, webhookServer, webhookUrl, webhookDeliveries,
    seedUser, charges, ingest, balance,
  };
}

// One shared app/db for the whole file (db.mjs is a module-level singleton —
// closing it between tests would break the next boot).
let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, webhookServer, db }) => {
    server.close();
    webhookServer.close();
    db.close?.();
  })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

test("api/approvals: a paid delivery is charged exactly once", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { seedUser, charges, ingest, balance } = await app();

  const key = await seedUser("u-single", { credits: 12, channels: [["sms", "+15550000"]] });
  const res = await ingest(key, "ship it?");

  assert.equal(res.status, 201);
  assert.deepEqual(res.body.delivered, ["sms"]);
  assert.equal(res.body.charged, 12);
  assert.deepEqual((await charges("u-single")).map((r) => Number(r.delta)), [-12]);
  assert.equal(await balance("u-single"), 0);
});

test("api/approvals: concurrent ingests cannot spend the same credits twice", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { seedUser, charges, ingest, balance } = await app();

  // A moshscript can fire ask()/notify() in parallel, so two ingests for one
  // account are in flight at once. Both read a balance that covers one paid
  // delivery — only one of them may actually get it.
  const key = await seedUser("u-race", { credits: 12, channels: [["sms", "+15550000"]] });
  const [a, b] = await Promise.all([ingest(key, "deploy A?"), ingest(key, "deploy B?")]);

  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.deepEqual((await charges("u-race")).map((r) => Number(r.delta)), [-12]);
  assert.equal(await balance("u-race"), 0);
  // exactly one of the two got the paid channel; the other was told why not
  const paid = [a, b].filter((r) => r.body.delivered.includes("sms"));
  assert.equal(paid.length, 1);
  const refused = [a, b].find((r) => !r.body.delivered.includes("sms"));
  assert.match(refused.body.warning, /insufficient credits/);
});

test("api/approvals: a second sequential ingest falls back to free channels", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { seedUser, ingest, balance, webhookUrl, webhookDeliveries } = await app();

  webhookDeliveries.length = 0;
  const key = await seedUser("u-seq", { credits: 12, channels: [["sms", "+15550000"], ["webhook", webhookUrl]] });
  const first = await ingest(key, "first");
  const second = await ingest(key, "second");

  assert.deepEqual(first.body.delivered, ["sms", "webhook"]);
  assert.equal(first.body.charged, 12);
  assert.deepEqual(second.body.delivered, ["webhook"]); // free channel still goes out
  assert.equal(second.body.charged, 0);
  assert.match(second.body.warning, /insufficient credits/);
  assert.equal(await balance("u-seq"), 0);
  assert.deepEqual(webhookDeliveries.map((delivery) => delivery.body.message), ["first", "second"]);
  assert.ok(webhookDeliveries.every((delivery) => delivery.contentType === "application/json"));
  assert.ok(webhookDeliveries.every((delivery) => delivery.body.url.includes("/approve/")));
});

test("api/approvals: a channel that fails to deliver is not charged for", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { seedUser, charges, ingest, balance } = await app();

  // slack has no webhook target and no configured default, so it refuses the
  // send. The ledger must show only what actually went out.
  const key = await seedUser("u-partial", { credits: 16, channels: [["sms", "+15550000"], ["slack", null]] });
  const res = await ingest(key, "half of this lands");

  assert.deepEqual(res.body.delivered, ["sms"]);
  assert.equal(res.body.charged, 12);
  assert.deepEqual((await charges("u-partial")).map((r) => Number(r.delta)), [-12]);
  assert.equal(await balance("u-partial"), 4); // the 4 held for slack is released
});

test("api/approvals: an SMS channel without a target is not charged for", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { seedUser, charges, ingest, balance } = await app();

  const key = await seedUser("u-sms-empty", { credits: 12, channels: [["sms", null]] });
  const res = await ingest(key, "nowhere to send");

  assert.deepEqual(res.body.delivered, []);
  assert.equal(res.body.charged, 0);
  assert.deepEqual(await charges("u-sms-empty"), []);
  assert.equal(await balance("u-sms-empty"), 12);
});

test("api/approvals: a free-only account is never charged", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { seedUser, charges, ingest, balance, webhookUrl, webhookDeliveries } = await app();

  webhookDeliveries.length = 0;
  const key = await seedUser("u-free", { credits: 0, channels: [["webhook", webhookUrl]] });
  const res = await ingest(key, "free ping");

  assert.deepEqual(res.body.delivered, ["webhook"]);
  assert.equal(res.body.charged, 0);
  assert.equal(res.body.warning, undefined);
  assert.deepEqual(await charges("u-free"), []); // no zero-value ledger noise
  assert.equal(await balance("u-free"), 0);
  assert.equal(webhookDeliveries.length, 1);
  assert.equal(webhookDeliveries[0].body.message, "free ping");
});
