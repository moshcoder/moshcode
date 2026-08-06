import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// `whoami` reads the credentials path from the home directory at import time, so
// the fake home has to be in place before the module is loaded.
const home = mkdtempSync(join(tmpdir(), "moshcode-auth-"));
mkdirSync(join(home, ".moshcode"));
writeFileSync(
  join(home, ".moshcode", "credentials.json"),
  JSON.stringify({ api: "https://app.example.test", token: "tok_revoked", email: "me@example.test" }),
);
process.env.HOME = home;
process.env.USERPROFILE = home;

const { saveCreds, whoami } = await import("../src/auth.mjs");
const posixMode = process.platform === "win32" ? { skip: "POSIX permission bits" } : {};

/** Run whoami against a canned app response and collect what it printed. */
async function whoamiWithFetch(fetchImpl, options) {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const lines = [];
  globalThis.fetch = fetchImpl;
  console.log = (...args) => lines.push(args.join(" "));
  try { await whoami(options); } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  return lines.join("\n");
}

/** Run whoami against a canned app response and collect what it printed. */
function whoamiAgainst({ status, body }, options) {
  return whoamiWithFetch(
    async () => ({ status, ok: status >= 200 && status < 300, json: async () => body }),
    options,
  );
}

test("whoami does not report an account when the app refuses the token", async () => {
  const out = await whoamiAgainst({ status: 403, body: { error: "token revoked" } });
  assert.doesNotMatch(out, /credits/);
  assert.doesNotMatch(out, /moshcoder/);
  assert.match(out, /403/);
});

test("whoami does not report an account when the app errors", async () => {
  const out = await whoamiAgainst({ status: 500, body: { error: "internal" } });
  assert.doesNotMatch(out, /credits/);
  assert.match(out, /couldn't verify/);
  assert.match(out, /500/);
});

test("whoami still prints the account the app confirms", async () => {
  const out = await whoamiAgainst({ status: 200, body: { email: "me@example.test", credits: 42 } });
  assert.match(out, /me@example\.test/);
  assert.match(out, /42 credits/);
});

test("whoami still calls out an expired session on 401", async () => {
  const out = await whoamiAgainst({ status: 401, body: { error: "unauthorized" } });
  assert.match(out, /session expired/);
});

test("whoami JSON exposes verified account status without credentials", async () => {
  const out = await whoamiAgainst(
    { status: 200, body: { id: "user_1", email: "me@example.test", name: "Me", credits: 42 } },
    { json: true },
  );
  const result = JSON.parse(out);

  assert.deepEqual(result, {
    status: "authenticated",
    verified: true,
    api: "https://app.example.test",
    user: { id: "user_1", email: "me@example.test", name: "Me", credits: 42 },
  });
  assert.doesNotMatch(out, /tok_revoked/);
});

test("whoami JSON stays machine-readable when verification fails", async () => {
  const out = await whoamiAgainst(
    { status: 403, body: { error: "token revoked" } },
    { json: true },
  );
  const result = JSON.parse(out);

  assert.equal(result.status, "unverified");
  assert.equal(result.verified, false);
  assert.equal(result.error.status, 403);
  assert.equal(result.user.email, "me@example.test");
  assert.doesNotMatch(out, /tok_revoked/);
});

test("whoami JSON reports when no credentials are available", async () => {
  const credentials = join(home, ".moshcode", "credentials.json");
  const original = readFileSync(credentials);
  writeFileSync(credentials, JSON.stringify({ api: "https://app.example.test", token: "" }));

  let out;
  try {
    out = await whoamiWithFetch(
      async () => { throw new Error("fetch should not be called without a token"); },
      { json: true },
    );
  } finally {
    writeFileSync(credentials, original);
  }

  const result = JSON.parse(out);
  assert.equal(result.status, "not_logged_in");
  assert.equal(result.verified, false);
  assert.equal(result.user, null);
});

test("whoami JSON reports an expired session", async () => {
  const out = await whoamiAgainst(
    { status: 401, body: { error: "unauthorized" } },
    { json: true },
  );
  const result = JSON.parse(out);

  assert.equal(result.status, "expired");
  assert.equal(result.verified, false);
  assert.deepEqual(result.error, { type: "auth", status: 401 });
  assert.doesNotMatch(out, /tok_revoked/);
});

test("whoami JSON stays machine-readable when the app is unreachable", async () => {
  const out = await whoamiWithFetch(
    async () => { throw new Error("network failed with tok_revoked"); },
    { json: true },
  );
  const result = JSON.parse(out);

  assert.equal(result.status, "unreachable");
  assert.equal(result.verified, false);
  assert.deepEqual(result.error, { type: "network" });
  assert.doesNotMatch(out, /tok_revoked/);
});

test("saving credentials tightens a world-readable existing file", posixMode, () => {
  chmodSync(join(home, ".moshcode", "credentials.json"), 0o644);

  saveCreds({ api: "https://app.example.test", token: "tok_fresh", email: "me@example.test" });

  assert.equal(statSync(join(home, ".moshcode", "credentials.json")).mode & 0o777, 0o600);
});
