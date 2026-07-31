// The console gateway is the only thing standing between the internet and a
// shell, so the interesting question is not just "does it reject a bad cookie"
// but "can an unauthenticated client stop it answering at all".
//
// parseCookies runs before any auth check, and it runs in two places whose
// throw is fatal: an async request handler (unhandled rejection) and an
// `upgrade` listener (uncaught exception). A cookie value is attacker-chosen
// text, so a stray "%" must not reach decodeURIComponent unguarded.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createConsoleServer, mintCookie, parseCookies } from "../src/console.mjs";

const SECRET = "test-secret";
const COOKIE = "moshcode_console";

// Record process-level failures instead of dying on them. Registering an
// uncaughtException listener also suppresses the default crash, so an
// unpatched run fails these tests individually rather than killing the file
// and taking the other results with it.
const fatal = [];
process.on("unhandledRejection", (e) => fatal.push(e));
process.on("uncaughtException", (e) => fatal.push(e));

/** A gateway with no real ttyd behind it and every token refused. */
async function gateway() {
  const server = createConsoleServer({ secret: SECRET, verify: async () => null });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { server, port, close: () => new Promise((r) => server.close(r)) };
}

/** Resolves to a status number, or to an error code when the socket dies. */
function get(port, cookie, path = "/") {
  return new Promise((resolve) => {
    const req = http.request(
      { port, host: "127.0.0.1", path, headers: cookie ? { cookie } : {} },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on("error", (e) => resolve(`socket:${e.code}`));
    req.end();
  });
}

/** The websocket handshake, which is the path that actually carries the shell. */
function upgrade(port, cookie) {
  return new Promise((resolve) => {
    const req = http.request({
      port,
      host: "127.0.0.1",
      path: "/ws",
      headers: {
        ...(cookie ? { cookie } : {}),
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
        "sec-websocket-version": "13",
      },
    });
    req.on("upgrade", (_res, socket) => { socket.destroy(); resolve("upgraded"); });
    req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", (e) => resolve(`socket:${e.code}`));
    req.end();
  });
}

// ---------------------------------------------------------------- the bug ---

test("a stray percent in a cookie value does not throw", () => {
  // "%" is not a valid escape. Before the fix this raised URIError.
  assert.deepEqual(parseCookies("sid=%"), { sid: "%" });
  assert.deepEqual(parseCookies("a=100%; b=ok"), { a: "100%", b: "ok" });
  // A truncated multi-byte escape is malformed too.
  assert.deepEqual(parseCookies("t=%E0%A4%A"), { t: "%E0%A4%A" });
});

test("an unauthenticated request with a malformed cookie is answered, not dropped", async () => {
  const g = await gateway();
  fatal.length = 0;
  try {
    // No token, no session, one stray percent sign. That is the whole attack.
    assert.equal(await get(g.port, "sid=%"), 401);
    assert.deepEqual(fatal, [], "handling a malformed cookie must not raise a process-level error");
  } finally { await g.close(); }
});

test("the gateway keeps serving after a malformed cookie", async () => {
  const g = await gateway();
  try {
    await get(g.port, "sid=%");
    // The point of the bug: unpatched, the process is gone by now, so a
    // perfectly ordinary request from anyone else never gets an answer.
    assert.equal(await get(g.port, "sid=normal"), 401);
    assert.equal(await get(g.port, null), 401);
  } finally { await g.close(); }
});

test("a websocket upgrade with a malformed cookie is refused, not fatal", async () => {
  const g = await gateway();
  fatal.length = 0;
  try {
    const status = await upgrade(g.port, "sid=%");
    assert.equal(status, 401, "an upgrade without a valid session must be refused");
    assert.deepEqual(fatal, [], "the upgrade listener must not throw");
    // Still alive afterwards.
    assert.equal(await get(g.port, null), 401);
  } finally { await g.close(); }
});

test("a valid session still authenticates when a malformed cookie sits beside it", async () => {
  const g = await gateway();
  try {
    const session = mintCookie(SECRET, { user: "anthony@profullstack.com" });
    // A browser sends every cookie for the host, so one unrelated bad value
    // must not cost the user their session.
    const status = await get(g.port, `junk=%; ${COOKIE}=${session}`);
    assert.equal(status, 502, "authenticated requests go to ttyd, which is not running here");
  } finally { await g.close(); }
});

// ----------------------------------------------------------- the controls ---
// These pass before and after. They are here so the fix cannot buy crash
// safety by quietly weakening the gate.

test("well-formed cookie values are still percent-decoded", () => {
  assert.deepEqual(parseCookies("a=1; b=two%20words"), { a: "1", b: "two words" });
  assert.deepEqual(parseCookies("e=a%40b.com"), { e: "a@b.com" });
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies("nonsense"), {});
});

test("no cookie at all is still refused on both paths", async () => {
  const g = await gateway();
  try {
    assert.equal(await get(g.port, null), 401);
    assert.equal(await upgrade(g.port, null), 401);
  } finally { await g.close(); }
});

test("a forged session cookie is still refused", async () => {
  const g = await gateway();
  try {
    const forged = mintCookie("attacker", { user: "root" });
    assert.equal(await get(g.port, `${COOKIE}=${forged}`), 401);
    assert.equal(await upgrade(g.port, `${COOKIE}=${forged}`), 401);
  } finally { await g.close(); }
});

test("an expired session cookie is still refused", async () => {
  const g = await gateway();
  try {
    const stale = mintCookie(SECRET, { user: "x", now: Date.now() - 10_000, ttlMs: 1000 });
    assert.equal(await get(g.port, `${COOKIE}=${stale}`), 401);
    assert.equal(await upgrade(g.port, `${COOKIE}=${stale}`), 401);
  } finally { await g.close(); }
});

test("a valid session still reaches the proxy on both paths", async () => {
  const g = await gateway();
  try {
    const session = mintCookie(SECRET, { user: "anthony@profullstack.com" });
    // 502 rather than 401: it got past the gate and failed to find ttyd.
    assert.equal(await get(g.port, `${COOKIE}=${session}`), 502);
    // The upgrade gets past the gate too, then the raw connect to ttyd fails.
    assert.notEqual(await upgrade(g.port, `${COOKIE}=${session}`), 401);
  } finally { await g.close(); }
});
