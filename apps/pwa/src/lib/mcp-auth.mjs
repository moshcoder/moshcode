// OAuth 2.1-style bearer tokens for the remote Moshcode MCP resource.
//
// This deliberately keeps OAuth credentials separate from the CLI's long-lived
// API keys. MCP clients get short-lived, scoped access tokens plus rotating
// refresh tokens, and can be pinned to one live Moshcode session.
import crypto from "node:crypto";
import { all, get, run } from "../db.mjs";
import { config } from "../config.mjs";
import { id, sha256, token } from "./crypto.mjs";

export const MCP_RESOURCE = `${config.origin}/mcp`;
export const MCP_SHARE_SCOPES = ["sessions:read", "sessions:write", "sessions:approve", "sessions:cancel"];
export const MCP_SCOPES = [...MCP_SHARE_SCOPES, "sessions:control"];
export const ACCESS_TTL_MS = config.mcp.accessTtlMs;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const DEVICE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const mcpShareResource = (shareId) => `${config.mcp.origin}/api/v1/mcp/${encodeURIComponent(shareId)}`;
export const mcpShareMetadata = (shareId) =>
  `${config.mcp.origin}/.well-known/oauth-protected-resource/api/v1/mcp/${encodeURIComponent(shareId)}`;

export function mcpShareIdFromResource(resource) {
  try {
    const url = new URL(String(resource || ""));
    if (url.origin !== new URL(config.mcp.origin).origin || url.search || url.hash) return null;
    const match = /^\/api\/v1\/mcp\/([^/]+)$/.exec(url.pathname);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export async function activeMcpShare(shareId, userId = null) {
  const args = [String(shareId || ""), Date.now()];
  let sql = `SELECT sh.*, s.name AS session_name, s.status AS session_status,
                    s.last_seen_at, s.cwd, s.engine, s.features
               FROM mcp_shares sh JOIN cli_sessions s ON s.id=sh.session_id
              WHERE sh.id=? AND sh.user_id=s.user_id AND sh.status='active' AND sh.expires_at>?`;
  if (userId) {
    sql += " AND sh.user_id=?";
    args.push(userId);
  }
  return get(sql, args);
}

export async function shareForResource(resource, userId = null) {
  const shareId = mcpShareIdFromResource(resource);
  return shareId && resource === mcpShareResource(shareId) ? activeMcpShare(shareId, userId) : null;
}

function shareScopes(share) {
  return new Set(String(share?.scopes || "").split(/\s+/).filter(Boolean));
}

export function normalizeScopes(value, { fallback = ["sessions:read"] } = {}) {
  const requested = String(value ?? "").trim()
    ? String(value).trim().split(/\s+/)
    : [...fallback];
  const set = new Set(requested.filter((scope) => MCP_SCOPES.includes(scope)));
  // Controlling a session without being able to identify/read it is not useful,
  // so make the implication explicit rather than returning a half-working token.
  if (["sessions:control", "sessions:write", "sessions:approve", "sessions:cancel"].some((scope) => set.has(scope))) set.add("sessions:read");
  return MCP_SCOPES.filter((scope) => set.has(scope));
}

export const hasScope = (auth, scope) => {
  const scopes = new Set(String(auth?.scope || "").split(/\s+/).filter(Boolean));
  return scopes.has(scope) || (auth?.resource === MCP_RESOURCE && scopes.has("sessions:control"));
};

export function validRedirectUri(raw, applicationType = "web") {
  try {
    const url = new URL(String(raw || ""));
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    // Native clients are allowed to bounce through an ephemeral local listener.
    return applicationType === "native" && url.protocol === "http:" && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

export async function registerOAuthClient(metadata = {}) {
  if (metadata.token_endpoint_auth_method && metadata.token_endpoint_auth_method !== "none") throw new Error("only public clients with token_endpoint_auth_method=none are supported");
  const applicationType = metadata.application_type === "native" ? "native" : "web";
  const redirectUris = Array.isArray(metadata.redirect_uris)
    ? [...new Set(metadata.redirect_uris.map(String))].slice(0, 20)
    : [];
  if (!redirectUris.length || redirectUris.some((uri) => !validRedirectUri(uri, applicationType))) {
    throw new Error("invalid redirect_uris");
  }
  const clientId = `mcp_${id()}`;
  const row = {
    client_id: clientId,
    client_name: String(metadata.client_name || "MCP client").slice(0, 120),
    redirect_uris: JSON.stringify(redirectUris),
    application_type: applicationType,
    client_uri: metadata.client_uri ? String(metadata.client_uri).slice(0, 500) : null,
    created_at: Date.now(),
  };
  await run(
    `INSERT INTO mcp_oauth_clients
      (client_id,client_name,redirect_uris,application_type,client_uri,created_at)
     VALUES (?,?,?,?,?,?)`,
    [row.client_id, row.client_name, row.redirect_uris, row.application_type, row.client_uri, row.created_at]
  );
  return { ...row, redirect_uris: redirectUris };
}

export async function oauthClient(clientId) {
  if (!clientId) return null;
  const row = await get(`SELECT * FROM mcp_oauth_clients WHERE client_id = ?`, [String(clientId)]);
  if (!row) return null;
  try {
    row.redirect_uris = JSON.parse(row.redirect_uris || "[]");
  } catch {
    row.redirect_uris = [];
  }
  return row;
}

export async function validateAuthorizationRequest(params = {}) {
  if (params.response_type !== "code") throw new Error("unsupported response_type");
  const client = await oauthClient(params.client_id);
  if (!client) throw new Error("unknown client_id");
  const redirectUri = String(params.redirect_uri || "");
  if (!client.redirect_uris.includes(redirectUri)) throw new Error("redirect_uri mismatch");
  if (params.code_challenge_method !== "S256") throw new Error("PKCE S256 is required");
  const challenge = String(params.code_challenge || "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Error("invalid code_challenge");
  const resource = String(params.resource || MCP_RESOURCE);
  const share = resource === MCP_RESOURCE ? null : await shareForResource(resource);
  if (resource !== MCP_RESOURCE && !share) throw new Error("invalid or expired resource");
  const rawScopes = String(params.scope || "").trim().split(/\s+/).filter(Boolean);
  const unknownScopes = rawScopes.filter((scope) => !MCP_SCOPES.includes(scope));
  if (unknownScopes.length) throw new Error(`unsupported scope: ${unknownScopes.join(" ")}`);
  if (share && rawScopes.includes("sessions:control")) throw new Error("Use separate sessions:write, sessions:approve and sessions:cancel scopes for session shares.");
  const scopes = normalizeScopes(params.scope);
  if (!scopes.length) throw new Error("no supported scopes requested");
  if (share && scopes.some((scope) => !shareScopes(share).has(scope))) {
    throw new Error("requested scope is not allowed by this session share");
  }
  return {
    client,
    clientId: client.client_id,
    redirectUri,
    resource,
    scopes,
    scope: scopes.join(" "),
    state: params.state == null ? "" : String(params.state),
    codeChallenge: challenge,
    share,
  };
}

export async function createAuthorizationCode({
  userId,
  clientId,
  redirectUri,
  scope,
  resource = MCP_RESOURCE,
  sessionId = null,
  codeChallenge,
}) {
  const raw = `mcc_${token(32)}`;
  const now = Date.now();
  await run(
    `INSERT INTO mcp_oauth_codes
      (code_hash,user_id,client_id,redirect_uri,scope,resource,session_id,code_challenge,created_at,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [sha256(raw), userId, clientId, redirectUri, scope, resource, sessionId, codeChallenge, now, now + CODE_TTL_MS]
  );
  return raw;
}

export function pkceChallenge(verifier) {
  return Buffer.from(sha256(String(verifier || "")), "hex").toString("base64url");
}

export async function exchangeAuthorizationCode({
  code,
  clientId,
  redirectUri,
  verifier,
  resource = MCP_RESOURCE,
}) {
  const hash = sha256(String(code || ""));
  const row = await get(
    `SELECT * FROM mcp_oauth_codes WHERE code_hash = ? AND expires_at > ?`,
    [hash, Date.now()]
  );
  if (!row) throw new Error("invalid or expired authorization code");
  if (row.client_id !== String(clientId || "")) throw new Error("client_id mismatch");
  if (row.redirect_uri !== String(redirectUri || "")) throw new Error("redirect_uri mismatch");
  if (row.resource !== String(resource || MCP_RESOURCE)) throw new Error("resource mismatch");
  const v = String(verifier || "");
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(v) || pkceChallenge(v) !== row.code_challenge) {
    throw new Error("PKCE verification failed");
  }

  // The delete is the replay lock. Exactly one concurrent exchange can consume
  // this code; everyone else loses the race and mints nothing.
  const consumed = await run(`DELETE FROM mcp_oauth_codes WHERE code_hash = ?`, [hash]);
  if (!consumed.rowsAffected) throw new Error("authorization code already used");
  return issueTokenPair(row);
}

async function activeGrantSource(source) {
  if (source.resource === MCP_RESOURCE) {
    if (!(await userOwnsSession(source.user_id, source.session_id))) throw new Error("session no longer belongs to this account");
    return null;
  }
  const share = await shareForResource(source.resource, source.user_id);
  if (!share || share.session_id !== source.session_id ||
      String(source.scope).split(/\s+/).some((scope) => !shareScopes(share).has(scope))) {
    throw new Error("session share is expired, revoked, or no longer permits this grant");
  }
  return share;
}

export async function issueTokenPair(source) {
  const share = await activeGrantSource(source);
  const now = Date.now();
  const family = source.family_id || id();
  await run(`INSERT OR IGNORE INTO mcp_oauth_grants (id,created_at) VALUES (?,?)`, [family, now]);
  const grant = await get(`SELECT revoked_at FROM mcp_oauth_grants WHERE id=?`, [family]);
  if (!grant || grant.revoked_at != null) throw new Error("authorization grant was revoked");
  const access = `mca_${token(32)}`;
  const refresh = `mcr_${token(40)}`;
  const accessExpiry = Math.min(now + ACCESS_TTL_MS, share ? Number(share.expires_at) : Infinity);
  const refreshExpiry = Math.min(now + REFRESH_TTL_MS, share ? Number(share.expires_at) : Infinity);
  for (const [raw, kind, expires] of [[access, "access", accessExpiry], [refresh, "refresh", refreshExpiry]]) {
    await run(
      `INSERT INTO mcp_oauth_tokens
        (token_hash,token_type,user_id,client_id,scope,resource,session_id,created_at,expires_at,revoked_at,family_id)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,?)`,
      [sha256(raw), kind, source.user_id, source.client_id, source.scope, source.resource,
        source.session_id || null, now, expires, family]
    );
  }
  return { access_token: access, token_type: "Bearer", expires_in: Math.max(0, Math.floor((accessExpiry - now) / 1000)),
    refresh_token: refresh, scope: source.scope };
}

async function revokeTokenFamily(family) {
  await run(`UPDATE mcp_oauth_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?`, [Date.now(), family]);
  await run(`UPDATE mcp_oauth_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE family_id=?`, [Date.now(), family]);
}

export async function rotateRefreshToken({ refreshToken, clientId, resource = MCP_RESOURCE, scope }) {
  const hash = sha256(String(refreshToken || ""));
  const row = await get(`SELECT * FROM mcp_oauth_tokens WHERE token_hash=? AND token_type='refresh'`, [hash]);
  if (!row || row.client_id !== String(clientId || "") || row.resource !== String(resource || "")) {
    throw new Error("invalid refresh_token or resource mismatch");
  }
  if (row.revoked_at != null) {
    // A consumed refresh token is evidence of replay. Kill its replacements,
    // including a replacement being inserted concurrently with this request.
    await revokeTokenFamily(row.family_id);
    throw new Error("refresh_token already used; authorization grant revoked");
  }
  if (Number(row.expires_at) <= Date.now()) throw new Error("invalid or expired refresh_token");
  await activeGrantSource(row);
  if (scope !== undefined && String(scope) !== row.scope) throw new Error("refresh scope must match the original grant");
  const revoked = await run(
    `UPDATE mcp_oauth_tokens SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL`, [Date.now(), hash]
  );
  if (!revoked.rowsAffected) {
    await revokeTokenFamily(row.family_id);
    throw new Error("refresh_token already used; authorization grant revoked");
  }
  return issueTokenPair(row);
}

export async function revokeOAuthToken({ rawToken, clientId }) {
  const row = await get(`SELECT family_id FROM mcp_oauth_tokens WHERE token_hash=? AND client_id=?`,
    [sha256(String(rawToken || "")), String(clientId || "")]);
  if (row) await revokeTokenFamily(row.family_id);
}

export function bearerToken(req) {
  const header = String(req.get?.("authorization") || req.headers?.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

export async function accessForToken(raw, resource = MCP_RESOURCE) {
  if (!raw) return null;
  return get(
    `SELECT t.* FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.id=t.family_id
      WHERE t.token_hash=? AND t.token_type='access' AND t.revoked_at IS NULL
        AND g.revoked_at IS NULL AND t.expires_at > ? AND t.resource = ?`,
    [sha256(raw), Date.now(), resource]
  );
}

async function validMcpOrigin(req, auth) {
  const origin = req.get?.("origin");
  if (!origin) return true; // Non-browser MCP clients do not send Origin.
  const client = await oauthClient(auth.client_id);
  const allowed = new Set([config.origin, config.mcp.origin,
    ...(client?.redirect_uris || []).map((uri) => new URL(uri).origin)]);
  return allowed.has(origin);
}

/** Public machine endpoints never use browser cookies as authorization. */
export function mcpCors(req, res, next) {
  if (!/^\/(?:\.well-known\/oauth-|oauth\/(?:token|register|device_authorization|revoke)$|mcp$|api\/v1\/mcp(?:\/|$))/.test(req.path)) return next();
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Protocol-Version");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name");
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

export async function requireMcpAccess(req, res, next) {
  const auth = await accessForToken(bearerToken(req));
  if (!auth) {
    const metadata = `${config.origin}/.well-known/oauth-protected-resource/mcp`;
    res.set("WWW-Authenticate", `Bearer resource_metadata="${metadata}"`);
    return res.status(401).json({ error: "invalid_token" });
  }
  if (!(await validMcpOrigin(req, auth))) return res.status(403).json({ error: "invalid_origin" });
  req.mcpAuth = auth;
  next();
}

export async function requireMcpShareAccess(req, res, next) {
  const share = await activeMcpShare(req.params.shareId);
  const resource = mcpShareResource(req.params.shareId);
  const auth = share ? await accessForToken(bearerToken(req), resource) : null;
  if (!share || !auth || auth.user_id !== share.user_id || auth.session_id !== share.session_id ||
      String(auth.scope).split(/\s+/).some((scope) => !shareScopes(share).has(scope))) {
    res.set("WWW-Authenticate", `Bearer resource_metadata="${mcpShareMetadata(req.params.shareId)}"`);
    return res.status(401).json({ error: "invalid_token" });
  }
  if (!(await validMcpOrigin(req, auth))) return res.status(403).json({ error: "invalid_origin" });
  await run(`UPDATE mcp_shares SET last_used_at=? WHERE id=?`, [Date.now(), share.id]);
  req.mcpAuth = auth;
  req.mcpShare = share;
  next();
}

export function scopeChallenge(res, scope, resource = MCP_RESOURCE) {
  const shareId = mcpShareIdFromResource(resource);
  const metadata = shareId ? mcpShareMetadata(shareId) : `${config.origin}/.well-known/oauth-protected-resource/mcp`;
  res.set(
    "WWW-Authenticate",
    `Bearer resource_metadata="${metadata}", error="insufficient_scope", scope="${scope}"`
  );
}

function userCode() {
  let value = "";
  for (let index = 0; index < 8; index++) value += DEVICE_ALPHABET[crypto.randomInt(DEVICE_ALPHABET.length)];
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

export async function createMcpDeviceAuthorization({ clientId, resource, scope }) {
  const client = await oauthClient(clientId);
  const share = await shareForResource(resource);
  if (!client || !share) throw new Error("invalid client_id or session resource");
  const rawScopes = String(scope || "").trim().split(/\s+/).filter(Boolean);
  if (rawScopes.some((value) => !MCP_SHARE_SCOPES.includes(value))) throw new Error("unsupported scope; use sessions:read/write/approve/cancel for a session share");
  const scopes = normalizeScopes(scope);
  if (!scopes.length || scopes.some((value) => !shareScopes(share).has(value))) {
    throw new Error("requested scope is not allowed by this session share");
  }

  const deviceCode = `mcd_${token(32)}`;
  let shortCode = userCode();
  for (let attempt = 0; attempt < 3 && await get(`SELECT 1 FROM device_codes WHERE user_code=?`, [shortCode]); attempt++) {
    shortCode = userCode();
  }
  const now = Date.now();
  const ttlMs = Math.min(10 * 60 * 1000, Number(share.expires_at) - now);
  await run(
    `INSERT INTO device_codes
      (device_code,user_code,status,name,interval_s,created_at,expires_at,kind,client_id,share_id,resource,scope)
     VALUES (?,?,?,?,?,?,?,'mcp',?,?,?,?)`,
    [sha256(deviceCode), shortCode, "pending", client.client_name, 5, now, Math.min(now + ttlMs, Number(share.expires_at)),
      client.client_id, share.id, resource, scopes.join(" ")]
  );
  return { deviceCode, userCode: shortCode, interval: 5, expiresIn: Math.floor(ttlMs / 1000) };
}

function grantError(code, message) {
  return Object.assign(new Error(message), { oauthError: code });
}

export async function exchangeMcpDeviceCode({ deviceCode, clientId, resource }) {
  const row = await get(`SELECT * FROM device_codes WHERE device_code=? AND kind='mcp'`, [sha256(String(deviceCode || ""))]);
  if (!row || row.client_id !== String(clientId || "") || Number(row.expires_at) <= Date.now()) {
    throw grantError("expired_token", "device code is invalid or expired");
  }
  if (row.resource !== String(resource || "")) throw grantError("invalid_grant", "resource mismatch");
  const currentShare = await activeMcpShare(row.share_id);
  if (!currentShare) throw grantError("invalid_grant", "session share is expired or revoked");
  if (["pending", "approved"].includes(row.status)) {
    const now = Date.now();
    const last = Number(row.last_polled_at || 0);
    const fast = last > 0 && now - last < Number(row.interval_s) * 1000;
    const poll = await run(`UPDATE device_codes SET last_polled_at=?, interval_s=interval_s+?
      WHERE device_code=? AND COALESCE(last_polled_at,0)=?`, [now, fast ? 5 : 0, row.device_code, last]);
    if (fast || !poll.rowsAffected) throw grantError("slow_down", "poll less frequently; increase the interval by five seconds");
  }
  if (row.status === "pending") throw grantError("authorization_pending", "authorization is still pending");
  if (row.status === "denied") throw grantError("access_denied", "authorization was denied");
  if (row.status !== "approved" || !row.user_id) throw grantError("expired_token", "device code is no longer valid");
  const share = await activeMcpShare(row.share_id, row.user_id);
  if (!share) throw grantError("invalid_grant", "session share is expired, revoked, or belongs to another account");
  const claimed = await run(
    `UPDATE device_codes SET status='claimed' WHERE device_code=? AND kind='mcp' AND status='approved'`,
    [row.device_code]
  );
  if (!claimed.rowsAffected) throw grantError("expired_token", "device code was already used");
  return issueTokenPair({
    user_id: row.user_id,
    client_id: row.client_id,
    scope: row.scope,
    resource: row.resource,
    session_id: share.session_id,
  });
}

export async function sessionsForAuthorization(userId) {
  return all(
    `SELECT id,name,host,cwd,engine,status,last_seen_at
       FROM cli_sessions WHERE user_id=? ORDER BY last_seen_at DESC LIMIT 50`,
    [userId]
  );
}

export async function userOwnsSession(userId, sessionId) {
  if (!sessionId) return true;
  return Boolean(await get(`SELECT id FROM cli_sessions WHERE id=? AND user_id=?`, [sessionId, userId]));
}
