import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
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
async function whoamiAgainst({ status, body }) {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const lines = [];
  globalThis.fetch = async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  console.log = (...args) => lines.push(args.join(" "));
  try { await whoami(); } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  return lines.join("\n");
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

test("saving credentials tightens a world-readable existing file", posixMode, () => {
  chmodSync(join(home, ".moshcode", "credentials.json"), 0o644);

  saveCreds({ api: "https://app.example.test", token: "tok_fresh", email: "me@example.test" });

  assert.equal(statSync(join(home, ".moshcode", "credentials.json")).mode & 0o777, 0o600);
});
