// The namespace API, driven by a machine.
//
// /api/moshpit/* reads as an API and behaved like one only for a browser: the
// same API key that `moshcode whoami` uses against /api/me got 401 from every
// endpoint here, so the namespace was the one part of the product no script
// could touch.
//
// These tests pin both halves of that: a key works, and the absence of one
// still does not.
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
  deps = null;
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pit-apikey-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u2','x@y.z','two',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('held','u1','a@b.c',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('theirs','u2','x@y.z',1)`);

  const keyOne = (await createApiKey("u1", "cli one")).plaintext;
  const keyTwo = (await createApiKey("u2", "cli two")).plaintext;

  // The real middleware stack, so the CSRF guard gets a vote on these requests
  // exactly as it does in production.
  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(moshpitRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = (token) => async (method, p, body) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML error page */ }
    return { status: res.status, json, text };
  };

  return { server, db, one: call(keyOne), two: call(keyTwo), anon: call(null) };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

test("api key: reading your own endings no longer needs a browser", skip, async () => {
  const { one, anon } = await app();

  const mine = await one("GET", "/api/moshpit/tlds?mine=1");
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.json.tlds.map((t) => t.tld), ["held"]);

  // The absence of a key is still 401 — this widened who can authenticate, not
  // whether anyone has to.
  assert.equal((await anon("GET", "/api/moshpit/tlds?mine=1")).status, 401);
});

test("api key: claiming an ending works from a script", skip, async () => {
  const { one } = await app();
  const res = await one("POST", "/api/moshpit/tlds", { tld: "claimed" });
  assert.equal(res.status, 201, res.text);   // 201: it created something

  const mine = await one("GET", "/api/moshpit/tlds?mine=1");
  assert.ok(mine.json.tlds.map((t) => t.tld).includes("claimed"));
});

test("api key: a write with no key is refused, not silently accepted", skip, async () => {
  const { anon } = await app();
  const res = await anon("POST", "/api/moshpit/tlds", { tld: "nokey" });
  assert.equal(res.status, 401);

  const { anon: check } = await app();
  const still = await check("GET", "/api/moshpit/tlds/nokey");
  assert.equal(still.json.available, true, "nothing was written");
});

test("api key: one key cannot act on another account's ending", skip, async () => {
  const { two } = await app();
  // u2 holds .theirs, not .held. Authenticating is not authorising.
  const res = await two("PUT", "/api/moshpit/tlds/held/alias", { to: "theirs" });
  assert.notEqual(res.status, 200);

  const { one } = await app();
  const mine = await one("GET", "/api/moshpit/tlds?mine=1");
  const held = mine.json.tlds.find((t) => t.tld === "held");
  assert.equal(held.alias_of, null, "somebody else's key did not repoint it");
});

test("api key: a made-up key is nobody", skip, async () => {
  const { server } = await app();
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/moshpit/tlds?mine=1`, {
    headers: { authorization: "Bearer not-a-real-key" },
  });
  assert.equal(res.status, 401);
});

test("api key: names can be minted and pointed from a script", skip, async () => {
  const { one } = await app();
  assert.equal((await one("POST", "/api/moshpit/tlds/held/names", { label: "blue" })).status, 201);

  const pointed = await one("PUT", "/api/moshpit/tlds/held/names", {
    label: "blue", target: "2606:4700:4700::1111",
  });
  assert.equal(pointed.status, 200, pointed.text);

  const resolved = await one("GET", "/api/moshpit/resolve?name=blue.held");
  assert.equal(resolved.json.target, "2606:4700:4700::1111");

  // The IPv6 rule holds for scripts too, or the API becomes the way around it.
  const v4 = await one("PUT", "/api/moshpit/tlds/held/names", { label: "blue", target: "198.51.100.7" });
  assert.equal(v4.status, 400, v4.text);
  const still = await one("GET", "/api/moshpit/resolve?name=blue.held");
  assert.equal(still.json.target, "2606:4700:4700::1111", "a refused target left the old one alone");
});

test("api key: the browser routes are still browser routes", skip, async () => {
  const { one } = await app();
  // /pit/claim is a CSRF-guarded form post. A bearer token must not stand in
  // for a session there — the guard runs before the router and should reject it.
  const res = await fetch(`http://127.0.0.1:${(await app()).server.address().port}/pit/claim`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Bearer whatever" },
    body: "tld=sneaky",
  });
  assert.equal(res.status, 403, "csrf guard still owns the form routes");

  const check = await one("GET", "/api/moshpit/tlds/sneaky");
  assert.equal(check.json.available, true, "nothing was claimed");
});
