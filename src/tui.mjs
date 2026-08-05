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
import { tradeArgs, tradeUsage } from "./trade.mjs";
import { runUpgrade } from "./upgrade.mjs";
import { locate, tilde } from "./pwd.mjs";
import { createPrd, listPrds, authoringPrompt } from "./prd.mjs";
import { loginAuto, whoami, logout } from "./auth.mjs";
import { createMirror, teeOutput } from "./mirror.mjs";
import { fetchMotdAd } from "./ads.mjs";
import { runScript } from "./runtime.mjs";
import { moshVocabulary } from "./commands.mjs";
import { mcpCommand, skillCommand } from "./integrations.mjs";
import { banner, hr, acid, ash, bone, dim, ok, err, warn, info, moshcodeVersion } from "./ui.mjs";
import { CORE_CLI_COMMAND_NAMES } from "./cli-schema.mjs";
import { findPitCommand, pitHelpModel, renderPitCommand, suggest, wantsHelp } from "./help.mjs";
import { openNewTab } from "./tabs.mjs";

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
    // Owner-only, like credentials.json: the pit records whatever was typed at
    // the prompt, and that includes secrets by design — `/mcp install <url> -H
    // "Authorization: Bearer …"`, `/secrets`, `/coinpay`, and `!` shell escapes.
    fs.writeFileSync(HISTORY_FILE, history.slice(0, HISTORY_MAX).join("\n") + "\n", { mode: 0o600 });
    // `mode` only applies when the file is created, so a history file that
    // already exists keeps whatever the umask gave it (0644 on most systems).
    // Tighten it every save so existing installs get fixed too.
    fs.chmodSync(HISTORY_FILE, 0o600);
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
  const input = String(line);
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (escaped) {
      value += char;
      escaped = false;
      started = true;
    } else if (char === "\\" && quote !== "'") {
      const next = input[i + 1];
      if (quote === '"' && next !== '"' && next !== "\\") {
        value += char;
        started = true;
        continue;
      }
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

// Everything after the first word of a command line, exactly as typed. `/shell`
// hands this straight to `$SHELL -c`, the same way `!cmd` does: the shell does
// its own parsing, so re-joining the tokenized parts would strip the user's
// quotes and escapes and silently split `-m "two words"` into two arguments.
function commandRemainder(line) {
  const firstWord = /^\s*\S+\s*/.exec(String(line));
  return firstWord ? String(line).slice(firstWord[0].length).trim() : "";
}

function printEngines() {
  console.log(bone("  engines") + ash("  — autonomous ") + acid("/agents <name>") + ash(" · raw ") + acid("/start <name>"));
  for (const e of engineStatus()) {
    const dot = e.installed ? acid("●") : ash("○");
    console.log(`   ${dot} ${bone(e.key.padEnd(9))} ${ash(e.installed ? "installed" : "not installed — /install " + e.key)}`);
  }
}

function printTools() {
  // Named generically rather than listing every tool: the roster grows, and a
  // hardcoded list here silently goes stale the moment TOOLS gains an entry.
  console.log(bone("  tools") + ash("    — run one with ") + acid("/<name>") + ash(", e.g. ") + acid("/gh"));
  for (const tool of toolStatus()) {
    const dot = tool.installed ? acid("●") : ash("○");
    console.log(`   ${dot} ${bone(tool.key.padEnd(9))} ${ash(tool.installed ? "installed" : "not installed — /install " + tool.key)}`);
  }
  console.log(ash("   the primary dev toolchain runs through moshcode as a dev.profullstack.com user"));
  console.log(ash("   → ") + acid("https://dev.profullstack.com/"));
}

/**
 * The moshscript vocabulary, split the way the CLI's help splits it.
 *
 * A verb that is also a CLI command shells out; everything else is local to the
 * script. Deriving the split from TOOLS + the command table means a tool added
 * to the roster cannot be misfiled here as a local verb.
 */
/**
 * Group `items` into lines whose joined length stays under `width`.
 *
 * Works on the bare strings, before any colour is applied — measuring a string
 * that already contains ANSI escapes counts the escapes as width and wraps far
 * too early.
 */
function wrapPlain(items, width) {
  const lines = [[]];
  let length = 0;
  for (const item of items) {
    const cost = item.length + 3; // " · "
    if (length + cost > width && lines[lines.length - 1].length) {
      lines.push([]);
      length = 0;
    }
    lines[lines.length - 1].push(item);
    length += cost;
  }
  return lines.filter((l) => l.length);
}

function vocabulary() {
  const cliVerbs = new Set([...CORE_CLI_COMMAND_NAMES, ...Object.keys(TOOLS)]);
  const all = moshVocabulary().all().map((c) => c.name);
  return {
    local: all.filter((n) => !cliVerbs.has(n)),
    cli: all.filter((n) => cliVerbs.has(n)),
  };
}

/**
 * `/help`, rendered from the schema (PRD 0006 R12).
 *
 * Every tool name used to be typed out here — `/railway /gh /supabase …` —
 * immediately below a printTools() whose own comment explains why hardcoding
 * the roster goes stale. It had already: `/logout` has been dispatched forever
 * and appeared nowhere, and nothing said that `/dns` and `/console` do not
 * exist in the pit at all, so their absence read as an oversight rather than a
 * fact.
 *
 * `topic` renders one command instead of the list.
 */
function printHelp(topic = null) {
  if (topic) {
    const block = renderPitCommand(topic);
    if (!block) {
      const near = suggest(String(topic).replace(/^\//, ""),
        [...Object.keys(ENGINES), ...Object.keys(TOOLS)]);
      console.log(err(`no help for "${topic}"${near ? ` — did you mean /${near}?` : ""}`));
      console.log(ash("   /help for the list"));
      return;
    }
    console.log(block.split("\n").map((l) => `  ${l}`).join("\n"));
    return;
  }

  const model = pitHelpModel({ engines: Object.keys(ENGINES), tools: Object.keys(TOOLS) });
  const USAGE_COL = 30;
  const rows = model.commands.map((c) => {
    const alias = c.aliases.length ? ash(`  (${c.aliases.map((a) => `/${a}`).join(" ")})`) : "";
    // A usage longer than the column gets its description on the next line
    // rather than shunting it off the right edge.
    return c.usage.length > USAGE_COL
      ? `   ${acid(c.usage)}\n   ${" ".repeat(USAGE_COL)} ${ash(c.description)}${alias}`
      : `   ${acid(c.usage.padEnd(USAGE_COL))} ${ash(c.description)}${alias}`;
  });

  /** A roster, wrapped so a growing list never runs off an 80-column terminal. */
  const roster = (items, colour = acid) =>
    wrapPlain(items, 62).map((line) => line.map((i) => colour(i)).join(ash(" · ")));

  console.log([
    bone("  commands") + ash("  — one in detail with ") + acid("/help <command>"),
    ...rows,
    "",
    ...roster(model.engines.map((e) => `/${e}`)).map((l, i) =>
      (i ? "            " : bone("  engines") + "   ") + l),
    ...roster(model.tools.map((t) => `/${t}`)).map((l, i) =>
      (i ? "            " : bone("  tools") + "     ") + l),
    ash("             a bare engine or tool name runs it — flags after it are its own"),
    "",
    bone("  not in the pit") + ash(" — CLI-only:"),
    ...roster(model.notInPit.map((c) => `moshcode ${c.name}`), ash).map((l) => `   ${l}`),
    "",
    bone("  moshscript") + ash("  — secretly all JS is legal"),
    ash("   .mosh files are real JavaScript with the command vocabulary injected."),
    // Derived, for the same reason the tool roster is: these were three
    // hand-typed lines that the vocabulary had already outgrown.
    ...wrapPlain(vocabulary().local.map((n) => `${n}()`), 62)
      .map((line, i) => (i ? ash("                ") : ash("   local verbs: ")) + acid(line.join(" "))),
    ...wrapPlain(vocabulary().cli.map((n) => `${n}()`), 62)
      .map((line, i) => (i ? ash("                ") : ash("   CLI verbs:   ")) + acid(line.join(" "))),
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

// The live mirror for this pit, once /sessions is watching. Module-level so the
// engine/tool hand-offs can flag who owns the terminal without threading it
// through every call.
let activeMirror = null;

/**
 * Where a child's output should be copied to: the live mirror, or nowhere.
 *
 * teeOutput only sees what *this* process prints; a child launched with
 * `stdio: "inherit"` writes straight to the tty and is invisible to it. Handing
 * this sink down lets the launcher capture the child through a pty instead (see
 * src/pty.mjs). Returning undefined when nothing is watching is what keeps
 * unmirrored sessions on the untouched `inherit` path.
 */
const childSink = () => (activeMirror ? (chunk) => activeMirror?.write(chunk) : undefined);

async function openEngine(key, engine, args, { agentMode = false } = {}) {
  if (!engine.installed && !args.length) {
    console.log(info(`${key} isn't installed — try ${acid("/install " + key)} first.`));
  }
  if (agentMode) {
    // An agent view is just a listing — plain info. Anything else means the
    // engine's own approval prompts are gone, which is worth a warning.
    const note = `agent mode: ${key} ${agentLaunchArgs(engine).join(" ")}`;
    console.log(engine.agentsView
      ? info(`${note} — opening its agent view.`)
      : warn(`${note} — native approvals/permissions are bypassed or auto-approved.`));
  }
  console.log(info(`opening ${bone(key)}${agentMode ? " autonomously" : " raw"} — hand-off to its CLI, exit it to come back…`));
  console.log(hr());
  activeMirror?.setEngine(key);
  const r = await openSession(engine, agentMode ? agentLaunchArgs(engine, args) : args, { onOutput: childSink() });
  activeMirror?.setEngine(null);
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
  const result = await openTool(tool, args, { onOutput: childSink() });
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
    // Own properties only — `/install constructor` must print the unknown-target
    // line, not resolve to something off Object.prototype and crash the pit.
    const target = (Object.hasOwn(ENGINES, key) && ENGINES[key]) || (Object.hasOwn(TOOLS, key) && TOOLS[key]);
    if (!target) { console.log(err(`unknown engine or tool "${key}"`)); return resolve(); }
    console.log(info(`installing ${key}: ${target.install.cmd} ${target.install.args.join(" ")}`));
    console.log(hr());
    const child = spawn(target.install.cmd, target.install.args, { stdio: "inherit" });
    child.on("error", (e) => {
      console.log(hr());
      console.log(err(`install failed: ${e.message}`));
      if (e.code === "ENOENT" && target.installHelp) console.log(info(target.installHelp));
      resolve();
    });
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
  let optionsEnded = false;
  const argv = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!optionsEnded && a === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && (a === "--max" || a === "-n")) {
      const v = Number(args[++i]);
      if (!Number.isSafeInteger(v) || v < 1) { console.log(err(`--max needs a positive integer`)); return; }
      max = v;
    } else if (!optionsEnded && a.startsWith("--max=")) {
      const v = Number(a.slice("--max=".length));
      if (!Number.isSafeInteger(v) || v < 1) { console.log(err(`--max needs a positive integer`)); return; }
      max = v;
    } else if (!optionsEnded && a === "--dry-run") {
      dryRun = true;
    } else if (!optionsEnded && a.startsWith("-") && !file) {
      console.log(err(`unknown option ${a}`));
      return;
    } else if (!file) {
      file = a;
    } else {
      argv.push(a);
    }
  }
  if (!file) { console.log(err("usage: /run <file.mosh> [--max N] [--dry-run]")); return; }

  let src;
  try { src = fs.readFileSync(file, "utf8"); }
  catch (e) { console.log(err(`can't read ${file}: ${e.message}`)); return; }
  console.log(hr());
  if (dryRun) console.log(info("dry run — narrating without executing"));
  let result = { iterations: 0 };
  const opts = { commands: moshVocabulary(), dryRun, argv, out: (s) => console.log(s) };
  if (max !== undefined) opts.max = max;
  try {
    result = await runScript(src, opts);
  } catch (e) { console.log(err(String(e.message || e))); }
  console.log(hr());
  console.log(info(`moshscript done — ${result.iterations} loop(s).`));
}

export async function tui() {
  // In flight while the banner renders, so the MOTD costs no visible startup
  // time. Skipped for piped runs — nobody is reading an ad in a test harness.
  const motd = process.stdin.isTTY ? fetchMotdAd() : Promise.resolve(null);

  console.log(banner());
  console.log();
  printEngines();
  console.log();
  printTools();
  console.log("\n" + ash("  /help for commands · /new for a tab · /quit to leave") + "\n");

  const ad = await motd;
  if (ad) console.log(dim(ad) + "\n");

  const { restoreTee, drainRemote, atPrompt } = await startMirror();

  let rl = mkrl();
  for (;;) {
    let line;
    // Arm the prompt first, THEN release any command waiting from the web:
    // rl.write() only lands as input once readline is actually asking.
    const answer = ask(rl);
    atPrompt(rl);
    drainRemote();
    try { line = await answer; } catch { break; }
    finally { atPrompt(null); }
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
    if (cmd === "help" || cmd === "?" || cmd === "h") { printHelp(rest[0] || null); continue; }

    // `/<command> --help` answers here, before the command runs (PRD 0006 R1,
    // R12) — the same rule the CLI follows, so `/prd --help` cannot publish a
    // PRD any more than `moshcode prd --help` can. Only for the pit's own
    // verbs: after an engine or tool name the flag is theirs, so `/gh --help`
    // still reaches gh.
    if (findPitCommand(cmd) && wantsHelp(rest, { stopAt: cmd === "run" })) {
      printHelp(cmd);
      continue;
    }
    if (cmd === "new") {
      if (rest.length) { console.log(err("usage: /new")); continue; }
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(err("/new needs an interactive terminal"));
        continue;
      }
      rl.close();
      console.log(info(process.env.TMUX
        ? "opening a new mosh tab — switch with your tmux window keys…"
        : "opening a two-tab mosh workspace — switch with Ctrl-b n/p or Ctrl-b <number>…"));
      const result = await openNewTab();
      if (!result.ok) {
        console.log(err(`can't open a tab: ${result.error?.message || result.error}`));
        console.log(ash("   /new uses tmux so every provider CLI still owns a real terminal"));
      }
      rl = mkrl();
      continue;
    }
    if (cmd === "pwd" || cmd === "where") { printPwd(); continue; }
    if (cmd === "login") {
      const device = rest.includes("--device") || rest.includes("device") || rest.includes("-d");
      const browser = rest.includes("--browser") || rest.includes("browser") || rest.includes("-b");
      try { const { email } = await loginAuto({ device, browser }); console.log(ok(`logged in${email ? ` as ${email}` : ""} 🤘`)); }
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
      const rawCmd = commandRemainder(line);
      rl.close();
      await openShell(rawCmd || null);
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
      // createPrd writes prd/ under the cwd, so it can throw for reasons that have
      // nothing to do with the session: prd/ already taken by a regular file, a
      // read-only checkout, a full disk. Report it and go back to the prompt like
      // every sibling command does — an unguarded throw here escapes the loop and
      // takes the whole REPL down, losing the session over one bad cwd.
      let created;
      try { created = createPrd(idea); }
      catch (e) { console.log(err(`can't publish the PRD: ${String(e.message || e)}`)); continue; }
      const { id, slug, path: file, existed, bootstrapped } = created;
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
    if (cmd === "trade") {
      const translated = tradeArgs(rest);
      if (translated.usage) { console.log(tradeUsage()); continue; }
      if (translated.error) { console.log(err(translated.error)); continue; }
      rl.close();
      const tool = TOOLS.alpaca;
      await openWorkflowTool("alpaca", {
        ...tool,
        installed: toolStatus().find((entry) => entry.key === "alpaca")?.installed,
      }, translated.args);
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
  await stopMirror(restoreTee);
}

/**
 * Bring up the live mirror (app.moshcode.sh/sessions) for this pit: register
 * the session, tee everything we print to it, and hold commands typed on the
 * web until the prompt is ready for them.
 *
 * Entirely optional — not logged in, or the app unreachable, and the pit runs
 * exactly as before.
 */
async function startMirror() {
  const noop = { restoreTee: null, drainRemote: () => {}, atPrompt: () => {} };
  // Only mirror a real interactive pit. A piped or scripted run (tests, CI,
  // `echo /quit | moshcode`) has no human to watch from a browser, and the
  // long-poll would keep that process alive long after its input ran out.
  if (!process.stdin.isTTY || process.env.MOSHCODE_NO_MIRROR) return noop;

  let mirror;
  try { mirror = createMirror({ version: moshcodeVersion() || "", cwd: process.cwd() }); }
  catch { return noop; }

  let started = false;
  try { started = await mirror.start(); } catch { started = false; }
  if (!started) return noop;

  activeMirror = mirror;
  const restoreTee = teeOutput((chunk) => mirror.write(chunk));

  // Commands arrive whenever; the prompt is only ready between engine
  // hand-offs. Queue them and replay in order once readline is asking.
  const queue = [];
  let promptRl = null;
  const drainRemote = () => {
    // Exactly one per prompt: readline resolves the pending question with the
    // first line it sees, so writing a second here would be swallowed. The
    // loop re-arms and drains the next one on its way round.
    if (promptRl && queue.length) {
      const body = queue.shift();
      // Echo it so the mirror (and the person at the keyboard) can see that
      // this line came from the web rather than the local keyboard.
      console.log(ash(`  ▸ (web) ${body}`));
      promptRl.write(`${body}\n`);
    }
  };
  mirror.onCommand((body) => { queue.push(body); drainRemote(); });

  console.log(info(`mirroring this session → ${acid(mirror.url)}`));
  return { restoreTee, drainRemote, atPrompt: (rl) => { promptRl = rl; } };
}

async function stopMirror(restoreTee) {
  const mirror = activeMirror;
  activeMirror = null;
  try { restoreTee?.(); } catch { /* noop */ }
  try { await mirror?.stop(); } catch { /* best effort */ }
}
