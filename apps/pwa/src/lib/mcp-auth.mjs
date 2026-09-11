// OAuth 2.1-style bearer tokens for the remote Moshcode MCP resource.
//
// This deliberately keeps OAuth credentials separate from the CLI's long-lived
// API keys. MCP clients get short-lived, scoped access tokens plus rotating
// refresh tokens, and can be pinned to one live Moshcode session.
import { all, get, run } from "../db.mjs";
import { config } from "../config.mjs";
import { id, sha256, token } from "./crypto.mjs";

export const MCP_RESOURCE = `${config.origin}/mcp`;
export const MCP_SCOPES = ["sessions:read", "sessions:control"];
export const ACCESS_TTL_MS = 4 * 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function normalizeScopes(value, { fallback = ["sessions:read"] } = {}) {
  const requested = String(value ?? "").trim()
    ? String(value).trim().split(/\s+/)
    : [...fallback];
  const set = new Set(requested.filter((scope) => MCP_SCOPES.includes(scope)));
  // Controlling a session without being able to identify/read it is not useful,
  // so make the implication explicit rather than returning a half-working token.
  if (set.has("sessions:control")) set.add("sessions:read");
  return MCP_SCOPES.filter((scope) => set.has(scope));
}

export const hasScope = (auth, scope) =>
  new Set(String(auth?.scope || "").split(/\s+/).filter(Boolean)).has(scope);

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
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw new Error("invalid code_challenge");
  const resource = String(params.resource || MCP_RESOURCE);
  if (resource !== MCP_RESOURCE) throw new Error("invalid resource");
  const rawScopes = String(params.scope || "").trim().split(/\s+/).filter(Boolean);
  const unknownScopes = rawScopes.filter((scope) => !MCP_SCOPES.includes(scope));
  if (unknownScopes.length) throw new Error(`unsupported scope: ${unknownScopes.join(" ")}`);
  const scopes = normalizeScopes(params.scope);
  if (!scopes.length) throw new Error("no supported scopes requested");
  return {
    client,
    clientId: client.client_id,
    redirectUri,
    resource,
    scopes,
    scope: scopes.join(" "),
    state: params.state == null ? "" : String(params.state),
    codeChallenge: challenge,
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

async function issueTokenPair(source) {
  const now = Date.now();
  const access = `mca_${token(32)}`;
  const refresh = `mcr_${token(40)}`;
  await run(
    `INSERT INTO mcp_oauth_tokens
      (token_hash,token_type,user_id,client_id,scope,resource,session_id,created_at,expires_at,revoked_at)
     VALUES (?,?,?,?,?,?,?,?,?,NULL)`,
    [sha256(access), "access", source.user_id, source.client_id, source.scope, source.resource,
      source.session_id || null, now, now + ACCESS_TTL_MS]
  );
  await run(
    `INSERT INTO mcp_oauth_tokens
      (token_hash,token_type,user_id,client_id,scope,resource,session_id,created_at,expires_at,revoked_at)
     VALUES (?,?,?,?,?,?,?,?,?,NULL)`,
    [sha256(refresh), "refresh", source.user_id, source.client_id, source.scope, source.resource,
      source.session_id || null, now, now + REFRESH_TTL_MS]
  );
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
    scope: source.scope,
  };
}

export async function rotateRefreshToken({ refreshToken, clientId }) {
  const hash = sha256(String(refreshToken || ""));
  const row = await get(
    `SELECT * FROM mcp_oauth_tokens
      WHERE token_hash=? AND token_type='refresh' AND revoked_at IS NULL AND expires_at > ?`,
    [hash, Date.now()]
  );
  if (!row || row.client_id !== String(clientId || "")) throw new Error("invalid refresh_token");
  const revoked = await run(
    `UPDATE mcp_oauth_tokens SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL`,
    [Date.now(), hash]
  );
  if (!revoked.rowsAffected) throw new Error("refresh_token already used");
  return issueTokenPair(row);
}

export function bearerToken(req) {
  const header = String(req.get?.("authorization") || req.headers?.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

export async function accessForToken(raw) {
  if (!raw) return null;
  return get(
    `SELECT * FROM mcp_oauth_tokens
      WHERE token_hash=? AND token_type='access' AND revoked_at IS NULL
        AND expires_at > ? AND resource = ?`,
    [sha256(raw), Date.now(), MCP_RESOURCE]
  );
}

export async function requireMcpAccess(req, res, next) {
  const auth = await accessForToken(bearerToken(req));
  if (!auth) {
    const metadata = `${config.origin}/.well-known/oauth-protected-resource/mcp`;
    res.set("WWW-Authenticate", `Bearer resource_metadata="${metadata}"`);
    return res.status(401).json({ error: "invalid_token" });
  }
  req.mcpAuth = auth;
  next();
}

export function scopeChallenge(res, scope) {
  const metadata = `${config.origin}/.well-known/oauth-protected-resource/mcp`;
  res.set(
    "WWW-Authenticate",
    `Bearer resource_metadata="${metadata}", error="insufficient_scope", scope="${scope}"`
  );
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
