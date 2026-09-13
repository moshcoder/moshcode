import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import cookieParser from "cookie-parser";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-security-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
process.env.PUBLIC_ORIGIN = "https://app.example.test";
process.env.MCP_PUBLIC_ORIGIN = "https://gateway.example.test";
process.env.SESSION_POLL_MS = "50";
const { migrate } = await import("../src/migrate.mjs");
await migrate();
const { run, get, all, db } = await import("../src/db.mjs");
const auth = await import("../src/lib/mcp-auth.mjs");
const { createApiKey } = await import("../src/lib/apikey.mjs");
const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
const { mcpRouter } = await import("../src/routes/mcp.mjs");
const { mcpOAuthMachineRouter, mcpOAuthBrowserRouter } = await import("../src/routes/mcp-oauth.mjs");
const { cliRouter } = await import("../src/routes/cli.mjs");
const { sessionsRouter } = await import("../src/routes/sessions.mjs");
const app = express();
app.use(express.json(), express.urlencoded({ extended: false }), cookieParser(), sessionMiddleware);
app.use(mcpOAuthMachineRouter, mcpRouter, csrfGuard, mcpOAuthBrowserRouter, cliRouter, sessionsRouter);
const server = await new Promise((resolve) => { const one = app.listen(0, "127.0.0.1", () => resolve(one)); });
const base = `http://127.0.0.1:${server.address().port}`;
const keys = {};
for (const user of ["owner", "other"]) {
  await run(`INSERT INTO users (id,email,created_at) VALUES (?,?,?)`, [user, `${user}@example.test`, Date.now()]);
  keys[user] = (await createApiKey(user, "fixture")).plaintext;
  await run(`INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)`, [`cookie-${user}`, user, Date.now(), Date.now() + 3600000]);
}
const client = await auth.registerOAuthClient({ client_name: "Fixture", redirect_uris: ["https://client.example.test/callback"] });
const otherClient = await auth.registerOAuthClient({ redirect_uris: ["https://other-client.example.test/callback"] });
const request = async (url, { method = "GET", bearer, user, csrf = true, body, headers = {} } = {}) => {
  const response = await fetch(base + url, { method, redirect: "manual", headers: {
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    ...(user ? { cookie: `mc_sess=cookie-${user}; mc_csrf=fixture-csrf`, ...(csrf ? { "x-csrf-token": "fixture-csrf" } : {}) } : {}),
    ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers,
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, headers: response.headers, data };
};
async function fixture(scope = "sessions:read sessions:write sessions:approve sessions:cancel") {
  const session = crypto.randomUUID(); const now = Date.now();
  await run(`INSERT INTO cli_sessions (id,user_id,name,features,status,created_at,last_seen_at) VALUES (?,'owner','Fixture','["keys","signals"]','live',?,?)`, [session, now, now]);
  const result = await request("/api/v1/mcp/shares", { method: "POST", bearer: keys.owner, body: { session_id: session, scope, ttl_seconds: 300 } });
  assert.equal(result.status, 201);
  return { session, share: result.data, route: `/api/v1/mcp/${result.data.id}` };
}
async function codeFor(f, scope = "sessions:read") {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const code = await auth.createAuthorizationCode({ userId: "owner", clientId: client.client_id, redirectUri: client.redirect_uris[0],
    scope, resource: f.share.endpoint, sessionId: f.session, codeChallenge: auth.pkceChallenge(verifier) });
  return { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_verifier: verifier, resource: f.share.endpoint };
}
async function grant(f, scope = "sessions:read") {
  const response = await request("/oauth/token", { method: "POST", body: await codeFor(f, scope) });
  assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data;
}
const call = (f, token, name, args = {}, extra = {}) => request(f.route, { method: "POST", bearer: token,
  body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, ...extra });
const deviceRequest = (device, f) => ({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: client.client_id, resource: f.share.endpoint });
test.after(async () => { await new Promise((resolve) => server.close(resolve)); db.close?.(); fs.rmSync(dir, { recursive: true, force: true }); });

test("share creation is owner-only, defaults read-only, and rejects broad control", async () => {
  const f = await fixture();
  const other = await request("/api/v1/mcp/shares", { method: "POST", bearer: keys.other, body: { session_id: f.session } });
  assert.equal(other.status, 404);
  const broad = await request("/api/v1/mcp/shares", { method: "POST", bearer: keys.owner, body: { session_id: f.session, scope: "sessions:control" } });
  assert.equal(broad.status, 400); assert.match(broad.data.error, /sessions:write/);
  const read = await request("/api/v1/mcp/shares", { method: "POST", bearer: keys.owner, body: { session_id: f.session } });
  assert.deepEqual(read.data.scopes, ["sessions:read"]);
  assert.equal((await request(`/api/v1/mcp/shares/${f.share.id}`, { method: "DELETE", bearer: keys.other })).status, 404);
});

test("metadata and GET challenge identify the exact canonical resource; tokens cannot cross shares", async () => {
  const f = await fixture(); const other = await fixture(); const token = await grant(f);
  const metadata = await request(`/.well-known/oauth-protected-resource/api/v1/mcp/${f.share.id}`);
  assert.equal(metadata.data.resource, f.share.endpoint); assert.deepEqual(metadata.data.authorization_servers, ["https://app.example.test"]);
  const unauth = await request(f.route); assert.equal(unauth.status, 401); assert.ok(unauth.headers.get("www-authenticate").includes(f.share.id));
  assert.equal((await request(f.route, { bearer: token.access_token })).status, 405);
  assert.equal((await call(other, token.access_token, "session_read")).status, 401);
  assert.equal((await request("/mcp", { method: "POST", bearer: token.access_token, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status, 401);
  const mismatch = await call(f, token.access_token, "session_read", { session_id: other.session });
  assert.equal(mismatch.data.result.isError, true); assert.match(mismatch.data.result.content[0].text, /different session/);
});

test("granular scopes expose bound tools and enforce read/write/approve/cancel independently", async () => {
  const f = await fixture();
  const allowed = { "sessions:read": ["session_read"], "sessions:write": ["session_read", "session_send", "session_answer"],
    "sessions:approve": ["session_read", "session_approve"], "sessions:cancel": ["session_read", "session_cancel"] };
  for (const [scope, names] of Object.entries(allowed)) {
    const token = await grant(f, auth.normalizeScopes(scope).join(" "));
    const listed = await request(f.route, { method: "POST", bearer: token.access_token, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    assert.deepEqual(listed.data.result.tools.map((t) => t.name), names);
    for (const tool of listed.data.result.tools) assert.equal(tool.inputSchema.required.includes("session_id"), false);
    assert.equal((await call(f, token.access_token, "session_read")).data.result.structuredContent.session.id, f.session);
    for (const [name, args] of [["session_send", { text: "fixture text" }], ["session_answer", { text: "fixture answer" }], ["session_approve", { decision: "deny" }], ["session_cancel", {}]]) {
      const result = await call(f, token.access_token, name, args);
      assert.equal(result.status, names.includes(name) ? 200 : 403, `${scope}: ${name}`);
    }
  }
  const token = await grant(f, "sessions:read sessions:approve");
  const bad = await call(f, token.access_token, "session_approve", { decision: "rm -rf anything" });
  assert.equal(bad.data.result.isError, true);
});

test("commands reject truncation and control-byte injection; audits contain metadata only", async () => {
  const f = await fixture(); const token = await grant(f, "sessions:read sessions:write");
  for (const text of ["x".repeat(501), "a\n".repeat(51), "\u001bmoshsignal:interrupt", "\u0003"]) {
    assert.equal((await call(f, token.access_token, "session_send", { text })).data.result.isError, true);
  }
  const secret = "fixture body must never appear in audit";
  assert.equal((await call(f, token.access_token, "session_answer", { text: secret })).data.result.isError, undefined);
  const events = await all(`SELECT * FROM mcp_audit_events WHERE share_id=?`, [f.share.id]);
  assert.ok(events.some((event) => event.action === "session_answer" && event.outcome === "allowed"));
  assert.equal(JSON.stringify(events).includes(secret), false); assert.equal(JSON.stringify(events).includes(token.access_token), false);
  assert.deepEqual((await all(`SELECT body,mcp_share_id FROM session_commands WHERE session_id=?`, [f.session])).map((row) => [row.body, row.mcp_share_id]), [[secret, f.share.id]]);
});

test("PKCE, client, redirect and resource checks precede atomic single-use code consumption", async () => {
  const f = await fixture(); const code = await codeFor(f);
  for (const changed of [{ code_verifier: "a".repeat(43) }, { client_id: otherClient.client_id }, { redirect_uri: "https://client.example.test/elsewhere" }, { resource: auth.MCP_RESOURCE }, { resource: undefined }]) {
    assert.equal((await request("/oauth/token", { method: "POST", body: { ...code, ...changed } })).status, 400);
  }
  const attempts = await Promise.all([1, 2].map(() => request("/oauth/token", { method: "POST", body: code })));
  assert.deepEqual(attempts.map((one) => one.status).sort(), [200, 400]);
  const expired = await codeFor(f); await run(`UPDATE mcp_oauth_codes SET expires_at=0 WHERE resource=?`, [f.share.endpoint]);
  assert.equal((await request("/oauth/token", { method: "POST", body: expired })).status, 400);
});

test("refresh is resource-bound; replay revokes replacement tokens and explicit revocation is client-bound", async () => {
  const f = await fixture(); const first = await grant(f);
  const body = { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: client.client_id, resource: f.share.endpoint };
  for (const changed of [{ resource: auth.MCP_RESOURCE }, { client_id: otherClient.client_id }, { scope: "sessions:write" }, { resource: undefined }]) {
    assert.equal((await request("/oauth/token", { method: "POST", body: { ...body, ...changed } })).status, 400);
  }
  const second = await request("/oauth/token", { method: "POST", body }); assert.equal(second.status, 200);
  assert.equal((await call(f, second.data.access_token, "session_read")).status, 200);
  assert.equal((await request("/oauth/token", { method: "POST", body })).status, 400);
  assert.equal((await call(f, second.data.access_token, "session_read")).status, 401);
  assert.equal((await request("/oauth/token", { method: "POST", body: { ...body, refresh_token: second.data.refresh_token } })).status, 400);
  const fresh = await grant(f);
  await request("/oauth/revoke", { method: "POST", body: { token: fresh.refresh_token, client_id: otherClient.client_id } });
  assert.equal((await call(f, fresh.access_token, "session_read")).status, 200);
  await request("/oauth/revoke", { method: "POST", body: { token: fresh.refresh_token, client_id: client.client_id } });
  assert.equal((await call(f, fresh.access_token, "session_read")).status, 401);
});

test("expired/revoked shares cannot mint or use tokens, and token lifetimes do not outlive the share", async () => {
  const f = await fixture(); const code = await codeFor(f); const token = await grant(f);
  assert.ok(token.expires_in <= 300);
  await run(`UPDATE mcp_shares SET expires_at=0 WHERE id=?`, [f.share.id]);
  assert.equal((await call(f, token.access_token, "session_read")).status, 401);
  assert.equal((await request("/oauth/token", { method: "POST", body: code })).status, 400);
  assert.equal((await request("/oauth/token", { method: "POST", body: { grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: client.client_id, resource: f.share.endpoint } })).status, 400);
  const list = await request("/api/v1/mcp/shares", { bearer: keys.owner }); assert.equal(list.data.shares.find((sh) => sh.id === f.share.id).status, "expired");
});

test("device flow enforces resource, polling interval, owner consent, CSRF and single use", async () => {
  const f = await fixture();
  const device = (await request("/oauth/device_authorization", { method: "POST", body: { client_id: client.client_id, resource: f.share.endpoint, scope: "sessions:read" } })).data;
  assert.equal(await get(`SELECT 1 FROM device_codes WHERE device_code=?`, [device.device_code]), null);
  const body = deviceRequest(device, f);
  assert.equal((await request("/oauth/token", { method: "POST", body: { ...body, resource: auth.MCP_RESOURCE } })).data.error, "invalid_grant");
  assert.equal((await request("/oauth/token", { method: "POST", body })).data.error, "authorization_pending");
  assert.equal((await request("/oauth/token", { method: "POST", body })).data.error, "slow_down");
  assert.equal(Number((await get(`SELECT interval_s FROM device_codes WHERE user_code=?`, [device.user_code])).interval_s), 10);
  await request("/device", { method: "POST", user: "other", body: { user_code: device.user_code, decision: "approve" } });
  assert.equal((await get(`SELECT status FROM device_codes WHERE user_code=?`, [device.user_code])).status, "pending");
  assert.equal((await request("/device", { method: "POST", user: "owner", csrf: false, body: { user_code: device.user_code, decision: "approve" } })).status, 403);
  await request("/device", { method: "POST", user: "owner", body: { user_code: device.user_code, decision: "approve" } });
  await run(`UPDATE device_codes SET last_polled_at=0 WHERE user_code=?`, [device.user_code]);
  const issued = await request("/oauth/token", { method: "POST", body }); assert.equal(issued.status, 200);
  assert.equal((await call(f, issued.data.access_token, "session_read")).status, 200);
  assert.equal((await request("/oauth/token", { method: "POST", body })).data.error, "expired_token");
});

test("browser consent checks owner and CSRF before granting the exact session", async () => {
  const f = await fixture(); const verifier = crypto.randomBytes(48).toString("base64url");
  const body = { client_id: client.client_id, response_type: "code", redirect_uri: client.redirect_uris[0], resource: f.share.endpoint,
    scope: "sessions:read", code_challenge_method: "S256", code_challenge: auth.pkceChallenge(verifier), decision: "allow", session_id: "not-the-shared-session" };
  assert.equal((await request("/oauth/authorize", { method: "POST", user: "other", body })).status, 400);
  assert.equal((await request("/oauth/authorize", { method: "POST", user: "owner", csrf: false, body })).status, 403);
  const consent = await request("/oauth/authorize", { method: "POST", user: "owner", body }); assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  const issued = await request("/oauth/token", { method: "POST", body: { grant_type: "authorization_code", code, client_id: client.client_id,
    redirect_uri: client.redirect_uris[0], code_verifier: verifier, resource: f.share.endpoint } });
  assert.equal(issued.status, 200); assert.equal((await call(f, issued.data.access_token, "session_read")).data.result.structuredContent.session.id, f.session);
});

test("share revocation and expiry prevent queued commands from being claimed; claims remain single-use", async () => {
  for (const revoke of [true, false]) {
    const f = await fixture(); const token = await grant(f, "sessions:read sessions:write");
    await call(f, token.access_token, "session_send", { text: "never deliver this fixture" });
    if (revoke) await request(`/api/v1/mcp/shares/${f.share.id}`, { method: "DELETE", bearer: keys.owner });
    else await run(`UPDATE mcp_shares SET expires_at=0 WHERE id=?`, [f.share.id]);
    const polled = await request(`/api/sessions/${f.session}/commands`, { bearer: keys.owner });
    assert.deepEqual(polled.data.commands, []);
    assert.equal((await get(`SELECT status FROM session_commands WHERE session_id=?`, [f.session])).status, "cancelled");
  }
  const f = await fixture(); const token = await grant(f, "sessions:read sessions:approve");
  await call(f, token.access_token, "session_approve", { decision: "deny" });
  const polls = await Promise.all([1, 2].map(() => request(`/api/sessions/${f.session}/commands`, { bearer: keys.owner })));
  assert.deepEqual(polls.flatMap((one) => one.data.commands.map((command) => command.body)), ["no"]);
});

test("browser origins, preflight, protocol versions and notifications are validated", async () => {
  const f = await fixture(); const token = await grant(f, "sessions:read sessions:write");
  const preflight = await request(f.route, { method: "OPTIONS", headers: { origin: "https://client.example.test" } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.equal((await call(f, token.access_token, "session_read", {}, { headers: { origin: "https://evil.example.test" } })).status, 403);
  assert.equal((await call(f, token.access_token, "session_read", {}, { headers: { origin: "https://client.example.test" } })).status, 200);
  assert.equal((await call(f, token.access_token, "session_read", {}, { headers: { "mcp-protocol-version": "unknown" } })).status, 400);
  assert.equal((await request(f.route, { method: "POST", bearer: token.access_token, body: { jsonrpc: "2.0", method: "notifications/initialized" } })).status, 202);
  assert.equal((await request(f.route, { method: "POST", bearer: token.access_token, body: { jsonrpc: "2.0", method: "tools/call", params: { name: "session_send", arguments: { text: "must not queue" } } } })).status, 400);
  assert.equal((await all(`SELECT * FROM session_commands WHERE session_id=?`, [f.session])).length, 0);
});

test("bound shares reject unlisted navigation/list tools through canonical and legacy aliases", async () => {
  const f = await fixture(); const token = await grant(f, "sessions:read sessions:write");
  for (const name of ["session_key", "moshcode_session_key", "sessions_list", "moshcode_sessions_list"]) {
    const result = await call(f, token.access_token, name, name.includes("key") ? { key: "enter" } : {});
    assert.equal(result.data.error.code, -32602); assert.match(result.data.error.message, /unknown tool/);
  }
  assert.equal((await all(`SELECT * FROM session_commands WHERE session_id=?`, [f.session])).length, 0);
  assert.equal((await call(f, token.access_token, "moshcode_session_answer", { text: "allowed alias" })).data.result.isError, undefined);
});

test("grant revocation and refresh replay cancel undelivered shared and legacy MCP input only", async () => {
  for (const legacy of [false, true]) for (const replay of [false, true]) {
    const f = await fixture();
    const target = legacy ? { ...f, route: "/mcp", share: { endpoint: auth.MCP_RESOURCE } } : f;
    const scope = legacy ? "sessions:read sessions:control" : "sessions:read sessions:write";
    const name = legacy ? "moshcode_session_send" : "session_send";
    const args = text => ({ text, ...(legacy ? { session_id: f.session } : {}) });
    const token = await grant(target, scope);
    await call(target, token.access_token, name, args("revoked fixture"));
    const queued = await get(`SELECT * FROM session_commands WHERE session_id=?`, [f.session]);
    assert.ok(queued.mcp_grant_id); assert.equal(queued.mcp_share_id, legacy ? null : f.share.id);
    const independent = await grant(target, scope);
    await call(target, independent.access_token, name, args("separate grant"));
    await run(`INSERT INTO session_commands (id,session_id,body,status,created_at) VALUES (?,?,'ordinary input','queued',?)`, [crypto.randomUUID(), f.session, Date.now()]);
    if (replay) {
      const body = { grant_type: "refresh_token", client_id: client.client_id, resource: target.share.endpoint, refresh_token: token.refresh_token };
      const rotated = await request("/oauth/token", { method: "POST", body }); assert.equal(rotated.status, 200);
      await call(target, rotated.data.access_token, name, args("replacement grant input"));
      assert.equal((await request("/oauth/token", { method: "POST", body })).status, 400);
    } else {
      assert.equal((await request("/oauth/revoke", { method: "POST", body: { token: token.refresh_token, client_id: client.client_id } })).status, 200);
    }
    assert.equal((await get(`SELECT status FROM session_commands WHERE id=?`, [queued.id])).status, "cancelled");
    const polled = await request(`/api/sessions/${f.session}/commands`, { bearer: keys.owner });
    assert.deepEqual(polled.data.commands.map((one) => one.body).sort(), ["ordinary input", "separate grant"]);
    assert.equal((await call(target, independent.access_token, legacy ? "moshcode_session_read" : "session_read", legacy ? { session_id: f.session } : {})).status, 200);
  }
});

test("claim rechecks grant revocation after reading the queue; already-claimed actions remain claimed", async () => {
  const f = await fixture(); const token = await grant(f, "sessions:read sessions:write");
  await call(f, token.access_token, "session_send", { text: "revoked during claim" });
  const command = await get(`SELECT * FROM session_commands WHERE session_id=?`, [f.session]);
  const execute = db.execute.bind(db); let raced = false;
  db.execute = async (statement) => {
    if (!raced && typeof statement === "object" && statement.sql.includes("SET status='claimed'") && statement.args.includes(command.id)) {
      raced = true;
      await execute({ sql: `UPDATE mcp_oauth_grants SET revoked_at=? WHERE id=?`, args: [Date.now(), command.mcp_grant_id] });
    }
    return execute(statement);
  };
  try {
    const polled = await request(`/api/sessions/${f.session}/commands`, { bearer: keys.owner });
    assert.equal(raced, true); assert.deepEqual(polled.data.commands, []);
  } finally { db.execute = execute; }
  const another = await grant(f, "sessions:read sessions:write");
  await call(f, another.access_token, "session_send", { text: "already delivered" });
  const polled = await request(`/api/sessions/${f.session}/commands`, { bearer: keys.owner });
  assert.equal(polled.data.commands.length, 1);
  await request("/oauth/revoke", { method: "POST", body: { token: another.refresh_token, client_id: client.client_id } });
  assert.equal((await get(`SELECT status FROM session_commands WHERE id=?`, [polled.data.commands[0].id])).status, "claimed");
});
