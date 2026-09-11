import assert from "node:assert/strict";
import crypto from "node:crypto";
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

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-mcp-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
process.env.SESSION_POLL_MS = "300";
process.env.MCP_PUBLIC_ORIGIN = "https://moshcode.example.test";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, get, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { sessionsRouter } = await import("../src/routes/sessions.mjs");
  const { mcpRouter } = await import("../src/routes/mcp.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");
  const { sha256 } = await import("../src/lib/crypto.mjs");

  const serverApp = deps.express();
  serverApp.use(deps.express.json());
  serverApp.use(deps.express.urlencoded({ extended: false }));
  serverApp.use(deps.cookieParser());
  serverApp.use(sessionMiddleware);
  serverApp.use(csrfGuard);
  serverApp.use(sessionsRouter);
  serverApp.use(mcpRouter);
  const server = await new Promise((resolve) => {
    const listening = serverApp.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await run(`INSERT INTO users (id,email,display_name,created_at) VALUES ('u1','one@example.test','one',1)`);
  await run(`INSERT INTO users (id,email,display_name,created_at) VALUES ('u2','two@example.test','two',1)`);
  const ownerKey = (await createApiKey("u1", "owner")).plaintext;
  const otherKey = (await createApiKey("u2", "other")).plaintext;

  const request = (pathname, { method = "GET", token, body } = {}) => fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => ({ response, body: await response.json().catch(() => null) }));

  return { run, get, db, server, request, ownerKey, otherKey, sha256 };
}

let booted = null;
const app = () => (booted ||= boot());
const skip = { skip: !deps && "apps/pwa deps not installed", timeout: 10_000 };

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

test("remote MCP: device OAuth grants scoped access to one live session", skip, async () => {
  const { run, get, request, ownerKey } = await app();
  const registered = await request("/api/sessions", {
    method: "POST",
    token: ownerKey,
    body: { name: "live demo", cwd: "/srv/demo", features: ["keys", "signals"] },
  });
  assert.equal(registered.response.status, 200);
  const sessionId = registered.body.id;
  await request(`/api/sessions/${sessionId}/output`, {
    method: "POST",
    token: ownerKey,
    body: { chunk: "ready\n" },
  });

  const shared = await request("/api/v1/mcp/shares", {
    method: "POST",
    token: ownerKey,
    body: { session_id: sessionId, scope: "session:read session:write session:cancel" },
  });
  assert.equal(shared.response.status, 201);

  const client = await request("/oauth/register", {
    method: "POST",
    body: { client_name: "Claude", redirect_uris: ["https://claude.example.test/callback"] },
  });
  assert.equal(client.response.status, 201);

  const device = await request("/oauth/device_authorization", {
    method: "POST",
    body: {
      client_id: client.body.client_id,
      resource: shared.body.endpoint,
      scope: "session:read session:write session:cancel offline_access",
    },
  });
  assert.equal(device.response.status, 200);
  assert.match(device.body.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const pending = await request("/oauth/token", {
    method: "POST",
    body: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: client.body.client_id, device_code: device.body.device_code },
  });
  assert.equal(pending.body.error, "authorization_pending");

  await run(`UPDATE device_codes SET status='approved', user_id='u1' WHERE device_code = ?`, [device.body.device_code]);
  const token = await request("/oauth/token", {
    method: "POST",
    body: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: client.body.client_id, device_code: device.body.device_code },
  });
  assert.equal(token.response.status, 200);
  assert.match(token.body.access_token, /^mca_/);
  assert.match(token.body.refresh_token, /^mcr_/);
  const replay = await request("/oauth/token", {
    method: "POST",
    body: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: client.body.client_id, device_code: device.body.device_code },
  });
  assert.equal(replay.body.error, "expired_token");

  const listed = await request(`/api/v1/mcp/${shared.body.id}`, {
    method: "POST",
    token: token.body.access_token,
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  assert.equal(listed.body.result.tools.some((tool) => tool.name === "session_cancel"), true);

  const read = await request(`/api/v1/mcp/${shared.body.id}`, {
    method: "POST",
    token: token.body.access_token,
    body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "session_read", arguments: {} } },
  });
  assert.match(read.body.result.content[0].text, /ready/);

  const sent = await request(`/api/v1/mcp/${shared.body.id}`, {
    method: "POST",
    token: token.body.access_token,
    body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "session_send", arguments: { text: "/status" } } },
  });
  assert.equal(sent.body.result.isError, undefined);
  assert.equal((await get(`SELECT body FROM session_commands WHERE session_id = ?`, [sessionId])).body, "/status");

  const denied = await request(`/api/v1/mcp/${shared.body.id}`, {
    method: "POST",
    token: token.body.access_token,
    body: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "session_approve", arguments: { decision: "approve" } } },
  });
  assert.equal(denied.body.result.isError, true, "the token did not receive session:approve");

  const cancelled = await request(`/api/v1/mcp/${shared.body.id}`, {
    method: "POST",
    token: token.body.access_token,
    body: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "session_cancel", arguments: {} } },
  });
  assert.equal(cancelled.body.result.isError, undefined);
  assert.ok(await get(`SELECT 1 FROM session_commands WHERE session_id = ? AND body = ?`, [sessionId, "\u001bmoshsignal:interrupt"]));

  await request(`/api/v1/mcp/shares/${shared.body.id}`, { method: "DELETE", token: ownerKey });
  const afterRevoke = await request(`/api/v1/mcp/${shared.body.id}`, {
    method: "POST",
    token: token.body.access_token,
    body: { jsonrpc: "2.0", id: 6, method: "tools/list" },
  });
  assert.equal(afterRevoke.response.status, 401);
});

test("remote MCP: shares are owner-bound and revocation kills access", skip, async () => {
  const { request, ownerKey, otherKey } = await app();
  const registered = await request("/api/sessions", { method: "POST", token: ownerKey, body: { name: "private" } });
  const foreign = await request("/api/v1/mcp/shares", {
    method: "POST",
    token: otherKey,
    body: { session_id: registered.body.id },
  });
  assert.equal(foreign.response.status, 404);

  const shared = await request("/api/v1/mcp/shares", {
    method: "POST",
    token: ownerKey,
    body: { session_id: registered.body.id },
  });
  const revoked = await request(`/api/v1/mcp/shares/${shared.body.id}`, { method: "DELETE", token: ownerKey });
  assert.equal(revoked.response.status, 200);
  const metadata = await request(`/.well-known/oauth-protected-resource/api/v1/mcp/${shared.body.id}`);
  assert.equal(metadata.response.status, 404);
});

test("remote MCP: PKCE codes are single-use and tokens are resource-bound", skip, async () => {
  const { run, request, ownerKey, sha256 } = await app();
  const registered = await request("/api/sessions", { method: "POST", token: ownerKey, body: { name: "browser oauth" } });
  const firstShare = await request("/api/v1/mcp/shares", {
    method: "POST",
    token: ownerKey,
    body: { session_id: registered.body.id, scope: "session:read" },
  });
  const secondShare = await request("/api/v1/mcp/shares", {
    method: "POST",
    token: ownerKey,
    body: { session_id: registered.body.id, scope: "session:read" },
  });
  const client = await request("/oauth/register", {
    method: "POST",
    body: { client_name: "ChatGPT", redirect_uris: ["https://chatgpt.example.test/callback"] },
  });

  const code = "mccode_test";
  const verifier = "browser-verifier-012345678901234567890123456789";
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const now = Date.now();
  await run(
    `INSERT INTO mcp_oauth_codes
       (code_hash,client_id,share_id,user_id,redirect_uri,resource,scope,code_challenge,created_at,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [sha256(code), client.body.client_id, firstShare.body.id, "u1", "https://chatgpt.example.test/callback",
      firstShare.body.endpoint, "session:read", challenge, now, now + 60_000]
  );

  const exchange = () => request("/oauth/token", {
    method: "POST",
    body: {
      grant_type: "authorization_code",
      client_id: client.body.client_id,
      code,
      redirect_uri: "https://chatgpt.example.test/callback",
      code_verifier: verifier,
    },
  });
  const issued = await exchange();
  assert.equal(issued.response.status, 200);
  assert.match(issued.body.access_token, /^mca_/);
  assert.equal((await exchange()).body.error, "invalid_grant");

  const wrongResource = await request(`/api/v1/mcp/${secondShare.body.id}`, {
    method: "POST",
    token: issued.body.access_token,
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  assert.equal(wrongResource.response.status, 401);
});
