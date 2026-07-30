// Integration tests for POST /auth/passkey/register/verify when one registration
// response is submitted more than once.
//
// mc_c_reg is only cleared on the way out of a successful verify, so two requests
// that are already in flight — a double click, or a client retry after a slow
// first attempt — both pass the ceremony check, and both create a user before
// either writes its credential. The credential id is the primary key, so the
// second insert loses; unhandled, that left an account with no passkey behind,
// paid the signup bonus twice, and rejected inside the request.
//
// Same shape as sessions-output-seq.test.mjs: boot the real router against a
// throwaway libsql file database, build a real "none"-attestation response so the
// app's own verifyRegistrationResponse runs (no stubs), and skip cleanly when the
// PWA dependencies aren't installed so the root `npm test` stays green.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = {
    express: require("express"),
    cookieParser: require("cookie-parser"),
    helpers: require("@simplewebauthn/server/helpers"),
  };
} catch {
  deps = null; // pwa dependencies not installed — tests below skip
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-passkey-dup-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
process.env.PUBLIC_ORIGIN = "http://localhost:3000";

// Express 4 does not catch async rejections, so an unhandled one kills the
// process in production. Record them instead of dying, and assert on the record:
// that is the property under test, not just a crashed test file.
const rejections = [];
process.on("unhandledRejection", (e) => rejections.push(String(e?.code || e?.message || e)));

const b64u = (buf) => Buffer.from(buf).toString("base64url");

// ---- a genuine registration response the real verifier accepts ----
function makeCredential() {
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  // COSE_Key for ES256: kty EC2, alg ES256, crv P-256, then the public point.
  const cose = new Map([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x, "base64url")],
    [-3, Buffer.from(jwk.y, "base64url")],
  ]);
  return { credId: crypto.randomBytes(32), cosePublicKey: deps.helpers.isoCBOR.encode(cose) };
}

function makeResponse({ challenge, origin, rpID, credId, cosePublicKey, corrupt = false }) {
  const flags = Buffer.from([0x45]); // user present | user verified | attested credential data
  const credIdLen = Buffer.alloc(2);
  credIdLen.writeUInt16BE(credId.length);
  const authData = Buffer.concat([
    crypto.createHash("sha256").update(rpID).digest(),
    flags,
    Buffer.alloc(4), // sign count
    Buffer.alloc(16), // aaguid
    credIdLen,
    credId,
    Buffer.from(cosePublicKey),
  ]);
  const attestationObject = deps.helpers.isoCBOR.encode(new Map([
    ["fmt", "none"],
    ["attStmt", new Map()],
    ["authData", new Uint8Array(authData)],
  ]));
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.create", challenge, origin, crossOrigin: false,
  }));
  return {
    id: b64u(credId),
    rawId: b64u(credId),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64u(clientDataJSON),
      attestationObject: corrupt ? b64u(crypto.randomBytes(64)) : b64u(Buffer.from(attestationObject)),
      transports: ["internal"],
    },
  };
}

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { all } = await import("../src/db.mjs");
  const { config } = await import("../src/config.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { passkeyRouter } = await import("../src/routes/passkey.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(passkeyRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address();

  // Raw http with a fresh connection per request: a keep-alive agent would reuse
  // one socket and serialise the two submits this exercises, and would also apply
  // the winner's Set-Cookie to the request that is already on the wire.
  const call = (path_, body, cookies, extra = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { "content-type": "application/json", ...extra };
    if (cookies) headers.cookie = cookies;
    if (payload) headers["content-length"] = Buffer.byteLength(payload);
    const req = http.request(
      { host: "127.0.0.1", port, path: path_, agent: false, method: payload ? "POST" : "GET", headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, raw, setCookie: res.headers["set-cookie"] || [] }));
      }
    );
    req.on("error", reject);
    // Unpatched, the losing request never answers. Bound the wait so that shows
    // up as a failed assertion rather than a hung test run.
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("no response")); });
    if (payload) req.write(payload);
    req.end();
  });

  const jar = (setCookie) => setCookie.map((c) => c.split(";")[0]).join("; ");
  const readCookie = (setCookie, name) => {
    const hit = setCookie.find((c) => c.startsWith(`${name}=`));
    return hit ? hit.split(";")[0].slice(name.length + 1) : null;
  };

  // A page load first, so the client holds mc_csrf the way a browser would.
  const seed = await call("/");
  const seedCookies = jar(seed.setCookie);
  const csrf = readCookie(seed.setCookie, "mc_csrf");
  const csrfHeader = { "x-csrf-token": csrf };

  // Start a real ceremony: a real challenge in a real signed mc_c_reg cookie.
  async function startCeremony() {
    const opts = await call("/auth/passkey/register/options", {}, seedCookies, csrfHeader);
    assert.equal(opts.status, 200);
    const options = JSON.parse(opts.raw);
    return {
      options,
      cookies: [seedCookies, jar(opts.setCookie)].filter(Boolean).join("; "),
    };
  }

  // One browser-shaped registration response for a fresh credential.
  async function newRegistration({ corrupt = false } = {}) {
    const { options, cookies } = await startCeremony();
    const body = makeResponse({
      challenge: options.challenge,
      origin: config.origin,
      rpID: config.rpID,
      corrupt,
      ...makeCredential(),
    });
    return { body, cookies };
  }

  const submit = (body, cookies) =>
    call("/auth/passkey/register/verify", body, cookies, csrfHeader);

  // Assertions are scoped to the rows a single test adds, so tests stay
  // independent of each other's leftovers.
  async function snapshot() {
    const users = (await all(`SELECT id FROM users`)).map((r) => r.id);
    const creds = await all(`SELECT id, user_id FROM webauthn_credentials`);
    const ledger = await all(`SELECT user_id, delta, reason FROM credit_ledger`);
    return { users, creds, ledger };
  }
  async function since(before) {
    const now = await snapshot();
    const newUsers = now.users.filter((u) => !before.users.includes(u));
    const newCreds = now.creds.filter((c) => !before.creds.some((b) => b.id === c.id));
    const newLedger = now.ledger.filter((l) => newUsers.includes(l.user_id));
    return {
      users: newUsers,
      creds: newCreds,
      credits: newLedger.reduce((s, r) => s + Number(r.delta), 0),
      bonuses: newLedger.filter((r) => r.reason === "signup.bonus").length,
      orphans: newUsers.filter((u) => !now.creds.some((c) => c.user_id === u)),
    };
  }

  return { server, submit, newRegistration, snapshot, since, seedCookies, csrfHeader, call };
}

const ctx = deps ? await boot() : null;
const t = (name, fn) => test(name, { skip: deps ? false : "pwa dependencies not installed" }, fn);

// ---- the bug: one response, submitted twice while both are in flight ----

t("a double-submitted registration creates exactly one account", async () => {
  const before = await ctx.snapshot();
  const { body, cookies } = await ctx.newRegistration();
  const [a, b] = await Promise.all([ctx.submit(body, cookies), ctx.submit(body, cookies)]);

  const added = await ctx.since(before);
  assert.equal(added.users.length, 1, "one registration must not mint two users");
  assert.equal(added.creds.length, 1, "one credential is stored");
  assert.deepEqual(added.orphans, [], "no account is left without a passkey to sign in with");
  // Exactly one of the two wins; which one is a race, so don't pin the order.
  assert.equal([a.status, b.status].filter((s) => s === 200).length, 1);
});

t("a double-submitted registration pays the signup bonus once", async () => {
  const before = await ctx.snapshot();
  const { body, cookies } = await ctx.newRegistration();
  await Promise.all([ctx.submit(body, cookies), ctx.submit(body, cookies)]);

  const added = await ctx.since(before);
  assert.equal(added.bonuses, 1, "the signup bonus is granted once per account");
  assert.equal(added.credits, 100, "SIGNUP_BONUS, not a multiple of it");
});

t("the losing submit answers instead of hanging, and nothing rejects unhandled", async () => {
  rejections.length = 0;
  const before = await ctx.snapshot();
  const { body, cookies } = await ctx.newRegistration();
  const [a, b] = await Promise.all([ctx.submit(body, cookies), ctx.submit(body, cookies)]);

  const loser = [a, b].find((r) => r.status !== 200);
  assert.ok(loser, "one submit loses the race");
  assert.equal(loser.status, 400, "the loser gets a clean client error");
  assert.match(JSON.parse(loser.raw).error, /already registered/i);
  // An unhandled rejection here is fatal to the process under express 4.
  assert.deepEqual(rejections, [], "the duplicate insert must not reject unhandled");
  await ctx.since(before);
});

// ---- controls: these pass with and without the fix ----

t("a single registration still creates the account and signs it in", async () => {
  const before = await ctx.snapshot();
  const { body, cookies } = await ctx.newRegistration();
  const res = await ctx.submit(body, cookies);

  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.raw), { ok: true, redirect: "/" });
  const added = await ctx.since(before);
  assert.equal(added.users.length, 1);
  assert.equal(added.creds.length, 1);
  assert.equal(added.creds[0].user_id, added.users[0]);
  assert.equal(added.credits, 100);
  assert.ok(res.setCookie.some((c) => c.startsWith("mc_sess=")), "a session cookie is set");
  assert.ok(res.setCookie.some((c) => /^mc_c_reg=;/.test(c)), "the ceremony cookie is cleared");
});

t("two separate registrations still create two accounts", async () => {
  const before = await ctx.snapshot();
  const one = await ctx.newRegistration();
  assert.equal((await ctx.submit(one.body, one.cookies)).status, 200);
  const two = await ctx.newRegistration();
  assert.equal((await ctx.submit(two.body, two.cookies)).status, 200);

  const added = await ctx.since(before);
  assert.equal(added.users.length, 2, "distinct credentials are distinct accounts");
  assert.equal(added.creds.length, 2);
  assert.equal(added.bonuses, 2);
});

t("a verify with no ceremony cookie is rejected and writes nothing", async () => {
  const before = await ctx.snapshot();
  const { body } = await ctx.newRegistration();
  const res = await ctx.submit(body, ctx.seedCookies); // csrf, but no mc_c_reg

  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.raw).error, /expired/i);
  const added = await ctx.since(before);
  assert.deepEqual(added.users, [], "no account is created without a ceremony");
  assert.deepEqual(added.creds, []);
});

t("an unverifiable attestation is rejected and writes nothing", async () => {
  const before = await ctx.snapshot();
  const { body, cookies } = await ctx.newRegistration({ corrupt: true });
  const res = await ctx.submit(body, cookies);

  assert.equal(res.status, 400);
  const added = await ctx.since(before);
  assert.deepEqual(added.users, [], "a response that does not verify creates no account");
  assert.deepEqual(added.creds, []);
});

test.after(() => ctx?.server.close());
