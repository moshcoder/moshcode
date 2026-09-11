// Integration tests for the remote MCP + OAuth surface.
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
process.env.PUBLIC_ORIGIN = "https://app.moshcode.test";
process.env.SESSION_SECRET = "mcp-test-secret";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, all, db } = await import("../src/db.mjs");
  const { mcpRouter } = await import("../src/routes/mcp.mjs");
  const { mcpOAuthMachineRouter } = await import("../src/routes/mcp-oauth.mjs");
  const {
    MCP_RESOURCE,
    createAuthorizationCode,
    exchangeAuthorizationCode,
    pkceChallenge,
    registerOAuthClient,
    rotateRefreshToken,
  } = await import("../src/lib/mcp-auth.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(mcpOAuthMachineRouter);
  app.use(mcpRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await run(`INSERT OR REPLACE INTO users (id,email,display_name,created_at) VALUES ('u1','mcp@example.test','MCP Test',1)`);

  async function tokenFor(scope, sessionId = null) {
    const client = await registerOAuthClient({
      client_name: "test client",
      redirect_uris: ["https://client.example.test/callback"],
    });
    const verifier = crypto.randomBytes(48).toString("base64url").slice(0, 64);
    const code = await createAuthorizationCode({
      userId: "u1",
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0],
      scope,
      resource: MCP_RESOURCE,
      sessionId,
      codeChallenge: pkceChallenge(verifier),
    });
    const result = await exchangeAuthorizationCode({
      code,
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0],
      verifier,
      resource: MCP_RESOURCE,
    });
    return { ...result, __client_id: client.client_id };
  }

  return {
    run, all, db, server, base, tokenFor, MCP_RESOURCE,
    createAuthorizationCode, exchangeAuthorizationCode, pkceChallenge, registerOAuthClient, rotateRefreshToken,
  };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

test("MCP protected resource returns an OAuth challenge without a token", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { base } = await app();
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") || "", /oauth-protected-resource\/mcp/);
});

test("OAuth authorization codes are PKCE-protected and single-use", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { MCP_RESOURCE, createAuthorizationCode, exchangeAuthorizationCode, pkceChallenge, registerOAuthClient } = await app();
  const client = await registerOAuthClient({
    client_name: "single-use test",
    redirect_uris: ["https://client.example.test/replay"],
  });
  const verifier = crypto.randomBytes(48).toString("base64url").slice(0, 64);
  const code = await createAuthorizationCode({
    userId: "u1",
    clientId: client.client_id,
    redirectUri: client.redirect_uris[0],
    scope: "sessions:read",
    resource: MCP_RESOURCE,
    codeChallenge: pkceChallenge(verifier),
  });

  await assert.rejects(
    exchangeAuthorizationCode({
      code, clientId: client.client_id, redirectUri: client.redirect_uris[0],
      verifier: "wrong-" + verifier, resource: MCP_RESOURCE,
    }),
    /PKCE verification failed/
  );

  const tokens = await exchangeAuthorizationCode({
    code, clientId: client.client_id, redirectUri: client.redirect_uris[0],
    verifier, resource: MCP_RESOURCE,
  });
  assert.match(tokens.access_token, /^mca_/);
  assert.match(tokens.refresh_token, /^mcr_/);
  assert.equal(tokens.scope, "sessions:read");

  await assert.rejects(
    exchangeAuthorizationCode({
      code, clientId: client.client_id, redirectUri: client.redirect_uris[0],
      verifier, resource: MCP_RESOURCE,
    }),
    /invalid or expired authorization code|already used/
  );
});

test("OAuth refresh tokens rotate and cannot be replayed", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { tokenFor, rotateRefreshToken } = await app();
  const first = await tokenFor("sessions:read");
  const second = await rotateRefreshToken({ refreshToken: first.refresh_token, clientId: first.__client_id });
  assert.match(second.access_token, /^mca_/);
  assert.notEqual(second.refresh_token, first.refresh_token);
  await assert.rejects(
    rotateRefreshToken({ refreshToken: first.refresh_token, clientId: first.__client_id }),
    /invalid refresh_token|already used/
  );
});

test("read-only MCP tokens only discover read tools", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { base, tokenFor } = await app();
  const tokens = await tokenFor("sessions:read");
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const names = body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["moshcode_sessions_list", "moshcode_session_read"]);
  assert.equal(body.result.resultType, "complete");
  assert.equal(body.result.cacheScope, "private");
});

test("control token can queue a command into its bound live session", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { base, tokenFor, run, all } = await app();
  const now = Date.now();
  await run(
    `INSERT INTO cli_sessions
      (id,user_id,name,host,version,cwd,cols,rows,features,status,created_at,last_seen_at)
     VALUES ('s1','u1','test session','host','1.0','/tmp',80,24,'["keys"]','live',?,?)`,
    [now, now]
  );
  const tokens = await tokenFor("sessions:control", "s1");
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "moshcode_session_send",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "moshcode_session_send",
        arguments: { session_id: "s1", text: "git status" },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.isError, undefined);
  const commands = await all(`SELECT body,status FROM session_commands WHERE session_id='s1'`);
  assert.deepEqual(commands.map((r) => [r.body, r.status]), [["git status", "queued"]]);
});

test("a session-bound token cannot read a different session", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { base, tokenFor, run } = await app();
  const now = Date.now();
  await run(
    `INSERT OR IGNORE INTO cli_sessions
      (id,user_id,name,features,status,created_at,last_seen_at)
     VALUES ('s-bound','u1','bound','[]','live',?,?)`,
    [now, now]
  );
  await run(
    `INSERT OR IGNORE INTO cli_sessions
      (id,user_id,name,features,status,created_at,last_seen_at)
     VALUES ('s-other','u1','other','[]','live',?,?)`,
    [now, now]
  );
  const tokens = await tokenFor("sessions:read", "s-bound");
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "moshcode_session_read", arguments: { session_id: "s-other" } },
    }),
  });
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /bound to a different session/);
});
