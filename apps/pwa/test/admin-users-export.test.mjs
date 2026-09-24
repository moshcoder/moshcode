// GET /api/admin/users/export: operators only, and never a secret column.
//
// Boots the real router against a throwaway libsql file, the same way
// settings-sync.test.mjs does, and skips cleanly when the PWA dependencies are
// not installed (the root `node --test` in CI never installs them).
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
  deps = null;
}
const skip = deps ? false : "PWA dependencies are not installed";

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-admin-export-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

let booted = null;
async function boot() {
  if (booted) return booted;
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { adminRouter } = await import("../src/routes/admin.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(adminRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // The operator, signed up with a password.
  await run(`INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES ('op','Boss@Example.com','scrypt$SECRETHASH','boss',1700000000000)`);
  // A regular user.
  await run(`INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES ('u1','fan@example.org','scrypt$OTHERHASH','=cmd|calc,"x"',1700000001000)`);
  // A passkey account that later added an email.
  await run(`INSERT INTO users (id, email, display_name, created_at) VALUES ('pk','key@example.net','keys',1700000002000)`);
  await run(`INSERT INTO webauthn_credentials (id, user_id, public_key, created_at) VALUES ('cred1','pk','pub',1)`);
  // CoinPay accounts: one with an email, one without.
  await run(`INSERT INTO users (id, email, coinpay_sub, display_name, created_at) VALUES ('cp','coin@example.com','coinpay-SUB-SECRET','coin',1700000003000)`);
  await run(`INSERT INTO users (id, coinpay_sub, display_name, created_at) VALUES ('cp2','coinpay-SUB-2','anon',1700000004000)`);
  // A passkey account with no email at all.
  await run(`INSERT INTO users (id, display_name, created_at) VALUES ('pk2','ghost',1700000005000)`);
  await run(`INSERT INTO webauthn_credentials (id, user_id, public_key, created_at) VALUES ('cred2','pk2','pub',1)`);

  const opKey = (await createApiKey("op", "cli")).plaintext;
  const userKey = (await createApiKey("u1", "cli")).plaintext;
  const call = (key, route) => fetch(`${base}${route}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  booted = { server, call, opKey, userKey };
  return booted;
}

test.after(() => booted?.server.close());

test("no key is a 401, a non-operator is a 403, and an unset allowlist refuses everyone", { skip }, async () => {
  const { call, opKey, userKey } = await boot();
  process.env.ADMIN_EMAILS = "boss@example.com";
  assert.equal((await call(null, "/api/admin/users/export")).status, 401);
  assert.equal((await call("mck_not_a_key", "/api/admin/users/export")).status, 401);
  const denied = await call(userKey, "/api/admin/users/export?format=json");
  assert.equal(denied.status, 403);
  const body = await denied.text();
  assert.ok(!body.includes("@"), "a refusal must not leak an address");

  delete process.env.ADMIN_EMAILS;
  assert.equal((await call(opKey, "/api/admin/users/export")).status, 403, "unset ADMIN_EMAILS means nobody is an operator");
  process.env.ADMIN_EMAILS = "someone-else@example.com";
  assert.equal((await call(opKey, "/api/admin/users/export")).status, 403);
});

test("the CSV has the documented columns, only emailed rows, and no secrets", { skip }, async () => {
  const { call, opKey } = await boot();
  process.env.ADMIN_EMAILS = " other@x.io , BOSS@example.com ";
  const res = await call(opKey, "/api/admin/users/export?format=csv");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-users-total"), "6");
  assert.equal(res.headers.get("x-users-without-email"), "2");
  const text = await res.text();
  const lines = text.trimEnd().split("\n");
  assert.equal(lines[0], "email,display_name,created_at,id,signup_method");
  assert.equal(lines.length, 5, "four accounts have an email");
  assert.equal(lines[1], "Boss@Example.com,boss,2023-11-14T22:13:20.000Z,op,password");
  // A formula-looking name is neutralised and quoted, not executed.
  assert.equal(lines[2], `fan@example.org,"'=cmd|calc,""x""",2023-11-14T22:13:21.000Z,u1,password`);
  assert.equal(lines[3], "key@example.net,keys,2023-11-14T22:13:22.000Z,pk,passkey");
  assert.equal(lines[4], "coin@example.com,coin,2023-11-14T22:13:23.000Z,cp,coinpay");
  for (const secret of ["SECRETHASH", "OTHERHASH", "coinpay-SUB", "password_hash", "coinpay_sub"]) {
    assert.ok(!text.includes(secret), `the export leaked ${secret}`);
  }
});

test("JSON carries the same rows plus counts of users without an email", { skip }, async () => {
  const { call, opKey } = await boot();
  process.env.ADMIN_EMAILS = "boss@example.com";
  const res = await call(opKey, "/api/admin/users/export?format=json");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.columns, ["email", "display_name", "created_at", "id", "signup_method"]);
  assert.equal(body.users.length, 4);
  for (const u of body.users) assert.deepEqual(Object.keys(u), body.columns);
  assert.deepEqual(body.counts, {
    total: 6, with_email: 4, without_email: 2,
    without_email_by_method: { total: 2, password: 0, passkey: 1, coinpay: 1, unknown: 0 },
  });
  assert.ok(!JSON.stringify(body).includes("SECRET"));
  assert.equal((await call(opKey, "/api/admin/users/export?format=xml")).status, 400);
});
