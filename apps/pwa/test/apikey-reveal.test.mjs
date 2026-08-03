// Integration test for how a freshly created API key gets back to the user.
//
// Only sha256(key) is stored, so the plaintext exists for exactly one response
// and can never be recovered afterwards. That makes the handoff the whole
// feature: if the user cannot copy it there and then, the key is landfill and
// they have to create another one.
//
// It used to travel as `/settings?key=mck_…`, which put a live credential in
// browser history, in the Referer of anything that page loads, and in every
// access log in front of the app — and it still only survived a single render,
// so an accidental reload destroyed the one copy on offer.
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
const CSRF = "test-csrf-token";
const COOKIE = `mc_sess=${SESSION}; mc_csrf=${CSRF}`;

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { pagesRouter } = await import("../src/routes/pages.mjs");
  const { userForApiKey } = await import("../src/lib/apikey.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(pagesRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  await run(`INSERT INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','demo',1)`);
  await run(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)`,
    [SESSION, "u1", Date.now(), Date.now() + 60_000]);

  return { server, db, userForApiKey, base: `http://127.0.0.1:${server.address().port}` };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

// Everything the reveal box hands the user, pulled back out of the markup.
const revealed = (html) => {
  const m = /<b class="mono" id="newkey"[^>]*>([^<]*)<\/b>/.exec(html);
  return m ? m[1] : null;
};

const post = (base, url, cookie, body = "") =>
  fetch(`${base}${url}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `_csrf=${encodeURIComponent(CSRF)}${body ? "&" + body : ""}`,
  });

const getSettings = (base, cookie) => fetch(`${base}/settings`, { headers: { cookie } });

// Create a key and follow the redirect by hand, carrying cookies the way a
// browser would, so the test exercises the actual handoff rather than the
// internals of it.
async function createKey(name = "laptop") {
  const { base } = await app();
  const res = await post(base, "/settings/apikeys", COOKIE, `name=${encodeURIComponent(name)}`);
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const carried = setCookie.map((c) => c.split(";")[0]).join("; ");
  const cookie = carried ? `${COOKIE}; ${carried}` : COOKIE;
  return { res, cookie, base, location: res.headers.get("location") };
}

test("the new key never travels in the URL", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { res, location } = await createKey();
  assert.equal(res.status, 302);
  assert.equal(location, "/settings", "the redirect must not carry the key as a query parameter");
  assert.ok(!/mck_/.test(location ?? ""), "no credential in a URL — it lands in history and logs");
});

test("the key is shown once, in full, and works", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { userForApiKey } = await app();
  const { cookie, base } = await createKey();
  const key = revealed(await (await getSettings(base, cookie)).text());

  assert.ok(key, "the settings page must display the new key");
  assert.match(key, /^mck_[A-Za-z0-9_-]+$/, "the whole key, not a truncated prefix");

  const user = await userForApiKey(key);
  assert.equal(user?.id, "u1", "the displayed key must actually authenticate");
});

test("a reload does not destroy the only copy", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { cookie, base } = await createKey();
  const first = revealed(await (await getSettings(base, cookie)).text());
  const second = revealed(await (await getSettings(base, cookie)).text());
  assert.ok(first, "the key must be shown");
  assert.equal(second, first, "a reload must not lose the key before it has been copied");
});

test("hiding it takes it off the page for good", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { cookie, base } = await createKey();
  assert.ok(revealed(await (await getSettings(base, cookie)).text()), "shown before hiding");

  const res = await post(base, "/settings/apikeys/hide", cookie);
  assert.equal(res.status, 302);
  const cleared = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const after = revealed(await (await getSettings(base, `${COOKIE}; ${cleared}`)).text());
  assert.equal(after, null, "the key must be gone once dismissed");
});

test("existing keys are listed by prefix only", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { cookie, base } = await createKey("ci");
  const key = revealed(await (await getSettings(base, cookie)).text());
  // Without this the assertion below passes on a null key, which is exactly the
  // broken case it is supposed to catch.
  assert.ok(key, "the key must have been revealed for this test to mean anything");

  // Dismiss the reveal, then look at the page a user sees on a later visit.
  const res = await post(base, "/settings/apikeys/hide", cookie);
  const cleared = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const html = await (await getSettings(base, `${COOKIE}; ${cleared}`)).text();

  assert.ok(/ci/.test(html), "the key is still listed by name");
  assert.ok(!html.includes(key), "but its secret must never reappear on a later visit");
});
