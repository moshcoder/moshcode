// Everything behind this gateway is a shell, so the auth tests are the point:
// an unsigned cookie, an expired one, or a websocket upgrade without a cookie
// must never reach ttyd.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  consoleUrl, createConsoleServer, mintCookie, parseCookies, parseTarget, readCookie, verifyToken,
} from "../src/console.mjs";

const SECRET = "test-secret";

test("parseTarget accepts host:port, bare host, and a URL", () => {
  assert.deepEqual(parseTarget("127.0.0.1:7681"), { host: "127.0.0.1", port: 7681 });
  assert.deepEqual(parseTarget("localhost"), { host: "localhost", port: 7681 });
  assert.deepEqual(parseTarget("http://10.0.0.5:9999/"), { host: "10.0.0.5", port: 9999 });
  assert.deepEqual(parseTarget(), { host: "127.0.0.1", port: 7681 });
});

test("parseCookies reads the raw header the upgrade handler sees", () => {
  assert.deepEqual(parseCookies("a=1; b=two%20words"), { a: "1", b: "two words" });
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies("nonsense"), {});
});

test("a minted cookie round-trips and carries the user", () => {
  const c = mintCookie(SECRET, { user: "anthony@profullstack.com" });
  assert.equal(readCookie(SECRET, c), "anthony@profullstack.com");
});

test("a cookie signed with another secret is rejected", () => {
  const forged = mintCookie("attacker", { user: "root" });
  assert.equal(readCookie(SECRET, forged), null);
});

test("tampering with the payload invalidates the signature", () => {
  const c = mintCookie(SECRET, { user: "guest" });
  const [, expiry, mac] = c.split(".");
  const root = Buffer.from("root").toString("base64url");
  // Same signature, escalated user — must not verify.
  assert.equal(readCookie(SECRET, `${root}.${expiry}.${mac}`), null);
  // Same user, extended expiry — must not verify either.
  const guest = Buffer.from("guest").toString("base64url");
  assert.equal(readCookie(SECRET, `${guest}.${Number(expiry) + 999999}.${mac}`), null);
});

test("an expired cookie is rejected", () => {
  const c = mintCookie(SECRET, { user: "x", now: Date.now() - 10_000, ttlMs: 1000 });
  assert.equal(readCookie(SECRET, c), null);
});

test("malformed cookies are rejected rather than throwing", () => {
  for (const bad of ["", "a.b", "a.b.c.d", "....", undefined, null]) {
    assert.equal(readCookie(SECRET, bad), null);
  }
});

test("verifyToken trusts the app's answer and fails closed", async () => {
  const ok = async () => ({ ok: true, json: async () => ({ user: { email: "a@b.c" } }) });
  assert.equal(await verifyToken("https://app.moshcode.sh", "tok", ok), "a@b.c");

  const rejected = async () => ({ ok: false, status: 401 });
  assert.equal(await verifyToken("https://app.moshcode.sh", "tok", rejected), null);

  // A network failure must deny, never default to allow.
  const down = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await verifyToken("https://app.moshcode.sh", "tok", down), null);

  assert.equal(await verifyToken("https://app.moshcode.sh", "", ok), null);
});

test("consoleUrl carries the token to the gateway", () => {
  assert.equal(consoleUrl("https://dev.example.com/", "tok"), "https://dev.example.com/?token=tok");
  assert.equal(consoleUrl("https://dev.example.com/"), "https://dev.example.com/");
});

/** Boot the gateway on an ephemeral port with a stubbed verifier. */
async function withServer(verify, fn) {
  const server = createConsoleServer({ secret: SECRET, verify, ttyd: "127.0.0.1:1" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try { return await fn(port); }
  finally { await new Promise((r) => server.close(r)); }
}

const request = (port, path, headers = {}) =>
  new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on("error", () => resolve({ status: 0, headers: {} }));
    req.end();
  });

test("no token and no cookie is refused", async () => {
  await withServer(async () => null, async (port) => {
    const res = await request(port, "/");
    assert.equal(res.status, 401);
  });
});

test("a bad token is refused, and the verifier is what decides", async () => {
  await withServer(async (_api, token) => (token === "good" ? "a@b.c" : null), async (port) => {
    assert.equal((await request(port, "/?token=bad")).status, 401);
  });
});

test("a good token is exchanged for a cookie and redirected clean", async () => {
  await withServer(async () => "a@b.c", async (port) => {
    const res = await request(port, "/?token=good");
    assert.equal(res.status, 302);
    const cookie = String(res.headers["set-cookie"]?.[0] || "");
    assert.match(cookie, /^moshcode_console=/);
    assert.match(cookie, /HttpOnly/, "the console cookie must not be readable from JS");
    // The token must not survive in the redirect target — it should stop
    // travelling with every subsequent request and stay out of history.
    assert.ok(!String(res.headers.location).includes("token"), res.headers.location);
  });
});

test("a websocket upgrade without a valid cookie is refused before reaching ttyd", async () => {
  await withServer(async () => "a@b.c", async (port) => {
    const raw = await new Promise((resolve) => {
      const req = http.request({
        host: "127.0.0.1", port, path: "/ws",
        headers: { connection: "Upgrade", upgrade: "websocket" },
      });
      // A refused upgrade comes back as a plain response, not an 'upgrade' event.
      req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
      req.on("upgrade", () => resolve("upgraded"));
      req.on("error", () => resolve(0));
      req.end();
    });
    assert.equal(raw, 401, "the terminal socket itself must be authenticated");
  });
});
