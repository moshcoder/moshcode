// Integration test for the sign-in / sign-up form keeping the typed email.
//
// Every path that re-renders the auth page with an error is a POST — wrong
// password, weak password, taken email, malformed email. The email field
// carries a `value` so the visitor does not have to type their address again
// to correct a password, so that value has to come from the submitted body.
//
// Boots the real auth router against a throwaway libsql file database; skips
// cleanly when the PWA dependencies are not installed.
import assert from "node:assert/strict";
import fs, { mkdtempSync } from "node:fs";
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
const TAKEN = "taken@example.com";
const PASSWORD = "hunter2hunter2";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { authRouter } = await import("../src/routes/auth.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(authRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function post(url, fields) {
    const res = await fetch(base + url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `mc_csrf=${CSRF}` },
      body: new URLSearchParams({ _csrf: CSRF, ...fields }),
    });
    return { status: res.status, location: res.headers.get("location"), html: await res.text() };
  }

  // one real account, so "that email already has an account" is reachable
  await post("/auth/register", { email: TAKEN, password: PASSWORD });

  return { db, server, base, post };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

// What the browser would put in the field: the value attribute, entity-decoded.
function emailField(html) {
  const m = /name="email"[^>]*\svalue="([^"]*)"/.exec(html);
  assert.ok(m, "the email input should render a value attribute");
  return m[1]
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
const errorNotice = (html) => (/notice err">([^<]*)/.exec(html) || [, ""])[1];

test("the auth form keeps the email through every error it can show", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { post } = await app();

  const cases = [
    ["wrong password", "/auth/login", TAKEN, PASSWORD + "-nope", "Wrong email or password."],
    ["password too short", "/auth/register", "newbie@example.com", "short", "Password must be at least 8 characters."],
    ["email already registered", "/auth/register", TAKEN, PASSWORD, "That email already has an account — sign in."],
    ["malformed email", "/auth/register", "not-an-email", PASSWORD, "Enter a valid email."],
  ];

  for (const [name, url, email, password, expectedError] of cases) {
    const res = await post(url, { email, password });
    assert.equal(res.status, 200, `${name}: re-renders the form`);
    assert.equal(errorNotice(res.html), expectedError, `${name}: shows its error`);
    assert.equal(emailField(res.html), email, `${name}: keeps the typed email`);
  }
});

test("a submitted email cannot break out of the value attribute", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { post } = await app();

  const hostile = `a"><script>alert(1)</script><input x="`;
  const res = await post("/auth/register", { email: hostile, password: PASSWORD });

  assert.equal(errorNotice(res.html), "Enter a valid email.");
  assert.equal(emailField(res.html), hostile, "the field still round-trips what was typed");
  assert.ok(!res.html.includes("<script>alert(1)</script>"), "no markup escapes the attribute");
});

test("the query-string prefill and a good sign-in still work", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { base, post } = await app();

  // a /?email=… link is the other way this field gets filled — keep it working
  const prefilled = await fetch(`${base}/?email=${encodeURIComponent("link@example.com")}`).then((r) => r.text());
  assert.equal(emailField(prefilled), "link@example.com");

  const empty = await fetch(base).then((r) => r.text());
  assert.equal(emailField(empty), "", "no email anywhere means an empty field, not \"undefined\"");

  const ok = await post("/auth/login", { email: TAKEN, password: PASSWORD });
  assert.equal(ok.status, 302, "correct credentials still sign in");
  assert.equal(ok.location, "/");
});
