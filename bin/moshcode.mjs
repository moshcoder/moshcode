#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compile, run } from "../src/interpreter.mjs";
import { defaultCommands } from "../src/commands.mjs";
import { ENGINES, engineList, engineStatus, resolveEngine, openSession } from "../src/engines.mjs";
import { runUpgrade } from "../src/upgrade.mjs";
import { locate, tilde } from "../src/pwd.mjs";
import { createPrd, listPrds, authoringPrompt } from "../src/prd.mjs";
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

function help() {
  console.log(`moshcode — metal scripting toolkit 🤘

usage:
  moshcode                             open the TUI shell (then /agents <engine>)
  moshcode <engine> [args…]            open a passthrough session on an engine
  moshcode run [file.mosh] [--max N]   run a moshscript (stdin with '-', or the
                                       built-in loop if no file); --max bounds
                                       the while loop (default 3)
  moshcode install <engine>            install an agentic-coding engine
  moshcode upgrade [self|<engine>…]    update moshcode + all installed engines
                                       (no args = everything; name targets to
                                       narrow, e.g. \`upgrade claude\`)
  moshcode prd [idea]                  publish the next numbered PRD (OpenPRD) to
                                       prd/NNNN-slug.md and hand it to an engine to
                                       author; no arg lists existing PRDs
  moshcode pwd                         show the current dir + git repo/branch/origin
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
      backToPit(`install ${engine}`, code);
    });
    return;
  }
  if (cmd === "upgrade" || cmd === "update") {
    console.log("🎸 moshcode upgrade — updating moshcode + installed engines 🤘");
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
      else if (a.startsWith("-")) {
        console.error(`moshcode run: unknown option ${a}`);
        process.exit(1);
      }
      else if (file) {
        console.error(`moshcode run: expected one script file, got ${JSON.stringify(file)} and ${JSON.stringify(a)}`);
        process.exit(1);
      }
      else file = a;
    }
    let src;
    try {
      src = file ? readScript(file) : (fs.existsSync(EXAMPLE) ? fs.readFileSync(EXAMPLE, "utf8") : DEFAULT_SCRIPT);
    } catch (e) {
      console.error(String(e.message || e));
      process.exit(1);
    }
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
    const r = await openSession(engine, rest);
    if (!r.ok) {
      console.error(r.error?.code === "ENOENT"
        ? `${key} isn't installed (\`${engine.bin}\`). run: moshcode install ${key}`
        : `launch failed: ${r.error?.message || r.error}`);
      // Couldn't even launch — drop into the pit (so you can /install it) when
      // interactive; otherwise exit non-zero for scripts/CI.
      if (!process.stdin.isTTY) process.exit(1);
      return tui();
    }
    return backToPit(key, r.code, r.signal);
  }

  help();
  if (cmd && cmd !== "help") process.exit(1);
}

main();
