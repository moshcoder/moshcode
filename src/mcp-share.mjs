import { loadCreds, loginDevice } from "./auth.mjs";

const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

export function parseMcpTtl(value) {
  if (value == null || value === "") return undefined;
  const match = /^(\d+)(s|m|h|d)?$/i.exec(String(value).trim());
  if (!match) throw new Error("--ttl must be seconds or a duration like 30m, 8h, or 2d");
  const amount = Number(match[1]);
  const units = { s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = amount * units[(match[2] || "s").toLowerCase()];
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > MAX_TTL_SECONDS) {
    throw new Error("--ttl must be between 60 seconds and 7 days");
  }
  return seconds;
}

async function credentialsFor({ credentials, login = loginDevice } = {}) {
  let creds = credentials === undefined ? loadCreds() : credentials;
  if (!creds?.token) {
    const result = await login();
    creds = result?.token ? result : loadCreds();
  }
  if (!creds?.token) throw new Error("device authorization completed without storing Moshcode credentials");
  return creds;
}

async function request(path, { method = "GET", body, fetchImpl = fetch, ...options } = {}) {
  const creds = await credentialsFor(options);
  const api = String(creds.api || process.env.MOSHCODE_API || "https://app.moshcode.sh").replace(/\/+$/, "");
  const response = await fetchImpl(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${creds.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Moshcode returned ${response.status}`);
  return data;
}

export async function connectMcp({ login = loginDevice, credentials } = {}) {
  const result = await login();
  return result?.token ? result : (credentials === undefined ? loadCreds() : credentials);
}

export function createMcpShare({ sessionId, name, scope, ttl, ...options } = {}) {
  if (!sessionId) throw new Error("no live session is available — run this as /mcp answer inside moshcode");
  return request("/api/v1/mcp/shares", {
    ...options,
    method: "POST",
    body: {
      session_id: sessionId,
      ...(name ? { name } : {}),
      ...(scope ? { scope } : {}),
      ...(ttl === undefined ? {} : { ttl_seconds: parseMcpTtl(ttl) }),
    },
  });
}

export function listMcpShares(options = {}) {
  return request("/api/v1/mcp/shares", options);
}

export function revokeMcpShare(shareId, options = {}) {
  if (!shareId) throw new Error("mcp revoke requires a share id");
  return request(`/api/v1/mcp/shares/${encodeURIComponent(shareId)}`, { ...options, method: "DELETE" });
}
