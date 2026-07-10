#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compile, run } from "../src/interpreter.mjs";
import { defaultCommands } from "../src/commands.mjs";
import { ENGINES, engineList, engineStatus, resolveEngine, openSession } from "../src/engines.mjs";
import { runSpec, OPENSPEC } from "../src/spec.mjs";
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
  return fs.readFileSync(arg, "utf8");
}

function parseMax(value) {
  if (value === undefined) throw new Error("moshcode run: --max requires a positive integer");
  const max = Number(value);
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`moshcode run: --max must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return max;
}

function help() {
  console.log(`moshcode — metal scripting toolkit 🤘

usage:
  moshcode                             open the TUI shell (then /agents <engine>)
  moshcode <engine> [args…]            open a passthrough session on an engine
  moshcode run [file.mosh] [--max N]   run a moshscript (stdin with '-', or the
                                       built-in loop if no file); --max bounds
                                       the while loop (default 3)
  moshcode install <engine>            install an agentic-coding engine
  moshcode spec [init|update|list|…]   spec-driven dev via OpenSpec — writes an
                                       openspec/ folder to your repo (passthrough
                                       to the openspec CLI; npx if not installed)
  moshcode agents                      list engines + install status
  moshcode engines                     (alias of agents)
  moshcode commands                    list built-in moshscript commands
  moshcode help                        this

engines (moshcode is a wrapper — it installs/drives these):
${engineList()}

moshscript looks like this:
${DEFAULT_SCRIPT}
commands: code() mosh() notify() repeat() say("…") sleep(ms) stop()
notify() pings moshcoding.com web notifications, and a webhook too if
MOSHCODE_WEBHOOK_URL is set (signed with MOSHCODE_WEBHOOK_SECRET).

env: MOSHCODE_API (default https://moshcoding.com), MOSHCODE_WEBHOOK_URL,
     MOSHCODE_WEBHOOK_SECRET
`);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  // No args → open the interactive TUI shell (/agents <engine>, etc.).
  if (cmd === undefined) return tui();

  if (cmd === "engines" || cmd === "agents") {
    for (const e of engineStatus()) {
      console.log(`${e.installed ? "●" : "○"} ${e.key.padEnd(10)} ${e.desc}`);
    }
    return;
  }
  if (cmd === "install") {
    const engine = rest.find((a) => !a.startsWith("-"));
    if (!engine || !ENGINES[engine]) {
      console.error(`usage: moshcode install <engine>\nengines:\n${engineList()}`);
      process.exit(engine ? 1 : 0);
    }
    const { install, desc, bin } = ENGINES[engine];
    console.log(`🎸 installing ${engine} — ${desc}\n$ ${install.cmd} ${install.args.join(" ")}\n`);
    const child = spawn(install.cmd, install.args, { stdio: "inherit" });
    child.on("error", (e) => { console.error(`install failed: ${e.message}`); process.exit(1); });
    child.on("exit", (code) => {
      if (code === 0) console.log(`\n✓ ${engine} installed. run it with \`${bin}\`. 🤘`);
      process.exit(code ?? 0);
    });
    return;
  }
  if (cmd === "commands") {
    console.log("built-in moshscript commands:\n  " + Object.keys(defaultCommands()).map((c) => `${c}()`).join("  "));
    return;
  }
  if (cmd === "run") {
    let max = 3, dryRun = false, file = null;
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (a === "--max" || a === "-n") {
        try { max = parseMax(rest[++k]); }
        catch (e) { console.error(String(e.message || e)); process.exit(1); }
      }
      else if (a === "--dry-run") dryRun = true;
      else file = a;
    }
    const src = file ? readScript(file) : (fs.existsSync(EXAMPLE) ? fs.readFileSync(EXAMPLE, "utf8") : DEFAULT_SCRIPT);
    let ast;
    try { ast = compile(src); }
    catch (e) { console.error(String(e.message || e)); process.exit(1); }

    const ctx = {
      vars: { alive: true },
      iter: 0,
      maxIterations: max,
      dryRun,
      out: (s) => console.log(s),
      commands: defaultCommands(),
    };
    console.log("🎸 moshcode — running moshscript\n");
    try { await run(ast, ctx); }
    catch (e) { console.error("\n" + String(e.message || e)); process.exit(1); }
    console.log(`\n✓ ${ctx.iter} loop(s) — no bugs, only features. 🤘`);
    return;
  }

  if (cmd === "spec") {
    const r = await runSpec(rest);
    if (!r.ok) {
      console.error(r.error?.code === "ENOENT"
        ? `couldn't run openspec — need \`${OPENSPEC.bin}\` on PATH or npx available. install: ${OPENSPEC.install.cmd} ${OPENSPEC.install.args.join(" ")}`
        : `openspec failed: ${r.error?.message || r.error}`);
      process.exit(1);
    }
    process.exit(r.code ?? 0);
  }

  // `moshcode <engine> [args…]` → open a passthrough session directly.
  const resolved = resolveEngine(cmd);
  if (resolved) {
    const [key, engine] = resolved;
    const r = await openSession(engine, rest);
    if (!r.ok) {
      console.error(r.error?.code === "ENOENT"
        ? `${key} isn't installed (\`${engine.bin}\`). run: moshcode install ${key}`
        : `launch failed: ${r.error?.message || r.error}`);
      process.exit(1);
    }
    process.exit(r.code ?? 0);
  }

  help();
  if (cmd && cmd !== "help") process.exit(1);
}

main();
