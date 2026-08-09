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
import { spawn, spawnSync } from "node:child_process";

import { createRegistry } from "./registry.mjs";
import { cliVerb, aiVerb } from "./cli.mjs";
import { ingestApproval, pollApproval } from "./notify.mjs";
import { capture, killSession, sendPrompt } from "./herd.mjs";
import { herdStart, roster, waitFor } from "./herd-cli.mjs";

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

/**
 * Fire-and-forget open of a URL in the OS default browser. Never throws.
 *
 * Returns whether the open was *attempted*, not whether it worked: a missing
 * opener surfaces as an async 'error' event on the child, long after this has
 * returned, so the catch below only ever sees a synchronous spawn failure.
 * Callers must not phrase the result as a browser that definitely opened.
 */
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
    usage: "code()",
    detail: "narrates a build step; takes no arguments",
    run(ctx, ...args) {
      expectNoArgs("code", args);
      ctx.out("  ⌨  code()    → compiling features (no bugs)…");
    },
  },
  {
    name: "mosh",
    summary: "open the pit + blast the moshcoding playlist",
    usage: "mosh()",
    detail: "opens the pit and starts the playlist",
    run(ctx, ...args) {
      expectNoArgs("mosh", args);
      ctx.out("  🤘 mosh()    → opening the pit");
      ctx.out(`     🎧 ${MOSH_PLAYLIST}`);
      if (ctx.dryRun) return;
      // Only ever an attempt — see openBrowser. dns.mjs ("opening <url>") and
      // auth.mjs ("opening your browser…") word their own opens the same way,
      // and the playlist URL is already on the line above to fall back to.
      if (hasDesktop() && openBrowser(MOSH_PLAYLIST)) {
        ctx.out("     ↗  opening it in your browser — crank it 🔊");
      }
    },
  },
  {
    name: "notify",
    summary: "ping the operator via app.moshcode.sh (email/SMS/Slack/Telegram/push)",
    usage: "notify(...message)",
    detail: "returns { id, url } — fire and forget, no reply awaited",
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
    usage: "ask(...prompt)",
    detail: "BLOCKS until a human answers at app.moshcode.sh; returns their reply or null. needs await",
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
    usage: "repeat()",
    detail: "jumps back to the top of the loop",
    run(ctx, ...args) {
      expectNoArgs("repeat", args);
      ctx.out("  ↻  repeat()  → back to the top");
    },
  },
  {
    name: "say",
    summary: "print a line",
    usage: "say(...parts)",
    detail: "prints one line",
    run(ctx, ...args) {
      ctx.out(`  💬 ${args.join(" ")}`);
    },
  },
  {
    name: "sleep",
    summary: "pause for N milliseconds (blocking)",
    usage: "sleep(ms)",
    detail: "blocks for ms milliseconds",
    // Synchronous/blocking so it pauses inline in the simple no-`await` style:
    // `while (alive) { work(); sleep(1000); }` actually waits each iteration.
    run(ctx, ...args) {
      const raw = args[0] ?? 0;
      const ms = Number(raw);
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`moshscript: sleep(ms) requires a finite non-negative number, got ${JSON.stringify(raw)}`);
      }
      if (ctx.dryRun) {
        ctx.out(`  ⏱ sleep(${ms}) → would pause for ${ms}ms`);
        return;
      }
      if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
  },
  {
    name: "stop",
    summary: "end the loop (alive = false)",
    usage: "stop()",
    detail: "ends the loop (alive = false)",
    run(ctx, ...args) {
      expectNoArgs("stop", args);
      ctx.stop();
      ctx.out("  ⏹  stop()    → alive = false");
    },
  },

  {
    name: "shell",
    summary: "run a shell command (blocking, cmd.exe on Windows or $SHELL -c elsewhere)",
    usage: "shell(cmd)",
    detail: "runs cmd in $SHELL; returns { ok, code, signal }",
    // The moshscript system verb for arbitrary shell commands. Blocking
    // (spawnSync + inherited stdio) so it runs inline in the no-`await` style,
    // and the child owns the terminal for interactive commands. Returns
    // { ok, code } so scripts can branch on the exit status:
    //   const r = shell("npm test"); if (!r.ok) say("tests failed");
    run(ctx, ...args) {
      const cmd = args.join(" ");
      if (!cmd) throw new Error("moshscript: shell() requires a command string");
      if (ctx.dryRun) {
        ctx.out(`  ▶ shell(${JSON.stringify(cmd)}) → would run: $SHELL -c ${JSON.stringify(cmd)}`);
        // Same R8 contract as the comment above: `code` is always present, so a
        // script branching on the exit status behaves the same under --dry-run.
        return { ok: true, code: 0, dryRun: true };
      }
      const sh = process.platform === "win32"
        ? (process.env.COMSPEC || "cmd.exe")
        : (process.env.SHELL || "/bin/sh");
      const shArgs = process.platform === "win32" ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
      ctx.out(`  ▶ shell: ${cmd}`);
      const res = spawnSync(sh, shArgs, { stdio: "inherit" });
      if (res.error) throw res.error;
      const code = res.status ?? 1;
      if (code !== 0) {
        ctx.out(`  ✗ shell() exited ${res.signal || code}`);
        return { ok: false, code, signal: res.signal || null };
      }
      return { ok: true, code: 0 };
    },
  },

  // The herd (PRD 0009 R12). These are local rather than cliVerbs on purpose:
  // a cliVerb returns { ok, code }, and the whole reason a script wants the
  // herd is to fan work out and then read what came back. `herdRead()` has to
  // hand back a string and `herdList()` an array, which shelling out cannot do.
  //
  //   const a = herdStart("claude", { name: "api" });
  //   const b = herdStart("codex",  { name: "web" });
  //   herdPrompt("api", "port the auth routes");
  //   herdPrompt("web", "port the dashboard");
  //   await herdWait("api"); await herdWait("web");   // both, in parallel
  //   say(herdRead("api", { lines: 20 }));
  {
    name: "herdStart",
    summary: "start an agent session that outlives this script",
    usage: 'herdStart(engine, { name, cwd, agent })',
    detail: "returns { ok, name }; the session keeps running after the script ends",
    run(ctx, engine, opts = {}) {
      if (!engine) throw new Error("moshscript: herdStart(engine) requires an engine name");
      const argv = [String(engine), "--json"];
      if (opts.name) argv.push("--name", String(opts.name));
      if (opts.cwd) argv.push("--cwd", String(opts.cwd));
      if (opts.agent) argv.push("--agent");
      if (ctx.dryRun) {
        ctx.out(`  🐑 herdStart(${engine}) → would run: moshcode herd start ${argv.join(" ")}`);
        return { ok: true, name: opts.name || String(engine), dryRun: true };
      }
      let captured = "";
      const code = herdStart(argv, { write: (s) => { captured += `${s}\n`; } });
      if (code !== 0) { ctx.out(`  ✗ herdStart(${engine}) → ${captured.trim()}`); return { ok: false, name: null }; }
      const name = JSON.parse(captured).name;
      ctx.out(`  🐑 herdStart(${engine}) → ${name}`);
      return { ok: true, name };
    },
  },
  {
    name: "herdPrompt",
    summary: "type a prompt into a herd session",
    usage: "herdPrompt(name, text)",
    detail: "returns { ok }; does not wait — use herdWait() to join",
    run(ctx, name, ...words) {
      const text = words.join(" ");
      if (!name || !text) throw new Error("moshscript: herdPrompt(name, text) requires both");
      if (ctx.dryRun) { ctx.out(`  💬 herdPrompt(${name}) → would send: ${text}`); return { ok: true, dryRun: true }; }
      ctx.out(`  💬 herdPrompt(${name}) → ${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`);
      const sent = sendPrompt(String(name), text);
      return { ok: Boolean(sent.ok) };
    },
  },
  {
    name: "herdWait",
    summary: "BLOCK until a herd session is blocked, done, or idle",
    usage: "herdWait(name, { states, timeout })",
    detail: "returns the state it reached. needs await",
    async run(ctx, name, opts = {}) {
      if (!name) throw new Error("moshscript: herdWait(name) requires a session name");
      const states = opts.states || ["blocked", "done", "idle"];
      if (ctx.dryRun) { ctx.out(`  ⏳ herdWait(${name}) → would wait for ${states.join("/")}`); return "idle"; }
      ctx.out(`  ⏳ herdWait(${name}) → waiting for ${states.join("/")}…`);
      const result = await waitFor(String(name), states, opts.timeout ? { timeoutMs: Number(opts.timeout) } : {});
      ctx.out(`     ${result.outcome === "matched" ? "✅" : "⌛"} ${name} is ${result.state}`);
      return result.state;
    },
  },
  {
    name: "herdRead",
    summary: "read a herd session's screen as a string",
    usage: "herdRead(name, { lines })",
    detail: "returns the last `lines` rows of its screen (default 60)",
    run(ctx, name, opts = {}) {
      if (!name) throw new Error("moshscript: herdRead(name) requires a session name");
      if (ctx.dryRun) { ctx.out(`  📖 herdRead(${name}) → would read its screen`); return ""; }
      return capture(String(name), { lines: Number(opts.lines) || 60 });
    },
  },
  {
    name: "herdList",
    summary: "every herd session and its state",
    usage: "herdList()",
    detail: "returns [{ name, engine, state, cwd, alive }, …]",
    run(ctx) {
      if (ctx.dryRun) { ctx.out("  🐑 herdList() → would list the herd"); return []; }
      return roster().map(({ name, engine, state, cwd, alive }) => ({ name, engine, state, cwd, alive }));
    },
  },
  {
    name: "herdKill",
    summary: "end a herd session",
    usage: "herdKill(name)",
    detail: "returns { ok }",
    run(ctx, name) {
      if (!name) throw new Error("moshscript: herdKill(name) requires a session name");
      if (ctx.dryRun) { ctx.out(`  ⏹ herdKill(${name}) → would end it`); return { ok: true, dryRun: true }; }
      ctx.out(`  ⏹ herdKill(${name})`);
      return { ok: Boolean(killSession(String(name)).ok) };
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
  cliVerb("herd", "drive the herd (moshcode herd <verb>) — see herdStart/herdWait for values"),
  cliVerb("ps", "print the herd roster"),
  cliVerb("start", "raw-launch an engine (moshcode start <engine>)"),
  cliVerb("install", "install an engine or workflow tool"),
  cliVerb("upgrade", "upgrade moshcode, engines, and tools"),
  cliVerb("mcp", "register/fan out an MCP server across engines"),
  cliVerb("skill", "install a skill across engines"),
  cliVerb("prd", "publish/author an OpenPRD doc"),
  cliVerb("ugig", "drive the ugig workflow CLI"),
  cliVerb("coinpay", "drive the coinpay workflow CLI"),
  cliVerb("c0mpute", "drive the c0mpute workflow CLI"),
  cliVerb("c0upons", "drive the c0upons workflow CLI"),
  cliVerb("secrets", "manage/view team secrets via logicsrc (login, teams, credentials)"),
  cliVerb("railway", "drive the Railway CLI (deploys, services, env vars)"),
  cliVerb("gh", "drive the GitHub CLI (repos, PRs, issues, releases)"),
  cliVerb("supabase", "drive the Supabase CLI (local stack, migrations, functions)"),
  cliVerb("doppler", "drive the Doppler CLI (secrets, env injection)"),
  cliVerb("doctl", "drive the DigitalOcean CLI (droplets, apps, databases)"),
  cliVerb("turso", "drive the Turso CLI (auth, databases, replicas)"),
  cliVerb("tailscale", "drive the Tailscale CLI (mesh VPN: up, status, ssh, serve)"),
  cliVerb("alpaca", "drive the native Alpaca trading CLI"),
  cliVerb("trade", "look up tickers, inspect markets, and preview/place Alpaca orders"),
  cliVerb("pwd", "print the current repo/location"),
];

/** A fresh registry preloaded with the built-in vocabulary. */
export function moshVocabulary() {
  return createRegistry(COMMANDS);
}
