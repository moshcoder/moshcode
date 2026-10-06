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
import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

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

/** Drop every autonomous flag except the prompt (always the last entry). */
function stripAutonomous(args, prompt) {
  // The prompt itself is the last argv entry in every AI_EXEC form; it is the
  // caller's text and is never filtered, even if it happens to read "--yes".
  const promptIndex = args.lastIndexOf(String(prompt));
  return args.filter((a, i) => i === promptIndex || !AUTONOMOUS_FLAGS.has(a));
}

/** The one-shot argv for a CLI engine, minus anything autonomous. */
export function oneShotArgs(key, prompt) {
  let args = aiExecArgs(key, prompt);
  if (Object.hasOwn(EMPTY_DIR_EXTRAS, key)) args = EMPTY_DIR_EXTRAS[key](args);
  return stripAutonomous(args, prompt);
}

export const DASHSCOPE_INTL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

const firstSet = (env, ...names) => {
  for (const n of names) if (env[n] && String(env[n]).trim()) return String(env[n]).trim();
  return null;
};

/** kimi --output-format stream-json: one JSON object per line; the answer is the assistant lines. */
export function parseKimiStream(text) {
  const parts = [];
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t);
      if (o.role !== "assistant") continue;
      if (typeof o.content === "string") parts.push(o.content);
      else if (Array.isArray(o.content)) for (const c of o.content) if (c && c.type === "text" && typeof c.text === "string") parts.push(c.text);
    } catch { /* not a JSON line */ }
  }
  return parts.join("\n").trim();
}

/** aider prints a banner and a token tally around the answer; keep the answer. */
export function stripAiderChrome(text) {
  const chrome = /^(Analytics have been .*|Aider v\d.*|(Main |Weak |Editor )?[Mm]odel: .*|Git repo: .*|Repo-map: .*|Tokens: .*|Cost: .*|Warning: .*|You can skip this check.*|https:\/\/aider\.chat\/.*)$/;
  return String(text || "").split("\n").filter((l) => !chrome.test(l.trim())).join("\n").trim();
}

/**
 * Per-engine wiring for a one-shot run, derived from keys the caller already
 * holds. Returns `{ args, env, parse, realBin }`:
 *   args    — flags placed before the headless argv (never autonomous ones)
 *   env     — variables set for THIS child only; nothing leaks into the
 *             caller's env or another engine's (an OPENAI_API_KEY handed to
 *             qwen must never reach codex)
 *   parse   — turns the engine's stdout into the answer
 *   realBin — spawn the real script behind a symlink / mise shim
 *
 * `scratch` is true when the run happens in a fresh empty directory (the
 * hooks runner), where trusting the workspace grants nothing.
 */
export function oneShotProfile(key, env = process.env, { scratch = false } = {}) {
  const p = { args: [], env: {}, parse: null, realBin: false };
  switch (key) {
    case "claude":
      // No MCP servers: the user's global MCP config is irrelevant to a
      // one-shot answer, and every server costs startup time.
      p.args = ["--strict-mcp-config"];
      break;
    case "gemini":
      if (scratch && env.GEMINI_CLI_TRUST_WORKSPACE === undefined) p.env.GEMINI_CLI_TRUST_WORKSPACE = "true";
      break;
    case "qwen": {
      // --safe-mode: no MCP servers, hooks, extensions or skills for a print run.
      p.args = ["--safe-mode"];
      const k = firstSet(env, "QWEN_API_KEY", "DASHSCOPE_API_KEY");
      if (k) {
        // DashScope speaks the OpenAI protocol. The key goes in qwen's env
        // (not argv, which `ps` shows); base URL and model are not secret.
        p.args.push("--auth-type", "openai", "--openai-base-url", firstSet(env, "QWEN_API_URL") || DASHSCOPE_INTL,
          "-m", firstSet(env, "QWEN_MODEL") || "qwen-plus");
        p.env.OPENAI_API_KEY = k;
      }
      break;
    }
    case "deepseek":
      // Its headless mode defaults to approvalMode "turbo" (approve every
      // tool call). "plan" is the only mode that refuses tools when headless.
      p.args = ["--approval-mode", "plan"];
      // dist/cli/index.js only runs when argv[1] is its real path, so through
      // the npm bin symlink it exits 0 having done nothing.
      p.realBin = true;
      if (String(env.MOSHCODE_DEEPSEEK_VIA || "").toLowerCase() === "dashscope" && firstSet(env, "DASHSCOPE_API_KEY")) {
        p.env.DEEPSEEK_API_KEY = firstSet(env, "DASHSCOPE_API_KEY");
        p.env.DEEPSEEK_BASE_URL = firstSet(env, "QWEN_API_URL") || DASHSCOPE_INTL;
        p.env.DEEPSEEK_MODEL = firstSet(env, "MOSHCODE_DEEPSEEK_MODEL") || "deepseek-v3.2";
      } else if (!firstSet(env, "DEEPSEEK_BASE_URL") && firstSet(env, "DEEPSEEK_API_URL")) {
        p.env.DEEPSEEK_BASE_URL = firstSet(env, "DEEPSEEK_API_URL");
      }
      break;
    case "kimi": {
      p.args = ["--output-format", "stream-json"];
      p.parse = parseKimiStream;
      const k = firstSet(env, "KIMI_MODEL_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY");
      if (k && !firstSet(env, "KIMI_MODEL_NAME")) {
        // kimi-code's env-defined model: a Moonshot platform key instead of the
        // `kimi login` OAuth provider, without touching ~/.kimi-code/config.toml.
        p.env.KIMI_MODEL_NAME = firstSet(env, "KIMI_MODEL") || "kimi-k2.6";
        p.env.KIMI_MODEL_API_KEY = k;
        const base = firstSet(env, "KIMI_MODEL_BASE_URL", "KIMI_API_URL");
        if (base) p.env.KIMI_MODEL_BASE_URL = base;
      }
      break;
    }
    case "aider": {
      p.args = ["--no-git", "--no-gitignore", "--no-check-update", "--no-show-release-notes", "--no-show-model-warnings",
        "--no-analytics", "--no-pretty", "--no-stream", "--no-fancy-input", "--no-detect-urls", "--map-tokens", "0"];
      p.parse = stripAiderChrome;
      if (firstSet(env, "AIDER_MODEL")) break; // aider reads it itself
      const ds = firstSet(env, "DASHSCOPE_API_KEY");
      if (ds) {
        p.args.push("--model", `openai/${firstSet(env, "MOSHCODE_AIDER_DASHSCOPE_MODEL") || "qwen-plus"}`);
        p.env.OPENAI_API_KEY = ds;
        p.env.OPENAI_API_BASE = firstSet(env, "QWEN_API_URL") || DASHSCOPE_INTL;
      } else if (firstSet(env, "GEMINI_API_KEY")) {
        p.args.push("--model", "gemini/gemini-flash-latest");
      } else if (firstSet(env, "DEEPSEEK_API_KEY")) {
        p.args.push("--model", "deepseek/deepseek-chat");
      }
      break;
    }
    default:
      break;
  }
  p.args = p.args.filter((a) => !AUTONOMOUS_FLAGS.has(a));
  return p;
}

const SHIM_TTL_MS = 30_000;
const shimCache = new Map();

/**
 * A mise shim is a symlink to the mise binary that only works when mise has a
 * version of the tool selected. A shim left behind by a tool installed under a
 * Node version that is no longer current is still a file on PATH, so "is it on
 * PATH" says yes and the run fails later with "No version is set for shim".
 * Ask mise. Returns `{ ok, target, reason }`; a non-shim is always ok, with
 * `target` its real path.
 */
export function checkShim(binPath, name, env = process.env, { spawnSyncImpl = spawnSync, now = Date.now() } = {}) {
  let real = binPath;
  try { real = realpathSync(binPath); } catch { /* dangling: let spawn report it */ }
  if (path.basename(real) !== "mise") return { ok: true, target: real };
  const cacheKey = `${binPath}\0${env.PATH || ""}`;
  const hit = shimCache.get(cacheKey);
  if (hit && now - hit.at < SHIM_TTL_MS) return hit.result;
  const r = spawnSyncImpl(real, ["which", name], { env, encoding: "utf8", timeout: 5000 });
  const out = String(r.stdout || "").trim().split("\n")[0];
  let result;
  if (r.status === 0 && out) {
    let target = out;
    try { target = realpathSync(out); } catch { /* keep mise's answer */ }
    result = { ok: true, target };
  } else {
    // A shim for a tool that is not active falls through to the next `name`
    // on PATH when run, so a real binary later on PATH still answers.
    const shimDir = path.dirname(binPath);
    const rest = (env.PATH || "").split(path.delimiter).filter((d) => d && path.resolve(d) !== path.resolve(shimDir));
    const fallback = resolveExecutable(name, [], { ...env, PATH: rest.join(path.delimiter) });
    let fallbackReal = null;
    try { fallbackReal = fallback ? realpathSync(fallback) : null; } catch { /* dangling */ }
    if (fallbackReal && path.basename(fallbackReal) !== "mise") {
      result = { ok: true, target: fallbackReal };
    } else {
      const why = String(r.stderr || r.error?.message || "").split("\n").map((l) => l.trim()).find(Boolean) || "mise which failed";
      result = { ok: false, target: null, reason: `${name} is a broken mise shim: ${why.replace(/^mise (ERROR|WARN)\s*/, "").slice(0, 160)}` };
    }
  }
  shimCache.set(cacheKey, { at: now, result });
  return result;
}

/**
 * Every engine and whether a one-shot run can use it here.
 * CLI: has a headless form and its binary resolves on (env) PATH or its binDirs.
 * API: its key is set in env.
 */
export function oneShotEngines(env = process.env, { checkShimImpl = checkShim } = {}) {
  const out = [];
  for (const [key, e] of Object.entries(ENGINES)) {
    if (!hasHeadlessMode(key)) { out.push({ name: key, kind: "cli", available: false, reason: "no one-shot mode" }); continue; }
    const bin = resolveExecutable(e.bin, e.binDirs || [], env);
    if (!bin) { out.push({ name: key, kind: "cli", available: false, reason: `${Array.isArray(e.bin) ? e.bin[0] : e.bin} not on PATH` }); continue; }
    const shim = checkShimImpl(bin, path.basename(bin), env);
    out.push(shim.ok ? { name: key, kind: "cli", available: true } : { name: key, kind: "cli", available: false, reason: shim.reason });
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
  scratch = false, checkShimImpl = checkShim,
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
    const empty = r.ok && !output.trim();
    return { engine: key, kind, ok: r.ok && !empty, output, error: empty ? "empty answer" : r.error, exit_code: null, ms: r.ms, model: r.model || apiEngineConfig(key, env).model, truncated };
  }

  if (!hasHeadlessMode(key)) {
    return { engine: key, kind, ok: false, output: "", error: `${key} has no one-shot mode`, exit_code: null, ms: 0, model: null, truncated: false };
  }
  const bin = resolveExecutable(engine.bin, engine.binDirs || [], env);
  if (!bin) {
    return { engine: key, kind, ok: false, output: "", error: `${key} is not installed (run: moshcode install ${key})`, exit_code: null, ms: 0, model: null, truncated: false };
  }
  const shim = checkShimImpl(bin, path.basename(bin), env);
  if (!shim.ok) {
    return { engine: key, kind, ok: false, output: "", error: shim.reason, exit_code: null, ms: Date.now() - started, model: null, truncated: false };
  }
  const profile = oneShotProfile(key, env, { scratch });
  const childEnv = { ...env, ...profile.env };
  for (const k of engine.stripEnv || []) delete childEnv[k];
  const cmd = profile.realBin && shim.target ? shim.target : bin;
  const args = stripAutonomous([...profile.args, ...oneShotArgs(key, prompt)], prompt);
  const run = spawnImpl || runCapped;
  const r = await run(cmd, args, { cwd, env: childEnv, timeoutMs, maxBytes });
  const raw = r.output || "";
  const output = (profile.parse ? profile.parse(raw) : raw).trim();
  // Exit 0 with nothing to show is not an answer: an engine that cannot
  // authenticate, or whose entrypoint never ran, often exits 0 silently.
  const empty = r.ok && !output;
  const ok = r.ok && !empty;
  return {
    engine: key,
    kind,
    ok,
    output: output || (ok ? "" : raw.trim()),
    error: ok ? null : [empty ? "empty answer" : r.error, r.stderr].filter(Boolean).join(": ").slice(0, MAX_STDERR),
    exit_code: r.exit_code ?? null,
    ms: Date.now() - started,
    model: profile.env.KIMI_MODEL_NAME || profile.env.DEEPSEEK_MODEL || null,
    truncated: Boolean(r.truncated),
  };
}
