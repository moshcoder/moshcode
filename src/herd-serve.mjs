// `moshcode herd serve` — the herd, over A2A v0.3.0 (PRD 0011 R9–R10).
//
// PRD 0009 took herdr's thesis — "the CLI and socket API are one surface agents
// drive" — and implemented it locally. A2A is that same thesis standardised
// across machines, and the mapping is not an integration to design so much as a
// translation table to write down:
//
//     herd prompt   → message/send          blocked → input-required
//     state / wait  → tasks/get (poll)      working → working
//     kill          → tasks/cancel          done    → completed
//     ps / roster   → agent-card discovery  killed  → canceled
//
// This is not a second API. It is the existing one answering a socket: every
// method here lands on the same herd verbs a person types, and mints the same
// ledger tasks (R5) that `herd tasks` reads back.
//
// SCOPE, deliberately small. v0.3.0, JSON-RPC, text parts. Streaming, push
// notifications and authenticated extended cards are declared *off* in the
// card's capability flags, which is what those flags are for. That is the same
// MVP surface the ADK itself ships, and a spec upgrade is its own PRD.
//
// SECURITY. `message/send` is keystrokes into a real pty, which is strictly
// more dangerous than a browser terminal — a terminal at least shows you what
// it is doing. So this reuses src/console.mjs's discipline wholesale: bind
// loopback by default, verify a moshcode token against app.moshcode.sh once,
// swap it for a short-lived HMAC credential, refuse unauthenticated requests
// before they reach anything, and warn loudly past loopback. There is no
// unauthenticated mode. Loopback included: every process on this box, and
// anything that can talk one of them into making a request, is on the other
// side of "loopback is safe".
import crypto from "node:crypto";
import http from "node:http";

import { loadCreds } from "./auth.mjs";
import { mintCookie, readCookie, verifyToken } from "./console.mjs";
import { capture, readManifest, sendKeys, sendPrompt } from "./herd.mjs";
import { roster } from "./herd-cli.mjs";
import { endTask, findTask, ledgerSessions, readTasks, screenDelta, startTask, TERMINAL_STATES } from "./herd-tasks.mjs";
import { moshcodeVersion } from "./ui.mjs";

export const A2A_PROTOCOL_VERSION = "0.3.0";
export const DEFAULT_SERVE_PORT = 7683;

/** The herd's states, as A2A says them. */
export const HERD_TO_A2A = {
  working: "working",
  blocked: "input-required",
  done: "completed",
  // A2A's vocabulary is smaller than ours, and this is where that costs
  // something. `idle` and `unknown` are both "not asking for anything and not
  // obviously finished", and the only two candidates are `working` and
  // `input-required`. Rounding *up* to input-required would page a human for a
  // session that has nothing to say, every time, so they round down and the
  // honest state travels in the task's metadata.
  idle: "working",
  unknown: "working",
  gone: "failed",
};

export const a2aState = (state) => HERD_TO_A2A[state] || "working";

/* --------------------------------------------------------------- JSON-RPC */

export const RPC_ERRORS = {
  parse: { code: -32700, message: "Invalid JSON payload" },
  invalidRequest: { code: -32600, message: "Invalid JSON-RPC request" },
  methodNotFound: { code: -32601, message: "Method not found" },
  invalidParams: { code: -32602, message: "Invalid parameters" },
  internal: { code: -32603, message: "Internal error" },
  // A2A's own range.
  taskNotFound: { code: -32001, message: "Task not found" },
  taskNotCancelable: { code: -32002, message: "Task cannot be canceled" },
};

const rpcOk = (id, result) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcErr = (id, error, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { ...error, ...(data ? { data } : {}) } });

/* ------------------------------------------------------------------- cards */

/**
 * A session is exposed unless it was launched autonomously.
 *
 * An engine running with its approvals bypassed, plus a network endpoint that
 * accepts prompts, is the worst pairing on the menu: prompt injection reaching
 * an agent that has already been told not to ask. So `--agent` sessions are off
 * the protocol surface unless someone says otherwise out loud.
 */
export function exposable(session, { exposeAutonomous = false } = {}) {
  if (session.kind === "remote") return false; // a remote is someone else's to serve
  if (!exposeAutonomous && session.agent) return false;
  return true;
}

/** The roster, filtered to what this server will admit exists. */
export function servedSessions({ exposeAutonomous = false, rows = roster() } = {}) {
  const manifest = readManifest().sessions;
  return rows
    .map((row) => ({ ...row, agent: Boolean(manifest[row.name]?.agent) }))
    .filter((row) => exposable(row, { exposeAutonomous }));
}

const SECURITY = {
  securitySchemes: { moshcode: { type: "http", scheme: "bearer", description: "a moshcode login token, or a credential from POST /auth" } },
  security: [{ moshcode: [] }],
};

const CAPABILITIES = {
  // Every one of these is false because it is false, not because it is
  // unfinished — see the scope note at the top. A card that claimed streaming
  // would be a client hanging on a stream that never opens.
  streaming: false,
  pushNotifications: false,
  stateTransitionHistory: true,
};

/** The card for one session. */
export function sessionCard(session, { base }) {
  const url = `${String(base).replace(/\/+$/, "")}/${session.name}/`;
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: `${session.name} (${session.engine})`,
    description: `A moshcode herd session running ${session.engine}${session.cwd ? ` in ${session.cwd}` : ""}.`,
    url,
    preferredTransport: "JSONRPC",
    version: moshcodeVersion() || "0.0.0",
    capabilities: CAPABILITIES,
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{
      id: "prompt",
      name: "prompt",
      description: `Type a prompt into ${session.name} and collect what it produces.`,
      tags: ["herd", "terminal", String(session.engine)],
      examples: ["port the auth routes", "run the tests and summarise the failures"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
    }],
    supportsAuthenticatedExtendedCard: false,
    ...SECURITY,
    metadata: {
      "sh.moshcode.herd": {
        session: session.name, engine: session.engine, state: session.state,
        authority: session.authority, cwd: session.cwd,
      },
    },
  };
}

/**
 * The card for the herd itself: one skill per member.
 *
 * Both shapes are published rather than one, because they answer different
 * questions. The herd card is discovery — "what is on this box" — and the
 * per-session cards are what a client stores when it wants to talk to one
 * member for a week. It also makes `herd remote add` of somebody else's single
 * session symmetric with adding a whole herd.
 */
export function herdCard(sessions, { base }) {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: "moshcode herd",
    description: "Agent sessions running on this machine. Each member is addressable at /<name>/ with its own card.",
    url: `${String(base).replace(/\/+$/, "")}/`,
    preferredTransport: "JSONRPC",
    version: moshcodeVersion() || "0.0.0",
    capabilities: CAPABILITIES,
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: sessions.map((s) => ({
      id: s.name,
      name: s.name,
      description: `${s.engine} — currently ${s.state}${s.cwd ? ` — ${s.cwd}` : ""}. Address it at /${s.name}/.`,
      tags: ["herd", String(s.engine), String(s.state)],
    })),
    supportsAuthenticatedExtendedCard: false,
    ...SECURITY,
  };
}

/* ------------------------------------------------------------------ tasks */

const iso = (ts) => new Date(Number(ts) || Date.now()).toISOString();

const textMessage = (text, { role = "agent", taskId, contextId } = {}) => ({
  kind: "message",
  role,
  messageId: crypto.randomUUID(),
  parts: [{ kind: "text", text: String(text ?? "") }],
  ...(taskId ? { taskId } : {}),
  ...(contextId ? { contextId } : {}),
});

/**
 * A ledger task as an A2A Task.
 *
 * `live` is the session's state right now, which outranks the ledger's last
 * transition for an open task: the ledger is written by whatever last polled,
 * and a client asking tasks/get IS a poll.
 */
export function taskToA2a(task, { live = null } = {}) {
  const herdState = task.status === "closed" ? (task.state || "done") : (live || task.state || "working");
  // A FINISHED task is `completed`, whatever the session went back to being.
  // The idle→working rounding above is about a *session* — "it is sitting
  // there, it is not asking for anything" — and applying it to a task that has
  // an outcome and an artifact would leave an A2A client polling a job that
  // finished ten minutes ago. The one exception is a task that ended by
  // stopping to ask, which is `input-required` in any vocabulary.
  const state = task.status === "closed"
    ? (herdState === "blocked" ? "input-required" : "completed")
    : a2aState(herdState);
  return {
    kind: "task",
    id: task.id,
    contextId: task.session,
    status: {
      state,
      timestamp: iso(task.endedAt || task.transitions.at(-1)?.ts || task.submitted),
      ...(task.artifact ? { message: textMessage(task.artifact, { taskId: task.id, contextId: task.session }) } : {}),
    },
    history: [textMessage(task.text, { role: "user", taskId: task.id, contextId: task.session })],
    artifacts: task.artifact
      ? [{
        artifactId: `${task.id}-output`,
        name: "screen",
        description: "What appeared on the session's screen after the prompt was submitted.",
        parts: [{ kind: "text", text: task.artifact }],
      }]
      : [],
    metadata: {
      // Where the vocabulary mismatch goes to stay honest.
      "sh.moshcode.herd": {
        session: task.session,
        state: herdState,
        status: task.status,
        submitted: task.submitted,
        endedAt: task.endedAt,
        durationMs: task.durationMs,
        truncated: Boolean(task.truncated),
        transitions: task.transitions,
      },
    },
  };
}

/* ------------------------------------------------------------------- auth */

/**
 * Who is allowed in.
 *
 * Two accepted credentials, in this order: an HMAC credential this process
 * minted (cheap, local, expires), or a moshcode login token (verified against
 * the app, then cached for the same window so a polling client does not become
 * a load test on app.moshcode.sh).
 */
export function createAuth({
  api = "https://app.moshcode.sh",
  secret = crypto.randomBytes(32).toString("hex"),
  verify = verifyToken,
  ttlMs = 12 * 60 * 60 * 1000,
} = {}) {
  const verified = new Map(); // sha256(token) → { user, until }

  const hash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

  return {
    secret,
    mint: (user) => mintCookie(secret, { user, ttlMs }),
    async check(token, { now = Date.now() } = {}) {
      if (!token) return null;
      const local = readCookie(secret, token, now);
      if (local) return local;
      const key = hash(token);
      const cached = verified.get(key);
      if (cached && cached.until > now) return cached.user;
      const user = await verify(api, token);
      if (!user) { verified.delete(key); return null; }
      verified.set(key, { user, until: now + Math.min(ttlMs, 15 * 60 * 1000) });
      return user;
    },
  };
}

/** The bearer token on a request, if there is one. */
export function bearer(req) {
  const header = req?.headers?.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : "";
}

/* ----------------------------------------------------------------- server */

const send = (res, status, body) => {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
};

function readBody(req, { limit = 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      // A prompt is text. Anything past a megabyte is not a prompt, and reading
      // it into memory to find that out is the whole attack.
      if (size > limit) { resolve({ tooLarge: true, text: "" }); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve({ tooLarge: false, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => resolve({ tooLarge: false, text: "" }));
  });
}

/**
 * The herd's A2A server.
 *
 * Routing, in full:
 *   GET  /.well-known/agent-card.json          the herd
 *   GET  /<name>/.well-known/agent-card.json   one member
 *   POST /auth                                 token → short-lived credential
 *   POST /<name>/                              message/send, tasks/get, tasks/cancel
 *   POST /                                     tasks/get, tasks/cancel (ids are herd-wide)
 */
export function createHerdServer({
  api = "https://app.moshcode.sh",
  auth = createAuth({ api }),
  exposeAutonomous = false,
  base = `http://127.0.0.1:${DEFAULT_SERVE_PORT}`,
  sessions = () => servedSessions({ exposeAutonomous }),
  prompt = defaultPrompt,
  interrupt = defaultInterrupt,
  screen = capture,
  now = () => Date.now(),
} = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);

    // Auth first, before routing — a 404 that only unauthenticated callers can
    // see is a way to ask which session names exist.
    const user = await auth.check(bearer(req));
    if (!user) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="moshcode herd"' });
      res.end(JSON.stringify({ error: "not authenticated", how: "Authorization: Bearer <moshcode token> — run `moshcode login` on the calling machine" }, null, 2));
      return;
    }

    if (req.method === "POST" && segments.length === 1 && segments[0] === "auth") {
      // The token that got here is already verified; this hands back something
      // shorter-lived to use instead, so the real token stops travelling.
      return send(res, 200, { credential: auth.mint(user), expiresIn: 12 * 60 * 60 });
    }

    const cardAt = segments.indexOf(".well-known");
    if (req.method === "GET" && cardAt >= 0 && segments[cardAt + 1] === "agent-card.json") {
      const rows = sessions();
      if (cardAt === 0) return send(res, 200, herdCard(rows, { base }));
      const found = rows.find((s) => s.name === segments[0]);
      if (!found) return send(res, 404, { error: `no member named ${JSON.stringify(segments[0])}` });
      return send(res, 200, sessionCard(found, { base }));
    }

    if (req.method !== "POST") {
      return send(res, 405, { error: "the A2A surface is POST for JSON-RPC and GET for agent cards" });
    }

    const body = await readBody(req);
    if (body.tooLarge) return send(res, 413, rpcErr(null, RPC_ERRORS.invalidParams, "payload too large"));
    let payload;
    try { payload = JSON.parse(body.text); }
    catch { return send(res, 400, rpcErr(null, RPC_ERRORS.parse)); }
    if (!payload || payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
      return send(res, 400, rpcErr(payload?.id, RPC_ERRORS.invalidRequest));
    }

    const member = segments.length && segments[0] !== "auth" ? segments[0] : null;
    const answer = await handleRpc(payload, {
      member, sessions, prompt, interrupt, screen, now,
    });
    // 200 even for an error: in JSON-RPC the transport succeeded and the error
    // is the payload. A 4xx here would have clients retrying a method name.
    return send(res, 200, answer);
  });

  server.on("clientError", (_error, socket) => {
    try { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch { /* already gone */ }
  });

  return server;
}

/**
 * Type a prompt into a live session.
 *
 * The one place the protocol becomes keystrokes. Everything above this is
 * routing and everything below it is the engine's business. Injectable so the
 * tests exercise the whole surface without a pty anywhere near them.
 */
function defaultPrompt(name, text) {
  return sendPrompt(name, text);
}

/**
 * Interrupt whatever a session is doing: Escape, then Ctrl-C.
 *
 * The same escalation `kill` uses, stopping one rung short of it on purpose. An
 * A2A task is a unit of work inside a member, and a member is a long-lived
 * thing somebody attached to five minutes ago — cancelling their task must not
 * take their session with it. Ending a member is `moshcode kill`, which is a
 * decision, not a protocol call.
 */
function defaultInterrupt(name) {
  const first = sendKeys(name, ["Escape"]);
  const second = sendKeys(name, ["C-c"]);
  return { ok: Boolean(first.ok || second.ok) };
}

/** The JSON-RPC methods, with no HTTP anywhere near them. */
export async function handleRpc(payload, { member, sessions, prompt, interrupt, screen, now = () => Date.now() }) {
  const { id, method, params } = payload;
  const rows = sessions();

  if (method === "message/send") {
    if (!member) return rpcErr(id, RPC_ERRORS.invalidParams, "address a member: POST /<name>/");
    const session = rows.find((s) => s.name === member);
    if (!session) return rpcErr(id, RPC_ERRORS.invalidParams, `no member named ${JSON.stringify(member)}`);
    if (!session.alive || session.exited) return rpcErr(id, RPC_ERRORS.invalidParams, `${member} is not running`);
    const text = messageText(params?.message);
    if (!text) return rpcErr(id, RPC_ERRORS.invalidParams, "the message needs a text part");

    const at = now();
    const baseline = screen(member, { lines: 60 });
    const taskId = startTask(member, text, { screen: baseline, now: at, state: session.state });
    const sent = prompt(member, text);
    if (!sent?.ok) {
      endTask(member, taskId, { state: "done", artifact: `moshcode could not type into ${member}: ${sent?.error?.message || "unknown error"}`, ts: now() });
      return rpcErr(id, RPC_ERRORS.internal, String(sent?.error?.message || "could not reach the session"));
    }
    // Returned before the engine has answered, on purpose: A2A's task model
    // exists so a client polls rather than holding a socket open for the half
    // hour an agent might take.
    const task = readTasks(member).find((t) => t.id === taskId);
    return rpcOk(id, taskToA2a(task || {
      id: taskId, session: member, text, submitted: at, transitions: [], status: "open", state: "working", artifact: null,
    }, { live: "working" }));
  }

  if (method === "tasks/get") {
    const found = locateTask(params?.id, { member, rows });
    if (!found) return rpcErr(id, RPC_ERRORS.taskNotFound);
    // A poll IS an observation, so it closes a task whose session has stopped.
    // Without this the only thing that ever finishes a task is the watcher, and
    // an A2A client — whose entire protocol is send-then-poll — would sit on
    // `working` forever against a herd where nobody happened to run one.
    const task = reconcileTask(found.task, found.session, { screen, now });
    return rpcOk(id, taskToA2a(task, { live: found.session?.state || null }));
  }

  if (method === "tasks/cancel") {
    const found = locateTask(params?.id, { member, rows });
    if (!found) return rpcErr(id, RPC_ERRORS.taskNotFound);
    if (found.task.status === "closed") return rpcErr(id, RPC_ERRORS.taskNotCancelable, "that task has already finished");
    const stopped = interrupt(found.task.session);
    const artifact = screenDelta(found.task.baseline, screen(found.task.session, { lines: 200 }));
    endTask(found.task.session, found.task.id, { state: "done", artifact, ts: now() });
    const task = { ...found.task, status: "closed", state: "done", artifact, endedAt: now() };
    const cancelled = taskToA2a(task);
    cancelled.status.state = "canceled";
    cancelled.metadata["sh.moshcode.herd"].interrupted = Boolean(stopped?.ok);
    return rpcOk(id, cancelled);
  }

  return rpcErr(id, RPC_ERRORS.methodNotFound, method);
}

/**
 * Close an open task whose session has already stopped, and hand back what the
 * task now is. Leaves a task alone while its session is still working.
 */
function reconcileTask(task, session, { screen, now }) {
  if (task.status === "closed" || !session) return task;
  if (!TERMINAL_STATES.includes(session.state)) return task;
  const artifact = screenDelta(task.baseline, screen(task.session, { lines: 400 }));
  const at = now();
  endTask(task.session, task.id, { state: session.state, artifact, ts: at });
  return { ...task, status: "closed", state: session.state, artifact, endedAt: at, durationMs: task.submitted ? at - task.submitted : null };
}

/** Ids are herd-wide, so a task can be found with or without its member. */
function locateTask(taskId, { member, rows }) {
  if (!taskId) return null;
  const search = member ? [member] : ledgerSessions();
  const task = findTask(String(taskId), { sessions: search });
  if (!task) return null;
  // A task in a member this server does not expose does not exist here either.
  const session = rows.find((s) => s.name === task.session);
  if (!session) return null;
  return { task, session };
}

/** The text of an A2A message. Text parts only — see the scope note. */
export function messageText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .filter((p) => p?.kind === "text" || typeof p?.text === "string")
    .map((p) => String(p.text ?? ""))
    .join("\n")
    .trim();
}

/** The credentials `herd serve` needs to verify anyone at all. */
export function serveCredentials() {
  const creds = loadCreds();
  return { api: creds?.api || "https://app.moshcode.sh", token: creds?.token || "" };
}
