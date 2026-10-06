// `moshcode hooks serve` — the fan-out prompt runner.
//
// A signed webhook comes in carrying one prompt; that prompt runs once on every
// available engine, in parallel, and each answer goes back to the caller as a
// signed webhook of its own, then one more to say the run is over. Signing and
// delivery are @profullstack/webhooks (Standard Webhooks headers, CloudEvents
// bodies), so the caller verifies us the same way we verify it, with the same
// shared secret (MOSHCODE_HOOKS_SECRET).
//
//   POST /hooks     moshcode.prompt.requested.v1  → 202 { run_id, engines, skipped }
//   GET  /engines   { engines: [{ name, kind, available, reason? }] }   (unsigned)
//   GET  /healthz   { ok, version, running }
//
// Outbound, per engine:  moshcode.prompt.result.v1
//   { run_id, engine, kind, ok, output, error, exit_code, ms, model, truncated }
// and once at the end:   moshcode.prompt.completed.v1
//   { run_id, total, ok, failed, ms }
//
// What a prompt from the network is allowed to do is the whole design here:
// every CLI engine runs in plain print mode (no yolo, no skip-permissions; see
// src/oneshot.mjs), in a fresh empty directory deleted afterwards, under a hard
// deadline that kills its process tree, with its output capped at 64 KB.
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { resolveAnyEngine } from "./engines.mjs";
import { DEFAULT_MAX_OUTPUT, oneShotEngines, runOneShot } from "./oneshot.mjs";

export const REQUEST_TYPE = "moshcode.prompt.requested.v1";
export const RESULT_TYPE = "moshcode.prompt.result.v1";
export const COMPLETED_TYPE = "moshcode.prompt.completed.v1";
export const EVENT_SOURCE = "urn:moshcode:hooks";
export const MAX_PROMPT_CHARS = 20_000;
export const MAX_BODY_BYTES = 256 * 1024;
export const DEFAULTS = { port: 7690, host: "127.0.0.1", concurrency: 4, timeout: 180 };

const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "host.docker.internal"]);

/** https anywhere; plain http only to this machine (or the docker host). */
export function callbackAllowed(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return false; }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOCAL_HTTP_HOSTS.has(url.hostname.toLowerCase());
}

/**
 * Check a verified CloudEvent and turn it into a run plan, or an error.
 * Pure: `available` is the engine roster (oneShotEngines()) to plan against.
 * → { ok: true, run } | { ok: false, status, error }
 */
export function validateRequest(event, { available, maxTimeout = DEFAULTS.timeout } = {}) {
  const bad = (error, status = 400) => ({ ok: false, status, error });
  if (!event || typeof event !== "object" || Array.isArray(event)) return bad("body must be a CloudEvent object");
  if (event.type !== REQUEST_TYPE) return bad(`type must be ${REQUEST_TYPE}`);
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return bad("data must be an object");
  const { run_id: runId, prompt, engines, timeout_s: timeoutS, callback_url: callbackUrl } = data;
  if (typeof runId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(runId)) return bad("data.run_id must be 1-128 chars of [A-Za-z0-9._:-]");
  if (typeof prompt !== "string" || !prompt.trim()) return bad("data.prompt must be a non-empty string");
  if (prompt.length > MAX_PROMPT_CHARS) return bad(`data.prompt is longer than ${MAX_PROMPT_CHARS} characters`, 413);
  if (typeof callbackUrl !== "string" || !callbackAllowed(callbackUrl)) {
    return bad("data.callback_url must be https (http only to localhost, 127.0.0.1 or host.docker.internal)");
  }
  let timeout = maxTimeout;
  if (timeoutS !== undefined && timeoutS !== null) {
    if (typeof timeoutS !== "number" || !Number.isFinite(timeoutS) || timeoutS <= 0) return bad("data.timeout_s must be a positive number");
    timeout = Math.min(timeoutS, maxTimeout);
  }

  const roster = new Map((available || []).map((e) => [e.name, e]));
  const skipped = [];
  let names;
  if (engines === undefined || engines === null) {
    names = [...roster.values()].filter((e) => e.available).map((e) => e.name);
  } else {
    if (!Array.isArray(engines) || !engines.length || engines.length > 64 || !engines.every((e) => typeof e === "string")) {
      return bad("data.engines must be a non-empty array of engine names");
    }
    names = [];
    for (const raw of engines) {
      const found = resolveAnyEngine(raw);
      if (!found) return bad(`unknown engine "${raw}"`);
      if (names.includes(found.key)) continue;
      const entry = roster.get(found.key);
      if (entry?.available) names.push(found.key);
      else skipped.push({ name: found.key, reason: entry?.reason || "not available" });
    }
  }
  if (!names.length) return bad("no requested engine is available here", 422);
  return { ok: true, run: { runId, prompt, engines: names, skipped, timeoutMs: Math.round(timeout * 1000), callbackUrl } };
}

/** A counting semaphore: at most `n` tasks hold it at once. */
export function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

/**
 * Run a planned request: every engine through the limiter, each in its own
 * empty temp dir, one result event per engine, then the completed event.
 * `deps` is the seam the tests use: runOne, send, createEvent, tmpRoot, log.
 */
export async function executeRun(run, {
  runOne = runOneShot,
  send,
  createEvent,
  limit = limiter(DEFAULTS.concurrency),
  tmpRoot = os.tmpdir(),
  maxBytes = DEFAULT_MAX_OUTPUT,
  log = () => {},
  env = process.env,
} = {}) {
  const started = Date.now();
  const deliver = async (type, data) => {
    const event = createEvent(type, data, { source: EVENT_SOURCE, subject: `run:${run.runId}` });
    try {
      const r = await send(run.callbackUrl, event);
      if (!r?.ok) log(`✗ ${type} ${data.engine || ""} → ${run.callbackUrl}: ${r?.error || `HTTP ${r?.status}`}`);
      return r;
    } catch (e) {
      log(`✗ ${type} → ${run.callbackUrl}: ${e.message}`);
      return { ok: false, error: e.message };
    }
  };

  const results = await Promise.all(run.engines.map((engine) => limit(async () => {
    let dir = null;
    let r;
    try {
      dir = await mkdtemp(path.join(tmpRoot, "moshcode-hook-"));
      r = await runOne(engine, run.prompt, { cwd: dir, timeoutMs: run.timeoutMs, maxBytes, env, scratch: true });
    } catch (e) {
      r = { engine, kind: resolveAnyEngine(engine)?.kind || null, ok: false, output: "", error: e.message, exit_code: null, ms: 0, model: null, truncated: false };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    const data = {
      run_id: run.runId,
      engine: r.engine ?? engine,
      kind: r.kind ?? null,
      ok: Boolean(r.ok),
      output: r.output ?? "",
      error: r.error ?? null,
      exit_code: r.exit_code ?? null,
      ms: r.ms ?? 0,
      model: r.model ?? null,
      truncated: Boolean(r.truncated),
    };
    log(`${data.ok ? "✓" : "✗"} ${run.runId} ${data.engine} ${data.ms}ms${data.ok ? "" : ` — ${data.error}`}`);
    await deliver(RESULT_TYPE, data);
    return data;
  })));

  const ok = results.filter((r) => r.ok).length;
  const completed = { run_id: run.runId, total: results.length, ok, failed: results.length - ok, ms: Date.now() - started };
  await deliver(COMPLETED_TYPE, completed);
  return { results, completed };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * The HTTP server. `webhooks` is the @profullstack/webhooks module (injected so
 * tests can pass the real one with a test secret); everything else defaults to
 * the real thing. Returns the http.Server (not yet listening) plus `idle()`,
 * which resolves once every accepted run has finished.
 */
export function createHooksServer({
  secret,
  webhooks,
  concurrency = DEFAULTS.concurrency,
  timeout = DEFAULTS.timeout,
  env = process.env,
  roster = () => oneShotEngines(env),
  runOne = runOneShot,
  sendOptions = {},
  tmpRoot = os.tmpdir(),
  log = () => {},
  version = "",
} = {}) {
  if (!secret) throw new Error("createHooksServer needs a secret");
  const limit = limiter(concurrency);
  const inflight = new Map();
  const send = (url, event) => webhooks.sendWebhook(url, event, { secret, ...sendOptions });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json(res, 200, { ok: true, version, running: inflight.size });
      }
      if (req.method === "GET" && url.pathname === "/engines") {
        return json(res, 200, { engines: roster() });
      }
      if (url.pathname !== "/hooks") return json(res, 404, { error: "not found" });
      if (req.method !== "POST") return json(res, 405, { error: "POST only" });

      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return json(res, 413, { error: `body larger than ${MAX_BODY_BYTES} bytes` });
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      // Signature first, before a single field is read: an unsigned body gets a
      // 401 and nothing else, not a validation error that describes the schema.
      const parsed = webhooks.verifyAndParse({ headers: req.headers, body, secret });
      if (!parsed.ok) return json(res, parsed.status || 401, { error: parsed.reason || "invalid signature" });

      const checked = validateRequest(parsed.event, { available: roster(), maxTimeout: timeout });
      if (!checked.ok) return json(res, checked.status, { error: checked.error });
      const { run } = checked;
      if (inflight.has(run.runId)) return json(res, 409, { error: `run ${run.runId} is already running` });

      const job = executeRun(run, { runOne, send, createEvent: webhooks.createEvent, limit, tmpRoot, log, env })
        .catch((e) => log(`✗ run ${run.runId} failed: ${e.message}`))
        .finally(() => inflight.delete(run.runId));
      inflight.set(run.runId, job);
      log(`→ ${run.runId}: ${run.engines.join(", ")}${run.skipped.length ? ` (skipped ${run.skipped.map((s) => s.name).join(", ")})` : ""}`);
      return json(res, 202, { run_id: run.runId, engines: run.engines, skipped: run.skipped });
    } catch (e) {
      log(`✗ ${req.method} ${url.pathname}: ${e.message}`);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  });

  return { server, idle: () => Promise.all([...inflight.values()]) };
}

export const HOOKS_USAGE = `usage: moshcode hooks serve [--port 7690] [--host 127.0.0.1] [--concurrency 4] [--timeout 180]
       moshcode hooks secret                print a new shared secret (whsec_…)
       moshcode hooks engines [--json]      which engines a run would use here

the shared secret comes from MOSHCODE_HOOKS_SECRET; serve refuses to start without it.`;

/** Parse serve's flags. → { ok, opts } | { ok: false, error } */
export function parseServeArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const key = { "--port": "port", "--host": "host", "--concurrency": "concurrency", "--timeout": "timeout" }[flag];
    if (!key) return { ok: false, error: `unknown option ${flag}` };
    const value = argv[++i];
    if (value === undefined) return { ok: false, error: `${flag} needs a value` };
    if (key === "host") { opts.host = value; continue; }
    const n = Number(value);
    const valid = key === "port" ? Number.isInteger(n) && n >= 0 && n <= 65535
      : key === "concurrency" ? Number.isInteger(n) && n >= 1 && n <= 64
        : Number.isFinite(n) && n > 0;
    if (!valid) return { ok: false, error: `${flag} must be ${key === "timeout" ? "a positive number of seconds" : "a positive integer"}` };
    opts[key] = n;
  }
  return { ok: true, opts };
}

export async function hooksCommand(argv, {
  env = process.env,
  out = (s) => process.stdout.write(s),
  err = (s) => process.stderr.write(s),
  loadWebhooks = () => import("@profullstack/webhooks"),
  version = "",
} = {}) {
  const [verb, ...rest] = argv;
  if (verb === "secret") {
    const { generateSecret } = await loadWebhooks();
    out(`${generateSecret()}\n`);
    return 0;
  }
  if (verb === "engines") {
    const engines = oneShotEngines(env);
    if (rest.includes("--json")) out(`${JSON.stringify({ engines }, null, 2)}\n`);
    else for (const e of engines) out(`${e.available ? "●" : "○"} ${e.name.padEnd(11)} ${e.kind}${e.reason ? `  — ${e.reason}` : ""}\n`);
    return 0;
  }
  if (verb !== "serve") { err(`${HOOKS_USAGE}\n`); return verb ? 1 : 0; }

  const parsed = parseServeArgs(rest);
  if (!parsed.ok) { err(`✗ ${parsed.error}\n${HOOKS_USAGE}\n`); return 1; }
  const secret = env.MOSHCODE_HOOKS_SECRET;
  if (!secret || !secret.trim()) {
    err("✗ MOSHCODE_HOOKS_SECRET is not set — refusing to accept unsigned work. make one: moshcode hooks secret\n");
    return 1;
  }
  const webhooks = await loadWebhooks();
  const { opts } = parsed;
  const { server } = createHooksServer({
    secret: secret.trim(),
    webhooks,
    concurrency: opts.concurrency,
    timeout: opts.timeout,
    env,
    version,
    log: (line) => err(`${new Date().toISOString()} ${line}\n`),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, resolve);
  });
  const { port } = server.address();
  const available = oneShotEngines(env).filter((e) => e.available).map((e) => e.name);
  out(`moshcode hooks listening on http://${opts.host}:${port}/hooks — engines: ${available.join(", ") || "(none available)"}\n`);
  // Serve until signalled; a run in flight is abandoned with the process.
  await new Promise((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
