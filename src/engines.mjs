// Agentic-coding engines moshcode can install + wrap. `moshcode install <name>`
// runs the engine's official installer; `/agents <name>` (or `moshcode <name>`)
// opens a passthrough session on it. moshcode itself stays lean (no vendored
// fork). Add engines here.
//
// `agentsView` (optional) is the exact argv that opens the engine's native
// agent list/view — used by `/agents <name>` when the engine actually has one
// (currently claude). It's the FULL leading args (subcommand + any flags that
// subcommand accepts). Engines without an `agentsView` fall back to
// `agentArgs` — an autonomous session with native approvals
// bypassed/auto-approved. Do not use a machine-readable, one-shot list command
// as an agents view: `/agents` promises to hand the terminal to a live session.
//
// `state` (optional) is how the herd reads this engine's screen when it has no
// authoritative hook to go on (PRD 0009 R7). It lives here, next to the install
// spec, so a new engine ships its detection rules with itself rather than in a
// table somewhere else that nobody remembers to update. Shared patterns — bare
// y/n prompts, "esc to interrupt" — are in src/herd-state.mjs and do not need
// repeating; only put a pattern here when it is this engine's own wording.
// Every pattern is matched against the bottom of the screen with ANSI stripped.
//
// `hooks` (optional) is how this engine reports its own state, so the herd can
// stop reading paint (PRD 0011 R1). It sits here for the same reason `state`
// does — and because the two are the same fact at different confidence: a hook
// spec supersedes the screen rules below it, so an engine that gains one should
// keep its rules rather than delete them. A missing `hooks` is not a gap to
// paper over with a guess; it means this engine is classified from its screen,
// which is what every engine did before.
//
// `resume` (optional) is the argv that reopens this engine's last conversation,
// used by `moshcode restore --resume` after a reboot. Omit it rather than guess:
// a session that starts fresh is a small disappointment, and one that starts
// with a flag the engine does not have is a crash.
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
    install: { cmd: "bash", args: ["-c", "curl -fsSL https://opencode.ai/install | bash"] },
    upgrade: { cmd: "opencode", args: ["upgrade"] },
    resume: ["--continue"],
    state: {
      blocked: [/\bpermission (?:request|required)\b/i, /\ballow this (?:command|tool)\b/i],
    },
    // The installer appends this directory to a shell profile. The moshcode
    // process that ran it cannot see that PATH change, so search it directly.
    binDirs: [path.join(homedir(), ".opencode", "bin")],
  },
  privacycode: {
    desc: "privacycode — privacy-first coding agent (profullstack)",
    bin: "privacycode",
    // An opencode derivative, so it speaks the same flags/subcommands.
    agentArgs: ["--auto"],
    install: { cmd: "sh", args: ["-c", "curl -fsSL https://getprivacycode.com/install | sh"] },
    binDirs: [path.join(homedir(), ".privacycode", "bin")],
    // Same lineage, so the same screen wording and the same resume flag.
    resume: ["--continue"],
    state: {
      blocked: [/\bpermission (?:request|required)\b/i, /\ballow this (?:command|tool)\b/i],
    },
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
    resume: ["--continue"],
    // The engine speaking for itself (PRD 0011 R1). Claude Code's lifecycle
    // hooks are documented and stable, which is why it is the one engine that
    // ships a spec here rather than a promise to write one: a hook schema we
    // guessed at would be a rule that rots with no screen to fall back to.
    //
    // `file` is a function, not a path, because the whole install is a write to
    // the user's home and the only honest way to test that is to move HOME.
    hooks: {
      format: "claude-settings",
      file: () => path.join(homedir(), ".claude", "settings.json"),
      // Stop fires when the turn ends, which is the end of the *task* — A2A
      // calls the same moment `completed`. Notification covers both halves of
      // blocked (a permission request and a plain question). UserPromptSubmit
      // is the cheapest honest `working`: PreToolUse would also do it, at the
      // cost of forking a moshcode per tool call for a state it is already in.
      // `label` is what moshcode calls the event; `event` is what the engine
      // calls it. They differ because one is a sentence and the other is a
      // schema key, and printing the schema key at someone is not an answer.
      events: [
        { event: "Stop", state: "done", label: "stop" },
        { event: "Notification", state: "blocked", label: "notification" },
        { event: "UserPromptSubmit", state: "working", label: "prompt-submit" },
      ],
    },
    state: {
      // The permission dialog's own heading, and the selector on its first
      // option — the generic numbered-menu pattern would catch the second only
      // if the cursor happened to be resting there.
      blocked: [/\bdo you want to (?:proceed|make this edit|create)\b/i, /^\s*❯\s*1\.\s*yes/im],
      // Claude Code parks "? for shortcuts" under the composer when it is
      // waiting on you and nothing else, which is as close to an explicit
      // "idle" as it publishes.
      idle: [/\?\s+for shortcuts/i],
    },
  },
  codex: {
    desc: "Codex — OpenAI's coding CLI",
    bin: "codex",
    agentArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    install: { cmd: "npm", args: ["install", "-g", "@openai/codex"] },
    resume: ["resume", "--last"],
    state: {
      blocked: [/\ballow (?:this )?command\b/i, /\bapprove this (?:command|edit|change)\b/i],
      working: [/\besc to interrupt\b/i, /^\s*working\b/im],
    },
  },
  gemini: {
    desc: "Gemini CLI — Google's agentic CLI",
    bin: "gemini",
    agentArgs: ["--approval-mode=yolo"],
    install: { cmd: "npm", args: ["install", "-g", "@google/gemini-cli"] },
    state: {
      blocked: [/\bapply this change\?/i, /\ballow execution\b/i],
    },
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
  qwen: {
    desc: "Qwen Code — Alibaba's agentic coding CLI",
    bin: "qwen",
    // A Gemini CLI fork, so it takes gemini's approval-mode flag. `--yolo`/`-y`
    // selects the same mode by another name, and passing both is a hard error
    // ("Cannot use --yolo (-y) and --approval-mode together"), so this stays on
    // the one form — the gemini-shaped one, matching the entry above.
    agentArgs: ["--approval-mode=yolo"],
    install: { cmd: "npm", args: ["install", "-g", "@qwen-code/qwen-code"] },
  },
  deepseek: {
    desc: "DeepSeek Code — terminal coding agent on DeepSeek models",
    // Community-built (SerjMihashin), not a DeepSeek-published CLI — DeepSeek
    // ships no first-party agentic CLI. The two other names that get suggested
    // are dead ends: `deepseek-tui` is now a stub whose own description says it
    // was renamed to `codewhale`, and `deepseek-cli` has not been touched since
    // January 2025.
    //
    // The package installs two identical bins, `dsc` and `deepseek-code`. Take
    // the long one: `dsc` is also Microsoft's Desired State Configuration
    // binary, so on a machine that has both, the short name would silently
    // launch the wrong program.
    bin: "deepseek-code",
    // `--turbo` is its "auto-approve all actions" mode (equivalently
    // `--approval-mode turbo`, alongside plan/default/auto-edit).
    agentArgs: ["--turbo"],
    install: { cmd: "npm", args: ["install", "-g", "@serjm/deepseek-code"] },
  },
  openagents: {
    desc: "OpenAgents — multi-agent launcher + dashboard (openagents.org)",
    // The package installs three identical bins — `agn`, `openagents`, and
    // `agent-connector`. Take the descriptive one: `agn` is short enough to
    // collide with something else on a machine we don't control.
    bin: "openagents",
    // Not a coding agent of its own: it launches and supervises the engines
    // above, so it has no approvals to bypass and no yolo flag to pass. A bare
    // launch opens the interactive dashboard, which IS its agent list, so both
    // `/agents openagents` and `moshcode start openagents` land in the same
    // place. (No `agentsView` for the same reason — it would spell the same
    // empty argv twice.)
    agentArgs: [],
    install: { cmd: "bash", args: ["-c", "curl -fsSL https://openagents.org/install.sh | bash"] },
    // Its own updater ("upgrade launcher to the latest npm release"), which
    // knows it was installed as an unpacked tarball under ~/.openagents rather
    // than by npm -g. Re-running the installer would work too, but it re-does
    // the Node bootstrap and ends on the pairing prompt below.
    upgrade: { cmd: "openagents", args: ["update"] },
    // The installer unpacks to ~/.openagents/nodejs and writes the bin shims
    // there, appending that directory to a shell rc — so PATH will not see
    // `openagents` until the next shell, including in the moshcode session that
    // just installed it.
    binDirs: [path.join(homedir(), ".openagents", "nodejs", "node_modules", ".bin")],
    // No `state`: the dashboard is a blessed TUI with no wording of its own we
    // have verified, and a guessed pattern is worse than the shared ones.
    //
    // The installer ends by offering to pair this device with a workspace, and
    // waits on a real answer — but only when stderr is a terminal, and Enter
    // skips it. `moshcode install` inherits the terminal, so that prompt is
    // yours to answer; run it where you can reach a keyboard.
  },
  aider: {
    desc: "Aider — pair-programming in your terminal",
    bin: "aider",
    agentArgs: ["--yes-always"],
    install: { cmd: "bash", args: ["-c", "curl -LsSf https://aider.chat/install.sh | sh"] },
    upgrade: { cmd: "aider", args: ["--upgrade"] },
    state: {
      // aider asks in prose and answers in (Y)es/(N)o, which the shared y/n
      // pattern misses because of the parentheses around the letters.
      blocked: [/\((?:Y\)es|N\)o)/, /\badd .* to the chat\?/i],
    },
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
  "qwen-code": "qwen", qwencode: "qwen", alibaba: "qwen",
  // `dsc` and `deepseek-code` are the binary names the package installs; accept
  // both as engine names so whichever one someone has seen resolves.
  ds: "deepseek", dsc: "deepseek", "deepseek-code": "deepseek",
  // Same idea for openagents: `agn` and `agent-connector` are the other two
  // binary names its package installs, and the domain is how it's advertised.
  oa: "openagents", agn: "openagents", "agent-connector": "openagents", "openagents.org": "openagents",
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
  qwen: (p) => ["-p", p],                                    // qwen prompt mode (gemini-derived)
  deepseek: (p) => ["--headless", "-p", p],                  // deepseek: -p runs one prompt and exits; --headless drops the TUI so stdout is pipe-clean
  // openagents is absent on purpose: it answers no prompts itself, it starts
  // the engines that do. ai() throws a named error rather than picking it.
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
  const order = preferred ? (wanted ? [wanted] : []) : ["claude", "codex", "opencode", "privacycode", "gemini", "kimi", "qwen", "deepseek", "aider"];
  for (const key of order) {
    if (Object.hasOwn(ENGINES, key) && Object.hasOwn(AI_EXEC, key) && isInstalled(ENGINES[key].bin, ENGINES[key].binDirs)) return key;
  }
  return null;
}

/** Engine entries annotated with install status. */
export function engineStatus() {
  // Search each engine's own install dir as well as PATH — several curl-based
  // installers only add their bin directory to a shell rc, so PATH alone
  // reports them missing in the very session that installed them. (Inert for
  // engines without binDirs.)
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
 *
 * With `{ capture: true }` the child's stdout/stderr are piped and *echoed
 * through* rather than inherited, and the combined text comes back as `output`.
 * The terminal still sees exactly what it saw before — the tee exists so a
 * caller can read the engine's own words about *why* it exited non-zero, which
 * a bare exit code cannot tell apart (see `alreadyRegistered` in mcp.mjs).
 * Inherit stays the default: piping costs a couple of streams, and every other
 * caller runs installers whose output nobody needs to parse.
 *
 * stdin is inherited either way, so a child that prompts still reaches the user.
 */
export function runCmd(cmd, args = [], { capture = false } = {}) {
  return new Promise((resolve) => {
    let child;
    const spec = spawnSpec(cmd, args);
    const stdio = capture ? ["inherit", "pipe", "pipe"] : "inherit";
    try { child = spawn(spec.cmd, spec.args, { stdio }); }
    catch (e) { resolve({ ok: false, error: e }); return; }
    let output = "";
    if (capture) {
      for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
        stream?.on("data", (chunk) => { output += chunk.toString(); sink.write(chunk); });
      }
    }
    child.on("error", (e) => resolve({ ok: false, error: e, output }));
    // "exit" fires as soon as the process is gone, which with pipes can leave
    // the last chunk still queued — the one line we are trying to read. "close"
    // waits for the streams too. With stdio inherited there are no streams, so
    // the two are the same moment and existing callers are unaffected; the
    // distinction is kept explicit so neither branch changes by accident.
    child.on(capture ? "close" : "exit", (code, signal) => resolve({ ok: true, code, signal, output }));
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
