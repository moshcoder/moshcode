// The moshcode shell — run `moshcode` with no args. A metal prompt that opens
// passthrough sessions on any engine via `/agents <engine>`, installs engines,
// and runs moshscript. Each session hands the whole terminal to the engine's own
// CLI and takes it back on exit.
import readline from "node:readline";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENGINES, resolveEngine, engineStatus, openSession } from "./engines.mjs";
import { createPrd, listPrds, authoringPrompt } from "./prd.mjs";
import { compile, run } from "./interpreter.mjs";
import { defaultCommands } from "./commands.mjs";
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

function printEngines() {
  console.log(bone("  engines") + ash("  — open one with ") + acid("/agents <name>"));
  for (const e of engineStatus()) {
    const dot = e.installed ? acid("●") : ash("○");
    console.log(`   ${dot} ${bone(e.key.padEnd(9))} ${ash(e.installed ? "installed" : "not installed — /install " + e.key)}`);
  }
}

function printHelp() {
  console.log([
    bone("  commands"),
    `   ${acid("/agents")}            list coding engines`,
    `   ${acid("/agents <name>")}     open a session (claude · codex · gemini · aider · opencode)`,
    `   ${acid("/install <name>")}    install an engine`,
    `   ${acid("/prd [idea]")}        publish a numbered PRD (OpenPRD), or list them with no arg`,
    `   ${acid("/run <file.mosh>")}   run a moshscript program`,
    `   ${acid("/help")}              this`,
    `   ${acid("/quit")}              leave the pit  (or Ctrl-D)`,
    "",
    ash("  shortcut: type an engine name by itself, e.g. ") + acid("claude"),
  ].join("\n"));
}

async function openEngine(key, engine, args) {
  if (!engine.installed && !args.length) {
    console.log(info(`${key} isn't installed — try ${acid("/install " + key)} first.`));
  }
  console.log(info(`opening ${bone(key)} — hand-off to its CLI, exit it to come back…`));
  console.log(hr());
  const r = await openSession(engine, args);
  console.log(hr());
  if (!r.ok) {
    console.log(r.error?.code === "ENOENT"
      ? err(`${key} isn't on PATH (\`${engine.bin}\`). install it with /install ${key}`)
      : err(`couldn't launch ${key}: ${r.error?.message || r.error}`));
  } else {
    console.log(info(`${key} exited${r.code != null ? ` (code ${r.code})` : ""}. back in the pit.`));
  }
}

function installEngine(key) {
  return new Promise((resolve) => {
    const engine = ENGINES[key];
    if (!engine) { console.log(err(`unknown engine "${key}"`)); return resolve(); }
    console.log(info(`installing ${key}: ${engine.install.cmd} ${engine.install.args.join(" ")}`));
    console.log(hr());
    const child = spawn(engine.install.cmd, engine.install.args, { stdio: "inherit" });
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

async function runFile(file) {
  let src;
  try { src = fs.readFileSync(file, "utf8"); }
  catch (e) { console.log(err(`can't read ${file}: ${e.message}`)); return; }
  let ast;
  try { ast = compile(src); } catch (e) { console.log(err(String(e.message || e))); return; }
  console.log(hr());
  const ctx = { vars: { alive: true }, iter: 0, maxIterations: 100000, out: (s) => console.log(s), commands: defaultCommands() };
  try { await run(ast, ctx); } catch (e) { console.log(err(String(e.message || e))); }
  console.log(hr());
  console.log(info(`moshscript done — ${ctx.iter} loop(s).`));
}

export async function tui() {
  console.log(banner());
  console.log();
  printEngines();
  console.log("\n" + ash("  /help for commands · /quit to leave") + "\n");

  let rl = mkrl();
  for (;;) {
    let line;
    try { line = await ask(rl); } catch { break; }
    if (line == null) break; // Ctrl-D
    line = line.trim();
    if (!line) continue;
    saveHistory(); // readline just recorded this line into the shared history

    const [raw, ...rest] = line.split(/\s+/);
    const cmd = raw.toLowerCase().replace(/^\//, "");

    if (cmd === "quit" || cmd === "exit" || cmd === "q") break;
    if (cmd === "help" || cmd === "?" || cmd === "h") { printHelp(); continue; }
    if (cmd === "run") {
      if (!rest[0]) { console.log(err("usage: /run <file.mosh>")); continue; }
      await runFile(rest[0]);
      continue;
    }
    if (cmd === "install") {
      if (!rest[0]) { console.log(err("usage: /install <engine>")); continue; }
      rl.close();
      await installEngine(rest[0].toLowerCase());
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
      await openEngine(key, { ...engine, installed: engineStatus().find((e) => e.key === key)?.installed }, rest.slice(1));
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
    console.log(err(`unknown command "${line}". /help for the list.`));
  }

  try { rl.close(); } catch { /* noop */ }
  saveHistory();
  console.log("\n" + ash("code hard, mosh harder. 🤘"));
}
