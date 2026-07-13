// The moshcode shell — run `moshcode` with no args. A metal prompt that opens
// passthrough sessions on any engine via `/agents <engine>`, installs engines,
// and runs moshscript. Each session hands the whole terminal to the engine's own
// CLI and takes it back on exit.
import readline from "node:readline";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENGINES, agentLaunchArgs, resolveEngine, engineStatus, openSession } from "./engines.mjs";
import { TOOLS, resolveTool, toolStatus, openTool } from "./tools.mjs";
import { runUpgrade } from "./upgrade.mjs";
import { locate, tilde } from "./pwd.mjs";
import { createPrd, listPrds, authoringPrompt } from "./prd.mjs";
import { login, whoami, logout } from "./auth.mjs";
import { runScript } from "./runtime.mjs";
import { moshVocabulary } from "./commands.mjs";
import { mcpCommand, skillCommand } from "./integrations.mjs";
import { banner, hr, acid, ash, bone, dim, ok, err, info } from "./ui.mjs";

const PROMPT = () => acid("mosh ") + dim("▸ ");

// Command history for ↑/↓ recall. We recreate the readline interface around
// every engine session/install (a passthrough child owns the terminal), which
// would otherwise reset readline's own history each time — so we keep one shared
// array (newest-first, the order readline maintains) and persist it between runs.
const HISTORY_FILE = path.join(os.homedir(), ".moshcode_history");
const HISTORY_MAX = 500;
const history = loadHistory();

function loadHistory() {
  try {
    return fs.readFileSync(HISTORY_FILE, "utf8").split("\n").filter(Boolean).slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}
function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, history.slice(0, HISTORY_MAX).join("\n") + "\n");
  } catch {
    /* best effort — history is a convenience, never fatal */
  }
}

const mkrl = () => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    // Enable line-editing/history only with a real TTY (arrow keys need raw
    // mode); piped input has no raw mode and would throw.
    terminal: Boolean(process.stdin.isTTY),
    historySize: HISTORY_MAX,
    removeHistoryDuplicates: true,
  });
  // Share the persistent array so ↑/↓ recalls earlier commands even after the
  // interface was torn down and rebuilt around an engine session.
  rl.history = history;
  return rl;
};
const ask = (rl) => new Promise((res) => rl.question(PROMPT(), res));

// Small shell-like tokenizer for TUI commands. It keeps quoted values such as
// `/coinpay card pay --description "Fix the build"` as one native CLI argument
// without invoking a shell or performing expansions.
export function splitCommandLine(line) {
  const parts = [];
  let value = "", quote = null, escaped = false, started = false;
  for (const char of String(line)) {
    if (escaped) {
      value += char;
      escaped = false;
      started = true;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else value += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        parts.push(value);
        value = "";
        started = false;
      }
    } else {
      value += char;
      started = true;
    }
  }
  if (escaped) throw new Error("trailing escape");
  if (quote) throw new Error(`unterminated ${quote} quote`);
  if (started) parts.push(value);
  return parts;
}

function printEngines() {
  console.log(bone("  engines") + ash("  — autonomous ") + acid("/agents <name>") + ash(" · raw ") + acid("/start <name>"));
  for (const e of engineStatus()) {
    const dot = e.installed ? acid("●") : ash("○");
    console.log(`   ${dot} ${bone(e.key.padEnd(9))} ${ash(e.installed ? "installed" : "not installed — /install " + e.key)}`);
  }
}

function printTools() {
  console.log(bone("  tools") + ash("    — run one with ") + acid("/ugig") + ash(", ") + acid("/coinpay") + ash(", or ") + acid("/c0mpute"));
  for (const tool of toolStatus()) {
    const dot = tool.installed ? acid("●") : ash("○");
    console.log(`   ${dot} ${bone(tool.key.padEnd(9))} ${ash(tool.installed ? "installed" : "not installed — /install " + tool.key)}`);
  }
}

function printHelp() {
  console.log([
    bone("  commands"),
    `   ${acid("/agents")}            list coding engines`,
    `   ${acid("/agents <name>")}     autonomous launch; bypass/auto-approve native permissions`,
    `   ${acid("/start <name>")}      raw launch; inject no engine arguments`,
    `   ${acid("/tools")}             list workflow tools (ugig · coinpay · c0mpute)`,
    `   ${acid("/ugig [args…]")}      hand off to the native UGig CLI`,
    `   ${acid("/coinpay [args…]")}   hand off to the native CoinPay CLI`,
    `   ${acid("/c0mpute [args…]")}   hand off to the native c0mpute CLI`,
    `   ${acid("/mcp install <url>")} register an MCP server across every engine that supports it`,
    `   ${acid("/skill install <url>")} install a skill across every engine that supports it`,
    `   ${acid("/install <name>")}    install an engine or workflow tool`,
    `   ${acid("/upgrade [name…]")}   update moshcode + installed engines/tools (or named targets)`,
    `   ${acid("/pwd")}                show the current dir + git repo/branch/origin`,
    `   ${acid("/shell [cmd]")}        drop into $SHELL (exit → back to the pit); also ${acid("!cmd")}`,
    `   ${acid("/prd [idea]")}        publish a numbered PRD (OpenPRD), or list them with no arg`,
    `   ${acid("/run <file.mosh>")}   run a moshscript [--max N] [--dry-run]`,
    `   ${acid("/help")}              this`,
    `   ${acid("/quit")}              leave the pit  (or Ctrl-D)`,
    "",
    bone("  moshscript") + ash("  — secretly all JS is legal"),
    ash("   .mosh files are real JavaScript with the command vocabulary injected."),
    ash("   local verbs: ") + acid("code() mosh() notify() ask() say() sleep() stop() repeat()"),
    ash("   CLI verbs:   ") + acid("agents() start() install() upgrade() mcp() skill() prd()"),
    ash("               ") + acid("ugig() coinpay() c0mpute() pwd() run() shell()"),
    ash("   shebang:     ") + acid("#!/usr/bin/env moshscript") + ash("  (chmod +x to self-run)"),
    "",
    ash("  raw shortcuts: type an engine or tool name by itself, e.g. ") + acid("claude") + ash(" or ") + acid("ugig"),
  ].join("\n"));
}

function printPwd() {
  const { cwd, home, git } = locate();
  console.log("  " + bone(tilde(cwd, home)));
  if (git) {
    console.log("  " + ash("repo   ") + acid(git.name) + (git.branch ? ash(" on ") + bone(git.branch) : ""));
    console.log("  " + ash("root   ") + tilde(git.root, home));
    if (git.origin) console.log("  " + ash("origin ") + ash(git.origin));
  } else {
    console.log("  " + ash("(not a git repo)"));
  }
}

async function upgradeAll(targets) {
  console.log(info(`upgrading ${bone("moshcode")} + installed engines/tools — hand-off to each updater…`));
  await runUpgrade(targets, { log: (s) => console.log(s), rule: () => console.log(hr()) });
}

async function openEngine(key, engine, args, { agentMode = false } = {}) {
  if (!engine.installed && !args.length) {
    console.log(info(`${key} isn't installed — try ${acid("/install " + key)} first.`));
  }
  if (agentMode) {
    console.log(err(`agent mode: ${key} ${agentLaunchArgs(engine).join(" ")}${engine.agentsView ? " — opening its agent view" : " — native approvals/permissions are bypassed or auto-approved"}.`));
  }
  console.log(info(`opening ${bone(key)}${agentMode ? " autonomously" : " raw"} — hand-off to its CLI, exit it to come back…`));
  console.log(hr());
  const r = await openSession(engine, agentMode ? agentLaunchArgs(engine, args) : args);
  console.log(hr());
  if (!r.ok) {
    console.log(r.error?.code === "ENOENT"
      ? err(`${key} isn't on PATH (\`${engine.bin}\`). install it with /install ${key}`)
      : err(`couldn't launch ${key}: ${r.error?.message || r.error}`));
  } else {
    console.log(info(`${key} exited${r.code != null ? ` (code ${r.code})` : ""}. back in the pit.`));
  }
}

async function openWorkflowTool(key, tool, args) {
  if (!tool.installed) {
    console.log(info(`${key} isn't installed — try ${acid("/install " + key)} first.`));
  }
  console.log(info(`opening ${bone(key)} — native CLI owns the terminal until it exits…`));
  console.log(hr());
  const result = await openTool(tool, args);
  console.log(hr());
  if (!result.ok) {
    console.log(result.error?.code === "ENOENT"
      ? err(`${key} isn't on PATH (\`${tool.bin}\`). install it with /install ${key}`)
      : err(`couldn't launch ${key}: ${result.error?.message || result.error}`));
  } else {
    console.log(info(`${key} exited${result.code != null ? ` (code ${result.code})` : result.signal ? ` (${result.signal})` : ""}. back in the pit.`));
  }
}

// Spawn the user's shell with the terminal fully handed over (stdio inherit),
// inheriting the current cwd + env. No args → an interactive shell; a raw
// command string → `$SHELL -c "<cmd>"` (one-off). Resolves { ok, code, signal }.
function runShell(rawCmd) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL
      || (process.platform === "win32" ? (process.env.COMSPEC || "cmd.exe") : "/bin/sh");
    const args = rawCmd ? ["-c", rawCmd] : [];
    let child;
    try { child = spawn(shell, args, { stdio: "inherit" }); }
    catch (e) { resolve({ ok: false, error: e }); return; }
    child.on("error", (e) => resolve({ ok: false, error: e }));
    child.on("exit", (code, signal) => resolve({ ok: true, code, signal }));
  });
}

// vim `:sh` — drop into a shell and land back at the mosh prompt on exit, with
// the whole TUI session (history, cwd) intact. `rawCmd` runs a one-off instead.
async function openShell(rawCmd) {
  const shellName = path.basename(process.env.SHELL || "sh");
  console.log(info(rawCmd
    ? `${bone(shellName)} ${ash("-c")} ${ash(rawCmd)}`
    : `dropping to ${bone(shellName)} — ${ash("`exit` or Ctrl-D brings you back to the pit")}`));
  console.log(hr());
  const r = await runShell(rawCmd);
  console.log(hr());
  if (!r.ok) {
    console.log(err(`couldn't start shell: ${r.error?.message || r.error}`));
  } else {
    console.log(info(`shell exited${r.code != null ? ` (code ${r.code})` : r.signal ? ` (${r.signal})` : ""}. back in the pit.`));
  }
}

function installTarget(key) {
  return new Promise((resolve) => {
    const target = ENGINES[key] || TOOLS[key];
    if (!target) { console.log(err(`unknown engine or tool "${key}"`)); return resolve(); }
    console.log(info(`installing ${key}: ${target.install.cmd} ${target.install.args.join(" ")}`));
    console.log(hr());
    const child = spawn(target.install.cmd, target.install.args, { stdio: "inherit" });
    child.on("error", (e) => { console.log(hr()); console.log(err(`install failed: ${e.message}`)); resolve(); });
    child.on("exit", (code) => { console.log(hr()); console.log(code === 0 ? ok(`${key} installed. 🤘`) : err(`install exited ${code}`)); resolve(); });
  });
}

// Prefer claude (its stripEnv keeps the session clean), else the first installed
// engine. Returns [key, engine] or null when nothing is installed.
function pickEngine() {
  const st = engineStatus();
  const chosen = st.find((e) => e.key === "claude" && e.installed) || st.find((e) => e.installed);
  return chosen ? [chosen.key, ENGINES[chosen.key]] : null;
}

function printPrds() {
  const prds = listPrds();
  if (!prds.length) { console.log(info(`no PRDs yet — ${acid("/prd <idea>")} to start one.`)); return; }
  console.log(bone("  PRDs") + ash("  — under prd/ (OpenPRD)"));
  for (const p of prds) {
    console.log(`   ${acid(p.id)} ${ash(p.status.padEnd(9))} ${bone(p.title)}`);
  }
}

async function runFile(args) {
  // Parse /run options the same way the CLI does (R3: two entrypoints agree).
  let max, dryRun = false, file = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--max" || a === "-n") {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v < 1) { console.log(err(`--max needs a positive integer`)); return; }
      max = v;
    } else if (a.startsWith("--max=")) {
      const v = Number(a.slice("--max=".length));
      if (!Number.isInteger(v) || v < 1) { console.log(err(`--max needs a positive integer`)); return; }
      max = v;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (!file) {
      file = a;
    }
  }
  if (!file) { console.log(err("usage: /run <file.mosh> [--max N] [--dry-run]")); return; }

  let src;
  try { src = fs.readFileSync(file, "utf8"); }
  catch (e) { console.log(err(`can't read ${file}: ${e.message}`)); return; }
  console.log(hr());
  if (dryRun) console.log(info("dry run — narrating without executing"));
  let result = { iterations: 0 };
  const opts = { commands: moshVocabulary(), dryRun, out: (s) => console.log(s) };
  if (max !== undefined) opts.max = max;
  try {
    result = await runScript(src, opts);
  } catch (e) { console.log(err(String(e.message || e))); }
  console.log(hr());
  console.log(info(`moshscript done — ${result.iterations} loop(s).`));
}

export async function tui() {
  console.log(banner());
  console.log();
  printEngines();
  console.log();
  printTools();
  console.log("\n" + ash("  /help for commands · /quit to leave") + "\n");

  let rl = mkrl();
  for (;;) {
    let line;
    try { line = await ask(rl); } catch { break; }
    if (line == null) break; // Ctrl-D
    line = line.trim();
    if (!line) continue;
    saveHistory(); // readline just recorded this line into the shared history

    // vim-style shell escape: `!` drops into $SHELL, `!<cmd>` runs one-off. We
    // take the raw remainder (not the tokenized parts) so quoting is preserved.
    if (line.startsWith("!")) {
      const rawCmd = line.slice(1).trim();
      rl.close();
      await openShell(rawCmd || null);
      rl = mkrl();
      continue;
    }

    let parts;
    try { parts = splitCommandLine(line); }
    catch (error) { console.log(err(`can't parse command: ${error.message}`)); continue; }
    const [raw, ...rest] = parts;
    const cmd = raw.toLowerCase().replace(/^\//, "");

    if (cmd === "quit" || cmd === "exit" || cmd === "q") break;
    if (cmd === "help" || cmd === "?" || cmd === "h") { printHelp(); continue; }
    if (cmd === "pwd" || cmd === "where") { printPwd(); continue; }
    if (cmd === "login") {
      try { const { email } = await login(); console.log(ok(`logged in${email ? ` as ${email}` : ""} 🤘`)); }
      catch (e) { console.log(err(String(e.message || e))); }
      continue;
    }
    if (cmd === "whoami") { await whoami(); continue; }
    if (cmd === "logout") { logout(); continue; }
    if (cmd === "run") {
      await runFile(rest);
      continue;
    }
    if (cmd === "shell" || cmd === "sh") {
      rl.close();
      await openShell(rest.length ? rest.join(" ") : null);
      rl = mkrl();
      continue;
    }
    if (cmd === "install") {
      if (!rest[0]) { console.log(err("usage: /install <engine|tool>")); continue; }
      rl.close();
      await installTarget(rest[0].toLowerCase());
      rl = mkrl();
      continue;
    }
    if (cmd === "upgrade" || cmd === "update") {
      rl.close();
      await upgradeAll(rest.map((r) => r.toLowerCase()));
      rl = mkrl();
      continue;
    }
    if (cmd === "prd") {
      if (!rest.length) { printPrds(); continue; }
      const idea = rest.join(" ");
      const { id, slug, path: file, existed, bootstrapped } = createPrd(idea);
      if (bootstrapped) console.log(info(`bootstrapped ${bone("prd/")} — README + 0000-template.md`));
      console.log(existed
        ? info(`PRD ${bone(id)} exists — opening an engine to keep editing ${ash(file)}`)
        : ok(`published ${bone(`prd/${id}-${slug}.md`)} ${ash("(committed — status: Draft)")}`));
      const eng = pickEngine();
      if (!eng) { console.log(info(`open an engine to fill it in — ${acid("/install claude")} then ${acid("/prd")} again.`)); continue; }
      const [key, engine] = eng;
      console.log(info(`handing ${bone(id)} to ${bone(key)} to author…`));
      rl.close();
      await openEngine(key, { ...engine, installed: true }, [authoringPrompt({ path: file, idea: existed ? "" : idea })]);
      rl = mkrl();
      continue;
    }
    if (cmd === "agents" || cmd === "agent" || cmd === "engines") {
      if (!rest[0]) { printEngines(); continue; }
      const resolved = resolveEngine(rest[0]);
      if (!resolved) { console.log(err(`unknown engine "${rest[0]}". try: ${Object.keys(ENGINES).join(", ")}`)); continue; }
      const [key, engine] = resolved;
      rl.close();
      await openEngine(
        key,
        { ...engine, installed: engineStatus().find((e) => e.key === key)?.installed },
        rest.slice(1),
        { agentMode: true },
      );
      rl = mkrl();
      continue;
    }
    if (cmd === "start") {
      if (!rest[0]) { console.log(err("usage: /start <engine> [args…]")); continue; }
      const resolved = resolveEngine(rest[0]);
      if (!resolved) { console.log(err(`unknown engine "${rest[0]}". try: ${Object.keys(ENGINES).join(", ")}`)); continue; }
      const [key, engine] = resolved;
      rl.close();
      await openEngine(key, { ...engine, installed: engineStatus().find((e) => e.key === key)?.installed }, rest.slice(1));
      rl = mkrl();
      continue;
    }
    if (cmd === "mcp") {
      rl.close();
      await mcpCommand(rest);
      rl = mkrl();
      continue;
    }
    if (cmd === "skill" || cmd === "skills") {
      rl.close();
      await skillCommand(rest);
      rl = mkrl();
      continue;
    }
    if (cmd === "tools") {
      if (!rest[0]) { printTools(); continue; }
      const resolved = resolveTool(rest[0]);
      if (!resolved) { console.log(err(`unknown tool "${rest[0]}". try: ${Object.keys(TOOLS).join(", ")}`)); continue; }
      const [key, tool] = resolved;
      rl.close();
      await openWorkflowTool(key, { ...tool, installed: toolStatus().find((entry) => entry.key === key)?.installed }, rest.slice(1));
      rl = mkrl();
      continue;
    }
    // Bare engine name → open it.
    const resolved = resolveEngine(cmd);
    if (resolved) {
      const [key, engine] = resolved;
      rl.close();
      await openEngine(key, { ...engine, installed: engineStatus().find((e) => e.key === key)?.installed }, rest);
      rl = mkrl();
      continue;
    }
    // Bare workflow-tool name (including `/ugig` and `/coinpay`) → run it.
    const resolvedTool = resolveTool(cmd);
    if (resolvedTool) {
      const [key, tool] = resolvedTool;
      rl.close();
      await openWorkflowTool(key, { ...tool, installed: toolStatus().find((entry) => entry.key === key)?.installed }, rest);
      rl = mkrl();
      continue;
    }
    console.log(err(`unknown command "${line}". /help for the list.`));
  }

  try { rl.close(); } catch { /* noop */ }
  saveHistory();
  console.log("\n" + ash("code hard, mosh harder. 🤘"));
}
