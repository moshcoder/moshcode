// Remote herd members — the roster stops at the edge of the box (PRD 0011 R11–R12).
//
// A deployed agent — a DigitalOcean Gradient ADK deployment answering at
// `agents.do-ai.run/<workspace>/<deployment>/run`, say — could not be on the
// roster, and nothing off the box could drive the herd. That is a strange place
// for the herd to stop, because the ecosystem already converged on the shape we
// need: A2A v0.3.0 gives an agent a card at a well-known URL, tasks with ids and
// status history, and a state vocabulary whose `input-required` is our
// `blocked` under another name.
//
// TWO KINDS, because half the deployed agents in the world do not speak A2A:
//
//   "a2a"  — discovery at /.well-known/agent-card.json, then JSON-RPC:
//            message/send, tasks/get, tasks/cancel. State comes from the task.
//
//   "run"  — a bare request/response endpoint: POST {"prompt": …}, get an
//            answer. The shape every `gradient agent deploy` prints. It has no
//            task model and no state, so the herd says so: it is `idle` when it
//            answers, `working` while a call is in flight, and honest about
//            knowing nothing else.
//
// AUTH IS NEVER WRITTEN DOWN. The token for a remote comes from the environment
// (MOSHCODE_REMOTE_<NAME>_TOKEN) and never touches the manifest, which is
// PRD 0010's allowlist reasoning verbatim: settings sync exists, the manifest is
// on the list of things that can be synced, and a bearer token for someone
// else's agent is exactly the thing that must not ride along to another machine.
import { forgetSession, readManifest, recordRemoteStatus, rememberSession, remoteStatus, validName, clearRemoteStatus } from "./herd.mjs";

// The status cache lives in herd.mjs so herd-state.mjs can read it without
// importing this module (and, with it, the network). Re-exported under a name
// that says whose status it is, for callers that already have this module.
export { remoteStatus as remoteStatusOf } from "./herd.mjs";

/** How a remote is driven. */
export const REMOTE_KINDS = ["a2a", "run"];

/** A2A's task states, and what the herd calls each one. */
export const A2A_TO_HERD = {
  submitted: "working",
  working: "working",
  "input-required": "blocked",
  "auth-required": "blocked",
  completed: "done",
  // A2A's three ways of stopping without an answer all leave the agent not
  // working and not asking, which is `done` in a vocabulary that has no word
  // for "gave up". The A2A state travels alongside in the cache so `--json`
  // never has to round-trip through our smaller set to find out what happened.
  canceled: "done",
  rejected: "done",
  failed: "done",
  unknown: "unknown",
};

/** The herd state for an A2A task state. */
export const herdStateFor = (a2a) => A2A_TO_HERD[String(a2a || "").toLowerCase()] || "unknown";

/**
 * The environment variable holding this remote's bearer token.
 *
 * Named per member rather than one shared secret, because two remotes are
 * routinely two different people's infrastructure.
 */
export const tokenEnvVar = (name) => `MOSHCODE_REMOTE_${String(name).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;

export function remoteToken(name, env = process.env) {
  return env[tokenEnvVar(name)] || "";
}

/**
 * Only http(s), and only an absolute URL.
 *
 * `herd prompt` on a remote is a POST of user text to whatever this says, so
 * the one thing that must not be possible is a scheme that means something
 * other than "a request over the network".
 */
export function parseRemoteUrl(raw) {
  let url;
  try { url = new URL(String(raw)); }
  catch { return { ok: false, error: new Error(`${JSON.stringify(String(raw))} is not a URL`) }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: new Error(`${url.protocol} is not a transport the herd speaks — use http or https`) };
  }
  return { ok: true, url: url.toString() };
}

/** Every remote member on the roster. */
export function listRemotes() {
  return Object.entries(readManifest().sessions)
    .filter(([, meta]) => meta?.kind === "remote")
    .map(([name, meta]) => ({ name, ...meta, status: remoteStatus(name) }));
}

export function isRemote(name) {
  return readManifest().sessions[name]?.kind === "remote";
}

export function remoteEntry(name) {
  const meta = readManifest().sessions[name];
  return meta?.kind === "remote" ? { name, ...meta } : null;
}

/** Register a remote. Nothing is contacted here — `ping` is the verb for that. */
export function addRemote(name, url, { kind = "run", now = Date.now() } = {}) {
  if (!validName(name)) return { ok: false, error: new Error(`invalid member name ${JSON.stringify(name)}`) };
  if (!REMOTE_KINDS.includes(kind)) return { ok: false, error: new Error(`unknown kind ${JSON.stringify(kind)} — one of ${REMOTE_KINDS.join(", ")}`) };
  const parsed = parseRemoteUrl(url);
  if (!parsed.ok) return parsed;
  if (readManifest().sessions[name] && !isRemote(name)) {
    return { ok: false, error: new Error(`"${name}" is already a local session — pick another name`) };
  }
  rememberSession(name, {
    kind: "remote", remoteKind: kind, url: parsed.url,
    engine: "remote", cwd: new URL(parsed.url).host, created: now, herd: "main",
  });
  return { ok: true, name, url: parsed.url, kind };
}

export function removeRemote(name) {
  if (!isRemote(name)) return { ok: false, error: new Error(`no remote member named ${JSON.stringify(name)}`) };
  clearRemoteStatus(name);
  forgetSession(name);
  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// Talking to one
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30000;

function authHeaders(name, env) {
  const token = remoteToken(name, env);
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request(url, { method = "GET", body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
      ...(body ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not every endpoint answers JSON */ }
    return { ok: res.ok, status: res.status, text, json };
  } catch (error) {
    return { ok: false, status: 0, error, text: "", json: null };
  }
}

const trimSlash = (u) => String(u).replace(/\/+$/, "");

/** Where an A2A agent publishes its card. */
export const cardUrl = (url) => `${trimSlash(url)}/.well-known/agent-card.json`;

/** Fetch and lightly validate an agent card. */
export async function discoverCard(name, { url = remoteEntry(name)?.url, env = process.env, fetchImpl = fetch } = {}) {
  if (!url) return { ok: false, error: new Error(`no remote member named ${JSON.stringify(name)}`) };
  const res = await request(cardUrl(url), { headers: authHeaders(name, env), fetchImpl });
  if (!res.ok || !res.json) {
    return { ok: false, status: res.status, error: res.error || new Error(`no agent card at ${cardUrl(url)} (${res.status || "unreachable"})`) };
  }
  return { ok: true, card: res.json };
}

/** One JSON-RPC call against an A2A endpoint. */
export async function rpc(name, method, params, { url = remoteEntry(name)?.url, env = process.env, fetchImpl = fetch, timeoutMs } = {}) {
  if (!url) return { ok: false, error: new Error(`no remote member named ${JSON.stringify(name)}`) };
  const res = await request(trimSlash(url), {
    method: "POST",
    headers: authHeaders(name, env),
    // The id is per-call and never reused; nothing here multiplexes.
    body: { jsonrpc: "2.0", id: `${Date.now()}`, method, params },
    fetchImpl, timeoutMs,
  });
  if (!res.json) return { ok: false, status: res.status, error: res.error || new Error(`${method}: ${res.status || "unreachable"}`) };
  if (res.json.error) return { ok: false, status: res.status, error: new Error(`${method}: ${res.json.error.message || "error"} (${res.json.error.code})`), rpcError: res.json.error };
  return { ok: true, result: res.json.result };
}

/** The text parts of an A2A message or artifact, joined. */
export function partsText(container) {
  const parts = Array.isArray(container?.parts) ? container.parts : [];
  return parts.filter((p) => p?.kind === "text" || typeof p?.text === "string").map((p) => String(p.text ?? "")).join("\n").trim();
}

/** Everything the herd wants out of an A2A Task object. */
export function readA2aTask(task) {
  const a2aState = task?.status?.state || "unknown";
  const artifact = [
    ...(Array.isArray(task?.artifacts) ? task.artifacts.map(partsText) : []),
    partsText(task?.status?.message),
  ].filter(Boolean).join("\n\n");
  return { taskId: task?.id || null, contextId: task?.contextId || null, a2aState, state: herdStateFor(a2aState), artifact };
}

/**
 * Hand work to a remote member.
 *
 * Both kinds record what they learned in the status cache, because that cache
 * is what `moshcode ps` reads — a remote that has just been prompted should not
 * still show whatever it was doing an hour ago.
 */
export async function promptRemote(name, text, { env = process.env, fetchImpl = fetch, timeoutMs, now = Date.now() } = {}) {
  const entry = remoteEntry(name);
  if (!entry) return { ok: false, error: new Error(`no remote member named ${JSON.stringify(name)}`) };
  recordRemoteStatus(name, { state: "working", at: now, kind: entry.remoteKind, note: "request in flight" });

  if (entry.remoteKind === "a2a") {
    const sent = await rpc(name, "message/send", {
      message: {
        kind: "message",
        role: "user",
        messageId: `m-${now}`,
        parts: [{ kind: "text", text: String(text) }],
      },
    }, { env, fetchImpl, timeoutMs });
    if (!sent.ok) {
      recordRemoteStatus(name, { state: "unknown", at: Date.now(), kind: entry.remoteKind, error: String(sent.error?.message || sent.error) });
      return sent;
    }
    // message/send may answer with a Task or with a Message. A Message means
    // the agent answered in one shot and there is nothing to poll.
    const result = sent.result;
    if (result?.kind === "message" || (!result?.status && result?.parts)) {
      const artifact = partsText(result);
      recordRemoteStatus(name, { state: "idle", at: Date.now(), kind: entry.remoteKind, artifact, a2aState: "completed" });
      return { ok: true, taskId: null, state: "done", artifact };
    }
    const task = readA2aTask(result);
    recordRemoteStatus(name, { ...task, at: Date.now(), kind: entry.remoteKind });
    return { ok: true, ...task };
  }

  // "run": one request, one answer, no task model to consult.
  const res = await request(trimSlash(entry.url), {
    method: "POST", headers: authHeaders(name, env), body: { prompt: String(text) }, fetchImpl, timeoutMs,
  });
  if (!res.ok) {
    recordRemoteStatus(name, { state: "unknown", at: Date.now(), kind: "run", error: String(res.error?.message || `HTTP ${res.status}`) });
    return { ok: false, status: res.status, error: res.error || new Error(`HTTP ${res.status}`) };
  }
  const artifact = runAnswer(res.json, res.text);
  recordRemoteStatus(name, { state: "idle", at: Date.now(), kind: "run", artifact });
  return { ok: true, taskId: null, state: "done", artifact };
}

/**
 * The answer inside a bare `run` response.
 *
 * No standard says what key it is under, so this checks the ones the ADK and
 * its neighbours actually use and falls back to the raw body. Returning the
 * whole JSON when nothing matches beats returning "" and calling it an answer.
 */
export function runAnswer(json, text = "") {
  if (json && typeof json === "object") {
    for (const key of ["output", "response", "result", "answer", "text", "message", "content"]) {
      const value = json[key];
      if (typeof value === "string" && value.trim()) return value;
      if (value && typeof value === "object") {
        const nested = partsText(value) || (typeof value.text === "string" ? value.text : "");
        if (nested.trim()) return nested;
      }
    }
    return JSON.stringify(json, null, 2);
  }
  return String(text || "");
}

/** Refresh what we know about a remote without giving it work. */
export async function pingRemote(name, { env = process.env, fetchImpl = fetch, timeoutMs = 8000, now = Date.now() } = {}) {
  const entry = remoteEntry(name);
  if (!entry) return { ok: false, error: new Error(`no remote member named ${JSON.stringify(name)}`) };

  if (entry.remoteKind === "a2a") {
    const cached = remoteStatus(name);
    // A live task outranks the card: "what is it doing" is a better answer than
    // "it is up", and only tasks/get can give it.
    if (cached?.taskId) {
      const got = await rpc(name, "tasks/get", { id: cached.taskId }, { env, fetchImpl, timeoutMs });
      if (got.ok) {
        const task = readA2aTask(got.result);
        recordRemoteStatus(name, { ...task, at: now, kind: "a2a" });
        return { ok: true, ...task };
      }
    }
    const card = await discoverCard(name, { env, fetchImpl });
    if (!card.ok) {
      recordRemoteStatus(name, { state: "unknown", at: now, kind: "a2a", error: String(card.error?.message || card.error) });
      return card;
    }
    recordRemoteStatus(name, { state: "idle", at: now, kind: "a2a", card: { name: card.card?.name, version: card.card?.version } });
    return { ok: true, state: "idle", card: card.card };
  }

  // A request/response endpoint is `idle` when it is up. There is no third
  // thing to know about it and we do not invent one.
  const res = await request(trimSlash(entry.url), { method: "GET", headers: authHeaders(name, env), timeoutMs, fetchImpl });
  const reachable = res.ok || (res.status >= 200 && res.status < 500);
  recordRemoteStatus(name, {
    state: reachable ? "idle" : "unknown", at: now, kind: "run",
    ...(reachable ? {} : { error: String(res.error?.message || `HTTP ${res.status}`) }),
  });
  return reachable ? { ok: true, state: "idle" } : { ok: false, status: res.status, error: res.error || new Error(`HTTP ${res.status}`) };
}

/** What a remote last produced — what `herd read` shows for one. */
export function readRemote(name) {
  const status = remoteStatus(name);
  return status?.artifact ? String(status.artifact) : "";
}

/**
 * Block until a remote reaches one of `states`.
 *
 * For `run` members this returns as soon as the in-flight call has landed,
 * because a request/response endpoint has no state to move through: the answer
 * IS the transition.
 */
export async function waitRemote(name, states, {
  timeoutMs = 30 * 60 * 1000, intervalMs = 2000, env = process.env, fetchImpl = fetch,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const entry = remoteEntry(name);
  if (!entry) return { outcome: "gone", state: "gone" };
  const wanted = new Set(states);
  const deadline = now() + timeoutMs;
  for (;;) {
    const status = remoteStatus(name);
    if (entry.remoteKind !== "a2a") {
      const state = status?.state || "unknown";
      if (wanted.has(state)) return { outcome: "matched", state };
      if (state !== "working") return { outcome: "ended", state };
    } else {
      const refreshed = await pingRemote(name, { env, fetchImpl });
      const state = refreshed?.state || status?.state || "unknown";
      if (wanted.has(state)) return { outcome: "matched", state, a2aState: refreshed?.a2aState };
      if (state === "done") return { outcome: "ended", state };
    }
    if (now() >= deadline) return { outcome: "timeout", state: remoteStatus(name)?.state || "unknown" };
    await sleep(intervalMs);
  }
}

/**
 * Stop whatever a remote is doing. Best effort by design: A2A says an agent may
 * refuse to cancel a task it has already finished, and a `run` endpoint has
 * nothing to cancel at all — the request either lands or it does not.
 */
export async function cancelRemote(name, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const entry = remoteEntry(name);
  if (!entry) return { ok: false, error: new Error(`no remote member named ${JSON.stringify(name)}`) };
  if (entry.remoteKind !== "a2a") {
    return { ok: false, error: new Error(`${name} is a request/response endpoint — there is nothing to cancel`) };
  }
  const cached = remoteStatus(name);
  if (!cached?.taskId) return { ok: false, error: new Error(`${name} has no task to cancel`) };
  const cancelled = await rpc(name, "tasks/cancel", { id: cached.taskId }, { env, fetchImpl });
  if (!cancelled.ok) return cancelled;
  const task = readA2aTask(cancelled.result);
  recordRemoteStatus(name, { ...task, at: now, kind: "a2a" });
  return { ok: true, ...task };
}
