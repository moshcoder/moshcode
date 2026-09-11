// Remote Model Context Protocol endpoint for live Moshcode sessions.
//
// The transport supports the current 2026-07-28 stateless lifecycle and the
// 2025 handshake-era lifecycle used by older clients. Application state is
// explicit: every operation that touches a terminal carries a Moshcode
// session_id; the MCP transport itself never invents a server-side MCP session.
import { Router } from "express";
import { all, get, run } from "../db.mjs";
import { id } from "../lib/crypto.mjs";
import {
  hasScope,
  requireMcpAccess,
  scopeChallenge,
} from "../lib/mcp-auth.mjs";

export const mcpRouter = Router();

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "moshcode", title: "Moshcode", version: "0.1.0" };
const STALE_MS = 90 * 1000;
const KEY_PREFIX = "\u001bmoshkey:";
const KEY_NAMES = new Set(["up", "down", "left", "right", "enter"]);

const isLive = (row) =>
  row?.status === "live" && Date.now() - Number(row.last_seen_at) < STALE_MS;

const toBool = (value, fallback = false) =>
  value == null ? fallback : value === true || String(value).toLowerCase() === "true";

const capInt = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isSafeInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function features(row) {
  try { return JSON.parse(row.features || "[]"); } catch { return []; }
}

async function sessionFor(auth, sessionId) {
  const sid = String(sessionId || "");
  if (!sid) throw new Error("session_id is required");
  if (auth.session_id && auth.session_id !== sid) throw new Error("this token is bound to a different session");
  const row = await get(`SELECT * FROM cli_sessions WHERE id=? AND user_id=?`, [sid, auth.user_id]);
  if (!row) throw new Error("no such session");
  return row;
}

function sessionView(row) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    version: row.version,
    cwd: row.cwd,
    engine: row.engine,
    status: isLive(row) ? "live" : "offline",
    last_seen_at: Number(row.last_seen_at),
    cols: row.cols == null ? null : Number(row.cols),
    rows: row.rows == null ? null : Number(row.rows),
    features: features(row),
  };
}

async function listSessions(auth, args = {}) {
  const includeOffline = toBool(args.include_offline, true);
  const limit = capInt(args.limit, 20, 1, 50);
  const params = [auth.user_id];
  let where = "user_id=?";
  if (auth.session_id) {
    where += " AND id=?";
    params.push(auth.session_id);
  }
  params.push(limit);
  const rows = await all(
    `SELECT * FROM cli_sessions WHERE ${where} ORDER BY last_seen_at DESC LIMIT ?`,
    params
  );
  return {
    sessions: rows.map(sessionView).filter((s) => includeOffline || s.status === "live"),
    token_bound_session_id: auth.session_id || null,
  };
}

async function readSession(auth, args = {}) {
  const row = await sessionFor(auth, args.session_id);
  const after = capInt(args.after_seq, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = capInt(args.limit, 200, 1, 400);
  const chunks = await all(
    `SELECT seq,chunk,created_at FROM session_output
       WHERE session_id=? AND seq>? ORDER BY seq ASC LIMIT ?`,
    [row.id, after, limit]
  );
  const output = chunks.map((item) => ({
    seq: Number(item.seq),
    chunk: String(item.chunk),
    created_at: Number(item.created_at),
  }));
  return {
    session: sessionView(row),
    after_seq: after,
    next_seq: output.length ? output[output.length - 1].seq : after,
    output,
    text: output.map((item) => item.chunk).join(""),
  };
}

function splitCommands(text) {
  return String(text ?? "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith(KEY_PREFIX))
    .slice(0, 50)
    .map((line) => line.slice(0, 500));
}

async function sendSession(auth, args = {}) {
  const row = await sessionFor(auth, args.session_id);
  if (!isLive(row)) throw new Error("session is offline");
  const lines = splitCommands(args.text);
  if (!lines.length) throw new Error("text must contain at least one command");
  const now = Date.now();
  const commands = [];
  for (const [index, body] of lines.entries()) {
    const commandId = id();
    await run(
      `INSERT INTO session_commands (id,session_id,body,status,created_at)
       VALUES (?,?,?,'queued',?)`,
      [commandId, row.id, body, now + index]
    );
    commands.push({ id: commandId, body });
  }
  return {
    ok: true,
    session_id: row.id,
    queued: commands,
    note: "Commands are queued for the live CLI. Delivery follows the CLI session long-poll window.",
  };
}

async function pressSessionKey(auth, args = {}) {
  const row = await sessionFor(auth, args.session_id);
  if (!isLive(row)) throw new Error("session is offline");
  const key = String(args.key || "").toLowerCase();
  if (!KEY_NAMES.has(key)) throw new Error("key must be up, down, left, right, or enter");
  if (!features(row).includes("keys")) throw new Error("this Moshcode session does not advertise remote key support");
  const commandId = id();
  await run(
    `INSERT INTO session_commands (id,session_id,body,status,created_at)
     VALUES (?,?,?,'queued',?)`,
    [commandId, row.id, KEY_PREFIX + key, Date.now()]
  );
  return { ok: true, session_id: row.id, command_id: commandId, key };
}

const TOOL_DEFS = [
  {
    name: "moshcode_sessions_list",
    title: "List Moshcode sessions",
    description: "List the authenticated user's mirrored Moshcode CLI sessions. A token may be restricted to one session.",
    inputSchema: {
      type: "object",
      properties: {
        include_offline: { type: "boolean", description: "Include stale or ended sessions. Defaults to true." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum sessions to return." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    requiredScope: "sessions:read",
  },
  {
    name: "moshcode_session_read",
    title: "Read Moshcode session output",
    description: "Read sequenced terminal scrollback from a Moshcode session. Pass after_seq from the previous result to fetch only new output.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Moshcode session id." },
        after_seq: { type: "integer", minimum: 0, description: "Only return output with seq greater than this value." },
        limit: { type: "integer", minimum: 1, maximum: 400, description: "Maximum output chunks to return." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    requiredScope: "sessions:read",
  },
  {
    name: "moshcode_session_send",
    title: "Send command to Moshcode",
    description: "Queue one command or a short newline-separated command block into a live Moshcode prompt. This changes the remote development session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Live Moshcode session id." },
        text: { type: "string", minLength: 1, maxLength: 25000, description: "Command text. New lines are queued in order." },
      },
      required: ["session_id", "text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    requiredScope: "sessions:control",
  },
  {
    name: "moshcode_session_key",
    title: "Press a Moshcode navigation key",
    description: "Queue one supported key press into a live Moshcode session. Useful for interactive prompts exposed by the Moshcode terminal mirror.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Live Moshcode session id." },
        key: { type: "string", enum: ["up", "down", "left", "right", "enter"] },
      },
      required: ["session_id", "key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    requiredScope: "sessions:control",
  },
];

export function toolsFor(auth) {
  return TOOL_DEFS
    .filter((tool) => hasScope(auth, tool.requiredScope))
    .map(({ requiredScope, ...tool }) => tool);
}

async function invokeTool(auth, name, args) {
  const def = TOOL_DEFS.find((tool) => tool.name === name);
  if (!def) throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 });
  if (!hasScope(auth, def.requiredScope)) {
    throw Object.assign(new Error(`scope ${def.requiredScope} is required`), {
      code: -32003,
      requiredScope: def.requiredScope,
    });
  }
  if (name === "moshcode_sessions_list") return listSessions(auth, args);
  if (name === "moshcode_session_read") return readSession(auth, args);
  if (name === "moshcode_session_send") return sendSession(auth, args);
  if (name === "moshcode_session_key") return pressSessionKey(auth, args);
  throw Object.assign(new Error(`unimplemented tool: ${name}`), { code: -32601 });
}

const serverMeta = () => ({ "io.modelcontextprotocol/serverInfo": SERVER_INFO });

function modernResult(payload, { cache = false } = {}) {
  return {
    ...payload,
    resultType: "complete",
    ...(cache ? { ttlMs: 0, cacheScope: "private" } : {}),
    _meta: { ...(payload?._meta || {}), ...serverMeta() },
  };
}

function toolResult(data, modern) {
  const result = {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
  return modern ? modernResult(result) : result;
}

function jsonRpcError(idValue, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: idValue ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function versionFor(req, body) {
  const header = String(req.get("mcp-protocol-version") || "");
  const meta = body?.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  return header || (meta ? String(meta) : "");
}

function headerMismatch(message) {
  return Object.assign(new Error(message), { code: -32020, httpStatus: 400 });
}

function validateModernHeaders(req, body) {
  const protocol = String(req.get("mcp-protocol-version") || "");
  if (protocol !== MODERN_VERSION) throw headerMismatch("MCP-Protocol-Version header is required and must match 2026-07-28");
  const method = String(req.get("mcp-method") || "");
  if (!method) throw headerMismatch("Mcp-Method header is required for MCP 2026-07-28");
  if (method !== body.method) throw headerMismatch("Mcp-Method header does not match JSON-RPC method");
  if (body.method === "tools/call") {
    const name = String(req.get("mcp-name") || "");
    if (!name) throw headerMismatch("Mcp-Name header is required for tools/call");
    if (name !== String(body.params?.name || "")) {
      throw headerMismatch("Mcp-Name header does not match tool name");
    }
  }
}

async function dispatch(req, auth, body) {
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    throw Object.assign(new Error("invalid JSON-RPC request"), { code: -32600 });
  }
  const version = versionFor(req, body);
  const modern = version === MODERN_VERSION;

  if (modern) validateModernHeaders(req, body);

  if (body.method === "server/discover") {
    if (!modern) throw Object.assign(new Error("server/discover requires MCP 2026-07-28"), { code: -32601 });
    return modernResult({
      supportedVersions: [MODERN_VERSION],
      capabilities: { tools: { listChanged: false } },
      instructions: "Use moshcode_sessions_list to find a session, moshcode_session_read with after_seq to observe it, and control tools only when the user intended the remote session to change.",
    }, { cache: true });
  }

  if (body.method === "initialize") {
    const requested = String(body.params?.protocolVersion || "");
    const negotiated = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
    return {
      protocolVersion: negotiated,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: "Use the session list/read tools for context before sending commands to a live Moshcode session.",
    };
  }

  if (body.method === "ping") return modern ? modernResult({}) : {};

  if (body.method === "tools/list") {
    const result = { tools: toolsFor(auth) };
    return modern ? modernResult(result, { cache: true }) : result;
  }

  if (body.method === "tools/call") {
    const name = String(body.params?.name || "");
    try {
      return toolResult(await invokeTool(auth, name, body.params?.arguments || {}), modern);
    } catch (error) {
      if (error.requiredScope || Number.isInteger(error.code)) throw error;
      return {
        ...(modern ? modernResult({}) : {}),
        content: [{ type: "text", text: error.message || "tool call failed" }],
        isError: true,
      };
    }
  }

  throw Object.assign(new Error(`method not found: ${body.method}`), { code: -32601 });
}

mcpRouter.get("/mcp", (_req, res) => {
  res.set("Allow", "POST");
  res.status(405).json({ error: "Moshcode MCP uses stateless HTTP POST." });
});

mcpRouter.post("/mcp", requireMcpAccess, async (req, res) => {
  const body = req.body;
  // initialized is a JSON-RPC notification in legacy clients and has no response.
  if (body?.method === "notifications/initialized" && body?.id === undefined) {
    return res.status(202).end();
  }

  try {
    const result = await dispatch(req, req.mcpAuth, body);
    // A notification has no JSON-RPC response.
    if (body?.id === undefined) return res.status(202).end();
    res.set("Cache-Control", "no-store");
    return res.json({ jsonrpc: "2.0", id: body.id, result });
  } catch (error) {
    if (error.requiredScope) {
      scopeChallenge(res, error.requiredScope);
      res.status(403);
    }
    const status = error.httpStatus || (res.statusCode >= 400 ? res.statusCode : 200);
    return res.status(status).json(jsonRpcError(
      body?.id,
      Number.isInteger(error.code) ? error.code : -32603,
      error.message || "internal error"
    ));
  }
});

export const __test = {
  splitCommands,
  sessionView,
  versionFor,
  modernResult,
  jsonRpcError,
};
