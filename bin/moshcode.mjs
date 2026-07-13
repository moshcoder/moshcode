#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runScript } from "../src/runtime.mjs";
import { moshVocabulary } from "../src/commands.mjs";
import {
  ENGINES,
  agentLaunchArgs,
  engineList,
  engineStatus,
  resolveEngine,
  openSession,
} from "../src/engines.mjs";
import { TOOLS, toolList, toolStatus, resolveTool, openTool } from "../src/tools.mjs";
import { runUpgrade } from "../src/upgrade.mjs";
import { mcpCommand, skillCommand } from "../src/integrations.mjs";
import { locate, tilde } from "../src/pwd.mjs";
import { createPrd, listPrds, authoringPrompt } from "../src/prd.mjs";
import { login, loginDevice, whoami, logout } from "../src/auth.mjs";
import { tui } from "../src/tui.mjs";

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
  const max = Number(value);
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`moshcode run: --max must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return max;
}

// After a hand-off subcommand/engine session ends, capture its exit and drop
// back into the mosh shell instead of quitting to the OS shell — but only when
// interactive. Piped / non-TTY invocations (scripts, CI, `… | moshcode run -`)
// keep the old behaviour: exit with the child's code.
function backToPit(label, code, signal) {
  if (!process.stdin.isTTY) process.exit(code ?? 0);
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

function printEngineStatus() {
  for (const engine of engineStatus()) {
    console.log(`${engine.installed ? "●" : "○"} ${engine.key.padEnd(10)} ${engine.desc}`);
  }
}

async function launchEngine(key, engine, args, { agentMode = false } = {}) {
  if (agentMode) {
    console.error(`⚠ agent mode: ${key} ${agentLaunchArgs(engine).join(" ")}${engine.agentsView ? " — opening its agent view" : " — native approvals/permissions are bypassed or auto-approved"}.`);
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
  const local = vocab.filter((c) => !["run","agents","start","install","upgrade","mcp","skill","prd","ugig","coinpay","c0mpute","secrets","pwd"].includes(c.name));
  const cli = vocab.filter((c) => !local.includes(c));
  console.log(`moshcode — metal scripting toolkit 🤘

usage:
  moshcode                             open the TUI shell (then /agents <engine>)
  moshcode agents [engine] [args…]     list engines, or launch one autonomously
                                       (bypasses/auto-approves native permissions)
  moshcode start <engine> [args…]      raw engine launch; inject no arguments
  moshcode <engine> [args…]            raw launch shorthand (backward compatible)
  moshcode <tool> [args…]              transparently invoke ugig, coinpay, c0mpute, or secrets
  moshcode secrets [args…]             manage/view team secrets (wraps the logicsrc CLI:
                                       login, teams, credentials — e.g. \`secrets teams pull acme prod\`)
  moshcode run [file.mosh] [--max N]   run a moshscript (stdin with '-', or the
     [--dry-run] [args…]               built-in loop if no file); --max bounds
                                       the while loop (default 3); --dry-run
                                       narrates without executing; extra args
                                       reach the script as argv
  moshcode mcp install <url>           register an MCP server across every engine
  moshcode mcp add <name> <url|cmd>    that supports it (claude/gemini/codex/opencode)
  moshcode skill install <git-url>     install a skill across every engine that
                                       supports it (claude/gemini)
  moshcode install <engine|tool>       install a coding engine or workflow tool
  moshcode upgrade [target…]           update moshcode + installed engines/tools
                                       (no args = everything; name targets to
                                       narrow, e.g. \`upgrade ugig\`)
  moshcode prd [idea]                  publish the next numbered PRD (OpenPRD) to
                                       prd/NNNN-slug.md and hand it to an engine to
                                       author; no arg lists existing PRDs
  moshcode login [--device]            authenticate this machine with app.moshcode.sh
                                       (browser OAuth+PKCE; --device = headless/CI
                                       code flow) so notify()/ask() reach you
  moshcode whoami | logout             show / clear the logged-in account
  moshcode pwd                         show the current dir + git repo/branch/origin
  moshcode engines                     list engines + install status
  moshcode tools                       list workflow tools + install status
  moshcode commands                    list built-in moshscript commands
  moshcode help                        this

engines (moshcode is a wrapper — it installs/drives these):
${engineList()}

warning: agent mode intentionally weakens native safety checks. use it only in
isolated or trusted workspaces. use \`moshcode start <engine>\` for native defaults.

tools (native CLI passthrough; each tool owns its auth and output):
${toolList()}

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

  if (cmd === "engines") {
    printEngineStatus();
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
    for (const tool of toolStatus()) {
      console.log(`${tool.installed ? "●" : "○"} ${tool.key.padEnd(10)} ${tool.desc}`);
    }
    return;
  }
  if (cmd === "mcp") {
    return mcpCommand(rest);
  }
  if (cmd === "skill" || cmd === "skills") {
    return skillCommand(rest);
  }
  if (cmd === "install") {
    const target = rest.find((a) => !a.startsWith("-"))?.toLowerCase();
    const entry = target && (ENGINES[target] || TOOLS[target]);
    if (!target || !entry) {
      console.error(`usage: moshcode install <engine|tool>\nengines:\n${engineList()}\ntools:\n${toolList()}`);
      process.exit(target ? 1 : 0);
    }
    const { install, desc, bin } = entry;
    console.log(`🎸 installing ${target} — ${desc}\n$ ${install.cmd} ${install.args.join(" ")}\n`);
    const child = spawn(install.cmd, install.args, { stdio: "inherit" });
    child.on("error", (e) => { console.error(`install failed: ${e.message}`); process.exit(1); });
    child.on("exit", (code) => {
      if (code === 0) console.log(`\n✓ ${target} installed. run it with \`${bin}\`. 🤘`);
      backToPit(`install ${target}`, code);
    });
    return;
  }
  if (cmd === "upgrade" || cmd === "update") {
    console.log("🎸 moshcode upgrade — updating moshcode + installed engines/tools 🤘");
    const results = await runUpgrade(rest);
    const failed = results.filter((r) => !r.ok).length;
    return backToPit("upgrade", failed ? 1 : 0);
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
    console.log("built-in moshscript commands:");
    for (const c of moshVocabulary().all()) {
      console.log(`  ${(`${c.name}()`).padEnd(12)} ${c.summary}`);
    }
    return;
  }
  if (cmd === "login") {
    const device = rest.includes("--device") || rest.includes("-d") || !process.stdin.isTTY;
    try {
      const { email } = device ? await loginDevice() : await login();
      console.log(`✓ logged in${email ? ` as ${email}` : ""} 🤘 — notify()/ask() will reach you now.`);
    } catch (e) { console.error(String(e.message || e)); process.exitCode = 1; }
    return;
  }
  if (cmd === "whoami") { await whoami(); return; }
  if (cmd === "logout") { logout(); return; }
  if (cmd === "run") {
    let max = 3, dryRun = false;
    const positional = []; // first is the file; the rest reach the script as argv
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (a === "--max" || a === "-n") {
        try { max = parseMax(rest[++k]); }
        catch (e) { console.error(String(e.message || e)); process.exit(1); }
      }
      else if (a.startsWith("--max=")) {
        try { max = parseMax(a.slice("--max=".length)); }
        catch (e) { console.error(String(e.message || e)); process.exit(1); }
      }
      else if (a === "--dry-run") dryRun = true;
      else if (a.startsWith("-") && positional.length === 0) {
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
  if (cmd && cmd !== "help") process.exit(1);
}

main();
