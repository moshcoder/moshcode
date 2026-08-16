#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runScript } from "../src/runtime.mjs";
import { moshVocabulary } from "../src/commands.mjs";
import {
  agentLaunchArgs,
  engineList,
  ENGINES,
  engineStatus,
  openSession,
  resolveEngine,
  resolveExecutable,
  runCmd,
} from "../src/engines.mjs";
import { TOOLS, toolList, toolStatus, resolveTool, openTool } from "../src/tools.mjs";
import { tradeArgs, tradeUsage } from "../src/trade.mjs";
import { runUpgrade } from "../src/upgrade.mjs";
import { selfUpdateCommand } from "../src/selfupdate.mjs";
import { describeUninstall, uninstallPlan } from "../src/uninstall.mjs";
import { mcpCommand, pluginCommand, skillCommand } from "../src/integrations.mjs";
import { stocksCommand } from "../src/advisor.mjs";
import { cryptoCommand } from "../src/crypto.mjs";
import { gamesCommand } from "../src/games.mjs";
import { canOpenBrowser, openBrowser } from "../src/open-url.mjs";
import { locate, tilde } from "../src/pwd.mjs";
import { createPrd, listPrds, authoringPrompt } from "../src/prd.mjs";
import { loginAuto, whoami, logout } from "../src/auth.mjs";
import { loadCommand, saveCommand } from "../src/settings-sync.mjs";
import { tui } from "../src/tui.mjs";
import { consoleCommand } from "../src/console.mjs";
import { herdCommand, herdStart, splitDetachArgs } from "../src/herd-cli.mjs";
import { detectSubstrate, substrateNote } from "../src/herd.mjs";
import { dnsCommand } from "../src/dns.mjs";
import { templateCommand } from "../src/templates.mjs";
import { serveCommand } from "../src/serve.mjs";
import { createDohServer, nginxDohSite, parseDohPort, parseGuardArgs, DEFAULT_DOH_PORT, DOH_PATH } from "../src/doh-server.mjs";
import { completionScript } from "../src/completion.mjs";
import { CORE_CLI_COMMAND_NAMES } from "../src/cli-schema.mjs";
import {
  findCommand, findVerb, helpModel, renderAll, renderCommand, renderOverview,
  renderMarkdown, renderScriptVerb, suggest, wantsHelp, withoutHelp,
} from "../src/help.mjs";
import { moshcodeVersion } from "../src/ui.mjs";
import { needsRootHere, primeEscalation } from "../src/escalate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(HERE, "..", "examples", "alive.mosh");

const DEFAULT_SCRIPT = `while (alive) {
  code();
  mosh();
  notify();
  repeat();
} // no bugs, only features
`;

function readScript(arg) {
  if (!arg || arg === "-") return fs.readFileSync(0, "utf8"); // stdin (paste)
  try {
    return fs.readFileSync(arg, "utf8");
  } catch (e) {
    throw new Error(`moshcode run: cannot read script ${JSON.stringify(arg)} (${e.code || e.message})`);
  }
}

function parseMax(value) {
  if (value === undefined) throw new Error("moshcode run: --max requires a positive integer");
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`moshcode run: --max must be a positive integer, got ${JSON.stringify(value)}`);
  }
  const max = Number(value);
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new Error(`moshcode run: --max must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return max;
}

// After a hand-off subcommand/engine session ends, capture its exit and drop
// back into the mosh shell instead of quitting to the OS shell — but only when
// interactive. Piped / non-TTY invocations (scripts, CI, `… | moshcode run -`)
// keep the old behaviour: exit with the child's code.
function backToPit(label, code, signal) {
  // A nested invocation (moshscript shim, or a CLI verb called from a script)
  // must hand control back to its parent, not open a second mosh pit on the
  // shared TTY.
  if (!process.stdin.isTTY || process.env.MOSHCODE_NESTED === "1") process.exit(code ?? 0);
  const how = signal ? ` (${signal})` : code != null ? ` (code ${code})` : "";
  console.log(`\n↩ ${label} exited${how} — back in the mosh pit. /quit to leave.\n`);
  return tui();
}

// Direct workflow-tool calls are ordinary CLI passthroughs, not interactive
// engine sessions. Preserve the child's result for shells, scripts, and agents.
function propagateExit(code, signal) {
  if (signal) {
    try { process.kill(process.pid, signal); }
    catch { process.exitCode = 1; }
    return;
  }
  process.exitCode = code ?? 0;
}

function printStatus(entries, json = false) {
  if (json) {
    console.log(JSON.stringify(entries.map(({ key, desc, bin, installed }) => ({
      name: key,
      description: desc,
      binary: bin,
      installed,
    })), null, 2));
    return;
  }
  for (const entry of entries) {
    console.log(`${entry.installed ? "●" : "○"} ${entry.key.padEnd(10)} ${entry.desc}`);
  }
}

function printEngineStatus(json = false) {
  printStatus(engineStatus(), json);
}

async function launchEngine(key, engine, args, { agentMode = false } = {}) {
  const { detach, name, rest: engineArgs } = splitDetachArgs(args);
  if (detach) {
    const substrate = detectSubstrate();
    if (substrate) {
      const code = herdStart([
        key, ...(name ? ["--name", name] : []), ...(agentMode ? ["--agent"] : []), ...engineArgs,
      ]);
      if (code) process.exitCode = code;
      if (!process.stdin.isTTY || process.env.MOSHCODE_NESTED === "1") return;
      return tui();
    }
    // R2: degrade, loudly, once — and then still do the thing that was asked
    // for. A launch that refuses because the box has no tmux would be a worse
    // answer than a launch that works and ends with this terminal.
    console.error(`⚠ ${substrateNote(null)}`);
  }
  args = engineArgs;
  if (agentMode) {
    const note = `agent mode: ${key} ${agentLaunchArgs(engine).join(" ")}`;
    console.error(engine.agentsView
      ? `· ${note} — opening its agent view.`
      : `⚠ ${note} — native approvals/permissions are bypassed or auto-approved.`);
  }
  const result = await openSession(engine, agentMode ? agentLaunchArgs(engine, args) : args);
  if (!result.ok) {
    console.error(result.error?.code === "ENOENT"
      ? `${key} isn't installed (\`${engine.bin}\`). run: moshcode install ${key}`
      : `launch failed: ${result.error?.message || result.error}`);
    if (!process.stdin.isTTY) { process.exitCode = 1; return; }
    return tui();
  }
  return backToPit(key, result.code, result.signal);
}

/**
 * Help, on the right stream, from the schema (PRD 0006 R3, R5).
 *
 * \`write\` decides the stream and it is not cosmetic: help asked for is output,
 * help printed because a verb was wrong is a diagnostic, and a diagnostic on
 * stdout ends up inside whatever the caller was redirecting to — \`moshcode doh
 * --nginx x > site.conf\` on a build without \`doh\` used to write this banner
 * into an nginx config, and nginx then failed to start for reasons four layers
 * from the typo.
 *
 * The 87-line template literal that used to live here is gone. It had already
 * drifted — \`dns\` and \`version\` were dispatchable and missing from it — and
 * every fix to it was a second place to remember.
 */
function helpContext() {
  return {
    engines: Object.keys(ENGINES),
    tools: Object.keys(TOOLS),
    version: moshcodeVersion() || "",
  };
}

function help(write = console.log, { all = false } = {}) {
  write(all ? renderAll(helpContext()) : renderOverview(helpContext()));
}

/**
 * Answer every form of "how does this work" before anything is parsed.
 *
 * Ahead of dispatch on purpose (PRD 0006 R1, R2). Asking for help used to be
 * handled by each command's own argument parser, by accident and differently
 * every time: `prd --help` read `--help` as the PRD's idea and *published a
 * document*, `run --help` was an unknown-option error, `console --help` printed
 * usage to stderr and exited 1. Recognising it here means no parser sees it and
 * none of them can act on it.
 *
 * Returns true when it handled the invocation.
 *
 * Two boundaries it deliberately does not cross:
 *  - an engine or tool name. `moshcode gh --help` is gh's question and passes
 *    through byte-for-byte; `moshcode help gh` asks how moshcode wraps it.
 *  - the moshscript filename. `moshcode run --help` is the runner's; after the
 *    file, `--help` is the script's argv (PRD 0004 R13).
 */
function handledHelp(cmd, rest) {
  const asJson = rest.includes("--json");
  const topLevel = ["help", "--help", "-h"].includes(cmd);

  if (topLevel) {
    // `--markdown` is the generator behind README.md's command table (R13). A
    // build-time convenience, deliberately not a docs pipeline: it emits one
    // table, and the test that keeps README.md honest calls the same function.
    if (rest.includes("--markdown")) {
      console.log(renderMarkdown());
      return true;
    }
    const args = withoutHelp(rest).filter((a) => a !== "--json" && a !== "--all");
    // `moshcode help --help` asks about `help` itself, and R4 says every
    // command answers for itself. Only the spelled-out verb: `moshcode --help`
    // is the overview, which is what a bare flag has always meant.
    if (cmd === "help" && !args.length && wantsHelp(rest)) args.push("help");
    if (asJson && !args.length) {
      console.log(JSON.stringify(helpModel(helpContext()), null, 2));
      return true;
    }
    if (!args.length) {
      help(console.log, { all: rest.includes("--all") });
      return true;
    }
    // `moshcode help <topic> [verb]`
    const command = findCommand(args[0]);
    if (!command) {
      // An engine or a tool is a legitimate topic: this is the only way to ask
      // how moshcode wraps something whose own --help passes through.
      if (resolveEngine(args[0])) {
        console.log(`moshcode ${args[0]} [args…] — open ${args[0]} directly (passthrough).`);
        console.log(`its own flags belong to it: \`moshcode ${args[0]} --help\` asks ${args[0]}, not moshcode.`);
        console.log(`see also: moshcode help agents · moshcode help start`);
        return true;
      }
      if (resolveTool(args[0])) {
        console.log(`moshcode ${args[0]} [args…] — run ${args[0]}, with moshcode's auth and env (passthrough).`);
        console.log(`its own flags belong to it: \`moshcode ${args[0]} --help\` asks ${args[0]}, not moshcode.`);
        console.log(`see also: moshcode help tools · moshcode help install`);
        return true;
      }
      // A moshscript verb is a fair thing to ask about — `ask()` is as much
      // part of the interface as `moshcode prd` (R14).
      const verbHelp = renderScriptVerb(moshVocabulary().get(args[0]));
      if (verbHelp) {
        console.log(verbHelp);
        return true;
      }
      const near = suggest(args[0], [
        ...Object.keys(ENGINES), ...Object.keys(TOOLS), ...moshVocabulary().names(),
      ]);
      console.error(`✗ no help for ${JSON.stringify(args[0])}${near ? ` — did you mean ${near}?` : ""}`);
      console.error("  moshcode help          list commands");
      process.exitCode = 1;
      return true;
    }
    const verb = args[1] ? findVerb(command, args[1]) : null;
    if (args[1] && !verb) {
      console.error(`✗ ${command.name} has no verb ${JSON.stringify(args[1])}`);
      console.error(renderCommand(command));
      process.exitCode = 1;
      return true;
    }
    if (asJson) {
      const model = helpModel(helpContext()).commands.find((c) => c.name === command.name);
      console.log(JSON.stringify(verb ? model.verbs.find((v) => v.name === verb.name) : model, null, 2));
      return true;
    }
    console.log(renderCommand(command, { verb }));
    return true;
  }

  // `moshcode <command> [verb] --help`, at any depth.
  const command = findCommand(cmd);
  if (!command) return false;
  // `run` claims --help only before the script filename.
  if (!wantsHelp(rest, { stopAt: command.name === "run" })) return false;

  const verb = findVerb(command, withoutHelp(rest)[0]);
  if (asJson) {
    const model = helpModel(helpContext()).commands.find((c) => c.name === command.name);
    console.log(JSON.stringify(verb ? model.verbs.find((v) => v.name === verb.name) : model, null, 2));
    return true;
  }
  console.log(renderCommand(command, { verb }));
  return true;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  // No args → open the interactive TUI shell (/agents <engine>, etc.).
  if (cmd === undefined) return tui();

  // Before every parser, so none of them can act on --help. See handledHelp().
  if (handledHelp(cmd, rest)) return;

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(moshcodeVersion() || "unknown");
    return;
  }

  if (cmd === "engines") {
    printEngineStatus(rest.includes("--json"));
    return;
  }
  if (cmd === "agents") {
    if (!rest.length || (rest.length === 1 && rest[0] === "--json")) {
      printEngineStatus(rest[0] === "--json");
      return;
    }
    const resolved = resolveEngine(rest[0]);
    if (!resolved) {
      console.error(`unknown engine "${rest[0]}". try: ${Object.keys(ENGINES).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const [key, engine] = resolved;
    return launchEngine(key, engine, rest.slice(1), { agentMode: true });
  }
  if (cmd === "start") {
    if (!rest.length) {
      console.error(`usage: moshcode start <engine> [args…]\nengines:\n${engineList()}`);
      process.exitCode = 1;
      return;
    }
    const resolved = resolveEngine(rest[0]);
    if (!resolved) {
      console.error(`unknown engine "${rest[0]}". try: ${Object.keys(ENGINES).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const [key, engine] = resolved;
    return launchEngine(key, engine, rest.slice(1));
  }
  // The herd (PRD 0009). `herd` is the namespace; the verbs people reach
  // for most often are also top-level, because `moshcode ps` is what someone
  // types when they want to know what is running and nobody should have to
  // learn a namespace to ask that.
  if (cmd === "herd") {
    process.exitCode = (await herdCommand(rest)) || 0;
    return;
  }
  if (["ps", "attach", "kill", "wait", "restore", "cost"].includes(cmd)) {
    process.exitCode = (await herdCommand([cmd === "ps" ? "ps" : cmd, ...rest])) || 0;
    return;
  }
  if (cmd === "tools") {
    const asJson = rest.includes("--json");
    printStatus(toolStatus(), asJson);
    // Never after --json: the note would corrupt output being piped into jq.
    if (!asJson) {
      console.log("\nthe primary development toolchain runs through `moshcode` as a");
      console.log("dev.profullstack.com user — https://dev.profullstack.com/");
    }
    return;
  }
  if (cmd === "trade") {
    const translated = tradeArgs(rest);
    if (translated.usage) {
      console.log(tradeUsage());
      return;
    }
    if (translated.error) {
      console.error(`${translated.error}\n\n${tradeUsage()}`);
      process.exitCode = 1;
      return;
    }
    const tool = TOOLS.alpaca;
    const r = await openTool(tool, translated.args);
    if (!r.ok) {
      console.error(r.error?.code === "ENOENT"
        ? `alpaca isn't installed (\`${tool.bin}\`). run: moshcode install alpaca`
        : `launch failed: ${r.error?.message || r.error}`);
      process.exitCode = 1;
      return;
    }
    propagateExit(r.code, r.signal);
    return;
  }
  if (cmd === "stocks" || cmd === "advisor") {
    const code = await stocksCommand(rest, {
      openUrl: (url) => canOpenBrowser() && openBrowser(url),
    });
    if (code) process.exitCode = code;
    return;
  }
  if (cmd === "crypto" || cmd === "coins") {
    const code = await cryptoCommand(rest, {
      openUrl: (url) => canOpenBrowser() && openBrowser(url),
    });
    if (code) process.exitCode = code;
    return;
  }
  if (cmd === "news") {
    const { newsCommand } = await import("../src/news.mjs");
    const code = await newsCommand(rest, {
      openUrl: (url) => canOpenBrowser() && openBrowser(url),
    });
    if (code) process.exitCode = code;
    return;
  }
  if (cmd === "rss") {
    const { rssUi } = await import("../src/rss-ui.mjs");
    const code = await rssUi(rest, {
      openUrl: (url) => canOpenBrowser() && openBrowser(url),
    });
    if (code) process.exitCode = code;
    return;
  }
  if (cmd === "plugin" || cmd === "plugins") {
    const code = await pluginCommand(rest);
    if (code) process.exitCode = code;
    return;
  }
  if (cmd === "games" || cmd === "game" || cmd === "arcade") {
    const code = await gamesCommand(rest);
    if (code) process.exitCode = code;
    return;
  }
  if (cmd === "console") {
    const code = await consoleCommand(rest);
    if (code) process.exitCode = code;
    return;
  }
  if (cmd === "mcp") {
    process.exitCode = (await mcpCommand(rest)) || 0;
    return;
  }
  if (cmd === "skill" || cmd === "skills") {
    process.exitCode = (await skillCommand(rest)) || 0;
    return;
  }
  if (cmd === "install") {
    const target = rest.find((a) => !a.startsWith("-"))?.toLowerCase();
    // Own properties only — `install constructor` must print usage, not resolve
    // to something off Object.prototype and crash on its missing install spec.
    const entry = target
      && ((Object.hasOwn(ENGINES, target) && ENGINES[target]) || (Object.hasOwn(TOOLS, target) && TOOLS[target]));
    if (!target || !entry) {
      console.error(`usage: moshcode install <engine|tool>\nengines:\n${engineList()}\ntools:\n${toolList()}`);
      process.exit(target ? 1 : 0);
    }
    const { install, desc, bin } = entry;
    console.log(`🎸 installing ${target} — ${desc}\n$ ${install.cmd} ${install.args.join(" ")}\n`);
    // Ask for the password before the installer starts, not after it has spent a
    // minute refreshing package lists and then stopped to wait on one.
    if (needsRootHere(entry)) primeEscalation({ what: target });
    const result = await runCmd(install.cmd, install.args);
    if (!result.ok) {
      console.error(`install failed: ${result.error?.message || result.error || "unknown error"}`);
      if (result.error?.code === "ENOENT" && entry.installHelp) console.error(entry.installHelp);
      process.exitCode = 1;
      return;
    }
    if (result.code === 0) console.log(`\n✓ ${target} installed. run it with \`${bin}\`. 🤘`);
    return backToPit(`install ${target}`, result.code);
  }
  if (cmd === "uninstall" || cmd === "remove") {
    const target = rest.find((a) => !a.startsWith("-"))?.toLowerCase();
    const entry = target
      && ((Object.hasOwn(ENGINES, target) && ENGINES[target]) || (Object.hasOwn(TOOLS, target) && TOOLS[target]));
    if (!target || !entry) {
      console.error(`usage: moshcode uninstall <engine|tool>\nengines:\n${engineList()}\ntools:\n${toolList()}`);
      process.exit(target ? 1 : 0);
    }

    const binPath = resolveExecutable(entry.bin, entry.binDirs);
    const plan = uninstallPlan(entry, { binPath });

    if (plan.kind === "absent" || plan.kind === "refused") {
      for (const w of plan.warnings) console.error(w);
      process.exitCode = plan.kind === "refused" ? 1 : 0;
      return;
    }

    console.log(`🎸 uninstalling ${target} — ${entry.desc}`);
    console.log(describeUninstall(plan));
    if (rest.includes("--dry-run")) return;

    // Removing a binary is not something to do because a flag was left off.
    // An npm uninstall is reversible with one command and does not ask.
    if (plan.kind === "binary" && !rest.includes("--yes") && !rest.includes("-y")) {
      console.error(`\nthis deletes ${binPath}. re-run with --yes to do it.`);
      process.exitCode = 1;
      return;
    }

    for (const step of plan.steps) {
      if (step.kind === "remove") {
        try {
          fs.rmSync(step.path, { force: true });
          console.log(`\n✓ removed ${step.path}`);
        } catch (err) {
          console.error(`could not remove ${step.path}: ${err.message}`);
          process.exitCode = 1;
          return;
        }
      } else {
        const result = await runCmd(step.command, step.args);
        if (!result.ok || result.code !== 0) {
          console.error(`uninstall failed: ${result.error?.message || `exit ${result.code}`}`);
          process.exitCode = 1;
          return;
        }
        console.log(`\n✓ ${target} uninstalled. 🤘`);
      }
    }
    return backToPit(`uninstall ${target}`, 0);
  }

  if (cmd === "upgrade" || cmd === "update") {
    // --check, --if-newer and --timer never reinstall blindly: a scheduled run
    // that re-fetches Node, bun and the tarball to discover nothing changed is
    // minutes of network and disk for no reason.
    if (rest.some((a) => ["--check", "--if-newer", "--timer"].includes(a))) {
      const { promises: fsp } = await import("node:fs");
      const { execFile } = await import("node:child_process");
      process.exitCode = (await selfUpdateCommand(rest, console.log, {
        upgrade: async () => {
          const results = await runUpgrade(rest.filter((a) => !a.startsWith("--")));
          return results.filter((r) => !r.ok).length ? 1 : 0;
        },
        write: (path, body) => fsp.writeFile(path, body),
        runner: (cmd2, args2) => new Promise((res) => execFile(cmd2, args2, (err) => res({ ok: !err }))),
      })) || 0;
      return;
    }
    console.log("🎸 moshcode upgrade — updating moshcode + installed engines/tools 🤘");
    const results = await runUpgrade(rest);
    const failed = results.filter((r) => !r.ok).length;
    return backToPit("upgrade", failed ? 1 : 0);
  }
  if (cmd === "dns") {
    process.exitCode = (await dnsCommand(rest)) || 0;
    return;
  }
  if (cmd === "doh") {
    const nameAt = rest.indexOf("--nginx");
    if (nameAt >= 0) {
      console.log(nginxDohSite({
        name: rest[nameAt + 1] || "dns.example",
        port: DEFAULT_DOH_PORT,
        tls: rest.includes("--tls"),
      }));
      return;
    }
    const listenPort = parseDohPort(rest, DEFAULT_DOH_PORT);
    if (!listenPort.ok) {
      console.error(`--port needs a decimal integer from 1 to 65535, got ${JSON.stringify(listenPort.raw)}`);
      process.exitCode = 1;
      return;
    }
    const server = await createDohServer({
      port: listenPort.port,
      ...parseGuardArgs(rest),
    });
    console.log(`DoH resolver on ${server.url}`);
    console.log(server.guards.rateLimit
      ? `  guards: ${server.guards.rateLimit.perSecond}/s per client (burst ${server.guards.rateLimit.burst}), `
        + `bans double from ${Math.round(server.guards.ban.baseMs / 1000)}s, answers capped at ${server.guards.maxResponseBytes}B`
      : "  ! guards OFF (--no-guards) — do not expose this without something else limiting it");
    console.log("TLS belongs to whatever holds 443 — see: moshcode doh --nginx <name>");
    console.log("this must not be reachable directly; it has no TLS and trusts X-Forwarded-For");
    return new Promise(() => {});
  }
  if (cmd === "site" || cmd === "serve") {
    process.exitCode = (await serveCommand(rest)) || 0;
    return;
  }
  if (cmd === "template" || cmd === "templates") {
    process.exitCode = (await templateCommand(rest)) || 0;
    return;
  }

  if (cmd === "pwd" || cmd === "where") {
    const location = locate();
    if (rest.includes("--json")) {
      console.log(JSON.stringify({ cwd: location.cwd, git: location.git }, null, 2));
      return;
    }
    const { cwd, home, git } = location;
    console.log(tilde(cwd, home));
    if (git) {
      console.log(`repo:   ${git.name}${git.branch ? ` (${git.branch})` : ""}`);
      console.log(`root:   ${tilde(git.root, home)}`);
      if (git.origin) console.log(`origin: ${git.origin}`);
    } else {
      console.log("(not a git repo)");
    }
    return;
  }
  if (cmd === "commands") {
    const commands = moshVocabulary().all();
    if (rest.includes("--json")) {
      console.log(JSON.stringify(commands.map(({ name, summary }) => ({
        name,
        description: summary,
      })), null, 2));
      return;
    }
    console.log("built-in moshscript commands:");
    for (const c of commands) {
      console.log(`  ${(`${c.name}()`).padEnd(12)} ${c.summary}`);
    }
    return;
  }
  if (cmd === "completion") {
    try {
      process.stdout.write(completionScript(rest[0]));
    } catch (e) {
      console.error(`usage: moshcode completion <bash|zsh|fish|powershell>\n${e.message || e}`);
      process.exitCode = 1;
    }
    return;
  }
  if (cmd === "login") {
    const device = rest.includes("--device") || rest.includes("-d") || !process.stdin.isTTY;
    const browser = rest.includes("--browser") || rest.includes("-b");
    try {
      const { email } = await loginAuto({ device, browser });
      console.log(`✓ logged in${email ? ` as ${email}` : ""} 🤘 — notify()/ask() will reach you now.`);
    } catch (e) { console.error(String(e.message || e)); process.exitCode = 1; }
    return;
  }
  if (cmd === "whoami") {
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--json")) {
      console.error("usage: moshcode whoami [--json]");
      process.exitCode = 1;
      return;
    }
    await whoami({ json: rest[0] === "--json" });
    return;
  }
  if (cmd === "logout") { logout(); return; }
  if (cmd === "save") { process.exitCode = await saveCommand(rest); return; }
  if (cmd === "load") { process.exitCode = await loadCommand(rest); return; }
  if (cmd === "run") {
    let max = 3, dryRun = false;
    let optionsEnded = false;
    const positional = []; // first is the file; the rest reach the script as argv
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (!optionsEnded && a === "--") {
        optionsEnded = true;
      }
      else if (!optionsEnded && (a === "--max" || a === "-n")) {
        try { max = parseMax(rest[++k]); }
        catch (e) { console.error(String(e.message || e)); process.exit(1); }
      }
      else if (!optionsEnded && a.startsWith("--max=")) {
        try { max = parseMax(a.slice("--max=".length)); }
        catch (e) { console.error(String(e.message || e)); process.exit(1); }
      }
      else if (!optionsEnded && a === "--dry-run") dryRun = true;
      else if (!optionsEnded && a !== "-" && a.startsWith("-") && positional.length === 0) {
        console.error(`moshcode run: unknown option ${a}`);
        process.exit(1);
      }
      else positional.push(a);
    }
    const file = positional[0] || null;
    const argv = positional.slice(1);
    let src;
    try {
      src = file ? readScript(file) : (fs.existsSync(EXAMPLE) ? fs.readFileSync(EXAMPLE, "utf8") : DEFAULT_SCRIPT);
    } catch (e) {
      console.error(String(e.message || e));
      process.exit(1);
    }

    console.log(`🎸 moshcode — running moshscript${dryRun ? " (dry run)" : ""}\n`);
    let result;
    try {
      result = await runScript(src, {
        commands: moshVocabulary(),
        max,
        dryRun,
        argv,
        out: (s) => console.log(s),
      });
    } catch (e) {
      console.error("\n" + String(e.message || e));
      process.exit(1);
    }
    console.log(`\n✓ ${result.iterations} loop(s) — no bugs, only features. 🤘`);
    return backToPit("moshscript", 0);
  }

  if (cmd === "prd") {
    const listMode = !rest.length || rest[0] === "list" || rest[0] === "--json";
    if (listMode) {
      const listArgs = rest[0] === "list" ? rest.slice(1) : rest;
      const unknown = listArgs.filter((arg) => arg !== "--json");
      if (unknown.length) {
        console.error(`usage: moshcode prd list [--json]\nunknown option: ${unknown[0]}`);
        process.exitCode = 1;
        return;
      }
      const prds = listPrds();
      if (listArgs.includes("--json")) {
        console.log(JSON.stringify(prds.map(({ id, title, status, file }) => ({
          id,
          title,
          status,
          file,
        })), null, 2));
        return;
      }
      if (!prds.length) { console.log("no PRDs yet — `moshcode prd <idea>` to start one."); return; }
      for (const p of prds) console.log(`${p.id}  ${p.status.padEnd(9)} ${p.title}`);
      return;
    }
    const idea = rest.join(" ");
    const { id, slug, path: file, existed, bootstrapped } = createPrd(idea);
    if (bootstrapped) console.log("bootstrapped prd/ — README + 0000-template.md");
    console.log(existed
      ? `PRD ${id} exists — ${file}`
      : `✓ published prd/${id}-${slug}.md (committed — status: Draft)`);
    const st = engineStatus();
    const chosen = st.find((e) => e.key === "claude" && e.installed) || st.find((e) => e.installed);
    if (!chosen) { console.log("open an engine to author it — run: moshcode install claude"); return; }
    console.log(`handing ${id} to ${chosen.key} to author…`);
    const r = await openSession(ENGINES[chosen.key], [authoringPrompt({ path: file, idea: existed ? "" : idea })]);
    return backToPit(chosen.key, r.code, r.signal);
  }

  // `moshcode <engine> [args…]` → open a passthrough session directly.
  const resolved = resolveEngine(cmd);
  if (resolved) {
    const [key, engine] = resolved;
    return launchEngine(key, engine, rest);
  }

  // `moshcode <tool> [args…]` is deliberately silent: the native CLI owns
  // stdout/stderr so JSON and other pipelines remain byte-for-byte usable.
  const resolvedTool = resolveTool(cmd);
  if (resolvedTool) {
    const [key, tool] = resolvedTool;
    const r = await openTool(tool, rest);
    if (!r.ok) {
      console.error(r.error?.code === "ENOENT"
        ? `${key} isn't installed (\`${tool.bin}\`). run: moshcode install ${key}`
        : `launch failed: ${r.error?.message || r.error}`);
      process.exitCode = 1;
      return;
    }
    propagateExit(r.code, r.signal);
    return;
  }

  // Unknown. One line and a way forward, on stderr (PRD 0006 R3, R11) — this
  // used to dump 127 lines to *stdout* and exit 1, which polluted every pipe
  // that had a typo in it and buried the one fact the caller needed.
  const near = suggest(cmd, [...Object.keys(ENGINES), ...Object.keys(TOOLS)]);
  console.error(`✗ unknown command ${JSON.stringify(cmd)}${near ? ` — did you mean ${near}?` : ""}`);
  console.error("  moshcode help          list commands");
  process.exit(1);
}

main();
