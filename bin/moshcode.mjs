#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compile, run } from "../src/interpreter.mjs";
import { defaultCommands } from "../src/commands.mjs";

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

function help() {
  console.log(`moshcode — metal scripting toolkit 🤘

usage:
  moshcode run [file.mosh] [--max N]   run a moshscript (stdin with '-', or the
                                       built-in loop if no file); --max bounds
                                       the while loop (default 3)
  moshcode commands                    list built-in commands
  moshcode help                        this

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

  if (cmd === "commands") {
    console.log("built-in commands:\n  " + Object.keys(defaultCommands()).map((c) => `${c}()`).join("  "));
    return;
  }
  if (cmd === "run") {
    let max = 3, dryRun = false, file = null;
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (a === "--max" || a === "-n") max = Number(rest[++k]);
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
      maxIterations: Number.isFinite(max) && max > 0 ? max : 3,
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

  help();
  if (cmd && cmd !== "help") process.exit(cmd === undefined ? 0 : 1);
}

main();
