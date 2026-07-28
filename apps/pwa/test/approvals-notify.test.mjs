// A fire-and-forget notify() must not sit in the operator's "needs you" queue.
//
// These boot the real routers against a throwaway libsql file database. They
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
const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pwa-notify-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, all, get } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { approvalsRouter } = await import("../src/routes/approvals.mjs");
  const { pagesRouter } = await import("../src/routes/pages.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");
  const { id, token } = await import("../src/lib/crypto.mjs");

  const app = deps.express();
  app.use(deps.express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(approvalsRouter);
  app.use(pagesRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  // A user with push enabled (free, and on by default for real signups), plus
  // the API key the CLI sends and a browser session for the dashboard.
  const seedUser = async (userId) => {
    await run(`INSERT INTO users (id, email, display_name, created_at) VALUES (?,?,?,?)`,
      [userId, `${userId}@b.c`, "demo", Date.now()]);
    await run(`INSERT INTO channels (id,user_id,kind,target,enabled,created_at) VALUES (?,?,?,?,?,?)`,
      [id(), userId, "push", null, 1, Date.now()]);
    const { plaintext } = await createApiKey(userId, "cli");
    const sess = token();
    await run(`INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)`,
      [sess, userId, Date.now(), Date.now() + 3600e3]);
    return { key: plaintext, sess };
  };

  // What the CLI does: POST /api/approvals with kind ask | notify.
  const ingest = async (key, kind, message) => {
    const res = await fetch(`${base}/api/approvals`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ message, kind, script: "ship.mosh" }),
    });
    return { status: res.status, body: await res.json() };
  };

  const dashboard = (sess) => fetch(`${base}/dashboard`, { headers: { cookie: `mc_sess=${sess}` } }).then((r) => r.text());
  const approvePage = (id, cap) => fetch(`${base}/approve/${id}?t=${cap}`).then((r) => r.text());

  return { base, server, run, all, get, seedUser, ingest, dashboard, approvePage };
}

// The dashboard's "needs you" column links each pending approval; "moshed"
// history renders the message in a <b> instead.
const waitingBanner = (html) => Number(/(\d+) waiting on you/.exec(html)?.[1]);
const needsYou = (html) =>
  [...html.matchAll(/href="\/approve\/[^"]*"[\s\S]{0,400}?font-weight:700">([^<]*)</g)].map((m) => m[1]);
const moshed = (html) => [...html.matchAll(/<b style="color:var\(--text\)">([^<]*)</g)].map((m) => m[1]);

test("a notify() is filed as already sent, not pending", { skip: !deps && "pwa deps not installed" }, async () => {
  const { server, get, seedUser, ingest } = await boot();
  try {
    const { key } = await seedUser("u-notify-status");
    const { status, body } = await ingest(key, "notify", "deployed to prod");
    assert.equal(status, 201);
    assert.equal(body.status, "sent");

    const row = await get(`SELECT status, submitted_at FROM approvals WHERE id = ?`, [body.id]);
    assert.equal(row.status, "sent");
    assert.ok(row.submitted_at, "a sent notify is resolved, so it needs a submitted_at to sort history by");
  } finally { server.close(); }
});

test("an ask() still waits on a human", { skip: !deps && "pwa deps not installed" }, async () => {
  const { server, get, seedUser, ingest } = await boot();
  try {
    const { key } = await seedUser("u-ask-status");
    const { body } = await ingest(key, "ask", "promote to stable?");
    assert.equal(body.status, "pending");

    const row = await get(`SELECT status, submitted_at FROM approvals WHERE id = ?`, [body.id]);
    assert.equal(row.status, "pending");
    assert.equal(row.submitted_at, null);
  } finally { server.close(); }
});

test("the dashboard counts only what is actually waiting", { skip: !deps && "pwa deps not installed" }, async () => {
  const { server, seedUser, ingest, dashboard } = await boot();
  try {
    const { key, sess } = await seedUser("u-dash");
    // a typical script run: chatter along the way, one real gate at the end
    for (const m of ["build started", "tests green", "deployed to prod"]) await ingest(key, "notify", m);
    await ingest(key, "ask", "promote to stable?");

    const html = await dashboard(sess);
    assert.equal(waitingBanner(html), 1, "only the ask() is waiting on the operator");
    assert.deepEqual(needsYou(html), ["promote to stable?"]);
    // the notifications are history, not a queue
    assert.deepEqual(moshed(html).sort(), ["build started", "deployed to prod", "tests green"]);
  } finally { server.close(); }
});

test("a notify() cannot be answered — it stays sent and records no reply",
  { skip: !deps && "pwa deps not installed" }, async () => {
  const { base, server, get, seedUser, ingest } = await boot();
  try {
    const { key } = await seedUser("u-notify-resolve");
    const { body } = await ingest(key, "notify", "deployed to prod");
    const cap = (await get(`SELECT cap_token FROM approvals WHERE id = ?`, [body.id])).cap_token;

    // the page issues the double-submit CSRF cookie the form posts back
    const pageRes = await fetch(`${base}/approve/${body.id}?t=${cap}`);
    await pageRes.text();
    const csrf = /mc_csrf=([^;]+)/.exec(pageRes.headers.getSetCookie().join("; "))[1];

    const res = await fetch(`${base}/approve/${body.id}?t=${cap}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `mc_csrf=${csrf}` },
      body: new URLSearchParams({ response: "sure, go ahead", _csrf: csrf }),
      redirect: "manual",
    });
    assert.equal(res.status, 302);

    const row = await get(`SELECT status, response FROM approvals WHERE id = ?`, [body.id]);
    assert.equal(row.status, "sent");
    assert.equal(row.response, null);
  } finally { server.close(); }
});

test("the notify page says there is nothing to respond to", { skip: !deps && "pwa deps not installed" }, async () => {
  const { server, get, seedUser, ingest, approvePage } = await boot();
  try {
    const { key } = await seedUser("u-notify-page");
    const { body } = await ingest(key, "notify", "deployed to prod");
    const cap = (await get(`SELECT cap_token FROM approvals WHERE id = ?`, [body.id])).cap_token;

    const html = await approvePage(body.id, cap);
    assert.match(html, /nothing to respond to/);
    assert.doesNotMatch(html, /You replied/);
    assert.doesNotMatch(html, /Kill the loop/, "a notification has no loop to kill");
  } finally { server.close(); }
});
