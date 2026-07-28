// Integration test for the hidden _csrf field that csrfInput() renders.
//
// The field's value comes straight off the mc_csrf cookie, and the app never
// validates that cookie's contents. Interpolated raw, a quote in it closes the
// value attribute early: the browser then submits a truncated token, csrfGuard
// rejects the POST, and every form in the app 403s until the cookie is cleared
// by hand. appBar() already escapes this same token — csrfInput() must match.
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

const SESSION = "test-session-token";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { authRouter } = await import("../src/routes/auth.mjs");
  const { pagesRouter } = await import("../src/routes/pages.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
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

// A browser decodes entities in the attribute before submitting the field, so
// the test must too — comparing the raw attribute text would measure the markup
// rather than what actually reaches the server.
const decodeAttr = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const formFields = (html, action) => {
  const form = new RegExp(`<form method="post" action="${action}"[^>]*>([\\s\\S]*?)</form>`).exec(html);
  assert.ok(form, `page renders a form posting to ${action}`);
  const value = /name="_csrf" value="([^"]*)"/.exec(form[1]);
  return { raw: value ? value[1] : null, submitted: value ? decodeAttr(value[1]) : null };
};

// Render /settings with the given mc_csrf cookie, then submit the "Save
// channels" form exactly as a browser would from that markup.
async function roundTrip(rawToken) {
  const { base } = await app();
  const cookie = `mc_sess=${SESSION}; mc_csrf=${encodeURIComponent(rawToken)}`;
  const html = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
  const field = formFields(html, "/settings/channels");
  const res = await fetch(`${base}/settings/channels`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `_csrf=${encodeURIComponent(field.submitted ?? "")}&on_email=1`,
  });
  return { html, field, status: res.status };
}

test("an ordinary token round-trips unchanged", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const token = "abc123def456";
  const { field, status } = await roundTrip(token);
  assert.equal(field.raw, token, "an ordinary token needs no escaping");
  assert.equal(field.submitted, token);
  assert.equal(status, 302, "the form must be accepted");
});

test("a quote in the token does not truncate the field", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const token = 'a"b';
  const { field, status } = await roundTrip(token);
  assert.equal(field.raw, "a&quot;b", "the quote must be escaped, not left to close the attribute");
  assert.equal(field.submitted, token, "the browser must submit the whole token");
  assert.equal(status, 302, "the form must still be accepted");
});

test("a token full of markup neither breaks nor injects into the page", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const token = '"><script>alert(1)</script><b x="';
  const { html, field, status } = await roundTrip(token);
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html), "the token must not inject an element");
  assert.equal(field.submitted, token, "the browser must submit the whole token");
  assert.equal(status, 302, "the form must still be accepted");
});

test("csrfInput escapes the token the same way appBar does", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { html } = await roundTrip('a"b');
  // Both hidden fields carry the same token; they must render identically.
  assert.equal(formFields(html, "/settings/channels").raw, formFields(html, "/auth/logout").raw);
});

test("csrfGuard still rejects a mismatched token", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { base } = await app();
  const res = await fetch(`${base}/settings/channels`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: `mc_sess=${SESSION}; mc_csrf=${encodeURIComponent('a"b')}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "_csrf=a&on_email=1", // the truncated token the unescaped field used to send
  });
  assert.equal(res.status, 403, "escaping must not loosen the guard");
});
