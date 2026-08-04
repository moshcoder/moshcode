// Agentic-coding engines moshcode can install + wrap. `moshcode install <name>`
// runs the engine's official installer; `/agents <name>` (or `moshcode <name>`)
// opens a passthrough session on it. moshcode itself stays lean (no vendored
// fork). Add engines here.
//
// `agentsView` (optional) is the exact argv that opens the engine's native
// agent list/view — used by `/agents <name>` when the engine actually has one
// (claude, opencode). It's the FULL leading args (subcommand + any flags that
// subcommand accepts), because not every agents-subcommand takes the engine's
// bypass flag (e.g. `opencode agent list` takes none). Engines without an
// `agentsView` fall back to `agentArgs` — an autonomous session with native
// approvals bypassed/auto-approved.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { followFile, ptyEnabled, ptySpec, scriptFlavor, stripScriptBanner } from "./pty.mjs";

export const ENGINES = {
  opencode: {
    desc: "opencode — the open-source coding agent (SST/anomalyco)",
    bin: "opencode",
    agentArgs: ["--auto"],
    agentsView: ["agent", "list"], // `opencode agent list` — lists agents; the `agent` subcommand takes no bypass flag
    install: { cmd: "bash", args: ["-c", "curl -fsSL https://opencode.ai/install | bash"] },
    upgrade: { cmd: "opencode", args: ["upgrade"] },
  },
  privacycode: {
    desc: "privacycode — privacy-first coding agent (profullstack)",
    bin: "privacycode",
    // An opencode derivative, so it speaks the same flags/subcommands.
    agentArgs: ["--auto"],
    agentsView: ["agent", "list"],
    install: { cmd: "sh", args: ["-c", "curl -fsSL https://getprivacycode.com/install | sh"] },
    // Deliberately no native updater. `privacycode upgrade` is opencode's, and
    // it works out how to update itself by recognising where it was installed —
    // it knows opencode's own locations, not this fork's ~/.privacycode/bin. It
    // reports `Using method: unknown` and aborts with "Unknown installation
    // method", every time, so it can never upgrade an install we made. Falling
    // through to the installer above is what actually moves the version.
  },
  claude: {
    desc: "Claude Code — Anthropic's agentic CLI",
    bin: "claude",
    agentArgs: ["--dangerously-skip-permissions"],
    agentsView: ["agents", "--dangerously-skip-permissions"], // `claude agents …` — the background-agents view; accepts the skip flag
    install: { cmd: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"] },
    // Claude Code authenticates via its own stored login (~/.claude). An
    // inherited ANTHROPIC_API_KEY hijacks that subscription auth — and if the
    // key can't serve the models, Claude Code shows an "enable models" screen
    // and exits straight back to the mosh prompt. Nested-session markers make a
    // fresh launch think it's running inside another Claude. Drop both so the
    // passthrough session starts clean on its own auth. (opencode/aider legitimately
    // use ANTHROPIC_API_KEY as a provider key, so we only scrub it for claude.)
    stripEnv: [
      "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
      "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
    ],
  },
  codex: {
    desc: "Codex — OpenAI's coding CLI",
    bin: "codex",
    agentArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    install: { cmd: "npm", args: ["install", "-g", "@openai/codex"] },
  },
  gemini: {
    desc: "Gemini CLI — Google's agentic CLI",
    bin: "gemini",
    agentArgs: ["--approval-mode=yolo"],
    install: { cmd: "npm", args: ["install", "-g", "@google/gemini-cli"] },
  },
  kimi: {
    desc: "Kimi Code — Moonshot AI's agentic CLI",
    bin: "kimi",
    // `--yolo` auto-approves regular tool calls while the agent can still ask a
    // question — the same shape as gemini's yolo and aider's --yes-always. Kimi
    // also has `--auto`, which additionally suppresses the questions; that is a
    // step past what /agents means for every other engine here.
    agentArgs: ["--yolo"],
    // No agentsView: Kimi Code has no agent list to land on. `--agent <name>`
    // picks a profile for the session it is starting, and there is no `kimi
    // agents` subcommand, so agent mode is the autonomous session above.
    //
    // Install the kimi-code installer directly rather than the code.kimi.com
    // /install.sh wrapper the older docs point at. That wrapper now installs the
    // deprecated Python kimi-cli, and it *prompts* — Enter, or a 30s timeout,
    // silently redirects to this same script. A vendor installer that blocks on
    // a human for half a minute is not something `moshcode install` can drive.
    install: { cmd: "bash", args: ["-c", "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"] },
    upgrade: { cmd: "kimi", args: ["upgrade"] },
    // The installer drops the binary in ~/.kimi-code/bin and only appends that
    // to your shell rc, so PATH won't see it until the next shell — including in
    // the moshcode session that just installed it. (A custom KIMI_INSTALL_DIR
    // lands in the rc the same way; only the default needs bridging here.)
    binDirs: [path.join(homedir(), ".kimi-code", "bin")],
  },
  aider: {
    desc: "Aider — pair-programming in your terminal",
    bin: "aider",
    agentArgs: ["--yes-always"],
    install: { cmd: "bash", args: ["-c", "curl -LsSf https://aider.chat/install.sh | sh"] },
    upgrade: { cmd: "aider", args: ["--upgrade"] },
  },
};

/**
 * The command that upgrades an already-installed engine in place: its native
 * updater if it has one, else re-run the installer (they're idempotent and
 * fetch the latest — claude/codex/gemini are `npm i -g` which upgrades).
 */
export function upgradeSpec(engine) {
  return engine.upgrade || engine.install;
}

/** Aliases so `/agents cc` etc. resolve. */
export const ENGINE_ALIASES = {
  cc: "claude", "claude-code": "claude", openai: "codex", gpt: "codex", google: "gemini",
  pc: "privacycode", getprivacycode: "privacycode", privacy: "privacycode",
  "kimi-cli": "kimi", "kimi-code": "kimi", moonshot: "kimi",
};

/** Resolve a name/alias to `[key, engine]`, or null. */
export function resolveEngine(token) {
  if (!token) return null;
  const t = String(token).trim().toLowerCase();
  // Own properties only: ENGINES/ALIASES are plain object literals, so a name
  // like `constructor` or `__proto__` would otherwise resolve to something off
  // Object.prototype and be handed on as an engine with no bin/install.
  const key = Object.hasOwn(ENGINES, t) ? t : Object.hasOwn(ENGINE_ALIASES, t) ? ENGINE_ALIASES[t] : null;
  return key ? [key, ENGINES[key]] : null;
}

// `extraDirs` are directories a vendor installer drops a binary into without
// putting it on PATH for the session that ran the install (turso's official
// script unpacks to $HOME/.turso and only appends it to your shell profile).
// Searching them after PATH keeps a real `turso` on PATH winning, while still
// finding the one we just installed.
function executableCandidates(bin, extraDirs = []) {
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")] : [""];
  const dirs = path.isAbsolute(bin) || bin.includes(path.sep)
    ? [""]
    : [...(process.env.PATH || "").split(path.delimiter).filter(Boolean), ...extraDirs.filter(Boolean)];
  const seen = new Set();
  const candidates = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? path.join(dir, bin + ext) : bin + ext;
      const key = candidate.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

export function resolveExecutable(bin, extraDirs = []) {
  for (const candidate of executableCandidates(bin, extraDirs)) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

function nodeShebang(file) {
  try {
    const head = readFileSync(file, "utf8").slice(0, 80);
    return /^#!.*\bnode(?:\.exe)?\b/.test(head);
  } catch {
    return false;
  }
}

function spawnSpec(bin, args = [], extraDirs = []) {
  const resolved = resolveExecutable(bin, extraDirs);
  if (!resolved) return { cmd: bin, args };
  if (process.platform === "win32" && path.extname(resolved) === "" && nodeShebang(resolved)) {
    return { cmd: process.execPath, args: [resolved, ...args] };
  }
  return { cmd: resolved, args };
}

/** Is `bin` an executable on PATH (or in one of `extraDirs`)? (cross-platform-ish) */
export function isInstalled(bin, extraDirs = []) {
  return Boolean(resolveExecutable(bin, extraDirs));
}

// Headless "run one prompt, print the answer, exit" invocation per engine — the
// non-interactive mode the ai() moshscript shortcut captures stdout from. Kept
// as a pure map so it's unit-tested without spawning engines.
const AI_EXEC = {
  claude: (p) => ["-p", p],                                  // claude print mode
  codex: (p) => ["exec", p],                                 // codex non-interactive
  gemini: (p) => ["-p", p],                                  // gemini prompt mode
  opencode: (p) => ["run", p],                               // opencode one-shot
  privacycode: (p) => ["run", p],                            // privacycode one-shot (opencode-derived)
  aider: (p) => ["--message", p, "--yes", "--no-auto-commits"], // aider single message
  kimi: (p) => ["-p", p],                                    // kimi prompt mode (prints the response, text by default)
};

/** argv that runs `prompt` headlessly on `engine` (throws if it has no headless mode). */
export function aiExecArgs(engine, prompt) {
  const fn = Object.hasOwn(AI_EXEC, engine) ? AI_EXEC[engine] : null;
  if (!fn) throw new Error(`moshscript: ai() has no headless mode for "${engine}"`);
  return fn(String(prompt));
}

/**
 * First installed engine that supports headless ai(), honoring a preference.
 *
 * A preference names an engine the same way every other engine surface does
 * (`/agents cc`, `moshcode start cc`, `moshcode upgrade cc` — README: "name
 * any; alias ok"), so resolve ALIASES here too. Matching raw ENGINES keys only
 * made `ai(prompt, { engine: "cc" })` read as "no such engine" and fail with
 * "needs an installed engine" even when Claude was installed. An unknown name
 * still yields null.
 */
export function pickAiEngine(preferred) {
  const wanted = preferred ? resolveEngine(preferred)?.[0] : null;
  const order = preferred ? (wanted ? [wanted] : []) : ["claude", "codex", "opencode", "privacycode", "gemini", "kimi", "aider"];
  for (const key of order) {
    if (Object.hasOwn(ENGINES, key) && Object.hasOwn(AI_EXEC, key) && isInstalled(ENGINES[key].bin, ENGINES[key].binDirs)) return key;
  }
  return null;
}

/** Engine entries annotated with install status. */
export function engineStatus() {
  // Search each engine's own install dir as well as PATH — kimi's installer only
  // adds ~/.kimi-code/bin to your shell rc, so PATH alone reports it missing in
  // the very session that installed it. (Inert for engines without binDirs.)
  return Object.entries(ENGINES).map(([key, e]) => ({ key, ...e, installed: isInstalled(e.bin, e.binDirs) }));
}

export function engineList() {
  return Object.entries(ENGINES).map(([k, v]) => `  ${k.padEnd(10)} ${v.desc}`).join("\n");
}

/**
 * Args for an agent-mode launch (`/agents <engine>` / `moshcode agents <engine>`):
 * the engine's native agents-view invocation when it has one (so you land on your
 * agent list), else its autonomous bypass flags. Caller-supplied args follow.
 */
export function agentLaunchArgs(engine, args = []) {
  const lead = engine.agentsView || engine.agentArgs || [];
  return [...lead, ...args];
}

/**
 * Spawn an arbitrary command with stdio inherited (so its own progress/prompts
 * own the terminal). Resolves { ok, code, signal } on exit. Used by install +
 * upgrade to run engine installers/updaters.
 */
export function runCmd(cmd, args = []) {
  return new Promise((resolve) => {
    let child;
    const spec = spawnSpec(cmd, args);
    try { child = spawn(spec.cmd, spec.args, { stdio: "inherit" }); }
    catch (e) { resolve({ ok: false, error: e }); return; }
    child.on("error", (e) => resolve({ ok: false, error: e }));
    child.on("exit", (code, signal) => resolve({ ok: true, code, signal }));
  });
}

/**
 * True only when a child actually ran and exited 0. Node reports a signal death
 * as `code === null` (the signal name lands in `signal` instead), so a killed
 * child — OOM, a timeout wrapper's SIGTERM, Ctrl-C — must not read as success
 * just because it has no exit code.
 */
export function ranOk(r) {
  return Boolean(r?.ok) && r.code === 0;
}

/**
 * Short human reason a `runCmd` result failed: "code 128", "SIGKILL", or the
 * spawn error message. Null when it succeeded.
 */
export function exitReason(r) {
  if (ranOk(r)) return null;
  if (r?.error) return r.error.message || String(r.error);
  if (r?.code != null) return `code ${r.code}`;
  if (r?.signal) return r.signal;
  return "unknown error";
}

/**
 * Hand the current process streams to an external CLI. Arguments, cwd, and the
 * environment are inherited unchanged unless that target explicitly asks for
 * environment keys to be stripped (Claude uses this to avoid nested-session
 * markers). `target.binDirs` extends the executable search past PATH for tools
 * whose installer drops the binary somewhere PATH won't see until the next
 * shell. Resolves { ok, code, signal } when the child exits.
 */
export function openPassthrough(target, args = [], { onOutput } = {}) {
  return new Promise((resolve) => {
    let env = process.env;
    if (target.stripEnv?.length) {
      env = { ...process.env };
      for (const k of target.stripEnv) delete env[k];
    }
    const spec = spawnSpec(target.bin, args, target.binDirs || []);

    // With a mirror attached, run the child under a pseudo-terminal so a copy
    // of its output can be streamed to the session page. `inherit` alone hands
    // the child the tty's own file descriptors, so none of its bytes ever pass
    // through this process. See src/pty.mjs for why this is script(1) and not
    // a pipe or node-pty.
    let transcript = null;
    let workDir = null;
    let stopFollow = null;
    let launch = { ...spec, stdio: "inherit" };
    if (ptyEnabled(onOutput)) {
      try {
        workDir = mkdtempSync(path.join(tmpdir(), "moshcode-pty-"));
        transcript = path.join(workDir, "transcript");
        writeFileSync(transcript, "");
        const wrapped = ptySpec(spec.cmd, spec.args, transcript, scriptFlavor());
        if (wrapped) {
          launch = { ...wrapped, stdio: "inherit" };
          let first = true;
          stopFollow = followFile(transcript, (chunk) => {
            const clean = stripScriptBanner(chunk, first);
            first = false;
            if (clean) onOutput(clean);
          });
        }
      } catch {
        // Capture is a nicety; never let it stop the session from opening.
        transcript = null;
      }
    }

    const cleanup = () => {
      try { stopFollow?.(); } catch { /* nothing left to drain */ }
      if (workDir) { try { rmSync(workDir, { recursive: true, force: true }); } catch { /* temp dir */ } }
    };

    let child;
    try { child = spawn(launch.cmd, launch.args, { stdio: "inherit", env }); }
    catch (e) { cleanup(); resolve({ ok: false, error: e }); return; }
    child.on("error", (e) => { cleanup(); resolve({ ok: false, error: e }); });
    child.on("exit", (code, signal) => { cleanup(); resolve({ ok: true, code, signal }); });
  });
}

// Backwards-compatible engine-oriented name used by the existing CLI/TUI.
export const openSession = openPassthrough;
