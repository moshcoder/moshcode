// One prompt, one engine, one answer — for any engine, CLI or API.
//
// The shared core of `moshcode oneshot` and `moshcode hooks serve`. A CLI engine
// runs in its headless form (AI_EXEC in src/engines.mjs); an API engine is one
// POST (src/api-engines.mjs). Both answer the same shape:
//
//   { engine, kind, ok, output, error, exit_code, ms, model, truncated }
//
// Two rules hold for every CLI run, because the hooks runner executes prompts
// that arrive over the network:
//   - no autonomous flags. The headless argv is plain print mode, and anything
//     that reads as "approve everything" is stripped from it (aider's
//     one-shot form carries --yes, which is exactly that).
//   - a hard deadline that kills the whole process tree, not just the direct
//     child: an engine that shells out leaves grandchildren behind otherwise.
import { spawn } from "node:child_process";

import { API_ENGINES, apiEngineAvailable, apiEngineConfig, runApiEngine } from "./api-engines.mjs";
import { ENGINES, aiExecArgs, hasHeadlessMode, resolveAnyEngine, resolveExecutable } from "./engines.mjs";

export const DEFAULT_MAX_OUTPUT = 64 * 1024;
const MAX_STDERR = 4 * 1024;

/** Flags that bypass an engine's own approvals. Never passed to a one-shot run. */
export const AUTONOMOUS_FLAGS = new Set([
  "--yes", "-y", "--yes-always", "--yolo", "--auto", "--turbo", "--auto-approve", "--trust",
  "--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox",
  "--approval-mode=yolo", "--full-auto", "--never-ask",
]);

// A one-shot run usually lands in an empty temp dir. `codex exec` refuses a
// directory that is not a git repo unless told otherwise; that check is about
// where it may write, not about approvals, so skipping it grants nothing.
const EMPTY_DIR_EXTRAS = {
  codex: (args) => [args[0], "--skip-git-repo-check", ...args.slice(1)],
};

/** The one-shot argv for a CLI engine, minus anything autonomous. */
export function oneShotArgs(key, prompt) {
  let args = aiExecArgs(key, prompt);
  if (Object.hasOwn(EMPTY_DIR_EXTRAS, key)) args = EMPTY_DIR_EXTRAS[key](args);
  // The prompt itself is the last argv entry in every AI_EXEC form; it is the
  // caller's text and is never filtered, even if it happens to read "--yes".
  const promptIndex = args.lastIndexOf(String(prompt));
  return args.filter((a, i) => i === promptIndex || !AUTONOMOUS_FLAGS.has(a));
}

/**
 * Every engine and whether a one-shot run can use it here.
 * CLI: has a headless form and its binary resolves on (env) PATH or its binDirs.
 * API: its key is set in env.
 */
export function oneShotEngines(env = process.env) {
  const out = [];
  for (const [key, e] of Object.entries(ENGINES)) {
    if (!hasHeadlessMode(key)) { out.push({ name: key, kind: "cli", available: false, reason: "no one-shot mode" }); continue; }
    const bin = resolveExecutable(e.bin, e.binDirs || [], env);
    out.push(bin
      ? { name: key, kind: "cli", available: true }
      : { name: key, kind: "cli", available: false, reason: `${Array.isArray(e.bin) ? e.bin[0] : e.bin} not on PATH` });
  }
  for (const key of Object.keys(API_ENGINES)) {
    const a = apiEngineAvailable(key, env);
    out.push(a.available ? { name: key, kind: "api", available: true } : { name: key, kind: "api", available: false, reason: a.reason });
  }
  return out;
}

/** Kill a detached child's whole process group; fall back to the child alone. */
function killTree(child, signal) {
  try { if (process.platform !== "win32") { process.kill(-child.pid, signal); return; } } catch { /* group gone */ }
  try { child.kill(signal); } catch { /* already exited */ }
}

/**
 * Spawn a command with a deadline and a capped stdout. Resolves
 * `{ ok, output, stderr, exit_code, signal, timedOut, truncated, error }`.
 * Exported so the timeout behaviour is tested against a real sleeping process.
 */
export function runCapped(cmd, args, {
  cwd, env = process.env, timeoutMs = 180_000, maxBytes = DEFAULT_MAX_OUTPUT, graceMs = 2000,
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (e) {
      resolve({ ok: false, output: "", stderr: "", exit_code: null, signal: null, timedOut: false, truncated: false, error: e.message });
      return;
    }
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout.on("data", (b) => {
      if (bytes >= maxBytes) { truncated = true; return; }
      const take = b.subarray(0, maxBytes - bytes);
      if (take.length < b.length) truncated = true;
      chunks.push(take);
      bytes += take.length;
    });
    child.stderr.on("data", (b) => { if (stderr.length < MAX_STDERR) stderr += b.toString().slice(0, MAX_STDERR - stderr.length); });
    let hardKill;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      hardKill = setTimeout(() => killTree(child, "SIGKILL"), graceMs);
      hardKill.unref?.();
    }, timeoutMs);
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The direct child is gone; make sure nothing it started outlives it.
      if (timedOut) killTree(child, "SIGKILL");
      clearTimeout(hardKill);
      resolve({ output: Buffer.concat(chunks).toString("utf8"), stderr: stderr.trim(), truncated, timedOut, ...r });
    };
    child.on("error", (e) => finish({ ok: false, exit_code: null, signal: null, error: e.code === "ENOENT" ? `${cmd} not found` : e.message }));
    child.on("close", (code, signal) => finish({
      ok: !timedOut && code === 0,
      exit_code: code,
      signal,
      error: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : code === 0 ? null : (signal ? `killed by ${signal}` : `exited with code ${code}`),
    }));
  });
}

/**
 * Run `prompt` once on `name` (any engine name or alias).
 * `cwd` is where a CLI engine runs; the hooks runner passes a fresh empty dir.
 */
export async function runOneShot(name, prompt, {
  cwd = process.cwd(), env = process.env, timeoutMs = 180_000, maxBytes = DEFAULT_MAX_OUTPUT, fetch, spawnImpl,
} = {}) {
  const started = Date.now();
  const found = resolveAnyEngine(name);
  if (!found) {
    return { engine: String(name), kind: null, ok: false, output: "", error: `unknown engine "${name}"`, exit_code: null, ms: 0, model: null, truncated: false };
  }
  const { key, kind, engine } = found;

  if (kind === "api") {
    const r = await runApiEngine(key, prompt, { env, timeoutMs, ...(fetch ? { fetch } : {}) });
    let output = r.output || "";
    let truncated = false;
    if (Buffer.byteLength(output) > maxBytes) { output = Buffer.from(output).subarray(0, maxBytes).toString("utf8"); truncated = true; }
    return { engine: key, kind, ok: r.ok, output, error: r.error, exit_code: null, ms: r.ms, model: r.model || apiEngineConfig(key, env).model, truncated };
  }

  if (!hasHeadlessMode(key)) {
    return { engine: key, kind, ok: false, output: "", error: `${key} has no one-shot mode`, exit_code: null, ms: 0, model: null, truncated: false };
  }
  const bin = resolveExecutable(engine.bin, engine.binDirs || [], env);
  if (!bin) {
    return { engine: key, kind, ok: false, output: "", error: `${key} is not installed (run: moshcode install ${key})`, exit_code: null, ms: 0, model: null, truncated: false };
  }
  const childEnv = { ...env };
  for (const k of engine.stripEnv || []) delete childEnv[k];
  const run = spawnImpl || runCapped;
  const r = await run(bin, oneShotArgs(key, prompt), { cwd, env: childEnv, timeoutMs, maxBytes });
  return {
    engine: key,
    kind,
    ok: r.ok,
    output: (r.output || "").trim(),
    error: r.ok ? null : [r.error, r.stderr].filter(Boolean).join(": ").slice(0, MAX_STDERR),
    exit_code: r.exit_code ?? null,
    ms: Date.now() - started,
    model: null,
    truncated: Boolean(r.truncated),
  };
}
