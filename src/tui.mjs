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
import { TOOLS, resolveTool, toolStatus, openTool, readToolAliases, toolsWithAliases } from "./tools.mjs";
import { tradeArgs, tradeUsage } from "./trade.mjs";
import { postSocial, socialRoster } from "./socials.mjs";
import { shortenCommand } from "./shorten.mjs";
import { runUpgrade } from "./upgrade.mjs";
import { locate, tilde } from "./pwd.mjs";
import { createPrd, listPrds, authoringPrompt } from "./prd.mjs";
import { loginAuto, whoami, logout } from "./auth.mjs";
import { startAutoSync } from "./autosync.mjs";
import { loadCommand, saveCommand } from "./settings-sync.mjs";
import { activeChildInput, createMirror, pressKey, setActiveSink, teeOutput } from "./mirror.mjs";
import { fetchMotdAd } from "./ads.mjs";
import { runScript } from "./runtime.mjs";
import { moshVocabulary } from "./commands.mjs";
import { mcpCommand, pluginCommand, skillCommand } from "./integrations.mjs";
import { stocksCommand } from "./advisor.mjs";
import { cryptoCommand } from "./crypto.mjs";
import { gamesCommand } from "./games.mjs";
import { canOpenBrowser, openBrowser } from "./open-url.mjs";
import { shellInvocation } from "./shell.mjs";
import { captureSpec } from "./pty.mjs";
import { needsRootHere, primeEscalation } from "./escalate.mjs";
import { banner, hr, acid, ash, bone, dim, ok, err, warn, info, moshcodeVersion } from "./ui.mjs";
import { CORE_CLI_COMMAND_NAMES } from "./cli-schema.mjs";
import { RENAMED_COMMANDS, findPitCommand, pitHelpModel, renderPitCommand, suggest, wantsHelp } from "./help.mjs";
import { openNewTab } from "./tabs.mjs";
import { MAX_EXPANSIONS, expandAlias, getAlias, loadAliases, mergeAliases, removeAlias, setAlias } from "./aliases.mjs";
import { herdCommand, herdStart, renderRoster, roster, splitDetachArgs } from "./herd-cli.mjs";
import { detectSubstrate, substrateNote } from "./herd.mjs";

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
// hands this straight to `$SHELL -ic`, the same way `!cmd` does: the shell does
// its own parsing, so re-joining the tokenized parts would strip the user's
// quotes and escapes and silently split `-m "two words"` into two arguments.
function commandRemainder(line, words = 1) {
  let out = String(line);
  for (let i = 0; i < words; i++) {
    const firstWord = /^\s*\S+\s*/.exec(out);
    out = firstWord ? out.slice(firstWord[0].length) : "";
  }
  return out.trim();
}

/**
 * The value half of `/alias set <name> <value…>`, as the user meant it.
 *
 * `/alias set gs "git status"` quotes the value because that is the obvious way
 * to write it, and `/alias set gc git commit -m "wip"` does not because the
 * quotes there belong to the shell. Tokenizing tells the two apart: exactly one
 * token means the whole value was quoted, so use it with the quotes stripped;
 * anything else is a bare command line, and it goes through verbatim so the
 * user's own quoting survives into `$SHELL -ic`.
 */
export function aliasValue(line) {
  const raw = commandRemainder(line, 3); // past "/alias", "set", "<name>"
  if (!raw) return "";
  let parts;
  try { parts = splitCommandLine(raw); }
  catch { return raw; }
  return parts.length === 1 ? parts[0] : raw;
}

function printEngines(json = false) {
  if (json) {
    console.log(JSON.stringify(engineStatus().map(({ key, desc, bin, installed }) => ({
      name: key,
      description: desc,
      binary: bin,
      installed,
    })), null, 2));
    return;
  }
  console.log(bone("  engines") + ash("  — autonomous ") + acid("/agents <name>") + ash(" · raw ") + acid("/start <name>"));
  for (const e of engineStatus()) {
    const dot = e.installed ? acid("●") : ash("○");
    console.log(`   ${dot} ${bone(e.key.padEnd(9))} ${ash(e.installed ? "installed" : "not installed — /install " + e.key)}`);
  }
}

/**
 * The herd, on the pit's front door.
 *
 * Printed before the prompt because "what is already running, and does any of
 * it want me?" is the first question on opening the pit, and until now the only
 * way to answer it was to remember. Silent when the herd is empty — a heading
 * over nothing is noise on every cold start.
 */
function printHerd() {
  const rows = roster();
  if (!rows.length) return;
  const blocked = rows.filter((r) => r.state === "blocked").length;
  console.log(bone("  herd") + ash(`     — ${rows.length} session${rows.length === 1 ? "" : "s"} · attach with `) + acid("/attach <name>"));
  console.log(renderRoster(rows, { indent: "   " }));
  if (blocked) console.log("   " + warn(`${blocked} waiting on you`));
}

/**
 * `-d` / `--name` on `/agents` and `/start`: run it in the herd instead of
 * handing over the terminal.
 *
 * Returns { taken, args }. `taken` means the herd has it and the caller should
 * skip its passthrough path; `args` is always the engine's own arguments with
 * the herd flags removed, so a box with no substrate falls back to a normal
 * foreground launch instead of passing `-d` on to an engine that has never
 * heard of it.
 */
function detachedLaunch(key, args, { agentMode = false } = {}) {
  const { detach, name, rest } = splitDetachArgs(args);
  if (!detach) return { taken: false, args: rest };
  if (!detectSubstrate()) {
    console.log(warn(substrateNote(null)));
    return { taken: false, args: rest };
  }
  herdStart([key, ...(name ? ["--name", name] : []), ...(agentMode ? ["--agent"] : []), ...rest]);
  return { taken: true, args: rest };
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

function printSocials() {
  console.log(bone("  socials") + ash("  — compose with ") + acid('/post <social> "message"'));
  for (const social of socialRoster()) {
    const aliases = social.aliases.length ? ` (${social.aliases.join(", ")})` : "";
    console.log(`   ${acid("●")} ${bone(social.name.padEnd(9))} ${ash(social.description + aliases)}`);
  }
  console.log(ash("   the browser always asks you to confirm before anything is published"));
}

/**
 * Is this name the pit's own?
 *
 * Asked by resolving it the way the dispatcher does, rather than by consulting
 * a list: the dispatcher checks pit verbs, then engines, then tools, and only
 * then aliases, so anything that resolves earlier would shadow an alias of the
 * same name into silence.
 */
function isReservedName(name) {
  const key = String(name).toLowerCase();
  return Boolean(findPitCommand(key) || resolveEngine(key) || resolveTool(key) || RENAMED_COMMANDS[key]);
}

function printAliases({ json = false } = {}) {
  const aliases = loadAliases();
  const names = Object.keys(aliases).sort();
  if (json) { console.log(JSON.stringify(aliases, null, 2)); return; }
  if (!names.length) {
    console.log(info(`no aliases yet — ${acid('/alias set gs "git status"')} then ${acid("/gs")}.`));
    return;
  }
  console.log(bone("  aliases") + ash("  — run one with ") + acid("/<name>") + ash(" · ") + acid("/alias rm <name>") + ash(" to forget"));
  const width = Math.max(...names.map((n) => n.length));
  for (const name of names) {
    // A leading slash marks the ones that are pit commands rather than shell,
    // which is the only thing about a value that is not already visible.
    const value = aliases[name];
    const kind = value.startsWith("/") ? ash("pit  ") : ash("shell");
    console.log(`   ${acid(`/${name}`.padEnd(width + 1))} ${kind} ${bone(value)}`);
  }
}

/**
 * `/alias install <tool>` — adopt the pit aliases a workflow tool offers.
 *
 * The tools in src/tools.mjs are separate products with their own release
 * cycles, and several of them ship a set of commands rather than one binary.
 * Which short words those deserve at this prompt is a question only the tool
 * can answer, and only moshcode can act on: the file is ours, so a tool that
 * wrote it directly would be reaching into a config it does not own — the same
 * objection that keeps `railway setup agent` out of /install.
 *
 * So the tool proposes and the pit disposes. Deliberately its own verb rather
 * than a step inside /install: writing the operator's aliases is a side effect
 * an install command has no business having, and the roster is worth adopting
 * long after the day a tool was installed.
 */
function aliasInstallCommand(args) {
  const all = args.includes("--all");
  const names = args.filter((a) => !a.startsWith("-"));
  if (!all && !names.length) {
    const offered = toolsWithAliases().map(([key]) => key);
    console.log(err("usage: /alias install <tool> | --all"));
    console.log(ash(offered.length
      ? `   tools that offer aliases: ${offered.join(", ")}`
      : "   no tool offers aliases yet"));
    return;
  }

  const wanted = all
    ? toolsWithAliases()
    : names.map((name) => [name, resolveTool(name)?.[1] ?? null]);

  // A run over --all reports per tool, because "3 added, 2 kept" for a roster
  // is the useful shape; a single named tool reports per alias, because those
  // are the words you are about to type.
  let touched = 0;
  for (const [key, tool] of wanted) {
    if (!tool) { console.log(err(`no tool named "${key}" — /tools for the roster`)); continue; }
    touched += adoptToolAliases(key, tool, { compact: all, quiet: false });
  }
  if (touched) console.log(ash("   run one with /<name> · /alias list for all of them"));
}

/**
 * Read one tool's proposed aliases, merge them, and say what happened.
 *
 * The one place that does this, because three surfaces need it: `/install` and
 * `/tools install` at the end of an install, `/upgrade` after a tool has gained
 * commands, and `/alias install` on its own. Returns how many names were added
 * so a caller can decide whether the run is worth a closing line.
 *
 * `quiet` is what makes it safe to hang off an install: a tool that offers
 * nothing, or that cannot be asked, must not print a failure after a install
 * that actually succeeded. Only real adoptions and genuine surprises speak up.
 */
function adoptToolAliases(key, tool, { compact = false, quiet = false } = {}) {
  const label = acid(`/${key}`);
  if (!tool?.aliases) {
    if (!quiet) console.log(info(`${label} offers no aliases`));
    return 0;
  }
  const read = readToolAliases(tool);
  if (!read.ok) {
    if (quiet) return 0;
    console.log(err(`${label} — ${read.error}`));
    if (!isInstalledTool(key)) console.log(ash(`   not installed here — /install ${key}`));
    return 0;
  }
  const result = mergeAliases(read.aliases, { isReserved: isReservedName });
  if (!result.ok) {
    if (!quiet) console.log(err(`${label} — ${result.error}`));
    return 0;
  }

  if (compact) {
    const parts = [`${result.added.length} added`];
    if (result.kept.length) parts.push(`${result.kept.length} kept`);
    if (result.refused.length) parts.push(`${result.refused.length} refused`);
    console.log(`  ${label.padEnd(20)} ${ash(parts.join(", "))}`);
    return result.added.length;
  }

  for (const { name, value } of result.added) {
    console.log(`  ${ok(`${acid(`/${name}`)} ${ash("→")} ${bone(value)}`)}`);
  }
  // Named rather than counted: an alias the operator already owns is the one
  // case where nothing changed *and* they need to know which word it was,
  // because theirs and the tool's suggestion are both plausible. Suppressed
  // after an install, where a list of names that did not change is noise
  // between the installer's output and the prompt.
  if (!quiet) {
    for (const { name, value } of result.kept) {
      console.log(`  ${info(`kept your own ${acid(`/${name}`)} ${ash(`(${value})`)}`)}`);
    }
  }
  for (const { name, reason } of result.refused) {
    console.log(`  ${warn(`skipped ${acid(`/${name}`)} ${ash(`— ${reason}`)}`)}`);
  }
  if (result.dropped) console.log(ash(`   ${result.dropped} more offered than one run writes`));
  if (!quiet && !result.added.length && !result.kept.length && !result.refused.length) {
    console.log(info(`${label} offers no aliases`));
  }
  return result.added.length;
}

/** Is this tool's native executable present? Used only to explain a failure. */
function isInstalledTool(key) {
  return Boolean(toolStatus().find((entry) => entry.key === key)?.installed);
}

/**
 * `/alias` — define, list, and forget the shortcuts (src/aliases.mjs).
 *
 * `line` comes in alongside the tokenized `rest` because the value is a command
 * line, not an argument list: re-joining tokens would drop the quoting that the
 * shell still has to read.
 */
function aliasCommand(rest, line) {
  const json = rest.includes("--json");
  // `--json` is the listing's flag wherever it appears, so `/alias --json` is a
  // listing rather than a verb nobody recognises. The value in `set` is read
  // from the raw line, not from here, so an aliased command that itself passes
  // --json is untouched by this.
  const [verb, ...args] = rest.filter((a) => a !== "--json");
  const sub = String(verb ?? "").toLowerCase();

  if (!verb || sub === "list" || sub === "ls") {
    printAliases({ json });
    return;
  }
  // Before `set`, because `install` is a verb and not a name: falling through
  // to the bare-`/alias <name> <value>` shorthand would define an alias called
  // "install" pointing at whatever came next.
  if (sub === "install" || sub === "adopt") {
    aliasInstallCommand(args);
    return;
  }
  if (sub === "set" || sub === "add") {
    const name = args[0];
    const value = aliasValue(line);
    if (!name || !value) {
      console.log(err('usage: /alias set <name> "<command>"'));
      console.log(ash("   the command runs in $SHELL unless it starts with / — then it's a pit command"));
      return;
    }
    const result = setAlias(name, value, { isReserved: isReservedName });
    if (!result.ok) { console.log(err(result.error)); return; }
    console.log(ok(`${acid(`/${result.name}`)} → ${bone(result.value)}`));
    if (result.previous) console.log(ash(`   replaced: ${result.previous}`));
    return;
  }
  if (sub === "rm" || sub === "remove" || sub === "unset" || sub === "delete" || sub === "del") {
    if (!args[0]) { console.log(err("usage: /alias rm <name>")); return; }
    const result = removeAlias(args[0]);
    console.log(result.ok ? ok(`forgot ${acid(`/${result.name}`)} ${ash(`(was: ${result.value})`)}`) : err(result.error));
    return;
  }
  if (sub === "get" || sub === "show") {
    if (!args[0]) { console.log(err("usage: /alias get <name>")); return; }
    const value = getAlias(args[0]);
    console.log(value == null
      ? err(`no alias named "${String(args[0]).replace(/^\//, "")}"`)
      : `  ${acid(`/${String(args[0]).toLowerCase().replace(/^\//, "")}`)} ${ash("→")} ${bone(value)}`);
    return;
  }
  // A bare `/alias gs "git status"` is what people type once they know the
  // command exists, so treat an unknown verb as the name in `set` — but only
  // when there is a value after it, or `/alias gs` would silently define
  // nothing.
  if (args.length) { aliasCommand(["set", ...rest], `/alias set ${commandRemainder(line)}`); return; }
  console.log(err(`unknown /alias verb "${verb}" — set, list, get, rm, install`));
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
  // An upgrade is where a tool *gains* commands, so it is the moment its new
  // shortcuts should appear — a roster adopted once at install time otherwise
  // goes stale the first time the tool ships something new. Quiet and
  // never-overwrite, exactly as at install.
  const wanted = targets?.length
    ? toolsWithAliases().filter(([key]) => targets.includes(key))
    : toolsWithAliases();
  let added = 0;
  for (const [key, tool] of wanted) added += adoptToolAliases(key, tool, { quiet: true });
  if (added) console.log(ash(`   ${added} new alias${added === 1 ? "" : "es"} · /alias list for all of them`));
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

/**
 * How fast an exit has to be before it is worth remarking on.
 *
 * A person who opens an agent and immediately quits takes longer than this.
 * Nothing that actually started a session lands under it.
 */
const INSTANT_EXIT_MS = 1500;

/**
 * The note for a hand-off that ended the moment it began, or null.
 *
 * A CLI that exits 0 without doing anything is indistinguishable, from out
 * here, from one the operator opened and closed — both are "exited (code 0)",
 * which reads as success and sent somebody looking for the bug in the wrong
 * program. It happens for real: @serjm/deepseek-code 0.5.0 compares
 * `resolve(process.argv[1])` against `import.meta.url` to decide whether it is
 * the entrypoint, and npm installs every global bin as a symlink, so the
 * comparison fails and the whole CLI silently runs nothing.
 *
 * Timing is all we have — the child owns the terminal, so its output is not
 * ours to inspect — and it is enough to say "this looks wrong" without
 * claiming to know why.
 */
export function instantExitNote({ key, bin, code, ms }) {
  if (code !== 0 || ms >= INSTANT_EXIT_MS) return null;
  return `${key} exited instantly without running — that usually means a broken install, not a clean session.`
    + ` check it directly with \`${bin} --version\`, and reinstall with /install ${key} if that prints nothing.`;
}

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
  const startedAt = Date.now();
  const r = await openSession(engine, agentMode ? agentLaunchArgs(engine, args) : args, { onOutput: childSink() });
  const elapsed = Date.now() - startedAt;
  activeMirror?.setEngine(null);
  console.log(hr());
  if (!r.ok) {
    console.log(r.error?.code === "ENOENT"
      ? err(`${key} isn't on PATH (\`${engine.bin}\`). install it with /install ${key}`)
      : err(`couldn't launch ${key}: ${r.error?.message || r.error}`));
  } else {
    console.log(info(`${key} exited${r.code != null ? ` (code ${r.code})` : ""}. back in the pit.`));
    const note = instantExitNote({ key, bin: engine.bin, code: r.code, ms: elapsed });
    if (note) console.log(warn(note));
  }
}

async function openWorkflowTool(key, tool, args) {
  if (!tool.installed) {
    console.log(info(`${key} isn't installed — try ${acid("/install " + key)} first.`));
  }
  console.log(info(`opening ${bone(key)} — native CLI owns the terminal until it exits…`));
  console.log(hr());
  const toolStartedAt = Date.now();
  const result = await openTool(tool, args, { onOutput: childSink() });
  const toolElapsed = Date.now() - toolStartedAt;
  console.log(hr());
  if (!result.ok) {
    console.log(result.error?.code === "ENOENT"
      ? err(`${key} isn't on PATH (\`${tool.bin}\`). install it with /install ${key}`)
      : err(`couldn't launch ${key}: ${result.error?.message || result.error}`));
  } else {
    console.log(info(`${key} exited${result.code != null ? ` (code ${result.code})` : result.signal ? ` (${result.signal})` : ""}. back in the pit.`));
    const note = instantExitNote({ key, bin: tool.bin, code: result.code, ms: toolElapsed });
    if (note) console.log(warn(note));
  }
}

// Spawn the user's shell with the terminal fully handed over (stdio inherit),
// inheriting the current cwd + env. No args → an interactive shell; a raw
// command string → `$SHELL +m -ic "<cmd>"` (one-off). Interactive so the command
// can see the aliases and functions in ~/.zshrc — see src/shell.mjs for why
// that is not optional. Resolves { ok, code, signal }.
//
// Captured through a pty when the mirror is watching, for the same reason an
// engine is: a shell command is where most of what a pit does actually happens
// — `!cmd`, /shell, and every shell-valued /alias land here — and with plain
// `inherit` none of its bytes, on stdout or stderr, ever pass through this
// process. The session page was showing the echoed command line and the exit
// note with nothing in between.
export function runShell(rawCmd, { onOutput } = {}) {
  return new Promise((resolve) => {
    const { shell, args } = shellInvocation(rawCmd);
    const launch = captureSpec({ cmd: shell, args }, onOutput);
    const done = (result) => { try { launch.stop(); } catch { /* already drained */ } resolve(result); };
    let child;
    try { child = spawn(launch.cmd, launch.args, { stdio: "inherit" }); }
    catch (e) { done({ ok: false, error: e }); return; }
    child.on("error", (e) => done({ ok: false, error: e }));
    child.on("exit", (code, signal) => done({ ok: true, code, signal }));
  });
}

// vim `:sh` — drop into a shell and land back at the mosh prompt on exit, with
// the whole TUI session (history, cwd) intact. `rawCmd` runs a one-off instead.
async function openShell(rawCmd) {
  // The flags come from the same place the spawn does, so the echoed line is
  // what actually ran — a `-c` printed above an `-ic` invocation is the kind of
  // small lie that sends someone debugging the wrong shell.
  const { flags, name: shellName } = shellInvocation(rawCmd);
  console.log(info(rawCmd
    ? `${bone(shellName)} ${ash(flags)} ${ash(rawCmd)}`
    : `dropping to ${bone(shellName)} — ${ash("`exit` or Ctrl-D brings you back to the pit")}`));
  console.log(hr());
  const r = await runShell(rawCmd, { onOutput: childSink() });
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
    // Before the rule, so the prompt reads as the pit asking rather than as
    // something the installer's output scrolled into view.
    if (needsRootHere(target)) primeEscalation({ what: key, out: (s) => console.log(info(s.replace(/^· /, ""))) });
    console.log(hr());
    // Installers are long, chatty, and the thing you most want to read from a
    // phone — so they go through the mirror's pty like everything else.
    const launch = captureSpec(
      { cmd: target.install.cmd, args: target.install.args },
      childSink(),
    );
    const child = spawn(launch.cmd, launch.args, { stdio: "inherit" });
    child.on("error", (e) => {
      launch.stop();
      console.log(hr());
      console.log(err(`install failed: ${e.message}`));
      if (e.code === "ENOENT" && target.installHelp) console.log(info(target.installHelp));
      resolve();
    });
    child.on("exit", (code) => {
      launch.stop();
      console.log(hr());
      if (code !== 0) { console.log(err(`install exited ${code}`)); return resolve(); }
      console.log(ok(`${key} installed. 🤘`));
      // Installing a tool is also configuring it: a set of commands is not
      // usable from the pit until the words that reach them exist. Quiet, so a
      // tool with nothing to offer — every engine, and most tools — finishes
      // exactly as it did before. Names you bound yourself are never touched.
      const added = Object.hasOwn(TOOLS, key) ? adoptToolAliases(key, TOOLS[key], { quiet: true }) : 0;
      if (added) console.log(ash(`   ${added} alias${added === 1 ? "" : "es"} from ${key} · /alias list for all of them`));
      resolve();
    });
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
  console.log();
  printHerd();
  console.log("\n" + ash("  /help for commands · /ps for the herd · /new for a tab · /quit to leave") + "\n");

  const ad = await motd;
  if (ad) console.log(dim(ad) + "\n");

  const { restoreTee, drainRemote, atPrompt } = await startMirror();

  // Settings sync, unattended. Started per `tui()` call and stopped in the
  // teardown below, because the pit is re-entered after an engine session
  // (`backToPit`) and a timer left behind would be joined by another one.
  // Deliberately holds no reference to `rl`: the loop closes and rebuilds it
  // around a dozen commands, so a tick that captured it would be writing to a
  // readline that no longer exists.
  const stopAutoSync = startAutoSync();

  let rl = mkrl();
  // An alias expands into a line that is dispatched exactly as if it had been
  // typed, so it goes back through the top of this loop instead of through a
  // second copy of the dispatcher. `expansions` bounds a chain of aliases that
  // name each other; it resets whenever a real line is read.
  let pending = null;
  let expansions = 0;
  for (;;) {
    let line;
    if (pending != null) {
      line = pending;
      pending = null;
    } else {
      // Arm the prompt first, THEN release any command waiting from the web:
      // rl.write() only lands as input once readline is actually asking.
      const answer = ask(rl);
      atPrompt(rl);
      drainRemote();
      try { line = await answer; } catch { break; }
      finally { atPrompt(null); }
      if (line == null) break; // Ctrl-D
      expansions = 0;
      line = line.trim();
      if (!line) continue;
      saveHistory(); // readline just recorded this line into the shared history
    }

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
    // The team gate (src/teams.mjs). After --help, because asking what a
    // command does is not doing it, and before everything else, because a
    // check that some commands skip is a check nobody can reason about. Costs
    // one small JSON read, and only when MOSHCODE_MEMBER is set.
    if (process.env.MOSHCODE_MEMBER) {
      const { checkAccess } = await import("./teams.mjs");
      const gate = checkAccess(cmd, rest);
      if (!gate.allowed) {
        console.log(err(gate.reason));
        console.log(`  ${ash("ask an owner for")} ${acid(`/team grant ${gate.acting?.teamId || "<team>"} ${gate.acting?.handle || "<you>"} ${gate.permission}`)}`);
        continue;
      }
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
    if (cmd === "alias" || cmd === "aliases") { aliasCommand(rest, line); continue; }
    if (cmd === "pwd" || cmd === "where") { printPwd(); continue; }
    if (cmd === "login") {
      const device = rest.includes("--device") || rest.includes("device") || rest.includes("-d");
      const browser = rest.includes("--browser") || rest.includes("browser") || rest.includes("-b");
      try { const { email } = await loginAuto({ device, browser }); console.log(ok(`logged in${email ? ` as ${email}` : ""} 🤘`)); }
      catch (e) { console.log(err(String(e.message || e))); }
      continue;
    }
    if (cmd === "whoami") {
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--json")) {
        console.log(err("usage: /whoami [--json]"));
        continue;
      }
      await whoami({ json: rest[0] === "--json" });
      continue;
    }
    if (cmd === "logout") { logout(); continue; }
    // Settings sync. Never closes readline: both are one request and some
    // printing, and the prompt is where you were about to type `/load` again.
    if (cmd === "save") { await saveCommand(rest, { write: (l) => console.log(`  ${l}`) }); continue; }
    if (cmd === "load") { await loadCommand(rest, { write: (l) => console.log(`  ${l}`) }); continue; }
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
    // The herd (PRD 0009). These never close the readline interface, because
    // that is the entire point of them: the pit keeps its prompt while the
    // sessions run somewhere that outlives it.
    if (cmd === "herd") { await herdCommand(rest); continue; }
    if (cmd === "ps") { await herdCommand(["ps", ...rest]); continue; }
    if (cmd === "cost" || cmd === "usage") { await herdCommand(["cost", ...rest]); continue; }
    if (cmd === "kill") { await herdCommand(["kill", ...rest]); continue; }
    if (cmd === "wait") { await herdCommand(["wait", ...rest]); continue; }
    if (cmd === "restore") { await herdCommand(["restore", ...rest]); continue; }
    // `/attach` is the exception — it hands over the terminal like an engine
    // session does, so readline has to let go of stdin first or the two fight
    // over every keystroke.
    if (cmd === "attach") {
      rl.close();
      await herdCommand(["attach", ...rest]);
      rl = mkrl();
      continue;
    }
    // SSH workspaces (PRD 0013). `/ssh dev`, `/ssh exec --tty` and `/ssh
    // shell` hand the terminal to ssh the way /attach does; every other verb
    // answers in place and the prompt stays.
    if (cmd === "ssh") {
      const { sshCommand, takesTerminal } = await import("./ssh.mjs");
      if (takesTerminal(rest)) {
        rl.close();
        await sshCommand(rest);
        rl = mkrl();
      } else {
        await sshCommand(rest);
      }
      continue;
    }
    if (cmd === "agents" || cmd === "agent" || cmd === "engines") {
      if (!rest[0] || (rest.length === 1 && rest[0] === "--json")) {
        printEngines(rest[0] === "--json");
        continue;
      }
      const resolved = resolveEngine(rest[0]);
      if (!resolved) { console.log(err(`unknown engine "${rest[0]}". try: ${Object.keys(ENGINES).join(", ")}`)); continue; }
      const [key, engine] = resolved;
      const detached = detachedLaunch(key, rest.slice(1), { agentMode: true });
      if (detached.taken) continue;
      rl.close();
      await openEngine(
        key,
        { ...engine, installed: engineStatus().find((e) => e.key === key)?.installed },
        detached.args,
        { agentMode: true },
      );
      rl = mkrl();
      continue;
    }
    if (cmd === "start") {
      if (!rest[0]) { console.log(err("usage: /start <engine> [args…] [-d]")); continue; }
      const resolved = resolveEngine(rest[0]);
      if (!resolved) { console.log(err(`unknown engine "${rest[0]}". try: ${Object.keys(ENGINES).join(", ")}`)); continue; }
      const [key, engine] = resolved;
      const detached = detachedLaunch(key, rest.slice(1));
      if (detached.taken) continue;
      rl.close();
      await openEngine(key, { ...engine, installed: engineStatus().find((e) => e.key === key)?.installed }, detached.args);
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
      // `/tools install <name>` reads as the obvious spelling to anyone who has
      // just been shown the roster by `/tools`, and resolveTool would otherwise
      // answer it with `unknown tool "install"` — a dead end pointing at the
      // wrong word. Same for the verbs that pair with it.
      if (["install", "upgrade", "update"].includes(rest[0].toLowerCase()) && rest[1]) {
        const verb = rest[0].toLowerCase();
        rl.close();
        if (verb === "install") await installTarget(rest[1].toLowerCase());
        else await upgradeAll(rest.slice(1).map((r) => r.toLowerCase()));
        rl = mkrl();
        continue;
      }
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
    // `/stocks` renders in the pit rather than handing the terminal to a tool:
    // there is no advis0r binary to launch, only a public read-only API.
    if (cmd === "stocks" || cmd === "advisor") {
      await stocksCommand(rest, { openUrl: (url) => canOpenBrowser() && openBrowser(url) });
      continue;
    }
    // `/crypto` renders in the pit for the same reason `/stocks` does: there is
    // no crypto binary to hand the terminal to, only a public read-only API.
    if (cmd === "crypto" || cmd === "coins") {
      await cryptoCommand(rest, { openUrl: (url) => canOpenBrowser() && openBrowser(url) });
      continue;
    }
    // `/news` renders in the pit rather than handing the terminal over: it is a
    // list and a prompt to come back to, the same as `/stocks`.
    if (cmd === "news") {
      const { newsCommand } = await import("./news.mjs");
      await newsCommand(rest, { openUrl: (url) => canOpenBrowser() && openBrowser(url) });
      continue;
    }
    // `/rss` is the exception `/attach` is: it takes the whole terminal, so
    // readline has to let go of stdin first or the two fight over every key.
    if (cmd === "rss" || cmd === "reader") {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(err("/rss needs an interactive terminal — try /news"));
        continue;
      }
      const { rssUi } = await import("./rss-ui.mjs");
      rl.close();
      await rssUi(rest, { openUrl: (url) => canOpenBrowser() && openBrowser(url) });
      rl = mkrl();
      continue;
    }
    // The business layer. Lazily imported for the same reason the CLI does it,
    // and none of these close the readline interface: they print and return,
    // like /ps and /cost, so the prompt never moves.
    if (cmd === "timer") {
      // @profullstack/timer when it is installed, the built-in otherwise. The
      // readline interface is closed around the external one the way /secrets
      // and /payments do it: the CLI prints its own tables and has to own
      // stdout while it runs.
      const { delegate, externalFor, installHint } = await import("./business-delegate.mjs");
      if (externalFor("timer")) {
        rl.close();
        await delegate("timer", rest, {});
        rl = mkrl();
        continue;
      }
      const { timerCommand } = await import("./timer.mjs");
      await timerCommand(rest, { write: (l) => console.log(l) });
      const hint = installHint("timer");
      if (hint) console.log(hint);
      continue;
    }
    if (cmd === "client" || cmd === "business" || cmd === "merchant" || cmd === "customer") {
      const { clientCommand } = await import("./clients.mjs");
      clientCommand(rest, { write: (l) => console.log(l) });
      continue;
    }
    if (cmd === "team" || cmd === "teams") {
      const { teamCommand } = await import("./teams.mjs");
      teamCommand(rest, { write: (l) => console.log(l) });
      continue;
    }
    if (cmd === "rate" || cmd === "rates") {
      const { rateCommand } = await import("./rates.mjs");
      rateCommand(rest, { write: (l) => console.log(l) });
      continue;
    }
    if (cmd === "billing" || cmd === "invoice") {
      // Closed and reopened around the call either way: the external CLI owns
      // stdout while it runs, and the built-in's `--send --yes` hands the
      // terminal to the gateway's own CLI, which may prompt.
      const { delegate, externalFor, installHint } = await import("./business-delegate.mjs");
      if (externalFor(cmd)) {
        rl.close();
        await delegate(cmd, rest, {});
        rl = mkrl();
        continue;
      }
      const { billingCommand } = await import("./billing.mjs");
      rl.close();
      billingCommand(rest, { write: (l) => console.log(l) });
      rl = mkrl();
      const hint = installHint(cmd);
      if (hint) console.log(hint);
      continue;
    }
    if (cmd === "payments") {
      const { paymentsCommand } = await import("./payments.mjs");
      // Same reason: `/payments connect coinpay` runs `coinpay login`, which is
      // an interactive session of somebody else's.
      rl.close();
      paymentsCommand(rest, { write: (l) => console.log(l) });
      rl = mkrl();
      continue;
    }
    if (cmd === "plugin" || cmd === "plugins") {
      await pluginCommand(rest);
      continue;
    }
    // The arcade (src/games.mjs). Takes the terminal the way an engine session
    // does, because every game reads single keypresses and readline cannot hand
    // those over while it owns stdin. Listing is just printing, so it keeps the
    // prompt.
    if (cmd === "games" || cmd === "game" || cmd === "arcade" || cmd === "play") {
      const listing = !rest.length || rest[0] === "list" || rest[0] === "ls" || rest[0] === "--json";
      if (listing) { await gamesCommand(rest, { prefix: "/games" }); continue; }
      rl.close();
      await gamesCommand(rest, { prefix: "/games" });
      rl = mkrl();
      continue;
    }
    // `/shorten` renders in the pit rather than handing the terminal over: it
    // is one call to the registry and one line back, the same as `/stocks`.
    if (cmd === "shorten" || cmd === "short" || cmd === "link") {
      await shortenCommand(rest, { prefix: `/${cmd}` });
      continue;
    }
    if (cmd === "socials" || cmd === "social") {
      printSocials();
      continue;
    }
    if (cmd === "post") {
      const result = postSocial(rest);
      if (!result.ok) { console.log(err(result.error)); continue; }
      if (result.opened) {
        console.log(ok(`opened the ${result.social} composer — confirm the post in your browser 🤘`));
      } else {
        console.log(info(`open this ${result.social} composer in a browser:`));
        console.log(`  ${result.url}`);
      }
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
    // A user-defined alias (src/aliases.mjs) — last, so it can never shadow a
    // built-in, and so an alias that names one is dead rather than surprising.
    // /alias set refuses those names for exactly this reason.
    const aliased = getAlias(cmd);
    if (aliased) {
      if (expansions >= MAX_EXPANSIONS) {
        console.log(err(`/${cmd} keeps expanding — ${MAX_EXPANSIONS} rounds and still not a command. check /alias list for a loop.`));
        continue;
      }
      expansions += 1;
      pending = expandAlias(aliased, commandRemainder(line));
      // Echoed because the line that runs is not the line that was typed, and a
      // shell command that fails is a lot easier to read when what actually ran
      // is on the screen above it.
      console.log(ash(`  ▸ ${pending}`));
      continue;
    }
    // A renamed verb gets pointed at its replacement; `/ticker` was a pit
    // command for a release, so a bare "unknown command" is a dead end here.
    const renamed = RENAMED_COMMANDS[cmd];
    console.log(err(renamed
      ? `unknown command "${line}" — /${cmd} is now /${renamed}.`
      : `unknown command "${line}". /help for the list.`));
  }

  stopAutoSync();
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
  // Every launcher that spawns a child reads this rather than being handed a
  // sink, so a command run from the pit is captured whether or not whoever
  // wrote that launcher knew the mirror existed.
  setActiveSink((chunk) => activeMirror?.write(chunk));
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
  mirror.onCommand((body) => {
    // An engine has the terminal: send the line to it rather than parking it
    // for a prompt that will not come back until the engine exits. Without this
    // the arrow keys could answer a menu but nothing could answer a question,
    // which is half a session page. Typed straight in, so it arrives the way
    // the keyboard would deliver it — no `▸ (web)` note, because the engine
    // echoes it itself and printing over an engine's screen shifts it.
    const toChild = activeChildInput();
    if (toChild && toChild(`${body}\r`)) return;
    queue.push(body);
    drainRemote();
  });

  // Keys skip the queue: they are pressed the instant they arrive, whether the
  // prompt is armed or something else has the tty (a herd bar, the reader, a
  // menu). Nothing is echoed for them either — a line gets a `▸ (web)` note
  // because it would otherwise appear from nowhere, but a key's effect is the
  // redraw it causes, and printing over that would shift it out of place.
  mirror.onKey((name) => { pressKey(name, promptRl); });

  console.log(info(`mirroring this session → ${acid(mirror.url)}`));
  return { restoreTee, drainRemote, atPrompt: (rl) => { promptRl = rl; } };
}

async function stopMirror(restoreTee) {
  const mirror = activeMirror;
  activeMirror = null;
  setActiveSink(null);
  try { restoreTee?.(); } catch { /* noop */ }
  try { await mirror?.stop(); } catch { /* best effort */ }
}
