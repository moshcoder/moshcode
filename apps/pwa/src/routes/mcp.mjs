import crypto from "node:crypto";
import { Router } from "express";
import { all, get, run } from "../db.mjs";
import { bearer, userForApiKey } from "../lib/apikey.mjs";
import { id, sha256, token } from "../lib/crypto.mjs";
import { appBar, esc, footer, page } from "../lib/html.mjs";
import { csrfInput, requireAuth } from "../lib/session.mjs";
import { config } from "../config.mjs";
import { balance } from "../lib/credits.mjs";

export const mcpRouter = Router();

const SHARE_SCOPES = ["session:read", "session:write", "session:approve", "session:cancel"];
const OAUTH_SCOPES = [...SHARE_SCOPES, "offline_access"];
const SIGNAL_PREFIX = "\u001bmoshsignal:";
const SESSION_STALE_MS = 90_000;
const MAX_TOOL_TEXT = 500;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const splitScopes = (value) => [...new Set(String(value || "").split(/\s+/).filter(Boolean))];
const jsonArray = (value) => {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
const resourceFor = (shareId) => `${config.mcp.origin}/api/v1/mcp/${shareId}`;
const resourceMetadataFor = (shareId) =>
  `${config.mcp.origin}/.well-known/oauth-protected-resource/api/v1/mcp/${shareId}`;
const noStore = (res) => res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });

function makeUserCode() {
  const bytes = crypto.randomBytes(8);
  const part = (start) => Array.from(bytes.subarray(start, start + 4), (byte) => DEVICE_ALPHABET[byte % DEVICE_ALPHABET.length]).join("");
  return `${part(0)}-${part(4)}`;
}

function redirectUris(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) return null;
  const result = [];
  for (const raw of value) {
    try {
      const uri = new URL(String(raw));
      const local = uri.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(uri.hostname);
      if (uri.hash || (uri.protocol !== "https:" && !local)) return null;
      result.push(uri.toString());
    } catch {
      return null;
    }
  }
  return [...new Set(result)];
}

function shareIdFromResource(resource) {
  try {
    const uri = new URL(String(resource));
    if (uri.origin !== new URL(config.mcp.origin).origin) return null;
    const match = /^\/api\/v1\/mcp\/([^/]+)$/.exec(uri.pathname);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function requestedScopes(value, allowed) {
  const requested = splitScopes(value);
  const picked = requested.length ? requested : allowed;
  return picked.length > 0 && picked.every((scope) => allowed.includes(scope)) ? picked : null;
}

function oauthError(res, error, description, status = 400) {
  return res.status(status).json({ error, error_description: description });
}

async function apiUser(req, res, next) {
  const user = await userForApiKey(bearer(req));
  if (!user) return res.status(401).json({ error: "invalid or missing API key" });
  req.apiUser = user;
  next();
}

async function audit(req, values) {
  await run(
    `INSERT INTO mcp_audit_log (id,user_id,share_id,client_id,event,decision,detail,ip,user_agent,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      id(),
      values.userId || null,
      values.shareId || null,
      values.clientId || null,
      values.event,
      values.decision,
      values.detail ? JSON.stringify(values.detail) : null,
      req.ip || null,
      String(req.get("user-agent") || "").slice(0, 300) || null,
      Date.now(),
    ]
  );
}

async function activeShare(shareId, userId = null) {
  const args = [shareId, Date.now()];
  let sql = `SELECT sh.*, s.name AS session_name, s.cwd, s.engine, s.status AS session_status,
                    s.last_seen_at, s.features
             FROM mcp_shares sh JOIN cli_sessions s ON s.id = sh.session_id
             WHERE sh.id = ? AND sh.status = 'active' AND sh.expires_at > ?`;
  if (userId) {
    sql += " AND sh.user_id = ?";
    args.push(userId);
  }
  return get(sql, args);
}

async function clientFor(clientId, redirectUri = null) {
  const client = await get(`SELECT * FROM mcp_oauth_clients WHERE client_id = ?`, [clientId]);
  if (!client) return null;
  if (redirectUri && !jsonArray(client.redirect_uris).includes(redirectUri)) return null;
  return client;
}

async function issueTokens({ clientId, shareId, userId, resource, scopes, refresh = false }) {
  const now = Date.now();
  const accessToken = "mca_" + token(32);
  await run(
    `INSERT INTO mcp_access_tokens
       (token_hash,client_id,share_id,user_id,resource,scope,created_at,expires_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [sha256(accessToken), clientId, shareId, userId, resource, scopes.join(" "), now, now + config.mcp.accessTtlMs]
  );
  const response = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(config.mcp.accessTtlMs / 1000),
    scope: scopes.join(" "),
  };
  if (refresh) {
    const refreshToken = "mcr_" + token(40);
    await run(
      `INSERT INTO mcp_refresh_tokens
         (token_hash,client_id,share_id,user_id,resource,scope,created_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [sha256(refreshToken), clientId, shareId, userId, resource, scopes.join(" "), now, now + config.mcp.refreshTtlMs]
    );
    response.refresh_token = refreshToken;
  }
  return response;
}

async function mcpAccess(req, res, next) {
  const accessToken = bearer(req);
  if (!accessToken) {
    res.set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataFor(req.params.shareId)}"`);
    return res.status(401).json({ error: "invalid_token" });
  }
  const row = await get(
    `SELECT t.*, sh.status AS share_status, sh.expires_at AS share_expires_at,
            s.id AS session_id, s.status AS session_status, s.last_seen_at, s.name AS session_name,
            s.cwd, s.engine, s.features
     FROM mcp_access_tokens t
     JOIN mcp_shares sh ON sh.id = t.share_id
     JOIN cli_sessions s ON s.id = sh.session_id
     WHERE t.token_hash = ? AND t.share_id = ?`,
    [sha256(accessToken), req.params.shareId]
  );
  const now = Date.now();
  const expectedResource = resourceFor(req.params.shareId);
  if (!row || row.revoked_at || Number(row.expires_at) <= now || row.share_status !== "active"
      || Number(row.share_expires_at) <= now || row.resource !== expectedResource) {
    res.set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataFor(req.params.shareId)}", error="invalid_token"`);
    return res.status(401).json({ error: "invalid_token" });
  }
  await run(`UPDATE mcp_access_tokens SET last_used_at = ? WHERE token_hash = ?`, [now, sha256(accessToken)]);
  await run(`UPDATE mcp_shares SET last_used_at = ? WHERE id = ?`, [now, row.share_id]);
  req.mcpAuth = { ...row, scopes: new Set(splitScopes(row.scope)) };
  next();
}

function requireScope(req, scope) {
  return req.mcpAuth.scopes.has(scope);
}

function rpcResult(id_, result) {
  return { jsonrpc: "2.0", id: id_, result };
}

function rpcError(id_, code, message, data) {
  return { jsonrpc: "2.0", id: id_ ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function toolText(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function liveSession(auth) {
  return auth.session_status === "live" && Date.now() - Number(auth.last_seen_at) < SESSION_STALE_MS;
}

async function queueCommand(auth, body) {
  if (!liveSession(auth)) throw new Error("session is offline");
  const commandId = id();
  await run(
    `INSERT INTO session_commands (id,session_id,body,status,created_at) VALUES (?,?,?,'queued',?)`,
    [commandId, auth.session_id, body, Date.now()]
  );
  return commandId;
}

export const MCP_TOOLS = [
  {
    name: "session_read",
    description: "Read bounded terminal output and status from this shared Moshcode session.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "integer", minimum: 0, description: "Return output after this sequence number." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum output chunks." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "session_send",
    description: "Type one bounded line into the live Moshcode session. This can execute commands.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 1, maxLength: MAX_TOOL_TEXT } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "session_answer",
    description: "Answer the question currently waiting in the live Moshcode session.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 1, maxLength: MAX_TOOL_TEXT } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "session_approve",
    description: "Approve or deny the confirmation currently waiting in the live Moshcode session.",
    inputSchema: {
      type: "object",
      properties: { decision: { type: "string", enum: ["approve", "deny"] } },
      required: ["decision"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "session_cancel",
    description: "Send an interrupt to the live Moshcode session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

async function callTool(req, name, args = {}) {
  const auth = req.mcpAuth;
  if (name === "session_read") {
    if (!requireScope(req, "session:read")) return toolText("session:read scope required", true);
    const cursor = Number.isSafeInteger(args.cursor) && args.cursor >= 0 ? args.cursor : 0;
    const limit = Number.isSafeInteger(args.limit) ? Math.min(100, Math.max(1, args.limit)) : 40;
    const rows = await all(
      `SELECT seq, chunk, created_at FROM session_output
       WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      [auth.session_id, cursor, limit]
    );
    const nextCursor = rows.length ? Number(rows.at(-1).seq) : cursor;
    return toolText({
      session: {
        name: auth.session_name,
        cwd: auth.cwd,
        engine: auth.engine,
        live: liveSession(auth),
        lastSeenAt: Number(auth.last_seen_at),
      },
      cursor: nextCursor,
      output: rows.map((row) => ({ seq: Number(row.seq), chunk: row.chunk, createdAt: Number(row.created_at) })),
    });
  }

  const needed = name === "session_approve"
    ? "session:approve"
    : name === "session_cancel"
      ? "session:cancel"
      : "session:write";
  if (!requireScope(req, needed)) return toolText(`${needed} scope required`, true);

  let body;
  if (name === "session_send" || name === "session_answer") {
    body = String(args.text || "").trim();
    if (!body || body.length > MAX_TOOL_TEXT || body.includes("\n") || body.includes("\r")
        || body.startsWith("\u001bmosh")) {
      return toolText(`text must be one line between 1 and ${MAX_TOOL_TEXT} characters`, true);
    }
  } else if (name === "session_approve") {
    if (!["approve", "deny"].includes(args.decision)) return toolText("decision must be approve or deny", true);
    body = args.decision === "approve" ? "yes" : "no";
  } else if (name === "session_cancel") {
    if (!jsonArray(auth.features).includes("signals")) {
      return toolText("this Moshcode session is too old to accept remote interrupts", true);
    }
    body = SIGNAL_PREFIX + "interrupt";
  } else {
    return toolText(`unknown tool: ${name}`, true);
  }

  try {
    const commandId = await queueCommand(auth, body);
    await audit(req, {
      userId: auth.user_id,
      shareId: auth.share_id,
      clientId: auth.client_id,
      event: `tool.${name}`,
      decision: "allowed",
      detail: { commandId, inputLength: body.length },
    });
    return toolText({ ok: true, commandId });
  } catch (error) {
    return toolText(error.message || "could not queue session input", true);
  }
}

mcpRouter.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: config.mcp.origin,
    authorization_endpoint: `${config.mcp.origin}/oauth/authorize`,
    token_endpoint: `${config.mcp.origin}/oauth/token`,
    device_authorization_endpoint: `${config.mcp.origin}/oauth/device_authorization`,
    registration_endpoint: `${config.mcp.origin}/oauth/register`,
    revocation_endpoint: `${config.mcp.origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", DEVICE_GRANT],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: OAUTH_SCOPES,
  });
});

mcpRouter.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: `${config.mcp.origin}/api/v1/mcp`,
    authorization_servers: [config.mcp.origin],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ["header"],
  });
});

mcpRouter.get("/.well-known/oauth-protected-resource/api/v1/mcp/:shareId", async (req, res) => {
  const share = await activeShare(req.params.shareId);
  if (!share) return res.status(404).json({ error: "no such active share" });
  res.json({
    resource: resourceFor(share.id),
    authorization_servers: [config.mcp.origin],
    scopes_supported: [...jsonArray(share.scopes), "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: share.name || share.session_name || "Moshcode session",
  });
});

mcpRouter.post("/oauth/register", async (req, res) => {
  const uris = redirectUris(req.body?.redirect_uris);
  if (!uris) return oauthError(res, "invalid_redirect_uri", "redirect_uris must contain one to ten HTTPS or loopback URLs");
  const clientId = "mcc_" + token(24);
  const clientName = String(req.body?.client_name || "MCP client").slice(0, 100);
  await run(
    `INSERT INTO mcp_oauth_clients (client_id,client_name,redirect_uris,created_at) VALUES (?,?,?,?)`,
    [clientId, clientName, JSON.stringify(uris), Date.now()]
  );
  res.status(201).json({
    client_id: clientId,
    client_name: clientName,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    client_id_issued_at: Math.floor(Date.now() / 1000),
  });
});

mcpRouter.post("/oauth/device_authorization", async (req, res) => {
  const clientId = String(req.body?.client_id || "");
  const resource = String(req.body?.resource || "");
  const shareId = shareIdFromResource(resource);
  const client = await clientFor(clientId);
  const share = shareId ? await activeShare(shareId) : null;
  if (!client || !share) return oauthError(res, "invalid_request", "client_id or MCP resource is invalid");
  const scopes = requestedScopes(req.body?.scope, [...jsonArray(share.scopes), "offline_access"]);
  if (!scopes) return oauthError(res, "invalid_scope", "requested scope is not allowed by this share");

  const deviceCode = "mcd_" + token(32);
  let userCode = makeUserCode();
  for (let attempt = 0; attempt < 3 && await get(`SELECT 1 FROM device_codes WHERE user_code = ?`, [userCode]); attempt++) {
    userCode = makeUserCode();
  }
  const now = Date.now();
  const interval = 5;
  const ttl = 10 * 60 * 1000;
  await run(
    `INSERT INTO device_codes
       (device_code,user_code,status,name,interval_s,created_at,expires_at,kind,client_id,share_id,resource,scope)
     VALUES (?,?,?,?,?,?,?,'mcp',?,?,?,?)`,
    [deviceCode, userCode, "pending", String(client.client_name || "MCP client").slice(0, 40), interval, now, now + ttl,
      clientId, share.id, resource, scopes.join(" ")]
  );
  noStore(res).json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${config.mcp.origin}/device`,
    verification_uri_complete: `${config.mcp.origin}/device?code=${encodeURIComponent(userCode)}`,
    expires_in: Math.floor(ttl / 1000),
    interval,
  });
});

async function authorizeRequest(req) {
  const values = req.method === "GET" ? req.query : req.body;
  const clientId = String(values.client_id || "");
  const redirectUri = String(values.redirect_uri || "");
  const resource = String(values.resource || "");
  const shareId = shareIdFromResource(resource);
  const client = await clientFor(clientId, redirectUri);
  const share = shareId ? await activeShare(shareId, req.user.id) : null;
  if (!client || !share) return { error: "invalid client, redirect URI, resource, or share" };
  if (values.response_type !== "code") return { error: "response_type must be code" };
  if (values.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(String(values.code_challenge || ""))) {
    return { error: "S256 PKCE is required" };
  }
  const scopes = requestedScopes(values.scope, [...jsonArray(share.scopes), "offline_access"]);
  if (!scopes) return { error: "requested scope is not allowed by this share" };
  return { values, client, share, scopes, redirectUri, resource };
}

mcpRouter.get("/oauth/authorize", requireAuth, async (req, res) => {
  const auth = await authorizeRequest(req);
  if (auth.error) return res.status(400).type("html").send(page({ body: `<main class="wrap" style="padding-top:12vh"><h1>Bad MCP request</h1><p class="dim mono">${esc(auth.error)}</p></main>` }));
  const hidden = ["client_id", "redirect_uri", "response_type", "state", "scope", "resource", "code_challenge", "code_challenge_method"]
    .map((key) => `<input type="hidden" name="${key}" value="${esc(auth.values[key] || "")}">`)
    .join("");
  res.type("html").send(page({
    title: "moshcode ▸ authorize MCP",
    body: `${appBar(req.user, await balance(req.user.id), req.csrfToken)}
      <main class="wrap" style="max-width:520px;padding-top:8vh">
        <div class="card"><div class="card-body">
          <h1 style="font-size:1.35rem">Connect ${esc(auth.client.client_name || "an MCP client")}</h1>
          <p class="dim mono">This grants access only to <b class="acid">${esc(auth.share.name || auth.share.session_name)}</b>.</p>
          <p class="mono" style="font-size:.78rem">Scopes: ${esc(auth.scopes.join(" "))}</p>
          <form method="post" action="/oauth/authorize">
            ${csrfInput(req)}${hidden}
            <button class="btn acid block" name="decision" value="approve" type="submit">Authorize</button>
            <button class="btn block" name="decision" value="deny" type="submit" style="margin-top:8px">Deny</button>
          </form>
        </div></div>
      </main>${footer}`,
  }));
});

mcpRouter.post("/oauth/authorize", requireAuth, async (req, res) => {
  const auth = await authorizeRequest(req);
  if (auth.error) return res.status(400).send(auth.error);
  const destination = new URL(auth.redirectUri);
  if (auth.values.state) destination.searchParams.set("state", String(auth.values.state));
  if (req.body?.decision !== "approve") {
    destination.searchParams.set("error", "access_denied");
    return res.redirect(destination.toString());
  }
  const code = "mccode_" + token(32);
  const now = Date.now();
  await run(
    `INSERT INTO mcp_oauth_codes
       (code_hash,client_id,share_id,user_id,redirect_uri,resource,scope,code_challenge,created_at,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      sha256(code),
      auth.client.client_id,
      auth.share.id,
      req.user.id,
      auth.redirectUri,
      auth.resource,
      auth.scopes.join(" "),
      String(auth.values.code_challenge),
      now,
      now + 5 * 60 * 1000,
    ]
  );
  destination.searchParams.set("code", code);
  await audit(req, {
    userId: req.user.id,
    shareId: auth.share.id,
    clientId: auth.client.client_id,
    event: "oauth.authorize",
    decision: "allowed",
    detail: { scopes: auth.scopes },
  });
  res.redirect(destination.toString());
});

mcpRouter.post("/oauth/token", async (req, res) => {
  noStore(res);
  if (req.body?.grant_type === DEVICE_GRANT) {
    const deviceCode = String(req.body.device_code || "");
    const clientId = String(req.body.client_id || "");
    const row = await get(
      `SELECT * FROM device_codes WHERE device_code = ? AND kind = 'mcp'`,
      [deviceCode]
    );
    if (!row || row.client_id !== clientId || Number(row.expires_at) <= Date.now()) {
      return oauthError(noStore(res), "expired_token", "device code is invalid or expired");
    }
    if (row.status === "pending") return oauthError(noStore(res), "authorization_pending", "authorization is still pending");
    if (row.status === "denied") return oauthError(noStore(res), "access_denied", "authorization was denied");
    if (row.status !== "approved" || !row.user_id) {
      return oauthError(noStore(res), "expired_token", "device code is no longer valid");
    }
    const share = await activeShare(row.share_id, row.user_id);
    if (!share) return oauthError(noStore(res), "invalid_grant", "share is expired, revoked, or belongs to another account");
    const claimed = await run(
      `UPDATE device_codes SET status = 'claimed' WHERE device_code = ? AND kind = 'mcp' AND status = 'approved'`,
      [deviceCode]
    );
    if (!claimed.rowsAffected) return oauthError(noStore(res), "expired_token", "device code was already used");
    const scopes = splitScopes(row.scope);
    return noStore(res).json(await issueTokens({
      clientId,
      shareId: row.share_id,
      userId: row.user_id,
      resource: row.resource,
      scopes,
      refresh: scopes.includes("offline_access"),
    }));
  }

  if (req.body?.grant_type === "authorization_code") {
    const code = await get(`SELECT * FROM mcp_oauth_codes WHERE code_hash = ?`, [sha256(String(req.body.code || ""))]);
    const clientId = String(req.body.client_id || "");
    const redirectUri = String(req.body.redirect_uri || "");
    const verifier = String(req.body.code_verifier || "");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    if (!code || code.used || Number(code.expires_at) <= Date.now() || code.client_id !== clientId
        || code.redirect_uri !== redirectUri || challenge !== code.code_challenge) {
      return oauthError(res, "invalid_grant", "authorization code, client, redirect URI, or PKCE verifier is invalid");
    }
    const claimed = await run(
      `UPDATE mcp_oauth_codes SET used = 1 WHERE code_hash = ? AND used = 0 AND expires_at > ?`,
      [code.code_hash, Date.now()]
    );
    if (!claimed.rowsAffected) return oauthError(res, "invalid_grant", "authorization code was already used");
    const scopes = splitScopes(code.scope);
    const share = await activeShare(code.share_id, code.user_id);
    if (!share) return oauthError(res, "invalid_grant", "share is expired or revoked");
    const issued = await issueTokens({
      clientId,
      shareId: code.share_id,
      userId: code.user_id,
      resource: code.resource,
      scopes,
      refresh: scopes.includes("offline_access"),
    });
    return noStore(res).json(issued);
  }

  if (req.body?.grant_type === "refresh_token") {
    const hash = sha256(String(req.body.refresh_token || ""));
    const refresh = await get(`SELECT * FROM mcp_refresh_tokens WHERE token_hash = ?`, [hash]);
    const clientId = String(req.body.client_id || "");
    if (!refresh || refresh.client_id !== clientId || refresh.revoked_at || refresh.rotated_at
        || Number(refresh.expires_at) <= Date.now()) {
      return oauthError(res, "invalid_grant", "refresh token is invalid, expired, or already rotated");
    }
    const rotated = await run(
      `UPDATE mcp_refresh_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL AND revoked_at IS NULL`,
      [Date.now(), hash]
    );
    if (!rotated.rowsAffected) return oauthError(res, "invalid_grant", "refresh token was already rotated");
    const share = await activeShare(refresh.share_id, refresh.user_id);
    if (!share) return oauthError(res, "invalid_grant", "share is expired or revoked");
    return noStore(res).json(await issueTokens({
      clientId,
      shareId: refresh.share_id,
      userId: refresh.user_id,
      resource: refresh.resource,
      scopes: splitScopes(refresh.scope),
      refresh: true,
    }));
  }

  return oauthError(noStore(res), "unsupported_grant_type", "use authorization_code, refresh_token, or the device-code grant");
});

mcpRouter.post("/oauth/revoke", async (req, res) => {
  const hash = sha256(String(req.body?.token || ""));
  const now = Date.now();
  await run(`UPDATE mcp_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?`, [now, hash]);
  await run(`UPDATE mcp_refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?`, [now, hash]);
  noStore(res).status(200).end();
});

mcpRouter.post("/api/v1/mcp/shares", apiUser, async (req, res) => {
  const sessionId = String(req.body?.session_id || "");
  const session = await get(`SELECT * FROM cli_sessions WHERE id = ? AND user_id = ?`, [sessionId, req.apiUser.id]);
  if (!session) return res.status(404).json({ error: "no such session" });
  const scopes = requestedScopes(req.body?.scope, SHARE_SCOPES);
  if (!scopes) return res.status(400).json({ error: "invalid scope" });
  const requestedTtl = Number(req.body?.ttl_seconds);
  const ttl = Number.isFinite(requestedTtl)
    ? Math.min(config.mcp.maxShareTtlMs, Math.max(60_000, Math.floor(requestedTtl * 1000)))
    : config.mcp.shareTtlMs;
  const shareId = "mcs_" + token(24);
  const now = Date.now();
  await run(
    `INSERT INTO mcp_shares (id,session_id,user_id,name,scopes,status,created_at,expires_at)
     VALUES (?,?,?,?,?,'active',?,?)`,
    [
      shareId,
      session.id,
      req.apiUser.id,
      String(req.body?.name || session.name || "Moshcode session").slice(0, 100),
      JSON.stringify(scopes),
      now,
      now + ttl,
    ]
  );
  res.status(201).json({
    id: shareId,
    session_id: session.id,
    endpoint: resourceFor(shareId),
    scopes,
    expires_at: now + ttl,
  });
});

mcpRouter.get("/api/v1/mcp/shares", apiUser, async (req, res) => {
  const rows = await all(
    `SELECT sh.*, s.name AS session_name, s.status AS session_status, s.last_seen_at
     FROM mcp_shares sh JOIN cli_sessions s ON s.id = sh.session_id
     WHERE sh.user_id = ? ORDER BY sh.created_at DESC LIMIT 100`,
    [req.apiUser.id]
  );
  res.json({
    shares: rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      name: row.name || row.session_name,
      endpoint: resourceFor(row.id),
      scopes: jsonArray(row.scopes),
      status: row.status,
      expires_at: Number(row.expires_at),
      session_live: row.session_status === "live" && Date.now() - Number(row.last_seen_at) < SESSION_STALE_MS,
    })),
  });
});

mcpRouter.delete("/api/v1/mcp/shares/:shareId", apiUser, async (req, res) => {
  const now = Date.now();
  const revoked = await run(
    `UPDATE mcp_shares SET status = 'revoked', revoked_at = ?
     WHERE id = ? AND user_id = ? AND status = 'active'`,
    [now, req.params.shareId, req.apiUser.id]
  );
  if (!revoked.rowsAffected) return res.status(404).json({ error: "no such active share" });
  await run(`UPDATE mcp_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE share_id = ?`, [now, req.params.shareId]);
  await run(`UPDATE mcp_refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE share_id = ?`, [now, req.params.shareId]);
  res.json({ ok: true });
});

mcpRouter.post("/api/v1/mcp/:shareId", mcpAccess, async (req, res) => {
  const message = req.body;
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return res.status(400).json(rpcError(message?.id, -32600, "Invalid Request"));
  }
  if (message.id === undefined) return res.status(202).end();
  if (message.method === "initialize") {
    return res.json(rpcResult(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "moshcode-session", version: "1.0.0" },
      instructions: "Read the session before acting. Ask for confirmation before session_send, session_approve, or session_cancel.",
    }));
  }
  if (message.method === "ping") return res.json(rpcResult(message.id, {}));
  if (message.method === "tools/list") return res.json(rpcResult(message.id, { tools: MCP_TOOLS }));
  if (message.method === "tools/call") {
    const name = String(message.params?.name || "");
    const args = message.params?.arguments && typeof message.params.arguments === "object"
      ? message.params.arguments
      : {};
    return res.json(rpcResult(message.id, await callTool(req, name, args)));
  }
  return res.json(rpcError(message.id, -32601, "Method not found"));
});
