// Integration tests for the credit chip on the two CLI-connect pages.
//
// appBar(user, balance, csrf) renders a "◆ <n> cr" chip for every signed-in
// visitor. Every other signed-in page passes the account's real balance, so
// the chip is a live readout of what the account can spend. The two CLI pages
// (/cli/authorize and /device) must do the same: a chip that always says 0
// tells a funded account it is broke on the page where it is deciding whether
// to connect a device.
//
// Boots the real routers against a throwaway libsql file database; skips
// cleanly when the PWA dependencies are not installed.
import assert from "node:assert/strict";
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

const CSRF = "test-csrf-token";
const SESSION = "test-session-token";
const CREDITS = 4321;

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, get, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { cliRouter } = await import("../src/routes/cli.mjs");
  const { sessionsRouter } = await import("../src/routes/sessions.mjs");
  const { pagesRouter } = await import("../src/routes/pages.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(cliRouter);
  app.use(sessionsRouter);
  app.use(pagesRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = `mc_sess=${SESSION}; mc_csrf=${CSRF}`;

  await run(`INSERT INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','demo',1)`);
  await run(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)`,
    [SESSION, "u1", Date.now(), Date.now() + 60_000]);
  await run(`INSERT INTO credit_ledger (id,user_id,delta,reason,created_at) VALUES (?,?,?,?,?)`,
    ["led-1", "u1", CREDITS, "test.seed", Date.now()]);
  await run(
    `INSERT INTO cli_sessions (id,user_id,name,status,created_at,last_seen_at) VALUES (?,?,?,?,?,?)`,
    ["cli-1", "u1", "local", "live", Date.now(), Date.now()],
  );

  return { run, get, db, server, base, cookies };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

// The chip is rendered as: <span class="bal-chip">◆ <b>4,321</b> cr</span>
// toLocaleString() puts separators in, so read the digits back out.
function chipBalance(html) {
  const m = /<span class="bal-chip">[^<]*<b>([^<]+)<\/b>/.exec(html);
  assert.ok(m, "page must render the app-bar balance chip");
  return Number(m[1].replace(/[^0-9-]/g, ""));
}

const AUTHORIZE = "/cli/authorize?redirect_uri=" + encodeURIComponent("http://127.0.0.1:9999/cb") +
  "&state=st&code_challenge=ch&name=moshcode+cli";

test("GET /cli/authorize shows the account's real balance", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { base, cookies } = await app();
  const res = await fetch(`${base}${AUTHORIZE}`, { headers: { cookie: cookies } });
  assert.equal(res.status, 200);
  assert.equal(chipBalance(await res.text()), CREDITS);
});

test("GET /device shows the account's real balance", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { base, cookies } = await app();
  const res = await fetch(`${base}/device`, { headers: { cookie: cookies } });
  assert.equal(res.status, 200);
  assert.equal(chipBalance(await res.text()), CREDITS);
});

test("GET /sessions shows the account's real balance", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { base, cookies } = await app();
  const res = await fetch(`${base}/sessions`, { headers: { cookie: cookies } });
  assert.equal(res.status, 200);
  assert.equal(chipBalance(await res.text()), CREDITS);
});

test("GET /sessions/:id shows the account's real balance", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { base, cookies } = await app();
  const res = await fetch(`${base}/sessions/cli-1`, { headers: { cookie: cookies } });
  assert.equal(res.status, 200);
  assert.equal(chipBalance(await res.text()), CREDITS);
});

// Control: the dashboard already reads the ledger, so this passes either way.
// It proves the seeded balance is really 4321 and that the chip parser works,
// which is what makes the two failures above meaningful.
test("control: the dashboard chip already reads the ledger", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { base, cookies } = await app();
  const res = await fetch(`${base}/dashboard`, { headers: { cookie: cookies } });
  assert.equal(res.status, 200);
  assert.equal(chipBalance(await res.text()), CREDITS);
});

// Control: the CLI pages must keep working, chip aside. A signed-in visitor
// gets the approve form (with its CSRF field), not an error page.
test("control: /cli/authorize still renders the approve form", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { base, cookies } = await app();
  const html = await (await fetch(`${base}${AUTHORIZE}`, { headers: { cookie: cookies } })).text();
  assert.match(html, /<form method="post" action="\/cli\/authorize"/);
  assert.match(html, /name="_csrf" value="test-csrf-token"/);
});
