// Agentic-coding engines moshcode can install + wrap. `moshcode install <name>`
// runs the engine's official installer; `/agents <name>` (or `moshcode <name>`)
// opens a passthrough session on it. moshcode itself stays lean (no vendored
// fork). Add engines here.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

export const ENGINES = {
  opencode: {
    desc: "opencode — the open-source coding agent (SST/anomalyco)",
    bin: "opencode",
    install: { cmd: "bash", args: ["-c", "curl -fsSL https://opencode.ai/install | bash"] },
  },
  claude: {
    desc: "Claude Code — Anthropic's agentic CLI",
    bin: "claude",
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
    install: { cmd: "npm", args: ["install", "-g", "@openai/codex"] },
  },
  gemini: {
    desc: "Gemini CLI — Google's agentic CLI",
    bin: "gemini",
    install: { cmd: "npm", args: ["install", "-g", "@google/gemini-cli"] },
  },
  aider: {
    desc: "Aider — pair-programming in your terminal",
    bin: "aider",
    install: { cmd: "bash", args: ["-c", "curl -LsSf https://aider.chat/install.sh | sh"] },
  },
};

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

/** Engine entries annotated with install status. */
export function engineStatus() {
  return Object.entries(ENGINES).map(([key, e]) => ({ key, ...e, installed: isInstalled(e.bin) }));
}

export function engineList() {
  return Object.entries(ENGINES).map(([k, v]) => `  ${k.padEnd(10)} ${v.desc}`).join("\n");
}

/**
 * Open a session on an engine: spawn its CLI with stdio inherited so the child
 * fully owns the terminal (its own TUI, prompts, colors — full stdin/stdout/
 * stderr passthrough). Resolves { ok, code } when it exits.
 */
export function openSession(engine, args = []) {
  return new Promise((resolve) => {
    let env = process.env;
    if (engine.stripEnv?.length) {
      env = { ...process.env };
      for (const k of engine.stripEnv) delete env[k];
    }
    let child;
    try { child = spawn(engine.bin, args, { stdio: "inherit", env }); }
    catch (e) { resolve({ ok: false, error: e }); return; }
    child.on("error", (e) => resolve({ ok: false, error: e }));
    child.on("exit", (code, signal) => resolve({ ok: true, code, signal }));
  });
}
