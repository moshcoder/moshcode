// Integration test for the post-login destination cookie (mc_next).
//
// requireAuth remembers where an unauthenticated request was headed so the user
// can be returned there after signing in. That destination is always consumed by
// a redirect, which the browser follows as a GET — so only a GET is a valid
// thing to remember. Several guarded routes are POST-only (/credits/buy,
// /settings/channels, /settings/apikeys, /push/subscribe); remembering one of
// those sent the user to a 404 immediately after a successful sign-in.
//
// Boots the real routers against a throwaway libsql file database; skips
// cleanly when the PWA dependencies are not installed.
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
const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-next-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const CSRF = "test-csrf-token";
const EMAIL = "buyer@example.com";
const PASSWORD = "correct-horse";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { authRouter } = await import("../src/routes/auth.mjs");
  const { creditsRouter } = await import("../src/routes/credits.mjs");
  const { pagesRouter } = await import("../src/routes/pages.mjs");
  const { createUserWithPassword, userByEmail } = await import("../src/lib/users.mjs");
  const { hashPassword } = await import("../src/lib/crypto.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(authRouter);
  app.use(creditsRouter);
  app.use(pagesRouter);
  // mirrors the catch-all 404 in src/server.mjs
  app.use((_req, res) => res.status(404).type("html").send("no such page in the pit"));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  if (!(await userByEmail(EMAIL))) await createUserWithPassword(EMAIL, hashPassword(PASSWORD));

  return { server, base };
}

const setCookieHeader = (res) => res.headers.getSetCookie().join(" | ");
const cookieValue = (res, name) => new RegExp(`${name}=([^;]+)`).exec(setCookieHeader(res))?.[1] || null;

// The user's session has expired (or they signed out in another tab) but the
// 30-day mc_csrf cookie is still present, so csrfGuard still accepts the form.
const postBuyCredits = (base) => fetch(`${base}/credits/buy`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie: `mc_csrf=${CSRF}` },
  body: new URLSearchParams({ pack: "starter", _csrf: CSRF }),
});

// Sign in and return where the app sends the user next.
async function signIn(base, cookie) {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD, _csrf: CSRF }),
  });
  return { destination: res.headers.get("location"), session: cookieValue(res, "mc_sess") };
}

test("a guarded POST is not remembered as the post-login destination", { skip: !deps }, async () => {
  const { server, base } = await boot();
  try {
    const res = await postBuyCredits(base);

    assert.equal(res.status, 302, "an unauthenticated guarded POST redirects to the sign-in page");
    assert.equal(res.headers.get("location"), "/");
    assert.equal(cookieValue(res, "mc_next"), null,
      "/credits/buy is POST-only, so it must not be stored as a place to redirect to");
  } finally {
    server.close();
  }
});

test("signing in after a guarded POST lands on the app, not a 404", { skip: !deps }, async () => {
  const { server, base } = await boot();
  try {
    const blocked = await postBuyCredits(base);
    const next = cookieValue(blocked, "mc_next");

    const cookie = `mc_csrf=${CSRF}` + (next ? `; mc_next=${next}` : "");
    const { destination, session } = await signIn(base, cookie);

    // The browser follows a redirect as a GET.
    const landed = await fetch(`${base}${destination}`, {
      redirect: "manual",
      headers: { cookie: `mc_csrf=${CSRF}; mc_sess=${session}` },
    });

    assert.notEqual(landed.status, 404,
      `signing in sent the user to ${destination}, which answered 404`);
    assert.equal(landed.status, 200);
  } finally {
    server.close();
  }
});

test("a guarded GET is still remembered and returned to after sign-in", { skip: !deps }, async () => {
  const { server, base } = await boot();
  try {
    const blocked = await fetch(`${base}/settings`, {
      redirect: "manual",
      headers: { cookie: `mc_csrf=${CSRF}` },
    });
    assert.equal(blocked.status, 302);
    const next = cookieValue(blocked, "mc_next");
    assert.ok(next, "a guarded GET must still be remembered");

    const { destination, session } = await signIn(base, `mc_csrf=${CSRF}; mc_next=${next}`);
    assert.equal(destination, "/settings", "the user is returned to the page they asked for");

    const landed = await fetch(`${base}${destination}`, {
      redirect: "manual",
      headers: { cookie: `mc_csrf=${CSRF}; mc_sess=${session}` },
    });
    assert.equal(landed.status, 200);
  } finally {
    server.close();
  }
});
