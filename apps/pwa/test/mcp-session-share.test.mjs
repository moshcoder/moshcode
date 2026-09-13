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
  deps = { express: require("express") };
} catch {
  deps = null;
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-mcp-share-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.PUBLIC_ORIGIN = "https://app.moshcode.example.test";
process.env.MCP_PUBLIC_ORIGIN = "https://moshcode.example.test";
process.env.SESSION_POLL_MS = "300";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, get, db } = await import("../src/db.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");
  const { mcpOAuthMachineRouter } = await import("../src/routes/mcp-oauth.mjs");
  const { mcpRouter } = await import("../src/routes/mcp.mjs");
  const { sessionsRouter } = await import("../src/routes/sessions.mjs");
  const { validateAuthorizationRequest } = await import("../src/lib/mcp-auth.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(mcpOAuthMachineRouter);
  app.use(mcpRouter);
  app.use(sessionsRouter);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await run(`INSERT INTO users (id,email,display_name,created_at) VALUES ('u1','owner@example.test','owner',1)`);
  const apiKey = (await createApiKey("u1", "share test")).plaintext;

  const request = (pathname, { method = "GET", bearer, body } = {}) => fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => ({ response, body: await response.json().catch(() => null) }));

  return { run, get, db, server, request, apiKey, validateAuthorizationRequest };
}

let booted = null;
const app = () => (booted ||= boot());
const options = { skip: !deps && "apps/pwa deps not installed", timeout: 10_000 };

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

test("session share: device OAuth binds one opaque endpoint and revocation kills it", options, async () => {
  const { run, get, request, apiKey, validateAuthorizationRequest } = await app();
  const session = await request("/api/sessions", {
    method: "POST",
    bearer: apiKey,
    body: { name: "shared session", cwd: "/srv/project", features: ["keys", "signals"] },
  });
  assert.equal(session.response.status, 200);

  const share = await request("/api/v1/mcp/shares", {
    method: "POST",
    bearer: apiKey,
    body: { session_id: session.body.id, scope: "sessions:read sessions:write sessions:approve sessions:cancel", ttl_seconds: 3600 },
  });
  assert.equal(share.response.status, 201);
  assert.match(share.body.endpoint, /^https:\/\/moshcode\.example\.test\/api\/v1\/mcp\/mcs_/);

  const metadata = await request(`/.well-known/oauth-protected-resource/api/v1/mcp/${share.body.id}`);
  assert.equal(metadata.response.status, 200);
  assert.equal(metadata.body.resource, share.body.endpoint);

  const client = await request("/oauth/register", {
    method: "POST",
    body: { client_name: "Chovy", redirect_uris: ["https://chovy.example.test/callback"] },
  });
  const browserGrant = await validateAuthorizationRequest({
    response_type: "code",
    client_id: client.body.client_id,
    redirect_uri: "https://chovy.example.test/callback",
    code_challenge_method: "S256",
    code_challenge: "a".repeat(43),
    resource: share.body.endpoint,
    scope: "sessions:read sessions:write sessions:approve sessions:cancel",
  });
  assert.equal(browserGrant.share.session_id, session.body.id);
  const device = await request("/oauth/device_authorization", {
    method: "POST",
    body: {
      client_id: client.body.client_id,
      resource: share.body.endpoint,
      scope: "sessions:read sessions:write sessions:approve sessions:cancel",
    },
  });
  assert.equal(device.response.status, 200);
  assert.match(device.body.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const pending = await request("/oauth/token", {
    method: "POST",
    body: {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: client.body.client_id,
      device_code: device.body.device_code,
      resource: share.body.endpoint,
    },
  });
  assert.equal(pending.body.error, "authorization_pending");

  await run(`UPDATE device_codes SET status='approved', user_id='u1', last_polled_at=NULL WHERE user_code=?`, [device.body.user_code]);
  const issued = await request("/oauth/token", {
    method: "POST",
    body: {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: client.body.client_id,
      device_code: device.body.device_code,
      resource: share.body.endpoint,
    },
  });
  assert.equal(issued.response.status, 200);
  assert.match(issued.body.access_token, /^mca_/);
  const replay = await request("/oauth/token", {
    method: "POST",
    body: {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: client.body.client_id,
      device_code: device.body.device_code,
      resource: share.body.endpoint,
    },
  });
  assert.equal(replay.body.error, "expired_token");

  const listed = await request(`/api/v1/mcp/${share.body.id}`, {
    method: "POST",
    bearer: issued.body.access_token,
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.result.tools.some((tool) => tool.name === "session_cancel"), true);

  const cancelled = await request(`/api/v1/mcp/${share.body.id}`, {
    method: "POST",
    bearer: issued.body.access_token,
    body: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "moshcode_session_cancel", arguments: { session_id: session.body.id } },
    },
  });
  assert.equal(cancelled.body.result.isError, undefined);
  assert.ok(await get(`SELECT 1 FROM session_commands WHERE session_id=? AND body=?`, [session.body.id, "\u001bmoshsignal:interrupt"]));

  const revoked = await request(`/api/v1/mcp/shares/${share.body.id}`, { method: "DELETE", bearer: apiKey });
  assert.equal(revoked.response.status, 200);
  const afterRevoke = await request(`/api/v1/mcp/${share.body.id}`, {
    method: "POST",
    bearer: issued.body.access_token,
    body: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
  });
  assert.equal(afterRevoke.response.status, 401);
});
