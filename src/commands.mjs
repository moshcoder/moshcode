// The moshscript command vocabulary — the verbs a .mosh script can call.
//
// moshscript is, more or less, the moshcode CLI scripted. Each command is
//   { name, summary, run(ctx, ...args) }
// and gets injected as a global of the same name by the runtime (src/runtime.mjs),
// so scripts call them bare: `mosh()`, `notify("shipping")`, `agents("claude")`.
//
// Two kinds of verb:
//   1. CLI verbs — the bulk. `agents("claude")` just runs `moshcode agents claude`
//      (see cliVerb / src/cli.mjs). One implementation of every capability (the
//      CLI); moshscript is a second caller. To expose a new CLI capability to
//      scripts, add one cliVerb line below.
//   2. Local verbs — moshscript-only flavor/helpers with no CLI equivalent
//      (mosh, code, notify, say, sleep, stop, repeat). `mosh()` is the worked
//      example of the local command shape.
import { spawn } from "node:child_process";

import { createRegistry } from "./registry.mjs";
import { cliVerb, aiVerb } from "./cli.mjs";
import { ingestApproval, pollApproval } from "./notify.mjs";

// The moshcoding pit-anthem playlist. mosh() blasts this URL and, on a desktop
// with a GUI, tries to open it in the default browser.
const MOSH_PLAYLIST =
  process.env.MOSHCODE_PLAYLIST ||
  "https://open.spotify.com/playlist/2FrXlq6ChSIFJ6CyGS0PGI";

/** True when we look like a desktop with a GUI the OS can open a browser on. */
function hasDesktop() {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  // Linux/BSD: only if a display server is present (skip headless/CI/servers).
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Fire-and-forget open of a URL in the OS default browser. Never throws. */
function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // no opener installed — stay quiet
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function expectNoArgs(name, args) {
  if (args.length > 0) {
    throw new Error(`moshscript: ${name}() does not take arguments`);
  }
}

// The vocabulary, in registration order. mosh() is the worked example of the
// command shape; the rest follow the same pattern.
const COMMANDS = [
  {
    name: "code",
    summary: "compile features (no bugs)",
    run(ctx, ...args) {
      expectNoArgs("code", args);
      ctx.out("  ⌨  code()    → compiling features (no bugs)…");
    },
  },
  {
    name: "mosh",
    summary: "open the pit + blast the moshcoding playlist",
    run(ctx, ...args) {
      expectNoArgs("mosh", args);
      ctx.out("  🤘 mosh()    → opening the pit");
      ctx.out(`     🎧 ${MOSH_PLAYLIST}`);
      if (ctx.dryRun) return;
      if (hasDesktop() && openBrowser(MOSH_PLAYLIST)) {
        ctx.out("     ↗  launched in your browser — crank it 🔊");
      }
    },
  },
  {
    name: "notify",
    summary: "ping the operator via app.moshcode.sh (email/SMS/Slack/Telegram/push)",
    // Fire-and-forget. Posts the approval to the app, which fans it out to the
    // operator's channels. Returns { id, url } so a script can hand the link off.
    async run(ctx, ...args) {
      const msg = args.length ? args.join(" ") : "moshcode ping 🤘";
      ctx.out(`  🔔 notify()  → ${msg}`);
      if (ctx.dryRun) return { dryRun: true };
      const r = await ingestApproval({ message: msg, kind: "notify", script: "moshscript", iter: ctx.iter });
      if (!r.ok) { ctx.out(`     ! notify failed (${r.error || r.status}) — run \`moshcode login\``); return null; }
      ctx.out(`     🔗 ${r.url}`);
      if (r.warning) ctx.out(`     ⚠ ${r.warning}`);
      return { id: r.id, url: r.url };
    },
  },
  {
    name: "ask",
    summary: "notify + BLOCK until the human approves/instructs at app.moshcode.sh",
    // The human-in-the-loop gate. Posts the approval to the app, then waits for
    // the operator to open app.moshcode.sh/approve/:id, read the context, and
    // submit. Resolves with their instructions (or null). Requires `await`.
    //   const task = await ask("what next?");
    async run(ctx, ...args) {
      const prompt = args.length ? args.join(" ") : "moshcode needs a human 🤘";
      ctx.out(`  🙋 ask()     → ${prompt}`);
      if (ctx.dryRun) {
        ctx.out("     (dry run — would block here for a human reply)");
        return null;
      }
      const r = await ingestApproval({ message: prompt, kind: "ask", script: "moshscript", iter: ctx.iter });
      if (!r.ok) { ctx.out(`     ! ask failed (${r.error || r.status}) — run \`moshcode login\``); return null; }
      ctx.out(`     🔗 approve/instruct: ${r.url}`);
      ctx.out("     ⏳ waiting for a human…");
      const reply = await pollApproval(r.id);
      ctx.out(reply == null ? "     ⌛ no reply — moving on" : `     ✅ got it: ${reply}`);
      return reply;
    },
  },
  {
    name: "repeat",
    summary: "back to the top of the loop",
    run(ctx, ...args) {
      expectNoArgs("repeat", args);
      ctx.out("  ↻  repeat()  → back to the top");
    },
  },
  {
    name: "say",
    summary: "print a line",
    run(ctx, ...args) {
      ctx.out(`  💬 ${args.join(" ")}`);
    },
  },
  {
    name: "sleep",
    summary: "pause for N milliseconds (blocking)",
    // Synchronous/blocking so it pauses inline in the simple no-`await` style:
    // `while (alive) { work(); sleep(1000); }` actually waits each iteration.
    run(_ctx, ...args) {
      const raw = args[0] ?? 0;
      const ms = Number(raw);
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`moshscript: sleep(ms) requires a finite non-negative number, got ${JSON.stringify(raw)}`);
      }
      if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
  },
  {
    name: "stop",
    summary: "end the loop (alive = false)",
    run(ctx, ...args) {
      expectNoArgs("stop", args);
      ctx.stop();
      ctx.out("  ⏹  stop()    → alive = false");
    },
  },

  // CLI verbs — each is `moshcode <name> ...args`. This is the whole point:
  // scripting the CLI. Add a capability by adding a line here.
  //
  // `run` composes scripts: run("setup.mosh") is `moshcode run setup.mosh`, so a
  // .mosh file can pull in other .mosh files. It blocks until the included script
  // finishes (spawnSync), so they run in order.
  cliVerb("run", "run another .mosh file (include)"),
  // shortcut: ai() runs an engine headlessly and RETURNS its output (see PRD R17)
  aiVerb,
  cliVerb("agents", "launch an autonomous agent session (moshcode agents <engine>)"),
  cliVerb("start", "raw-launch an engine (moshcode start <engine>)"),
  cliVerb("install", "install an engine or workflow tool"),
  cliVerb("upgrade", "upgrade moshcode, engines, and tools"),
  cliVerb("mcp", "register/fan out an MCP server across engines"),
  cliVerb("skill", "install a skill across engines"),
  cliVerb("prd", "publish/author an OpenPRD doc"),
  cliVerb("ugig", "drive the ugig workflow CLI"),
  cliVerb("coinpay", "drive the coinpay workflow CLI"),
  cliVerb("c0mpute", "drive the c0mpute workflow CLI"),
  cliVerb("pwd", "print the current repo/location"),
];

/** A fresh registry preloaded with the built-in vocabulary. */
export function moshVocabulary() {
  return createRegistry(COMMANDS);
}
