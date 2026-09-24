// Web Push on @profullstack/notifications: the VAPID public key is served at
// run time, subscriptions arrive as PushSubscription.toJSON(), and delivery
// forgets a subscription the push service reports gone (404/410).
//
// Boots the real pages router against a throwaway libsql file database, and
// skips cleanly when the PWA dependencies are not installed.
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let deps = null;
let generateVapidKeys = null;
try {
  deps = { express: require("express"), cookieParser: require("cookie-parser") };
  ({ generateVapidKeys } = await import("@profullstack/notifications/server"));
} catch {
  deps = null; // pwa dependencies not installed — tests below skip
}
const skip = !deps && "pwa deps not installed";

// config reads the environment once, at import time — set it first. The app's
// historic variable names, so existing deploys keep their keys.
const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pwa-push-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
const KEYS = generateVapidKeys ? generateVapidKeys() : null;
if (KEYS) {
  process.env.VAPID_PUBLIC = KEYS.publicKey;
  process.env.VAPID_PRIVATE = KEYS.privateKey;
}

// A subscription a real browser could have made: a P-256 point and a 16-byte secret.
function browserSubscription(endpoint) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
}

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, all } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { pagesRouter } = await import("../src/routes/pages.mjs");
  const { fanOut } = await import("../src/lib/deliver.mjs");
  const { id, token } = await import("../src/lib/crypto.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(pagesRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const seedUser = async (userId) => {
    await run(`INSERT INTO users (id, email, display_name, created_at) VALUES (?,?,?,?)`,
      [userId, `${userId}@b.c`, "demo", Date.now()]);
    await run(`INSERT INTO channels (id,user_id,kind,target,enabled,created_at) VALUES (?,?,?,?,?,?)`,
      [id(), userId, "push", null, 1, Date.now()]);
    const sess = token();
    await run(`INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)`,
      [sess, userId, Date.now(), Date.now() + 3600e3]);
    return { id: userId, email: `${userId}@b.c`, sess };
  };
  const addSubscription = (userId, sub) =>
    run(`INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,created_at) VALUES (?,?,?,?,?,?)`,
      [id(), userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now()]);
  const post = (sess, url, body, method = "POST") => fetch(`${base}${url}`, {
    method,
    headers: { "content-type": "application/json", cookie: `mc_sess=${sess}; mc_csrf=tok`, "x-csrf-token": "tok" },
    body: JSON.stringify(body),
  });

  return { base, server, run, all, seedUser, addSubscription, post, fanOut };
}

test("GET /api/push/vapid-public-key serves the key at run time", { skip }, async () => {
  const { base, server } = await boot();
  try {
    const res = await fetch(`${base}/api/push/vapid-public-key`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await res.json(), { publicKey: KEYS.publicKey });
  } finally { server.close(); }
});

test("the dashboard no longer renders the key into the page", { skip }, async () => {
  const { base, server, seedUser } = await boot();
  try {
    const u = await seedUser("u-push-dash");
    const html = await fetch(`${base}/dashboard`, { headers: { cookie: `mc_sess=${u.sess}` } }).then((r) => r.text());
    assert.ok(html.includes('id="push-btn"'));
    assert.ok(!html.includes(KEYS.publicKey), "the public key comes from /api/push/vapid-public-key");
    assert.ok(html.includes('<script type="module" src="/push.js">'));
  } finally { server.close(); }
});

test("/push/subscribe stores a PushSubscription.toJSON(), and still the flat shape", { skip }, async () => {
  const { server, all, seedUser, post } = await boot();
  try {
    const u = await seedUser("u-push-sub");
    const a = browserSubscription("https://fcm.googleapis.com/fcm/send/a");
    assert.equal((await post(u.sess, "/push/subscribe", a)).status, 200);
    const b = browserSubscription("https://updates.push.services.mozilla.com/wpush/v2/b");
    assert.equal((await post(u.sess, "/push/subscribe", { endpoint: b.endpoint, ...b.keys })).status, 200);

    const rows = await all(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY endpoint`, [u.id]);
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { endpoint: a.endpoint, p256dh: a.keys.p256dh, auth: a.keys.auth },
      { endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth },
    ]);

    // not an https endpoint, or keys of the wrong size: refused
    assert.equal((await post(u.sess, "/push/subscribe", { ...a, endpoint: "http://evil.test/x" })).status, 400);
    assert.equal((await post(u.sess, "/push/subscribe", { endpoint: a.endpoint, keys: { p256dh: "x", auth: "y" } })).status, 400);

    // unsubscribe: DELETE (the package client) and POST (the original form)
    assert.equal((await post(u.sess, "/push/unsubscribe", { endpoint: a.endpoint }, "DELETE")).status, 200);
    assert.equal((await post(u.sess, "/push/unsubscribe", { endpoint: b.endpoint })).status, 200);
    assert.equal((await all(`SELECT id FROM push_subscriptions WHERE user_id = ?`, [u.id])).length, 0);
  } finally { server.close(); }
});

test("delivery sends an encrypted VAPID push and forgets 404/410 subscriptions", { skip }, async () => {
  const { server, all, seedUser, addSubscription, fanOut } = await boot();
  const realFetch = globalThis.fetch;
  try {
    const u = await seedUser("u-push-deliver");
    const live = browserSubscription("https://push.example.com/live");
    const gone = browserSubscription("https://push.example.com/gone");
    const missing = browserSubscription("https://push.example.com/missing");
    for (const s of [live, gone, missing]) await addSubscription(u.id, s);

    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      const status = url.endsWith("/gone") ? 410 : url.endsWith("/missing") ? 404 : 201;
      return new Response(null, { status });
    };
    const notified = await fanOut(u, { id: "a1", message: "promote to stable?", url: "https://app.moshcode.sh/approve/a1" });

    assert.deepEqual(notified, ["push"]);
    assert.equal(calls.length, 3);
    const h = calls[0].init.headers;
    assert.equal(h["content-encoding"], "aes128gcm");
    assert.equal(h.ttl, String(60 * 60 * 24 * 7 * 4), "web-push's 4-week default TTL is kept");
    assert.match(h.authorization, new RegExp(`^vapid t=[^,]+, k=${KEYS.publicKey}$`));

    const left = await all(`SELECT endpoint FROM push_subscriptions WHERE user_id = ?`, [u.id]);
    assert.deepEqual(left.map((r) => r.endpoint), [live.endpoint]);
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});

test("delivery reports push as not accepted when every device is gone", { skip }, async () => {
  const { server, all, seedUser, addSubscription, fanOut } = await boot();
  const realFetch = globalThis.fetch;
  try {
    const u = await seedUser("u-push-all-gone");
    await addSubscription(u.id, browserSubscription("https://push.example.com/old"));
    globalThis.fetch = async () => new Response(null, { status: 410 });
    assert.deepEqual(await fanOut(u, { id: "a2", message: "hi", url: "https://app.moshcode.sh/approve/a2" }), []);
    assert.equal((await all(`SELECT id FROM push_subscriptions WHERE user_id = ?`, [u.id])).length, 0);
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});
