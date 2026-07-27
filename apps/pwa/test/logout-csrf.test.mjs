// Integration test for signing out from the app bar.
//
// The global csrfGuard requires a matching _csrf field on every browser POST.
// The sign-out form rendered by appBar() must therefore carry the token —
// a form without it always gets a 403 and the user stays logged in.
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

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, get, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { authRouter } = await import("../src/routes/auth.mjs");
  const { pagesRouter } = await import("../src/routes/pages.mjs");

  const app = deps.express();
  app.use(deps.express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(authRouter);
  app.use(pagesRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = `mc_sess=${SESSION}; mc_csrf=${CSRF}`;

  await run(`INSERT INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','demo',1)`);
  await run(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)`,
    [SESSION, "u1", Date.now(), Date.now() + 60_000]);

  return { run, get, db, server, base, cookies };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

test("sign-out form carries the CSRF token, and submitting it logs out", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { get, base, cookies } = await app();

  const page = await fetch(`${base}/`, { headers: { cookie: cookies } });
  assert.equal(page.status, 200);
  const html = await page.text();

  // The app-bar sign-out form must include the session's CSRF token, or the
  // global csrfGuard rejects the POST with 403 and the user can never log out.
  const form = /<form method="post" action="\/auth\/logout"[^>]*>([\s\S]*?)<\/form>/.exec(html);
  assert.ok(form, "dashboard renders a sign-out form");
  const token = /name="_csrf" value="([^"]+)"/.exec(form[1]);
  assert.ok(token, "sign-out form must include a hidden _csrf field");
  assert.equal(token[1], CSRF);

  // Submitting the form as rendered destroys the session.
  const res = await fetch(`${base}/auth/logout`, {
    method: "POST",
    headers: { cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
    body: `_csrf=${encodeURIComponent(token[1])}`,
    redirect: "manual",
  });
  assert.equal(res.status, 302);
  assert.equal(await get(`SELECT token FROM sessions WHERE token = ?`, [SESSION]), null, "session row must be deleted");
});

test("csrfGuard still rejects a sign-out POST without a token", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { run, get, base, cookies } = await app();
  await run(`INSERT OR REPLACE INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)`,
    [SESSION, "u1", Date.now(), Date.now() + 60_000]);

  const res = await fetch(`${base}/auth/logout`, {
    method: "POST",
    headers: { cookie: cookies },
    redirect: "manual",
  });
  assert.equal(res.status, 403);
  assert.ok(await get(`SELECT token FROM sessions WHERE token = ?`, [SESSION]), "session must survive a rejected POST");
});
