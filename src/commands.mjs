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
import { cliVerb, aiVerb, runMoshcode } from "./cli.mjs";
import { ingestApproval, pollApproval } from "./notify.mjs";
import { capture, killSession, sendPrompt } from "./herd.mjs";
import { herdStart, roster, waitFor } from "./herd-cli.mjs";
import { shellInvocation } from "./shell.mjs";
import { identity, loginAuto, logout as forgetCreds } from "./auth.mjs";
import { expandAlias, getAlias, loadAliases, removeAlias, setAlias } from "./aliases.mjs";
import { CORE_CLI_COMMAND_NAMES, PIT_COMMANDS } from "./cli-schema.mjs";
import { fetchAdvisor, stocksArgs } from "./advisor.mjs";
import { cryptoArgs, fetchCrypto } from "./crypto.mjs";
import { collectNews, loadListFeeds, readingList } from "./news.mjs";
import { resolveList } from "./news-sources.mjs";

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

/**
 * Whether a name already belongs to moshcode, for alias().
 *
 * The pit asks the dispatcher this by resolving; a script has no dispatcher, so
 * it asks the schema instead — the CLI commands and the pit's own verbs, which
 * is what an alias could collide with. Kept as a predicate (the shape
 * setAlias() takes) rather than an exported list, so this stays the caller's
 * answer and not a second roster to drift from the first.
 */
function isReserved(name) {
  const key = String(name).toLowerCase();
  return CORE_CLI_COMMAND_NAMES.includes(key)
    || PIT_COMMANDS.some((c) => (typeof c === "string" ? c : c.name) === key);
}

// The shell verb, named so runAlias() can execute an expanded alias line
// through exactly the same path a script's own shell() call takes — one
// invocation, one dry-run story, one { ok, code } contract. It is registered in
// COMMANDS below like every other verb.
const SHELL = {
  name: "shell",
  summary: "run a shell command (blocking, cmd.exe on Windows or $SHELL elsewhere)",
  usage: "shell(cmd)",
  detail: "runs cmd in $SHELL, loading your rc file where it can; returns { ok, code, signal }",
  // The moshscript system verb for arbitrary shell commands. Blocking
  // (spawnSync + inherited stdio) so it runs inline in the no-`await` style,
  // and the child owns the terminal for interactive commands. Returns
  // { ok, code } so scripts can branch on the exit status:
  //   const r = shell("npm test"); if (!r.ok) say("tests failed");
  run(ctx, ...args) {
    const cmd = args.join(" ");
    if (!cmd) throw new Error("moshscript: shell() requires a command string");
    if (ctx.dryRun) {
      ctx.out(`  ▶ shell(${JSON.stringify(cmd)}) → would run: $SHELL ${shellInvocation(cmd).flags} ${JSON.stringify(cmd)}`);
      // Same R8 contract as the comment above: `code` is always present, so a
      // script branching on the exit status behaves the same under --dry-run.
      return { ok: true, code: 0, dryRun: true };
    }
    // Same invocation the pit's own `!cmd` uses, so a command that works when
    // typed works when scripted: interactive where a terminal is attached, so
    // the user's rc file — and the aliases in it — are loaded. src/shell.mjs
    // has the reasoning, including why a headless run stays non-interactive.
    const { shell: sh, args: shArgs } = shellInvocation(cmd);
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
};

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

  SHELL,

  // The account. Local rather than cliVerbs for the same reason the herd is:
  // `moshcode whoami` prints, and a script needs to *branch* on the answer —
  // "am I logged in?", "whose account is this?", "are there credits left?".
  // Shelling out returns { ok, code }, so the only way to read the account
  // would be to re-parse stdout. src/auth.mjs owns the flows either way; these
  // are a second caller of the same identity(), not a second implementation.
  {
    name: "whoami",
    summary: "the logged-in account, as a value (verified against app.moshcode.sh)",
    usage: "whoami()",
    detail: "returns { status, verified, api, user: { id, email, name, credits } }. needs await",
    // Never throws — an unreachable app is a `status`, not an exception,
    // because the caller is usually deciding whether to start work.
    async run(ctx) {
      if (ctx.dryRun) {
        ctx.out("  👤 whoami()  → would check app.moshcode.sh");
        return { status: "dry_run", verified: false, api: null, user: null, dryRun: true };
      }
      const me = await identity();
      const who = me.user?.email || me.user?.name;
      ctx.out(me.verified
        ? `  👤 whoami()  → ${who || "moshcoder"} (${me.user.credits ?? "?"} credits)`
        : `  👤 whoami()  → ${me.status}${who ? ` (${who}, unverified)` : ""}`);
      return me;
    },
  },
  {
    name: "login",
    summary: "authenticate this machine against app.moshcode.sh",
    usage: "login({ device, browser, force })",
    detail: "no-op when already authenticated unless force; returns { ok, email, already }. needs await",
    // Idempotent by default. A script that opens with login() should be safe to
    // re-run all day without throwing a browser tab at an operator who is
    // already signed in — so the verified case returns early. `force` re-runs
    // the flow anyway (switching accounts), and device/browser pin the flow
    // rather than letting loginAuto sniff for SSH.
    async run(ctx, opts = {}) {
      if (ctx.dryRun) {
        ctx.out("  🔑 login()   → would authenticate against app.moshcode.sh");
        return { ok: true, email: null, already: false, dryRun: true };
      }
      if (!opts.force) {
        const me = await identity();
        if (me.verified) {
          ctx.out(`  🔑 login()   → already signed in as ${me.user.email || me.user.name || "moshcoder"}`);
          return { ok: true, email: me.user.email ?? null, already: true };
        }
      }
      try {
        const r = await loginAuto({ device: Boolean(opts.device), browser: Boolean(opts.browser) });
        ctx.out(`  🔑 login()   → signed in as ${r.email || "moshcoder"} 🤘`);
        return { ok: true, email: r.email ?? null, already: false };
      } catch (e) {
        // R8: hand back the failure instead of throwing, so a script can fall
        // back (skip the notify, run read-only) rather than die at line 1.
        ctx.out(`  ✗ login() failed — ${e.message}`);
        return { ok: false, email: null, already: false, error: e.message };
      }
    },
  },
  {
    name: "requireLogin",
    summary: "BLOCK until this machine is authenticated — the gate for scripts that need an account",
    usage: "requireLogin({ device, browser })",
    detail: "returns the verified { id, email, name, credits }; THROWS if it can't authenticate. needs await",
    // The one verb here that throws, and on purpose: "require" means the script
    // must not continue unauthenticated. Everything downstream (notify, ask,
    // credits) would fail one call at a time and much less legibly, so a script
    // that needs an account says so once, at the top.
    async run(ctx, opts = {}) {
      if (ctx.dryRun) {
        ctx.out("  🔒 requireLogin() → would require an authenticated account");
        return { id: null, email: null, name: null, credits: null, dryRun: true };
      }
      let me = await identity();
      if (!me.verified) {
        ctx.out(`  🔒 requireLogin() → ${me.status} — starting the login flow…`);
        try { await loginAuto({ device: Boolean(opts.device), browser: Boolean(opts.browser) }); }
        catch (e) { throw new Error(`moshscript: requireLogin() could not authenticate — ${e.message}`); }
        me = await identity();
      }
      if (!me.verified) {
        throw new Error(`moshscript: requireLogin() could not authenticate (${me.status}) — run \`moshcode login\``);
      }
      ctx.out(`  🔒 requireLogin() → ${me.user.email || me.user.name || "moshcoder"} 🤘`);
      return me.user;
    },
  },
  {
    name: "logout",
    summary: "forget this machine's credentials",
    usage: "logout()",
    detail: "returns { ok }",
    run(ctx, ...args) {
      expectNoArgs("logout", args);
      if (ctx.dryRun) { ctx.out("  🚪 logout()  → would forget the local credentials"); return { ok: true, dryRun: true }; }
      forgetCreds();
      return { ok: true };
    },
  },

  // Aliases. The pit already keeps named shortcuts (src/aliases.mjs) and they
  // are the operator's own vocabulary — the things *they* retype. A script that
  // cannot reach them has to re-spell every one of those lines, so the same
  // store is readable and writable here, and runAlias() executes one.
  {
    name: "alias",
    summary: "read, list, or define pit aliases",
    usage: 'alias() | alias(name) | alias(name, line)',
    detail: "no args → the whole map; one arg → that line or null; two → defines it, returns { ok, name, value, previous }",
    run(ctx, name, value) {
      if (name === undefined) return loadAliases();
      if (value === undefined) return getAlias(String(name));
      if (ctx.dryRun) {
        ctx.out(`  🔖 alias(${name}) → would define: ${value}`);
        return { ok: true, name: String(name), value: String(value), previous: null, dryRun: true };
      }
      // Same reservation rule the pit enforces: a shortcut that collides with a
      // built-in would be silently dead, so it is refused rather than shadowed.
      const r = setAlias(name, value, { isReserved });
      ctx.out(r.ok ? `  🔖 alias(${r.name}) → ${r.value}` : `  ✗ alias() — ${r.error}`);
      return r;
    },
  },
  {
    name: "unalias",
    summary: "forget a pit alias",
    usage: "unalias(name)",
    detail: "returns { ok, name, value } — { ok: false } when there was no such alias",
    run(ctx, name) {
      if (!name) throw new Error("moshscript: unalias(name) requires an alias name");
      if (ctx.dryRun) { ctx.out(`  🔖 unalias(${name}) → would forget it`); return { ok: true, name: String(name), dryRun: true }; }
      const r = removeAlias(name);
      ctx.out(r.ok ? `  🔖 unalias(${r.name})` : `  ✗ unalias() — ${r.error}`);
      return r;
    },
  },
  {
    name: "runAlias",
    summary: "run a pit alias by name, with extra arguments appended",
    usage: "runAlias(name, ...args)",
    detail: "returns { ok, code } like shell()/CLI verbs; { ok: false, code: 127 } when undefined",
    // The expansion rule is the pit's (src/aliases.mjs): a leading `/` is a pit
    // command, anything else is a shell line, and typed arguments are appended
    // rather than substituted. A pit command routes to its CLI twin here —
    // moshscript is not the pit, but `/agents claude` and `moshcode agents
    // claude` are the same capability, which is the whole cliVerb premise.
    run(ctx, name, ...args) {
      if (!name) throw new Error("moshscript: runAlias(name) requires an alias name");
      const value = getAlias(String(name));
      if (value == null) {
        ctx.out(`  ✗ runAlias(${name}) — no alias named "${name}"`);
        return { ok: false, code: 127 };
      }
      const line = expandAlias(value, args.map(String).join(" "));
      if (line.startsWith("/")) {
        const [verb, ...rest] = line.slice(1).split(/\s+/).filter(Boolean);
        return runMoshcode(verb, rest, ctx);
      }
      return SHELL.run(ctx, line.replace(/^!/, ""));
    },
  },

  // Reading the tools, not just running them. `stocks report NVDA` prints a
  // table; a script wants the score. These call the same advis0r/feed layer the
  // CLI renders from, so a verb here can never drift from its printed twin.
  {
    name: "stocksRead",
    summary: "run a stocks query and RETURN its JSON (advis0r)",
    usage: 'stocksRead("report", "NVDA")',
    detail: "same arguments as stocks(); returns the parsed data, or null on error. needs await",
    async run(ctx, ...args) {
      const request = stocksArgs(args.map(String));
      if (request.error) throw new Error(`moshscript: stocksRead() — ${request.error}`);
      if (ctx.dryRun) { ctx.out(`  📈 stocksRead(${args.join(" ")}) → would query advis0r`); return null; }
      ctx.out(`  📈 stocksRead(${args.join(" ")})`);
      const res = await fetchAdvisor(request);
      if (!res.ok) { ctx.out(`     ! ${res.error || `advis0r returned ${res.status}`}`); return null; }
      return res.data;
    },
  },
  {
    name: "cryptoRead",
    summary: "run a crypto query and RETURN its JSON (advis0r)",
    usage: 'cryptoRead("report", "BTC/USD")',
    detail: "same arguments as crypto(); returns the parsed data, or null on error. needs await",
    async run(ctx, ...args) {
      const request = cryptoArgs(args.map(String));
      if (request.error) throw new Error(`moshscript: cryptoRead() — ${request.error}`);
      if (ctx.dryRun) { ctx.out(`  🪙 cryptoRead(${args.join(" ")}) → would query advis0r`); return null; }
      ctx.out(`  🪙 cryptoRead(${args.join(" ")})`);
      const res = await fetchCrypto(request);
      if (!res.ok) { ctx.out(`     ! ${res.error || `advis0r returned ${res.status}`}`); return null; }
      return res.data;
    },
  },
  {
    name: "newsRead",
    summary: "fetch the news feeds and RETURN the headlines",
    usage: 'newsRead({ list, limit })',
    detail: "returns [{ title, link, source, date }, …] — your subscriptions, or a named list. needs await",
    // `list` names one of the built-in feed lists; omit it for the operator's
    // own subscriptions (the same reading list `/news` shows).
    async run(ctx, opts = {}) {
      const limit = Number(opts.limit) || 20;
      if (ctx.dryRun) { ctx.out(`  📰 newsRead() → would fetch ${opts.list || "your"} feeds`); return []; }
      let feeds;
      if (opts.list) {
        const list = resolveList(String(opts.list));
        if (!list) throw new Error(`moshscript: newsRead() — no feed list named "${opts.list}"`);
        const loaded = await loadListFeeds(list);
        if (!loaded.ok) { ctx.out(`     ! couldn't load ${opts.list}`); return []; }
        feeds = loaded.feeds;
      } else {
        feeds = readingList().feeds;
      }
      ctx.out(`  📰 newsRead() → reading ${feeds.length} feed(s)…`);
      const { items } = await collectNews(feeds);
      return items.slice(0, limit).map(({ title, link, source, date }) => ({ title, link, source, date }));
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
  cliVerb("coral", "drive the Coral CLI (SQL over APIs, databases, and internal systems)"),
  cliVerb("alpaca", "drive the native Alpaca trading CLI"),
  cliVerb("mcpjam", "drive the MCPJam CLI (test, debug, and validate MCP servers)"),
  cliVerb("trade", "look up tickers, inspect markets, and preview/place Alpaca orders"),
  cliVerb("pwd", "print the current repo/location"),

  // Research and feeds. The *Read() verbs above return the data; these are the
  // rendered CLI, for when a script wants the table on the operator's screen.
  cliVerb("stocks", "research tickers via advis0r (report, discover, signals, research)"),
  cliVerb("crypto", "research crypto pairs via advis0r (quote, report, bars, book)"),
  cliVerb("advisor", "query advis0r directly"),
  cliVerb("news", "read, search, and subscribe to news feeds"),
  cliVerb("rss", "manage RSS subscriptions and reading lists"),

  // Extending moshcode from a script — the same fan-out `mcp`/`skill` do.
  cliVerb("plugin", "install/manage moshcode plugins from the marketplace"),
  cliVerb("engines", "list coding engines and whether they're installed"),
  cliVerb("tools", "list the adjacent workflow CLIs and whether they're installed"),

  // Hosting: the Moshpit side of the CLI, so a deploy script can claim a name,
  // serve a site, and bring the resolver up without dropping to $SHELL.
  cliVerb("dns", "drive the Moshpit DNS bridge (enable, status, resolve)"),
  cliVerb("doh", "run/inspect the DNS-over-HTTPS endpoint"),
  cliVerb("site", "scaffold and publish a site"),
  cliVerb("serve", "serve a directory over HTTP"),
  cliVerb("template", "scaffold from a moshcode template"),

  // Settings sync (PRD 0010) — needs an account, so pair with requireLogin().
  cliVerb("save", "push local settings to your moshcode account"),
  cliVerb("load", "pull settings from your moshcode account"),
];

/** A fresh registry preloaded with the built-in vocabulary. */
export function moshVocabulary() {
  return createRegistry(COMMANDS);
}
