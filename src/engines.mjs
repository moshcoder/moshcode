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
import { existsSync, statSync } from "node:fs";
import path from "node:path";

export const ENGINES = {
  opencode: {
    desc: "opencode — the open-source coding agent (SST/anomalyco)",
    bin: "opencode",
    agentArgs: ["--auto"],
    agentsView: ["agent", "list"], // `opencode agent list` — lists agents; the `agent` subcommand takes no bypass flag
    install: { cmd: "bash", args: ["-c", "curl -fsSL https://opencode.ai/install | bash"] },
    upgrade: { cmd: "opencode", args: ["upgrade"] },
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
const ALIASES = { cc: "claude", "claude-code": "claude", openai: "codex", gpt: "codex", google: "gemini" };

/** Resolve a name/alias to `[key, engine]`, or null. */
export function resolveEngine(token) {
  if (!token) return null;
  const t = String(token).trim().toLowerCase();
  const key = ENGINES[t] ? t : ALIASES[t];
  return key ? [key, ENGINES[key]] : null;
}

/** Is `bin` an executable on PATH? (cross-platform-ish) */
export function isInstalled(bin) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try { if (existsSync(path.join(dir, bin + ext)) && statSync(path.join(dir, bin + ext)).isFile()) return true; } catch { /* keep looking */ }
    }
  }
  return false;
}

// Headless "run one prompt, print the answer, exit" invocation per engine — the
// non-interactive mode the ai() moshscript shortcut captures stdout from. Kept
// as a pure map so it's unit-tested without spawning engines.
const AI_EXEC = {
  claude: (p) => ["-p", p],                                  // claude print mode
  codex: (p) => ["exec", p],                                 // codex non-interactive
  gemini: (p) => ["-p", p],                                  // gemini prompt mode
  opencode: (p) => ["run", p],                               // opencode one-shot
  aider: (p) => ["--message", p, "--yes", "--no-auto-commits"], // aider single message
};

/** argv that runs `prompt` headlessly on `engine` (throws if it has no headless mode). */
export function aiExecArgs(engine, prompt) {
  const fn = AI_EXEC[engine];
  if (!fn) throw new Error(`moshscript: ai() has no headless mode for "${engine}"`);
  return fn(String(prompt));
}

/** First installed engine that supports headless ai(), honoring a preference. */
export function pickAiEngine(preferred) {
  const order = preferred ? [preferred] : ["claude", "codex", "opencode", "gemini", "aider"];
  for (const key of order) {
    if (ENGINES[key] && AI_EXEC[key] && isInstalled(ENGINES[key].bin)) return key;
  }
  return null;
}

/** Engine entries annotated with install status. */
export function engineStatus() {
  return Object.entries(ENGINES).map(([key, e]) => ({ key, ...e, installed: isInstalled(e.bin) }));
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
    try { child = spawn(cmd, args, { stdio: "inherit" }); }
    catch (e) { resolve({ ok: false, error: e }); return; }
    child.on("error", (e) => resolve({ ok: false, error: e }));
    child.on("exit", (code, signal) => resolve({ ok: true, code, signal }));
  });
}

/**
 * Hand the current process streams to an external CLI. Arguments, cwd, and the
 * environment are inherited unchanged unless that target explicitly asks for
 * environment keys to be stripped (Claude uses this to avoid nested-session
 * markers). Resolves { ok, code, signal } when the child exits.
 */
export function openPassthrough(target, args = []) {
  return new Promise((resolve) => {
    let env = process.env;
    if (target.stripEnv?.length) {
      env = { ...process.env };
      for (const k of target.stripEnv) delete env[k];
    }
    let child;
    try { child = spawn(target.bin, args, { stdio: "inherit", env }); }
    catch (e) { resolve({ ok: false, error: e }); return; }
    child.on("error", (e) => resolve({ ok: false, error: e }));
    child.on("exit", (code, signal) => resolve({ ok: true, code, signal }));
  });
}

// Backwards-compatible engine-oriented name used by the existing CLI/TUI.
export const openSession = openPassthrough;
