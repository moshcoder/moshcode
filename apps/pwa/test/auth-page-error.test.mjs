// Integration test for the `?err=` reason on the sign-in page.
//
// The CoinPay login flow bounces every failure to "/" — coinpay.mjs sends
// ?err=coinpay-not-configured, -state, -denied and -failed. All four happen
// before a session exists, so "/" serves the anonymous sign-in page, which
// rendered the bare form and dropped the reason on the floor: the visitor is
// returned to a sign-in screen with no hint that anything went wrong. /settings
// already renders the same query parameter, so the markup existed; only the
// sign-in branch never passed it through.
//
// Boots the real routers (including coinpayRouter, so the redirect under test is
// the app's own, not a hand-written URL) against a throwaway libsql file
// database; skips cleanly when the PWA dependencies are not installed.
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
// reads the environment once, at import time). COINPAY_OAUTH_* stays unset, so
// config.coinpayLoginEnabled is false and /auth/coinpay/start takes its
// not-configured redirect without any network access.
const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pwa-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const SESSION = "test-session-token";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { authRouter } = await import("../src/routes/auth.mjs");
  const { pagesRouter } = await import("../src/routes/pages.mjs");
  const { coinpayRouter } = await import("../src/routes/coinpay.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(coinpayRouter);
  app.use(authRouter);
  app.use(pagesRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  await run(`INSERT INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','demo',1)`);
  await run(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)`,
    [SESSION, "u1", Date.now(), Date.now() + 60_000]);

  return { server, db, base: `http://127.0.0.1:${server.address().port}` };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = !deps && "apps/pwa deps not installed";

// The reason banner both the sign-in page and /settings use.
const notice = (html) => {
  const m = /<div class="notice err">([\s\S]*?)<\/div>/.exec(html);
  return m ? m[1].trim() : null;
};
const isSignInPage = (html) => /id="passkey-btn"/.test(html);

async function get(url, { signedIn = false } = {}) {
  const { base } = await app();
  const res = await fetch(`${base}${url}`, {
    headers: signedIn ? { cookie: `mc_sess=${SESSION}` } : {},
  });
  return { status: res.status, html: await res.text() };
}

// ---------- the bug ----------

test("the app's own CoinPay failure redirect explains itself", { skip }, async () => {
  const { base } = await app();
  const started = await fetch(`${base}/auth/coinpay/start`, { redirect: "manual" });
  assert.equal(started.status, 302);
  const location = started.headers.get("location");
  assert.equal(location, "/?err=coinpay-not-configured", "the route under test still redirects here");

  const { status, html } = await get(location);
  assert.equal(status, 200);
  assert.ok(isSignInPage(html), "an anonymous visitor lands on the sign-in page");
  assert.equal(notice(html), "coinpay not configured", "the reason must reach the visitor");
});

test("every CoinPay failure code shows a reason", { skip }, async () => {
  for (const code of ["coinpay-state", "coinpay-denied", "coinpay-failed"]) {
    const { html } = await get(`/?err=${code}`);
    assert.ok(isSignInPage(html), `${code} still renders the sign-in page`);
    assert.equal(notice(html), code.replace(/-/g, " "), `${code} must be explained`);
  }
});

test("the sign-in page reports the reason the way /settings does", { skip }, async () => {
  const anon = await get("/?err=coinpay-failed");
  const authed = await get("/settings?err=coinpay-failed", { signedIn: true });
  assert.equal(notice(anon.html), notice(authed.html), "one wording for one failure");
});

// ---------- controls: these pass with or without the fix ----------

test("a clean sign-in page shows no error banner", { skip }, async () => {
  const { html } = await get("/");
  assert.ok(isSignInPage(html));
  assert.equal(notice(html), null, "the banner must only appear for a real failure");
});

test("a crafted err value cannot write prose or markup onto the sign-in page", { skip }, async () => {
  // ?err= is attacker-supplied through a link and this page is unauthenticated,
  // so a loose reflection would let a crafted URL put its own instructions above
  // a real password form. Only a short slug is echoed.
  const payloads = [
    "Your account is locked. Call 1-800-555-0100 to restore access.",
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "coinpay failed!!",
    "x".repeat(200),
  ];
  for (const payload of payloads) {
    const { html } = await get(`/?err=${encodeURIComponent(payload)}`);
    assert.ok(isSignInPage(html), "the page still renders");
    assert.equal(notice(html), null, `must not echo ${JSON.stringify(payload.slice(0, 24))}`);
    assert.ok(!/<script>alert\(1\)<\/script>/.test(html), "must not inject an element");
    assert.ok(!/onerror=alert/.test(html), "must not inject an event handler");
  }
});

test("the sign-in form still works alongside the banner", { skip }, async () => {
  const { html } = await get("/?err=coinpay-failed");
  assert.match(html, /<form method="post" action="\/auth\/login">/, "the login form survives");
  assert.match(html, /name="_csrf"/, "the CSRF field survives");
  assert.match(html, /name="password"/, "the password field survives");
});

test("?mode=up still selects the register form", { skip }, async () => {
  const { html } = await get("/?err=coinpay-failed&mode=up");
  assert.match(html, /<form method="post" action="\/auth\/register">/, "mode is still honoured");
  assert.equal(notice(html), "coinpay failed", "and the reason still shows");
});

test("a signed-in visitor still gets the dashboard at the root", { skip }, async () => {
  const { status, html } = await get("/?err=coinpay-failed", { signedIn: true });
  assert.equal(status, 200);
  assert.ok(!isSignInPage(html), "a session must not be shown the sign-in page");
  assert.match(html, /Needs you/, "the root still serves the dashboard");
});
