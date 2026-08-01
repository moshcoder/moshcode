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
import { runUpgrade } from "../src/upgrade.mjs";
import { selfUpdateCommand } from "../src/selfupdate.mjs";
import { describeUninstall, uninstallPlan } from "../src/uninstall.mjs";
import { mcpCommand, skillCommand } from "../src/integrations.mjs";
import { locate, tilde } from "../src/pwd.mjs";
import { createPrd, listPrds, authoringPrompt } from "../src/prd.mjs";
import { loginAuto, whoami, logout } from "../src/auth.mjs";
import { tui } from "../src/tui.mjs";
import { consoleCommand } from "../src/console.mjs";
import { dnsCommand } from "../src/dns.mjs";
import { templateCommand } from "../src/templates.mjs";
import { serveCommand } from "../src/serve.mjs";
import { createDohServer, nginxDohSite, parseGuardArgs, DEFAULT_DOH_PORT, DOH_PATH } from "../src/doh-server.mjs";
import { completionScript } from "../src/completion.mjs";
import { CORE_CLI_COMMAND_NAMES } from "../src/cli-schema.mjs";
import { moshcodeVersion } from "../src/ui.mjs";

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

function help() {
  const vocab = moshVocabulary().all();
  // Every workflow tool is exposed as a CLI verb, so derive them from TOOLS
  // rather than repeating the roster here — a tool missing from this list gets
  // misfiled as a moshscript-only local verb.
  const cliVerbs = [...CORE_CLI_COMMAND_NAMES, ...Object.keys(TOOLS)];
  const local = vocab.filter((c) => !cliVerbs.includes(c.name));
  const cli = vocab.filter((c) => !local.includes(c));
  console.log(`moshcode — metal scripting toolkit 🤘

usage:
  moshcode                             open the TUI shell (then /agents <engine>)
  moshcode agents [engine] [args…]     list engines, or launch one autonomously
                                       (bypasses/auto-approves native permissions)
  moshcode start <engine> [args…]      raw engine launch; inject no arguments
  moshcode <engine> [args…]            raw launch shorthand (backward compatible)
  moshcode <tool> [args…]              transparently invoke any workflow tool listed below
                                       (ugig, coinpay, gh, railway, supabase, doppler, doctl, …)
  moshcode secrets [args…]             manage/view team secrets (wraps the logicsrc CLI:
                                       login, teams, credentials — e.g. \`secrets teams pull acme prod\`)
  moshcode run [file.mosh] [--max N]   run a moshscript (stdin with '-', or the
     [--dry-run] [args…]               built-in loop if no file); --max bounds
                                       the while loop (default 3); --dry-run
                                       narrates without executing; extra args
                                       reach the script as argv
  moshcode mcp list [--json]           show MCP support + install status
  moshcode mcp install <url>           register an MCP server across every engine
  moshcode mcp add <name> <url|cmd>    that supports it (claude/gemini/codex/opencode)
  moshcode skill list [--json]         show skills support + install status
  moshcode skill install <git-url>     install a skill across every engine that
                                       supports it (claude/gemini)
  moshcode doh [--port N]              run the DNS-over-HTTPS resolver (loopback;
     [--rate N] [--burst N]            put TLS in front of it). Rate limits and
     [--ban-seconds N] [--no-guards]   bans are ON by default.
  moshcode doh --nginx <name>          print the reverse-proxy block for it
  moshcode site <name> [--install]     install web-server config for a Moshpit
     [--reload] [--proxy PORT]         name (nginx/Caddy does the serving, not
     [--root DIR]                      moshcode); shows the plan by default
  moshcode template list               starting stacks for a Moshpit-hosted service
  moshcode template install <name>     copy one here (also takes a git URL,
     [--into dir] [--force]            owner/repo, or a .tar.gz); nothing is run
  moshcode install <engine|tool>       install a coding engine or workflow tool
  moshcode uninstall <engine|tool>     take one back off this machine
  moshcode update --check              say whether a newer release exists
  moshcode update --if-newer           install only when there is one
  moshcode update --timer [--install]  check on a schedule (default 15min)
  moshcode upgrade [target…]           update moshcode + installed engines/tools
                                       (no args = everything; name targets to
                                       narrow, e.g. \`upgrade ugig\`)
  moshcode prd [idea]                  publish the next numbered PRD (OpenPRD) to
                                       prd/NNNN-slug.md and hand it to an engine to
                                       author; no arg lists existing PRDs
  moshcode login [--device|--browser]  authenticate this machine with app.moshcode.sh
                                       (device code over SSH/headless; --browser forces loopback)
                                       (browser OAuth+PKCE; --device = headless/CI
                                       code flow) so notify()/ask() reach you
  moshcode whoami | logout             show / clear the logged-in account
  moshcode console serve               serve a browser terminal on this box (ttyd
     [--port N] [--ttyd host:port]     behind moshcode login); --bind defaults to
     [--bind addr]                     127.0.0.1 — put it on a tailnet, not 0.0.0.0
  moshcode console --url <base>        print that gateway's URL with your login token
  moshcode pwd                         show the current dir + git repo/branch/origin
  moshcode engines [--json]            list engines + install status
  moshcode tools [--json]              list workflow tools + install status
  moshcode commands [--json]           list built-in moshscript commands
  moshcode completion <bash|zsh|fish|powershell>
                                       print a shell completion script
  moshcode help                        this

engines (moshcode is a wrapper — it installs/drives these):
${engineList()}

warning: agent mode intentionally weakens native safety checks. use it only in
isolated or trusted workspaces. use \`moshcode start <engine>\` for native defaults.

tools (native CLI passthrough; each tool owns its auth and output):
${toolList()}
the primary development toolchain is available through \`moshcode\` as a
dev.profullstack.com user — https://dev.profullstack.com/

moshscript — secretly all JS is legal:
${DEFAULT_SCRIPT}
a .mosh file is real JavaScript with the command vocabulary injected as globals.
const, for, if, await, template strings — all just work. shebang lines
(#!/usr/bin/env moshscript) are stripped automatically, so chmod +x works.

local commands (moshscript-only):
${local.map((c) => `  ${(`${c.name}()`).padEnd(14)} ${c.summary}`).join("\n")}

CLI commands (each shells out to \`moshcode <name> ...args\`):
${cli.map((c) => `  ${(`${c.name}()`).padEnd(14)} ${c.summary}`).join("\n")}

human-in-the-loop + AI (via app.moshcode.sh):
  notify(msg)          ping the operator across their channels + return the link
  ask(prompt)          blocking gate — waits for the human's reply at app.moshcode.sh
  ai(prompt, {engine}) run a coding engine headlessly and return its output

env: MOSHCODE_API (default https://app.moshcode.sh), MOSHCODE_API_KEY (from the
     app's Settings → API keys), MOSHCODE_WEBHOOK_SECRET, MOSHCODE_PLAYLIST
`);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  // No args → open the interactive TUI shell (/agents <engine>, etc.).
  if (cmd === undefined) return tui();

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(moshcodeVersion() || "unknown");
    return;
  }

  if (cmd === "engines") {
    printEngineStatus(rest.includes("--json"));
    return;
  }
  if (cmd === "agents") {
    if (!rest.length) { printEngineStatus(); return; }
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
    const result = await runCmd(install.cmd, install.args);
    if (!result.ok) {
      console.error(`install failed: ${result.error?.message || result.error || "unknown error"}`);
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
        runner: (cmd2, args2) => new Promise((res) => execFile(cmd2, args2, () => res({ ok: true }))),
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
      console.log(nginxDohSite({ name: rest[nameAt + 1] || "dns.example", port: DEFAULT_DOH_PORT }));
      return;
    }
    const portAt = rest.indexOf("--port");
    const server = await createDohServer({
      port: portAt >= 0 ? Number(rest[portAt + 1]) : DEFAULT_DOH_PORT,
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
    const { cwd, home, git } = locate();
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
  if (cmd === "whoami") { await whoami(); return; }
  if (cmd === "logout") { logout(); return; }
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
    if (!rest.length) {
      const prds = listPrds();
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

  help();
  if (cmd && !["help", "--help", "-h"].includes(cmd)) process.exit(1);
}

main();
