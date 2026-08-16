// `moshcode herd` — the command surface over src/herd.mjs (PRD 0009 R5, R10–R12).
//
// There is no second API. herdr's framing is that "the cli and socket api are
// the same surface agents drive"; moshcode's version of that is simpler,
// because there is only ever one surface — every verb here takes `--json`, and
// that is what a machine reads. A moshscript verb, a Claude Code session
// spawning a helper, and a person typing at the pit all go through this file.
import fs from "node:fs";
import path from "node:path";

import {
  attachSession, capture, defaultName, detectSubstrate, forgetSession, HERD_SOCKET,
  herdDir, killSession, listSessions, paneIndex, readManifest, rememberSession, sendKeys, sendPrompt,
  slugifyName, startSession, stopRuntime, substrateNote, validName, NAME_RE,
} from "./herd.mjs";
import { BLOCKED_KINDS, clearReport, inspectUserRules, reportState, STATES, withState } from "./herd-state.mjs";
import { ENGINES, resolveEngine, resolveExecutable, agentLaunchArgs } from "./engines.mjs";
import {
  endTask, findTask, ledgerSessions, openTask, readLog, readTasks, TERMINAL_STATES,
  recordTransition, screenDelta, startTask, stats as taskStats,
} from "./herd-tasks.mjs";
import { ingestApproval, pollApproval } from "./notify.mjs";
import { acid, amber, ash, bone, danger, dim, err, info, ok, table, warn } from "./ui.mjs";

/**
 * Distinct exit codes, because `wait` exists to be branched on (0009 R10), and
 * because `eval` in CI has to tell "the agent got worse" apart from "the
 * harness fell over" (0011 R13). One non-zero code cannot say both.
 */
export const EXIT = { matched: 0, usage: 1, timeout: 2, gone: 3, below: 4, infra: 5 };

const configFile = () => path.join(herdDir(), "config.json");

export function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    return { notify: { enabled: false, states: ["blocked"], ask: false, ...(raw?.notify || {}) } };
  } catch {
    return { notify: { enabled: false, states: ["blocked"], ask: false } };
  }
}

export function writeConfig(config) {
  try {
    fs.mkdirSync(herdDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** "4m", "1h12m", "3d" — a column, not a sentence. */
export function humanAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d`;
}

const tilde = (p) => {
  const home = process.env.HOME || "";
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

/**
 * The state column, coloured.
 *
 * `blocked` is the only one that gets a warning colour, because it is the only
 * one that is asking for something. A roster where four things are shouting is
 * a roster nobody reads.
 */
export function paintState(state) {
  if (state === "blocked") return amber("blocked");
  if (state === "working") return acid("working");
  if (state === "done") return bone("done");
  if (state === "gone") return danger("gone");
  return ash(state);
}

/**
 * The roster. Shared by `moshcode ps`, `/ps`, and the pit's own front door, so
 * they cannot drift into three different answers to the same question.
 */
export function renderRoster(rows, { indent = "  " } = {}) {
  if (!rows.length) return "";
  // Cells go in painted and `table` measures what prints, which is what the
  // state column needed: padding a coloured string to a fixed 9 used to mean
  // hand-correcting the width by the length of its own escape codes, and the
  // cwd column was pinned at 24 whether the paths were 8 columns or 60.
  return table(
    rows.map((r) => [
      bone(r.name),
      ash(String(r.engine)),
      paintState(r.state),
      // A remote member's cwd is the host it answers on, set when it was added:
      // "where is this thing" is the same question for both, and the answer is
      // a directory for one and a hostname for the other.
      ash(tilde(r.cwd || "")),
      // A remote row has no age worth printing — it was registered, not
      // started, and "3d" would read as three days of work.
      dim(r.kind === "remote" ? "—" : humanAge(r.age)),
      // Where the state came from (0011 R1, R11). This is the column that makes
      // the hook install visible — and the one that stops a remote's claim from
      // being mistaken for something this box verified.
      dim(String(r.authority || "")),
    ]),
    { columns: ["name", "engine", "state", "cwd", "age", "from"], header: false, indent: indent.length },
  );
}

/** Every session, with state attached. The one place that assembles both. */
export function roster(options = {}) {
  return withState(listSessions(options), options);
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

function requireSubstrate(write) {
  const substrate = detectSubstrate();
  if (substrate) return substrate;
  write(err("the herd needs somewhere to run."));
  write(info(substrateNote(null)));
  return null;
}

function findSession(name, options) {
  return roster(options).find((s) => s.name === name) || null;
}

/**
 * Start a session and hand the prompt straight back.
 *
 * The absolute path matters: the runtime's environment is whatever created the
 * server, which may predate an engine installer appending its bin directory to
 * a shell profile. resolveExecutable already knows every engine's extra
 * directories, so resolving here means `herd start opencode` works in the same
 * session that installed opencode — the exact case that bit the foreground
 * path first.
 */
export function herdStart(argv, { write = console.log } = {}) {
  const substrate = requireSubstrate(write);
  if (!substrate) return EXIT.usage;

  const flags = { name: null, cwd: process.cwd(), agent: false, json: false, herd: "main" };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") flags.name = argv[++i];
    else if (a.startsWith("--name=")) flags.name = a.slice(7);
    else if (a === "--cwd") flags.cwd = path.resolve(argv[++i] || ".");
    else if (a === "--herd") flags.herd = slugifyName(argv[++i]);
    else if (a.startsWith("--herd=")) flags.herd = slugifyName(a.slice(7));
    else if (a === "--agent") flags.agent = true;
    else if (a === "--json") flags.json = true;
    else rest.push(a);
  }

  const target = rest.shift();
  const resolved = target && resolveEngine(target);
  if (!resolved) {
    write(err(`usage: moshcode herd start <engine> [--name <slug>] [--agent] [args…]`));
    write(info(`engines: ${Object.keys(ENGINES).join(", ")}`));
    return EXIT.usage;
  }
  const [key, engine] = resolved;

  const taken = listSessions().map((s) => s.name);
  const name = flags.name || defaultName(key, flags.cwd, taken);
  if (!validName(name)) {
    write(err(`invalid name ${JSON.stringify(name)} — must match ${NAME_RE}`));
    return EXIT.usage;
  }

  const bin = resolveExecutable(engine.bin, engine.binDirs || []) || engine.bin;
  const args = flags.agent ? agentLaunchArgs(engine, rest) : rest;
  const started = startSession({
    name, engine: key, bin, args, stripEnv: engine.stripEnv || [], cwd: flags.cwd, substrate,
  });

  if (!started.ok) {
    write(err(String(started.error?.message || started.error)));
    return EXIT.usage;
  }
  rememberSession(name, { agent: flags.agent, herd: flags.herd });

  if (flags.json) {
    write(JSON.stringify({ name, engine: key, herd: flags.herd, cwd: flags.cwd, substrate, agent: flags.agent }, null, 2));
    return EXIT.matched;
  }
  write(ok(`${bone(name)} — ${key} running in the herd. the prompt is yours.`));
  if (flags.agent) write(warn("agent mode: native approvals are bypassed or auto-approved."));
  write(info(`workspace: ${acid("moshcode herd ui")} · attach: ${acid(`moshcode attach ${name}`)} · roster: ${acid("moshcode ps")}`));
  const note = substrateNote(substrate);
  if (note) write(info(note));
  return EXIT.matched;
}

/**
 * Run anything at all in the herd — a shell, or an agent moshcode does not ship
 * an install spec for.
 *
 * `herd start` is deliberately limited to the engines in ENGINES, because it
 * does engine-specific things: agent-mode flags, env stripping, resume args.
 * That made the herd useless for the two most common things people actually
 * want in it — a couple of shells, and whichever agent they use that moshcode
 * has never heard of (cursor-agent, copilot, amp, a local script).
 *
 * So this is the escape hatch, and it is the same model herdr uses: a session
 * holds a process, and an agent is just a process we happen to recognise.
 * Detection still works, because the shared rules in herd-state.mjs match what
 * a terminal draws — a y/n prompt, a numbered menu, "esc to interrupt" — rather
 * than anything engine-specific. An unknown agent that stops to ask a question
 * shows up `blocked` without moshcode knowing what it is.
 */
export function herdRun(argv, { write = console.log, shell = false } = {}) {
  const substrate = requireSubstrate(write);
  if (!substrate) return EXIT.usage;

  const flags = { name: null, cwd: process.cwd(), json: false, herd: "main" };
  const command = [];
  let afterSeparator = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (afterSeparator) { command.push(a); continue; }
    // Everything after `--` belongs to the command, flags included — otherwise
    // `herd run -- claude --json` would have its --json eaten by us.
    if (a === "--") { afterSeparator = true; }
    else if (a === "--name") flags.name = argv[++i];
    else if (a.startsWith("--name=")) flags.name = a.slice(7);
    else if (a === "--cwd") flags.cwd = path.resolve(argv[++i] || ".");
    else if (a === "--herd") flags.herd = slugifyName(argv[++i]);
    else if (a.startsWith("--herd=")) flags.herd = slugifyName(a.slice(7));
    else if (a === "--json") flags.json = true;
    else command.push(a);
  }

  if (shell && !command.length) {
    command.push(process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh"));
  }
  if (!command.length) {
    write(err('usage: moshcode herd run [--name <slug>] -- <command…>'));
    write(info(`e.g. ${acid('moshcode herd run --name build -- npm run watch')}`));
    return EXIT.usage;
  }

  const [bin, ...args] = command;
  const label = shell ? "shell" : path.basename(bin);
  const taken = listSessions().map((s) => s.name);
  const name = flags.name || defaultName(slugifyName(label), flags.cwd, taken);
  if (!validName(name)) {
    write(err(`invalid name ${JSON.stringify(name)} — must match ${NAME_RE}`));
    return EXIT.usage;
  }

  const started = startSession({ name, engine: label, bin, args, cwd: flags.cwd, substrate });
  if (!started.ok) {
    write(err(String(started.error?.message || started.error)));
    return EXIT.usage;
  }
  rememberSession(name, { herd: flags.herd });

  if (flags.json) {
    write(JSON.stringify({ name, engine: label, herd: flags.herd, cwd: flags.cwd, substrate }, null, 2));
    return EXIT.matched;
  }
  write(ok(`${bone(name)} — ${label} running in the herd. the prompt is yours.`));
  write(info(`workspace: ${acid("moshcode herd ui")} · attach: ${acid(`moshcode attach ${name}`)} · roster: ${acid("moshcode ps")}`));
  return EXIT.matched;
}

/** A plain $SHELL in the herd — the common case of herdRun. */
export const herdShell = (argv, options = {}) => herdRun(argv, { ...options, shell: true });

/**
 * Pull the herd flags out of an engine launch (PRD 0009 R3).
 *
 * Opt-in, never the default: `moshcode start claude` and `/start claude` have
 * to keep feeling exactly as they do today, or this is a regression wearing a
 * roster. `--name` implies `--detach`, because naming a session you were about
 * to sit inside is a request for one you can come back to.
 *
 * Shared by the CLI and the pit so the two cannot drift on what `-d` means.
 */
export function splitDetachArgs(args = []) {
  const rest = [];
  let detach = false, name = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--detach" || a === "-d") detach = true;
    else if (a === "--name") { name = args[++i]; detach = true; }
    else if (a.startsWith("--name=")) { name = a.slice(7); detach = true; }
    else rest.push(a);
  }
  return { detach, name, rest };
}

export function herdPs(argv, { write = console.log } = {}) {
  const rows = roster();
  if (argv.includes("--json")) {
    write(JSON.stringify(rows.map(({ name, engine, herd, state, authority, blockedOn, kind, url, cwd, age, alive, attached, substrate }) => ({
      name, engine, herd, state, authority, kind, ...(url ? { url } : {}),
      // The blocked sub-kind (R4) rides here and not in the roster's own
      // column: `--ask` needs to know whether a menu or a sentence is wanted,
      // and a person glancing at six rows does not.
      ...(blockedOn ? { blockedOn } : {}),
      cwd, ageMs: age, alive, attached, substrate,
    })), null, 2));
    return EXIT.matched;
  }
  if (!rows.length) {
    write(info("the herd is empty — `moshcode herd start claude` puts something in it."));
    const note = substrateNote();
    if (note) write(info(note));
    return EXIT.matched;
  }
  write(renderRoster(rows));
  const blocked = rows.filter((r) => r.state === "blocked");
  if (blocked.length) {
    write("");
    write(warn(`${blocked.length} waiting on you — ${acid(`moshcode attach ${blocked[0].name}`)}`));
  }
  return EXIT.matched;
}

export async function herdAttach(argv, { write = console.log } = {}) {
  const name = argv.find((a) => !a.startsWith("-"));
  if (!name) { write(err("usage: moshcode attach <name>")); return EXIT.usage; }
  const session = findSession(name);
  if (!session) { write(err(`no session named ${JSON.stringify(name)} — ${acid("moshcode ps")}`)); return EXIT.gone; }
  if (!session.alive) {
    write(err(`${name} is not running — ${acid("moshcode restore")} rebuilds it.`));
    return EXIT.gone;
  }
  // A finished session has nothing to type into. Show what it ended on rather
  // than dropping someone into a terminal that will not answer.
  if (session.exited) {
    write(info(`${bone(name)} has finished — this is where it stopped:`));
    write(capture(name, { lines: 40 }));
    write(info(`${acid(`moshcode restore`)} to start it again · ${acid(`moshcode kill ${name}`)} to drop it`));
    return EXIT.matched;
  }

  // Say how to get out before taking the terminal. The single worst outcome of
  // this whole feature is someone quitting a session they meant to leave
  // running, and the only defence is telling them the key first.
  const substrate = detectSubstrate();

  // Give the session a mosh bar, so the way out is on screen the whole time
  // rather than in a line that the agent's first repaint scrolls away. Only a
  // member sitting in its own session: a tiled one shares a window with its
  // neighbours and would be handing them a footer they did not ask for.
  const bar = await import("./herd-bar.mjs");
  let barTarget = null;
  if (substrate === "tmux") {
    bar.sweepBars({ runner: undefined, except: "herd" });
    const found = paneIndex().get(name);
    if (found && found.session === name) {
      barTarget = `${found.session}:${found.windowId}`;
      bar.ensureBar(barTarget, { command: bar.barCommand() });
      bar.bindJumpKey({});
    }
  }

  write(info(substrate === "tmux"
    ? `detach with Ctrl-b d — the session keeps running.${barTarget ? ` ${bar.BAR_KEY} for the mosh bar.` : ""}`
    : "detach with Ctrl-] — the session keeps running."));

  const result = await attachSession(name, { substrate });
  // Take it back out on the way through, so a member is a member again: `kill`
  // ends one by killing its pane, and a session still holding a bar would
  // outlive the member and keep its name on the roster.
  if (barTarget) bar.removeBar(barTarget, {});
  if (!result.ok) { write(err(String(result.error?.message || result.error))); return EXIT.usage; }

  const after = findSession(name);
  if (after?.alive) write(info(`detached — ${bone(name)} still ${after.state}. ${acid(`moshcode attach ${name}`)} to come back.`));
  else write(info(`${bone(name)} ended.`));
  return EXIT.matched;
}

export async function herdKill(argv, { write = console.log } = {}) {
  const all = argv.includes("--all");
  const names = all ? roster().map((s) => s.name) : argv.filter((a) => !a.startsWith("-"));
  if (!names.length) { write(err("usage: moshcode kill <name> | --all")); return EXIT.usage; }
  let failed = 0;
  for (const name of names) {
    // Killing a remote is deregistering it. There is no process of ours on the
    // other end, and reaching across the network to end somebody else's agent
    // because a local roster entry was removed would be a `kill` that does
    // considerably more than it says.
    if (isRemoteMember(name)) {
      const remote = await import("./herd-remote.mjs");
      const dropped = remote.removeRemote(name);
      if (dropped.ok) write(ok(`${name} removed from the roster — the agent at the far end is untouched.`));
      else { write(err(`${name}: ${dropped.error?.message}`)); failed++; }
      continue;
    }
    const result = killSession(name);
    clearReport(name);
    if (result.ok) write(ok(`${name} ended.`));
    else { write(err(`${name}: ${result.error?.message || "no such session"}`)); failed++; }
  }
  return failed && failed === names.length ? EXIT.gone : EXIT.matched;
}

/**
 * Drop sessions the runtime no longer has. Only ever removes bookkeeping — a
 * `prune` that could end running work would be a `kill` with a friendlier name.
 *
 * The task ledger is deliberately NOT pruned with the session. "What did that
 * agent do before the box rebooted" is the question the ledger exists for, and
 * a prune is usually the moment someone starts asking it. Growth is bounded by
 * the per-session cap in herd-tasks.mjs instead.
 */
export function herdPrune(argv, { write = console.log } = {}) {
  const gone = roster().filter((s) => !s.alive);
  for (const s of gone) { forgetSession(s.name); clearReport(s.name); }
  write(gone.length ? ok(`forgot ${gone.length} session(s) the runtime no longer has.`) : info("nothing to prune."));
  return EXIT.matched;
}

export function herdRead(argv, { write = console.log } = {}) {
  const positional = [];
  let lines = 60, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lines") lines = Number(argv[++i]) || 60;
    else if (a.startsWith("--lines=")) lines = Number(a.slice(8)) || 60;
    else if (a === "--json") json = true;
    else if (!a.startsWith("-")) positional.push(a);
  }
  const name = positional[0];
  if (!name) { write(err("usage: moshcode herd read <name> [--lines N]")); return EXIT.usage; }
  // A remote has no screen — what it has is the last thing it said, which is
  // what `read` is for in both cases.
  if (isRemoteMember(name)) return readRemoteMember(name, { json, write });
  const session = findSession(name);
  if (!session?.alive) { write(err(`no live session named ${JSON.stringify(name)}`)); return EXIT.gone; }
  const screen = capture(name, { lines });
  write(json ? JSON.stringify({ name, state: session.state, screen }, null, 2) : screen);
  return EXIT.matched;
}

async function readRemoteMember(name, { json, write }) {
  const remote = await import("./herd-remote.mjs");
  const entry = remote.remoteEntry(name);
  if (!entry) { write(err(`no member named ${JSON.stringify(name)}`)); return EXIT.gone; }
  const text = remote.readRemote(name);
  const status = remote.remoteStatusOf(name);
  if (json) {
    write(JSON.stringify({ name, kind: "remote", url: entry.url, state: status?.state || "unknown", observedAt: status?.at || null, screen: text }, null, 2));
    return EXIT.matched;
  }
  if (!text) {
    write(info(`${name} has not answered anything yet — ${acid(`moshcode herd prompt ${name} "…"`)}`));
    return EXIT.matched;
  }
  write(text);
  return EXIT.matched;
}

/**
 * Deliberately NOT unref'd.
 *
 * Everywhere else in moshcode a timer is unref'd so a background nicety — the
 * mirror, a follow — can never hold the process open. Here that instinct is
 * exactly backwards: `wait` and `watch` exist to keep the process alive, and an
 * unref'd timer means node finds nothing pending between polls and exits. It
 * does not hang; it is worse than that. `moshcode wait api --timeout 1h`
 * returns in a millisecond, exit 0, having waited for nothing.
 */
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Block until a session reaches one of `states`, or the timeout runs out.
 *
 * Polling, not an event stream, and deliberately so: neither substrate can push
 * a state change, and a one-second poll against a `capture-pane` is cheaper
 * than the machinery that would be needed to pretend otherwise. What matters is
 * that the *caller* stops polling and gets to just wait.
 */
export async function waitFor(name, states, {
  timeoutMs = 30 * 60 * 1000,
  intervalMs = 1000,
  now = () => Date.now(),
  look = (n) => findSession(n),
  // Called with every state this poll observes that differs from the last one.
  // The ledger (0011 R5) is written from here rather than from a second poller:
  // this loop already sees every transition a task goes through, and a second
  // one watching the same sessions would be twice the `capture-pane` for the
  // same answer.
  onState = null,
} = {}) {
  const wanted = new Set(states);
  const deadline = now() + timeoutMs;
  let seen;
  for (;;) {
    const session = look(name);
    if (!session) return { outcome: "gone", state: "gone" };
    if (onState && session.state !== seen) { seen = session.state; onState(session.state, session); }
    if (wanted.has(session.state)) return { outcome: "matched", state: session.state };
    // A session that ended can never reach `blocked`; waiting the full timeout
    // for something impossible is a hang, not a wait.
    if (!session.alive || session.state === "done") {
      return wanted.has("done") && session.state === "done"
        ? { outcome: "matched", state: session.state }
        : { outcome: "ended", state: session.state };
    }
    if (now() >= deadline) return { outcome: "timeout", state: session.state };
    await sleep(intervalMs);
  }
}

function parseDuration(raw, fallback) {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(String(raw || "").trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  return { ms: n, s: n * 1000, m: n * 60000, h: n * 3600000 }[m[2] || "s"];
}

/** Is this member a URL rather than a pty? Read straight from the manifest. */
export function isRemoteMember(name) {
  return readManifest().sessions[name]?.kind === "remote";
}

/**
 * Wait on one member, wherever it lives (0011 R12).
 *
 * A remote is polled by asking it, a local by looking at it, and the caller
 * writes the same `if` either way — which is the whole claim R12 makes.
 */
export async function waitMember(name, states, options = {}) {
  if (!isRemoteMember(name)) return waitFor(name, states, options);
  const remote = await import("./herd-remote.mjs");
  return remote.waitRemote(name, states, options);
}

/**
 * Wait on several members at once (0011 R8).
 *
 * `--any` returns on the first to arrive, `--all` when the last one has. Every
 * fan-out script written against the herd so far ends with a hand-rolled loop
 * doing one of these two things; this is that loop, once.
 */
export async function waitForMany(names, states, {
  mode = "any",
  timeoutMs = 30 * 60 * 1000,
  intervalMs = 1500,
  now = () => Date.now(),
  nap = sleep,
  observe = observeMember,
} = {}) {
  const wanted = new Set(states);
  const deadline = now() + timeoutMs;
  // ONE loop over all of them, rather than N waits raced against each other.
  // A race leaves the losers polling a process that has already printed its
  // answer, and their timers keep node alive — `wait --any` would return the
  // right thing and then refuse to exit for half an hour.
  const done = new Map();
  for (;;) {
    for (const name of names) {
      if (done.has(name)) continue;
      const seen = await observe(name);
      if (!seen.present) { done.set(name, { name, outcome: "gone", state: "gone" }); continue; }
      if (wanted.has(seen.state)) { done.set(name, { name, outcome: "matched", state: seen.state }); continue; }
      if (seen.alive === false || seen.state === "done") done.set(name, { name, outcome: "ended", state: seen.state });
    }
    const results = [...done.values()];
    const matched = results.filter((r) => r.outcome === "matched");
    if (mode === "any" && matched.length) {
      return { mode, outcome: "matched", winner: matched[0].name, first: matched[0], results };
    }
    if (done.size === names.length) {
      if (mode === "all") {
        const missed = results.find((r) => r.outcome !== "matched");
        return { mode, outcome: missed ? missed.outcome : "matched", winner: null, results };
      }
      return { mode, outcome: results[0]?.outcome || "gone", winner: null, results };
    }
    if (now() >= deadline) {
      return { mode, outcome: "timeout", winner: null, results, pending: names.filter((n) => !done.has(n)) };
    }
    await nap(intervalMs);
  }
}

/** One member's state right now — a look for a local, a request for a remote. */
export async function observeMember(name) {
  if (isRemoteMember(name)) {
    const remote = await import("./herd-remote.mjs");
    if (!remote.remoteEntry(name)) return { name, present: false };
    const pinged = await remote.pingRemote(name).catch(() => null);
    return { name, present: true, alive: true, state: pinged?.state || "unknown" };
  }
  const session = findSession(name);
  return session
    ? { name, present: true, alive: session.alive, state: session.state, blockedOn: session.blockedOn }
    : { name, present: false };
}

export async function herdWait(argv, { write = console.log } = {}) {
  const positional = [];
  let states = ["blocked", "done"], timeoutMs = 30 * 60 * 1000, json = false, mode = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--state") states = String(argv[++i] || "").split(",").filter(Boolean);
    else if (a.startsWith("--state=")) states = a.slice(8).split(",").filter(Boolean);
    else if (a === "--timeout") timeoutMs = parseDuration(argv[++i], timeoutMs);
    else if (a.startsWith("--timeout=")) timeoutMs = parseDuration(a.slice(10), timeoutMs);
    else if (a === "--any") mode = "any";
    else if (a === "--all") mode = "all";
    else if (a === "--json") json = true;
    else if (!a.startsWith("-")) positional.push(a);
  }
  if (!positional.length) {
    write(err("usage: moshcode wait <name…> [--any|--all] [--state blocked,done] [--timeout 30m]"));
    return EXIT.usage;
  }
  const unknown = states.filter((s) => !STATES.includes(s));
  if (unknown.length) { write(err(`unknown state ${unknown[0]} — one of ${STATES.join(", ")}`)); return EXIT.usage; }
  if (!mode && positional.length > 1) mode = "all"; // several names and no verb: join on all of them

  if (mode) {
    const result = await waitForMany(positional, states, { mode, timeoutMs });
    if (json) write(JSON.stringify({ mode, ...result }, null, 2));
    else if (result.outcome === "matched") {
      write(mode === "any"
        ? ok(`${result.winner} is ${result.first.state} first.`)
        : ok(`all ${positional.length} reached ${states.join("/")}.`));
    } else write(warn(`${mode === "any" ? "none of them" : "not all of them"} reached ${states.join("/")} (${result.outcome}).`));
    if (result.outcome === "matched") return EXIT.matched;
    return result.outcome === "timeout" ? EXIT.timeout : EXIT.gone;
  }

  const name = positional[0];
  const result = await waitMember(name, states, { timeoutMs, onState: ledgerRecorder(name) });
  if (json) write(JSON.stringify({ name, ...result }, null, 2));
  else if (result.outcome === "matched") write(ok(`${name} is ${result.state}.`));
  else if (result.outcome === "timeout") write(warn(`${name} is still ${result.state} after the timeout.`));
  else if (result.outcome === "gone") write(err(`no session named ${JSON.stringify(name)}`));
  else write(info(`${name} ended (${result.state}) without reaching ${states.join("/")}.`));

  if (result.outcome === "matched") return EXIT.matched;
  if (result.outcome === "timeout") return EXIT.timeout;
  return EXIT.gone;
}

/**
 * The ledger write a poll performs (0011 R5).
 *
 * Attributed to whichever task is open on that session, so a `wait` that
 * happens to be running while an agent works fills in the history of the prompt
 * that started it. With no open task the transition is still recorded, unbound
 * — `herd log` and `herd stats` want the state history whether or not anyone
 * submitted the work through the herd.
 */
export function ledgerRecorder(name) {
  return (state, session) => {
    const open = openTask(name);
    recordTransition(name, state, { id: open?.id || null, kind: session?.blockedOn || null });
  };
}

/**
 * Type a prompt into a running session, optionally waiting for it to land.
 *
 * `--wait` is the composite that makes agent-to-agent work practical: submit,
 * then block until the session stops working. The grace period before that is
 * not decoration — an engine takes a moment to notice input, and without it the
 * wait would see the still-idle screen and return instantly, reporting success
 * before the agent had read a word.
 */
export async function herdPrompt(argv, { write = console.log } = {}) {
  const positional = [];
  let wait = false, timeoutMs = 30 * 60 * 1000, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wait") wait = true;
    else if (a === "--timeout") timeoutMs = parseDuration(argv[++i], timeoutMs);
    else if (a.startsWith("--timeout=")) timeoutMs = parseDuration(a.slice(10), timeoutMs);
    else if (a === "--json") json = true;
    else positional.push(a);
  }
  const [name, ...words] = positional;
  const text = words.join(" ");
  if (!name || !text) { write(err('usage: moshcode herd prompt <name> "<text>" [--wait]')); return EXIT.usage; }

  // A remote member takes the same verb and the same flags (0011 R12). The
  // whole point is that a fan-out script contains no `if (remote)`, so this is
  // the one place that does.
  if (isRemoteMember(name)) return promptRemoteMember(name, text, { wait, json, write });

  const session = findSession(name);
  if (!session?.alive) { write(err(`no live session named ${JSON.stringify(name)}`)); return EXIT.gone; }

  // The task is minted BEFORE the keystrokes land, so a prompt that sends and
  // then vanishes into a crashed engine still leaves evidence that it was
  // submitted. A ledger that only records successful work is a ledger that
  // cannot answer the one question anybody asks it at 3am.
  const at = Date.now();
  const baseline = capture(name, { lines: 60 });
  const taskId = startTask(name, text, { screen: baseline, now: at, state: session.state });

  const sent = sendPrompt(name, text);
  if (!sent.ok) {
    endTask(name, taskId, { state: "done", artifact: `moshcode could not type into ${name}: ${sent.error?.message || sent.error}` });
    write(err(String(sent.error?.message || sent.error)));
    return EXIT.usage;
  }
  if (!wait) {
    if (json) write(JSON.stringify({ name, sent: true, task: taskId }, null, 2));
    else write(ok(`sent to ${bone(name)} — ${ash(taskId)}`));
    return EXIT.matched;
  }

  const record = ledgerRecorder(name);
  await waitFor(name, ["working"], { timeoutMs: 8000, intervalMs: 500, onState: record });
  const result = await waitFor(name, ["blocked", "done", "idle"], { timeoutMs, onState: record });
  endTask(name, taskId, {
    state: result.state,
    artifact: screenDelta(baseline, capture(name, { lines: 400 })),
  });
  if (json) write(JSON.stringify({ name, sent: true, task: taskId, ...result }, null, 2));
  else if (result.outcome === "matched") write(ok(`${name} is ${result.state}. ${ash(`${taskId} — moshcode herd task ${taskId}`)}`));
  else write(warn(`${name}: ${result.outcome} (${result.state})`));
  return result.outcome === "matched" ? EXIT.matched : result.outcome === "timeout" ? EXIT.timeout : EXIT.gone;
}

/** `herd prompt` against a URL. Same ledger, same exit codes, different wire. */
async function promptRemoteMember(name, text, { wait, json, write }) {
  const remote = await import("./herd-remote.mjs");
  const at = Date.now();
  const taskId = startTask(name, text, { screen: "", now: at });
  const sent = await remote.promptRemote(name, text);
  if (!sent.ok) {
    endTask(name, taskId, { state: "done", artifact: String(sent.error?.message || sent.error) });
    write(err(String(sent.error?.message || sent.error)));
    return EXIT.gone;
  }
  // An `a2a` member answers with a task that may still be running; a `run`
  // member has already answered by the time the POST returns. Both end up in
  // the ledger, which is what makes `herd tasks <remote>` mean anything.
  if (!wait || sent.state === "done") {
    endTask(name, taskId, { state: sent.state || "done", artifact: sent.artifact || "" });
    if (json) write(JSON.stringify({ name, sent: true, task: taskId, remoteTask: sent.taskId || null, state: sent.state }, null, 2));
    else write(ok(`${bone(name)} answered — ${ash(taskId)}`));
    return EXIT.matched;
  }
  const result = await remote.waitRemote(name, ["blocked", "done", "idle"]);
  const artifact = remote.readRemote(name);
  endTask(name, taskId, { state: result.state, artifact });
  if (json) write(JSON.stringify({ name, sent: true, task: taskId, ...result }, null, 2));
  else if (result.outcome === "matched") write(ok(`${name} is ${result.state}. ${ash(`${taskId}`)}`));
  else write(warn(`${name}: ${result.outcome} (${result.state})`));
  return result.outcome === "matched" ? EXIT.matched : result.outcome === "timeout" ? EXIT.timeout : EXIT.gone;
}

export function herdSendKeys(argv, { write = console.log } = {}) {
  const positional = argv.filter((a) => a !== "--json");
  const [name, ...keys] = positional;
  if (!name || !keys.length) { write(err("usage: moshcode herd send-keys <name> <keys…>")); return EXIT.usage; }
  const session = findSession(name);
  if (!session?.alive) { write(err(`no live session named ${JSON.stringify(name)}`)); return EXIT.gone; }
  const sent = sendKeys(name, keys);
  if (!sent.ok) { write(err(String(sent.error?.message || sent.error))); return EXIT.usage; }
  write(ok(`sent ${keys.join(" ")} to ${name}.`));
  return EXIT.matched;
}

export function herdReport(argv, { write = console.log } = {}) {
  const positional = [];
  let ttl;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ttl") ttl = parseDuration(argv[++i]);
    else if (a.startsWith("--ttl=")) ttl = parseDuration(a.slice(6));
    else if (!a.startsWith("-")) positional.push(a);
  }
  const [name, state] = positional;
  // A hook fired outside a herd session passes an empty name, because
  // $MOSHCODE_HERD_NAME is not set there. That is not a mistake to complain
  // about — it is an engine being used by hand, which is most of the time —
  // and a hook that printed usage on every turn would be uninstalled by
  // lunchtime. Present-but-empty is silence; absent entirely is still usage.
  if (positional.length >= 1 && name === "") return EXIT.matched;
  if (!name || !state) {
    write(err(`usage: moshcode herd report <name> <${STATES.join("|")}> [--ttl 15m]`));
    write(info(`blocked also takes a sub-kind: ${BLOCKED_KINDS.map((k) => `blocked:${k}`).join(", ")}`));
    return EXIT.usage;
  }
  const result = reportState(name, state, ttl ? { ttl } : {});
  if (!result.ok) { write(err(String(result.error?.message || result.error))); return EXIT.usage; }
  write(ok(`${name} → ${state} (authoritative)`));
  return EXIT.matched;
}

export function herdStatus(argv, { write = console.log } = {}) {
  const substrate = detectSubstrate();
  const rows = roster();
  const model = {
    substrate,
    socket: substrate === "tmux" ? HERD_SOCKET : null,
    dir: herdDir(),
    sessions: rows.length,
    live: rows.filter((r) => r.alive).length,
    blocked: rows.filter((r) => r.state === "blocked").length,
    notify: readConfig().notify,
  };
  if (argv.includes("--json")) { write(JSON.stringify(model, null, 2)); return EXIT.matched; }
  write(`${bone("substrate")}  ${substrate || danger("none")}${substrate === "tmux" ? ash(`  (socket ${HERD_SOCKET})`) : ""}`);
  write(`${bone("sessions")}   ${model.live} live${model.sessions - model.live ? ash(`, ${model.sessions - model.live} remembered`) : ""}`);
  write(`${bone("notify")}     ${model.notify.enabled ? acid(`on → ${model.notify.states.join(",")}`) : ash("off")}`);
  const note = substrateNote(substrate);
  if (note) write(info(note));
  return EXIT.matched;
}

export function herdNotify(argv, { write = console.log } = {}) {
  const verb = argv.find((a) => !a.startsWith("-"));
  const config = readConfig();
  if (!verb || verb === "status") {
    write(config.notify.enabled
      ? ok(`notifications on for ${config.notify.states.join(", ")}${config.notify.ask ? " (replies typed back into the session)" : ""}`)
      : info("notifications off — `moshcode herd notify on`"));
    return EXIT.matched;
  }
  if (verb === "on" || verb === "off") {
    config.notify.enabled = verb === "on";
    if (argv.includes("--ask")) config.notify.ask = true;
    if (argv.includes("--no-ask")) config.notify.ask = false;
    const at = argv.indexOf("--state");
    if (at >= 0 && argv[at + 1]) config.notify.states = argv[at + 1].split(",").filter((s) => STATES.includes(s));
    writeConfig(config);
    write(verb === "on"
      ? ok(`notifications on for ${config.notify.states.join(", ")} — run ${acid("moshcode herd watch")} in the herd to deliver them.`)
      : ok("notifications off."));
    return EXIT.matched;
  }
  write(err("usage: moshcode herd notify <on|off|status> [--state blocked,done] [--ask]"));
  return EXIT.usage;
}

/**
 * The watcher: the piece that turns a state change into a phone buzzing.
 *
 * It runs *inside* the herd (`moshcode herd watch` started as its own session),
 * which is the only placement that makes sense — a watcher in the pit would
 * stop watching the moment you closed the pit, which is precisely when you
 * needed it. This is also the part herdr structurally cannot do: it can colour
 * a pane, and moshcode can reach the human who is not looking at one.
 */
/**
 * Is this state change worth a human's attention?
 *
 * Only a *transition into* a watched state. Three things this rules out, each
 * of which would kill the feature on its own:
 *  - a session that sits blocked for an hour paging every five seconds;
 *  - the first sighting of an already-blocked session, which is history, not
 *    news — the watcher has just started and everything looks new;
 *  - any transition *out of* a watched state, which is the good news nobody
 *    needs a text about.
 */
export function shouldNotify(previous, current, interesting) {
  if (previous === undefined) return false;
  if (previous === current) return false;
  return interesting.has(current);
}

export async function herdWatch(argv, { write = console.log, once = false } = {}) {
  const intervalMs = (() => {
    const at = argv.indexOf("--interval");
    return at >= 0 ? parseDuration(argv[at + 1], 5000) : 5000;
  })();
  const config = readConfig();
  if (!config.notify.enabled && !argv.includes("--force")) {
    write(info("notifications are off — `moshcode herd notify on` first (or --force to watch anyway)."));
    return EXIT.usage;
  }
  const interesting = new Set(config.notify.states);
  write(ok(`watching the herd every ${Math.round(intervalMs / 1000)}s for ${[...interesting].join(", ")} 🤘`));

  const seen = new Map();
  for (;;) {
    // Remotes first, so this tick's roster reads a status cache that was
    // refreshed this tick rather than last one. The watcher is the only thing
    // in the herd that runs continuously, which makes it the only honest place
    // to keep a remote's state fresh (0011 R11).
    await refreshRemotes();
    // One roster per tick, not one per session: this loop runs forever, and
    // re-reading the herd inside the cleanup pass made a watcher on six
    // sessions shell out dozens of times every five seconds, all night.
    const current = roster();
    for (const session of current) {
      const previous = seen.get(session.name);
      seen.set(session.name, session.state);
      // The ledger write goes exactly where the notification decision already
      // is (0011 R5). Every transition, not only the ones worth a phone call —
      // "it worked for six hours and never asked me anything" is history too.
      if (previous !== undefined && previous !== session.state) recordObservedTransition(session);
      if (!shouldNotify(previous, session.state, interesting)) continue;
      await deliver(session, config, write);
    }
    const present = new Set(current.map((s) => s.name));
    for (const name of [...seen.keys()]) if (!present.has(name)) seen.delete(name);
    if (once) return EXIT.matched;
    await sleep(intervalMs);
  }
}

/**
 * What a reply to each kind of blocked has to look like.
 *
 * Sent with the notification rather than checked on the way back, because the
 * herd cannot know what a given engine's menu accepts and guessing wrong would
 * mean silently refusing to deliver a valid answer. Telling the human is the
 * part that is always safe.
 */
const ANSWER_HINT = {
  menu: "it is on a numbered menu — reply with the number.",
  permission: "it is asking permission — reply y or n.",
  question: "it asked a question — reply in words.",
};

/** Ask every remote member how it is, so the roster's cache is this tick's. */
async function refreshRemotes() {
  const remotes = roster().filter((s) => s.kind === "remote");
  if (!remotes.length) return;
  const remote = await import("./herd-remote.mjs");
  await Promise.all(remotes.map((s) => remote.pingRemote(s.name).catch(() => null)));
}

/**
 * Write one observed transition, and close the open task when the session has
 * stopped needing the CPU.
 *
 * This is what makes a prompt submitted WITHOUT `--wait` still end up with an
 * outcome and an artifact: the watcher is running anyway, and it is looking at
 * exactly the transition that ends the task.
 */
function recordObservedTransition(session) {
  const open = openTask(session.name);
  recordTransition(session.name, session.state, { id: open?.id || null, kind: session.blockedOn || null });
  if (!open) return;
  if (!TERMINAL_STATES.includes(session.state)) return;
  const screen = session.kind === "remote" ? "" : capture(session.name, { lines: 400 });
  endTask(session.name, open.id, {
    state: session.state,
    artifact: session.kind === "remote" ? "" : screenDelta(open.baseline, screen),
  });
}

async function deliver(session, config, write) {
  const tail = capture(session.name, { lines: 30 }).split("\n").slice(-12).join("\n");
  // The sub-kind (0011 R4) tells the human what shape of answer is wanted
  // before they read the screen — a menu wants a digit, a permission wants a
  // y or an n, and a question wants a sentence.
  const asking = session.blockedOn ? ` (${session.blockedOn})` : "";
  const message = `${session.name} (${session.engine}) is ${session.state}${asking} in ${tilde(session.cwd)}`
    + `${session.blockedOn ? `\n\n${ANSWER_HINT[session.blockedOn]}` : ""}\n\n${tail}`;
  if (!config.notify.ask) {
    const r = await ingestApproval({ message, kind: "notify", script: "herd", session: session.name });
    write(r.ok ? info(`notified: ${session.name} → ${session.state}`) : warn(`notify failed (${r.error || r.status}) — run \`moshcode login\``));
    return;
  }
  const r = await ingestApproval({ message, kind: "ask", script: "herd", session: session.name });
  if (!r.ok) { write(warn(`ask failed (${r.error || r.status}) — run \`moshcode login\``)); return; }
  write(info(`asked: ${r.url}`));
  const reply = await pollApproval(r.id);
  if (reply == null) { write(info(`no reply for ${session.name} — leaving it be`)); return; }
  const sent = sendPrompt(session.name, reply);
  write(sent.ok ? ok(`answered ${session.name}: ${reply}`) : warn(`could not type the reply into ${session.name}`));
}

/**
 * Rebuild the herd from the manifest.
 *
 * What comes back is the *shape* — the sessions, in their directories, on their
 * engines. The processes are gone and no amount of bookkeeping brings them
 * back, so the wording here never says "restored your work". `--resume` is the
 * separate, explicit act of asking each engine to reopen its own conversation,
 * and only the engines that actually have a resume flag get one.
 */
export function herdRestore(argv, { write = console.log } = {}) {
  const substrate = requireSubstrate(write);
  if (!substrate) return EXIT.usage;
  const resume = argv.includes("--resume");
  const dryRun = argv.includes("--dry-run");

  const manifest = readManifest();
  // Only a session that is actually *running* is one there is nothing to do
  // about. A finished one is a fair thing to bring back — it is on the roster
  // reading `done`, and restoring it is how you pick the work back up.
  const live = new Set(listSessions().filter((s) => s.alive && !s.exited).map((s) => s.name));
  const candidates = Object.entries(manifest.sessions).filter(([name]) => !live.has(name));
  if (!candidates.length) { write(info("nothing to restore — everything remembered is already running.")); return EXIT.matched; }

  let restored = 0;
  for (const [name, meta] of candidates) {
    const engine = ENGINES[meta.engine];
    if (!engine) { write(warn(`${name}: unknown engine ${meta.engine} — skipped`)); continue; }
    if (!fs.existsSync(meta.cwd || "")) { write(warn(`${name}: ${tilde(meta.cwd || "")} is gone — skipped`)); continue; }

    const resumeArgs = resume ? engine.resume || null : null;
    if (resume && !resumeArgs) write(info(`${name}: ${meta.engine} has no resume flag — starting fresh`));
    const args = resumeArgs || meta.args || [];
    if (dryRun) { write(info(`would restore ${bone(name)} — ${meta.engine} in ${tilde(meta.cwd)}${resumeArgs ? " (resumed)" : ""}`)); restored++; continue; }

    const bin = resolveExecutable(engine.bin, engine.binDirs || []) || engine.bin;
    const started = startSession({ name, engine: meta.engine, bin, args, stripEnv: engine.stripEnv || [], cwd: meta.cwd, substrate });
    if (!started.ok) { write(err(`${name}: ${started.error?.message || started.error}`)); continue; }
    clearReport(name);
    write(ok(`${bone(name)} — ${meta.engine} in ${tilde(meta.cwd)}${resumeArgs ? ash(" (asked to resume)") : ""}`));
    restored++;
  }
  if (restored && !dryRun) {
    write("");
    write(info("the shape is back; the processes are new. anything that was mid-task is not still running it."));
  }
  return EXIT.matched;
}

export function herdStop(argv, { write = console.log } = {}) {
  const rows = roster().filter((s) => s.alive);
  if (rows.length && !argv.includes("--yes") && !argv.includes("-y")) {
    write(err(`this ends ${rows.length} running session(s). re-run with --yes.`));
    write(renderRoster(rows));
    return EXIT.usage;
  }
  stopRuntime();
  write(ok("the herd is stopped."));
  return EXIT.matched;
}

// ---------------------------------------------------------------------------
// Hooks — believe the engine, not the paint (0011 R1)
// ---------------------------------------------------------------------------

export async function herdHooks(argv, { write = console.log } = {}) {
  const {
    hookableEngines, hooksStatus, installHooks, removeHooks, hookDiff, hookFile,
  } = await import("./herd-hooks.mjs");

  const positional = argv.filter((a) => !a.startsWith("-"));
  const [verb = "status", target] = positional;
  const dryRun = argv.includes("--dry-run");
  const json = argv.includes("--json");
  const supported = hookableEngines();

  const targets = (() => {
    if (!target || target === "all") return supported;
    const resolved = resolveEngine(target);
    return resolved ? [resolved[0]] : [];
  })();

  if (verb !== "status" && !targets.length) {
    write(err(`no engine named ${JSON.stringify(target)}`));
    write(info(`engines with hook specs: ${supported.join(", ") || "none yet"}`));
    return EXIT.usage;
  }

  if (verb === "status") {
    const rows = (target && target !== "all" ? targets : supported).map((engine) => hooksStatus(engine));
    if (json) { write(JSON.stringify(rows, null, 2)); return EXIT.matched; }
    if (!rows.length) { write(info("no engine in this release ships a hook spec.")); return EXIT.matched; }
    for (const row of rows) {
      if (!row.readable) { write(err(`${row.engine} — ${row.error}`)); continue; }
      const state = row.installed ? ok(`${row.engine} — hooks installed`)
        : row.partial ? warn(`${row.engine} — hooks are out of date, re-run install`)
        : info(`${row.engine} — no hooks; sessions are classified from the screen`);
      write(state);
      write(ash(`  ${row.file}`));
      for (const e of row.events) {
        write(`  ${e.installed && e.current ? acid("✓") : e.installed ? amber("~") : ash("·")} ${(e.label || e.event).padEnd(16)} ${ash(`→ ${e.state}`)}`);
      }
    }
    const unsupported = Object.keys(ENGINES).filter((k) => !supported.includes(k));
    if (unsupported.length && !target) write(info(`no hook spec yet: ${unsupported.join(", ")} — those stay on the screen rules.`));
    return EXIT.matched;
  }

  if (verb !== "install" && verb !== "remove") {
    write(err("usage: moshcode herd hooks <install|remove|status> [<engine>|all] [--dry-run] [--json]"));
    return EXIT.usage;
  }

  const results = targets.map((engine) => (verb === "install"
    ? installHooks(engine, { dryRun })
    : removeHooks(engine, { dryRun })));

  if (json) {
    write(JSON.stringify(results.map((r) => ({
      engine: r.engine, ok: r.ok, file: r.file ?? hookFile(r.engine), dryRun: Boolean(r.dryRun),
      ...(r.changes ? { changes: r.changes } : {}), ...(r.removed !== undefined ? { removed: r.removed } : {}),
      ...(r.error ? { error: String(r.error.message || r.error) } : {}),
    })), null, 2));
    return results.every((r) => r.ok) ? EXIT.matched : EXIT.usage;
  }

  for (const result of results) {
    if (!result.ok) { write(err(`${result.engine} — ${result.error?.message || result.error}`)); continue; }
    if (dryRun) {
      const diff = hookDiff(result.before, result.after);
      write(info(`${result.engine} — ${result.file} (dry run)`));
      write(diff.split("\n").some((l) => l.startsWith("+") || l.startsWith("-")) ? diff : ash("  nothing would change"));
      continue;
    }
    if (verb === "install") {
      const added = result.changes.filter((c) => c.change !== "unchanged");
      write(added.length
        ? ok(`${result.engine} — ${added.length} hook${added.length === 1 ? "" : "s"} installed (${added.map((c) => c.label).join(", ")})`)
        : ok(`${result.engine} — already installed`));
      if (added.length) {
        write(info("sessions started from the herd now report state directly."));
        write(info("screen rules remain the fallback for everything else."));
      }
    } else {
      write(result.removed ? ok(`${result.engine} — ${result.removed} hook(s) removed; back to the screen rules.`) : info(`${result.engine} — nothing of ours was in there.`));
    }
  }
  return results.every((r) => r.ok) ? EXIT.matched : EXIT.usage;
}

// ---------------------------------------------------------------------------
// Doctor — the things that actually go wrong (0011 R3)
// ---------------------------------------------------------------------------

export async function herdDoctor(argv, { write = console.log } = {}) {
  const { hookableEngines, hooksStatus } = await import("./herd-hooks.mjs");
  const substrate = detectSubstrate();
  const checks = [];
  const add = (name, level, detail, fix = null) => checks.push({ name, level, detail, ...(fix ? { fix } : {}) });

  // 1. Somewhere to run.
  if (substrate === "tmux") add("substrate", "ok", `tmux, socket ${HERD_SOCKET}`);
  else if (substrate === "pty") add("substrate", "warn", "script(1) — sessions work but cannot be resized", "install tmux");
  else add("substrate", "fail", "nothing to run sessions on", substrateNote(null));

  // 2. Does the manifest still describe reality?
  const rows = roster();
  const remembered = rows.filter((s) => !s.alive);
  if (remembered.length) add("manifest", "warn", `${remembered.length} remembered session(s) the runtime no longer has: ${remembered.map((s) => s.name).join(", ")}`, "moshcode restore  ·  moshcode herd prune");
  else add("manifest", "ok", `${rows.length} session(s), all accounted for`);

  // 3. Can we write where the state lives? A silently unwritable status dir is
  //    a herd where every hook report is lost and nothing anywhere says so.
  const statusDir = path.join(herdDir(), "status");
  try {
    fs.mkdirSync(statusDir, { recursive: true, mode: 0o700 });
    const probe = path.join(statusDir, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
    add("status dir", "ok", statusDir);
  } catch (error) {
    add("status dir", "fail", `${statusDir} is not writable (${error.code || error.message})`, "hook reports are being dropped — fix the permissions on ~/.moshcode/herd");
  }

  // 4. Hook reports that have gone stale — an engine that stopped reporting is
  //    a roster quietly back on the screen rules.
  const stale = [];
  for (const row of rows) {
    if (row.kind === "remote" || !row.alive) continue;
    const file = path.join(statusDir, `${row.name}.json`);
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const age = Date.now() - Number(raw.at || 0);
      if (age > Math.min(Number(raw.ttl) || 0, 15 * 60 * 1000)) stale.push(`${row.name} (${humanAge(age)} old)`);
    } catch { /* no report is not a stale report */ }
  }
  if (stale.length) add("hook reports", "warn", `expired: ${stale.join(", ")}`, "moshcode herd hooks status — the engine may have stopped reporting");
  else add("hook reports", "ok", "none expired");

  // 5. The hooks themselves.
  for (const engine of hookableEngines()) {
    const status = hooksStatus(engine);
    if (!status.readable) add(`hooks: ${engine}`, "fail", status.error, "fix the file, then moshcode herd hooks install");
    else if (status.installed) add(`hooks: ${engine}`, "ok", status.file);
    else if (status.partial) add(`hooks: ${engine}`, "warn", "installed but out of date", `moshcode herd hooks install ${engine}`);
    else add(`hooks: ${engine}`, "warn", "not installed — this engine is classified from its screen", `moshcode herd hooks install ${engine}`);
  }

  // 6. rules.json, which until now failed silently by design.
  const rules = inspectUserRules();
  if (!rules.present) add("rules.json", "ok", "none — using the built-in rules");
  else if (rules.ok) add("rules.json", "ok", `${rules.patterns} pattern(s) loaded`);
  else {
    add("rules.json", "fail", `${rules.problems.length} problem(s) — the whole file is being ignored`,
      rules.problems.map((p) => `${p.where}: ${p.error}`).join(" · "));
  }

  const worst = checks.some((c) => c.level === "fail") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "ok";
  if (argv.includes("--json")) {
    write(JSON.stringify({ ok: worst !== "fail", level: worst, herdDir: herdDir(), substrate, checks }, null, 2));
    return worst === "fail" ? EXIT.infra : EXIT.matched;
  }
  for (const check of checks) {
    const mark = check.level === "ok" ? acid("✓") : check.level === "warn" ? amber("!") : danger("✗");
    write(`${mark} ${bone(check.name.padEnd(16))} ${check.level === "ok" ? ash(check.detail) : check.detail}`);
    if (check.fix) write(`  ${ash("→")} ${acid(check.fix)}`);
  }
  return worst === "fail" ? EXIT.infra : EXIT.matched;
}

// ---------------------------------------------------------------------------
// The ledger's read verbs (0011 R6–R7)
// ---------------------------------------------------------------------------

/**
 * Close an open task whose session has already stopped.
 *
 * A prompt submitted without `--wait`, on a box with no watcher running, leaves
 * a task nobody ever came back to. Reading the ledger IS coming back to it: the
 * session's state is looked up here anyway, so recording what it says costs
 * nothing and turns "open forever" into the outcome that actually happened.
 */
function reconcile(session) {
  const open = openTask(session);
  if (!open) return;
  const row = findSession(session);
  if (!row || row.kind === "remote") return;
  if (!TERMINAL_STATES.includes(row.state)) return;
  endTask(session, open.id, {
    state: row.state,
    artifact: screenDelta(open.baseline, capture(session, { lines: 400 })),
  });
}

export function herdTasks(argv, { write = console.log } = {}) {
  const json = argv.includes("--json");
  const positional = argv.filter((a) => !a.startsWith("-"));
  const name = positional[0];
  if (!name) {
    write(err("usage: moshcode herd tasks <session> [--json]"));
    const known = ledgerSessions();
    write(info(known.length ? `sessions with history: ${known.join(", ")}` : "nothing has been prompted through the herd yet."));
    return EXIT.usage;
  }
  reconcile(name);
  const tasks = readTasks(name);
  if (json) { write(JSON.stringify(tasks, null, 2)); return EXIT.matched; }
  if (!tasks.length) {
    write(info(`no tasks recorded for ${JSON.stringify(name)} — ${acid(`moshcode herd prompt ${name} "…"`)} starts one.`));
    return EXIT.matched;
  }
  write(table(tasks.map((t) => [
    bone(t.id),
    ash(clock(t.submitted)),
    paintState(t.status === "open" ? (t.state || "working") : t.state),
    dim(t.durationMs != null ? humanAge(t.durationMs) : humanAge(Date.now() - (t.submitted || Date.now()))),
    ash(`"${oneLine(t.text, 48)}"`),
  ]), { columns: ["task", "at", "state", "took", "prompt"], header: false, indent: 2 }));
  const open = tasks.filter((t) => t.status === "open").length;
  if (open) write(info(`${open} still open — ${acid("moshcode herd watch")} closes them as they land.`));
  return EXIT.matched;
}

export function herdTask(argv, { write = console.log } = {}) {
  const json = argv.includes("--json");
  const id = argv.find((a) => !a.startsWith("-"));
  if (!id) { write(err("usage: moshcode herd task <id> [--json]")); return EXIT.usage; }
  const task = findTask(id);
  if (!task) { write(err(`no task ${JSON.stringify(id)} — ${acid("moshcode herd tasks <session>")}`)); return EXIT.gone; }
  if (json) { write(JSON.stringify(task, null, 2)); return EXIT.matched; }

  write(`${bone(task.id)} ${ash(`· ${task.session} · ${clock(task.submitted)}`)}`);
  write(`${ash("prompt")}  ${task.text}`);
  write("");
  for (const [i, step] of task.transitions.entries()) {
    const next = task.transitions[i + 1]?.ts ?? task.endedAt ?? Date.now();
    write(`  ${ash(clock(step.ts))}  ${paintState(step.state)}${step.kind ? ash(`:${step.kind}`) : ""}  ${dim(humanAge(next - step.ts))}`);
  }
  if (task.status === "closed") write(`  ${ash(clock(task.endedAt))}  ${paintState(task.state)}  ${dim("(end)")}`);
  else write(`  ${ash("…")}       ${amber("open")}`);
  if (task.artifact) {
    write("");
    write(ash(task.truncated ? `output (last ${task.artifact.length} of ${task.artifactChars} chars):` : "output:"));
    write(task.artifact);
  }
  return EXIT.matched;
}

export function herdLog(argv, { write = console.log } = {}) {
  const json = argv.includes("--json");
  const name = argv.find((a) => !a.startsWith("-"));
  if (!name) { write(err("usage: moshcode herd log <session> [--json]")); return EXIT.usage; }
  const entries = readLog(name);
  if (json) { write(JSON.stringify(entries, null, 2)); return EXIT.matched; }
  if (!entries.length) { write(info(`no history for ${JSON.stringify(name)} yet.`)); return EXIT.matched; }
  for (const entry of entries) {
    // The end of a task and a transition into the same state are two different
    // records, and a log that printed them identically would read as the herd
    // seeing everything twice.
    const label = entry.event === "submit" ? acid("submit")
      : entry.event === "end" ? `${paintState(entry.state)}${ash(" ✓")}`
      : paintState(entry.state);
    write(`  ${ash(clock(entry.ts))}  ${label}`
      + `${entry.kind ? ash(`:${entry.kind}`) : ""}  ${dim(entry.id || "")}`
      + `${entry.text ? `  ${ash(`"${oneLine(entry.text, 40)}"`)}` : ""}`);
  }
  return EXIT.matched;
}

export function herdStats(argv, { write = console.log } = {}) {
  const json = argv.includes("--json");
  const name = argv.find((a) => !a.startsWith("-"));
  const sessions = name ? [name] : ledgerSessions();
  if (!sessions.length) { write(info("nothing has been prompted through the herd yet.")); return EXIT.matched; }
  const all = sessions.map((s) => taskStats(s));
  if (json) { write(JSON.stringify(all, null, 2)); return EXIT.matched; }
  for (const s of all) {
    const parts = Object.entries(s.totals)
      .filter(([, ms]) => ms > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([state, ms]) => `${state} ${humanAge(ms)}`);
    write(`${bone(s.session.padEnd(12))} ${parts.join(ash(" · ")) || ash("no transitions recorded")}`);
    // The line the whole feature is for. Blocked time is not the agent being
    // slow; it is the agent finished and waiting for a person.
    if (s.totals.blocked) write(`  ${amber(`blocked ${humanAge(s.totals.blocked)}`)} ${ash(`over ${s.blockedSpells} spell(s) — that one is you`)}`);
  }
  return EXIT.matched;
}

const clock = (ts) => (Number.isFinite(ts) ? new Date(ts).toTimeString().slice(0, 5) : "  :  ");
const oneLine = (text, max) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// ---------------------------------------------------------------------------
// Remote members (0011 R11)
// ---------------------------------------------------------------------------

export async function herdRemote(argv, { write = console.log } = {}) {
  const remote = await import("./herd-remote.mjs");
  const json = argv.includes("--json");
  const positional = [];
  let kind = "run";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--kind") kind = String(argv[++i] || "");
    else if (a.startsWith("--kind=")) kind = a.slice(7);
    else if (!a.startsWith("-")) positional.push(a);
  }
  const [verb = "list", name, url] = positional;

  if (verb === "list") {
    const rows = remote.listRemotes();
    if (json) { write(JSON.stringify(rows, null, 2)); return EXIT.matched; }
    if (!rows.length) {
      write(info("no remote members — `moshcode herd remote add <name> <url> --kind a2a|run`"));
      return EXIT.matched;
    }
    write(table(rows.map((r) => [
      bone(r.name), ash(r.remoteKind), paintState(r.status?.state || "unknown"),
      ash(r.url), dim(r.status?.at ? `${humanAge(Date.now() - r.status.at)} ago` : "never asked"),
    ]), { columns: ["name", "kind", "state", "url", "seen"], header: false, indent: 2 }));
    for (const r of rows) {
      if (!process.env[remote.tokenEnvVar(r.name)]) write(ash(`  ${r.name}: no ${remote.tokenEnvVar(r.name)} in the environment — requests go unauthenticated`));
    }
    return EXIT.matched;
  }

  if (verb === "add") {
    if (!name || !url) { write(err("usage: moshcode herd remote add <name> <url> [--kind a2a|run]")); return EXIT.usage; }
    const added = remote.addRemote(name, url, { kind });
    if (!added.ok) { write(err(String(added.error?.message || added.error))); return EXIT.usage; }
    write(ok(`${bone(name)} — ${kind} member at ${added.url}`));
    write(info(`auth: export ${remote.tokenEnvVar(name)}=… (never written to the manifest, never synced)`));
    const pinged = await remote.pingRemote(name);
    write(pinged.ok ? ok(`it answers — ${pinged.state}`) : warn(`no answer yet: ${pinged.error?.message || pinged.error}`));
    return EXIT.matched;
  }

  if (verb === "remove" || verb === "rm") {
    if (!name) { write(err("usage: moshcode herd remote remove <name>")); return EXIT.usage; }
    const removed = remote.removeRemote(name);
    if (!removed.ok) { write(err(String(removed.error?.message || removed.error))); return EXIT.gone; }
    write(ok(`${name} is off the roster. the agent at the far end is untouched.`));
    return EXIT.matched;
  }

  if (verb === "ping") {
    const names = name ? [name] : remote.listRemotes().map((r) => r.name);
    if (!names.length) { write(info("no remote members to ping.")); return EXIT.matched; }
    const results = [];
    for (const one of names) {
      const pinged = await remote.pingRemote(one);
      results.push({ name: one, ok: pinged.ok, state: pinged.state || "unknown", error: pinged.error ? String(pinged.error.message || pinged.error) : null });
      if (!json) write(pinged.ok ? ok(`${one} — ${pinged.state}`) : err(`${one} — ${pinged.error?.message || pinged.error}`));
    }
    if (json) write(JSON.stringify(results, null, 2));
    return results.every((r) => r.ok) ? EXIT.matched : EXIT.gone;
  }

  if (verb === "card") {
    if (!name) { write(err("usage: moshcode herd remote card <name>")); return EXIT.usage; }
    const card = await remote.discoverCard(name);
    if (!card.ok) { write(err(String(card.error?.message || card.error))); return EXIT.gone; }
    write(JSON.stringify(card.card, null, 2));
    return EXIT.matched;
  }

  write(err("usage: moshcode herd remote <list|add|remove|ping|card> [args…]"));
  return EXIT.usage;
}

// ---------------------------------------------------------------------------
// serve — the herd over A2A (0011 R9–R10)
// ---------------------------------------------------------------------------

export async function herdServe(argv, { write = console.log } = {}) {
  const serve = await import("./herd-serve.mjs");
  const flag = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--")) return argv[at + 1];
    const inline = argv.find((a) => a.startsWith(`--${name}=`));
    return inline ? inline.slice(name.length + 3) : fallback;
  };

  const rawPort = flag("port", String(serve.DEFAULT_SERVE_PORT));
  const port = /^\d+$/.test(rawPort) && Number(rawPort) >= 1 && Number(rawPort) <= 65535 ? Number(rawPort) : null;
  if (port === null) { write(err(`--port needs a decimal integer from 1 to 65535, got ${JSON.stringify(rawPort)}`)); return EXIT.usage; }
  const bind = flag("bind", "127.0.0.1");
  const exposeAutonomous = argv.includes("--expose-autonomous");

  const { api, token } = serve.serveCredentials();
  if (!token) {
    // Not a warning. With nothing to verify tokens against, every request would
    // have to be refused, and a server that refuses everything is a confusing
    // way to spell "log in first".
    write(err("not logged in — `moshcode login` first. herd serve has no unauthenticated mode."));
    return EXIT.usage;
  }

  const base = `http://${bind}:${port}`;
  const server = serve.createHerdServer({ api, exposeAutonomous, base });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, resolve);
  }).catch((error) => { write(err(`could not listen on ${bind}:${port} — ${error.message}`)); });
  if (!server.listening) return EXIT.infra;

  const exposed = serve.servedSessions({ exposeAutonomous });
  write(ok(`herd A2A ${serve.A2A_PROTOCOL_VERSION} on ${base}/`));
  write(info(`card: ${base}/.well-known/agent-card.json · members: ${exposed.map((s) => s.name).join(", ") || "none yet"}`));
  write(info(`auth: moshcode login tokens verified against ${api} — every request, loopback included`));
  const hidden = roster().filter((s) => s.kind !== "remote" && readManifest().sessions[s.name]?.agent).length;
  if (hidden && !exposeAutonomous) {
    write(info(`${hidden} autonomous session(s) withheld — an engine with approvals bypassed plus a network prompt is the worst pairing on the menu. --expose-autonomous overrides.`));
  }
  if (bind !== "127.0.0.1" && bind !== "localhost") {
    write(warn("! bound past loopback — message/send is keystrokes into a real pty. prefer a tailnet address or a reverse proxy with TLS."));
  }
  return new Promise(() => {}); // serve until killed
}

// ---------------------------------------------------------------------------
// eval — which engine is best at THIS repo (0011 R13)
// ---------------------------------------------------------------------------

export async function herdEval(argv, { write = console.log } = {}) {
  const evals = await import("./herd-eval.mjs");
  let dataset = null, engines = "", judge = "rules", threshold = evals.DEFAULT_THRESHOLD;
  let json = false, keep = false, timeoutMs = 10 * 60 * 1000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dataset") dataset = argv[++i];
    else if (a.startsWith("--dataset=")) dataset = a.slice(10);
    else if (a === "--engines") engines = argv[++i];
    else if (a.startsWith("--engines=")) engines = a.slice(10);
    else if (a === "--judge") judge = argv[++i];
    else if (a.startsWith("--judge=")) judge = a.slice(8);
    else if (a === "--threshold") threshold = Number(argv[++i]);
    else if (a.startsWith("--threshold=")) threshold = Number(a.slice(12));
    else if (a === "--timeout") timeoutMs = parseDuration(argv[++i], timeoutMs);
    else if (a === "--keep") keep = true;
    else if (a === "--json") json = true;
  }
  if (!dataset || !engines) {
    write(err("usage: moshcode herd eval --dataset <file> --engines a,b [--judge <engine>|rules] [--threshold 0.8]"));
    write(info("a dataset row is { \"prompt\": \"…\", \"expect\": \"pattern\" } or { \"prompt\": \"…\", \"rubric\": \"…\" } — jsonl, json, or csv"));
    return EXIT.usage;
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    write(err(`--threshold is a score between 0 and 1, got ${JSON.stringify(String(threshold))}`));
    return EXIT.usage;
  }

  const loaded = evals.loadDataset(path.resolve(dataset));
  if (!loaded.ok) { write(err(String(loaded.error?.message || loaded.error))); return EXIT.usage; }
  const { keys, unknown } = evals.resolveEngines(engines);
  if (unknown.length) { write(err(`no engine named ${unknown.join(", ")}`)); return EXIT.usage; }
  if (!keys.length) { write(err("--engines needs at least one engine")); return EXIT.usage; }
  if (judge !== "rules" && !resolveEngine(judge)) { write(err(`no engine named ${JSON.stringify(judge)} to judge with`)); return EXIT.usage; }
  if (!requireSubstrate(write)) return EXIT.infra;

  if (!json) write(info(`${loaded.cases.length} case(s) × ${keys.length} engine(s), judged by ${judge}`));
  const report = await evals.runEval({
    cases: loaded.cases, engines: keys, judge: judge === "rules" ? "rules" : resolveEngine(judge)[0],
    threshold, timeoutMs, keep, waitFor,
    out: json ? () => {} : (line) => write(ash(line)),
  });

  if (json) write(JSON.stringify(report, null, 2));
  else {
    write("");
    for (const engine of report.engines) {
      if (!engine.ok) { write(err(`${engine.engine.padEnd(12)} could not run — ${engine.error}`)); continue; }
      const pct = `${Math.round(engine.score * 100)}%`;
      const line = `${bone(engine.engine.padEnd(12))} ${engine.score >= report.threshold ? acid(pct) : amber(pct)} ${ash(`${engine.passed}/${engine.cases.length} clean`)}`;
      write(engine.unscorable ? `${line} ${amber(`· ${engine.unscorable} unscorable`)}` : line);
      for (const c of engine.cases.filter((c) => c.score < 1)) write(ash(`   ${c.id}: ${c.why}`));
    }
    write("");
    if (report.outcome === "pass") write(ok(`every engine is at or above ${report.threshold}.`));
    else if (report.outcome === "below") write(warn(`below ${report.threshold}: ${report.below.join(", ")}`));
    else write(err(`the harness could not run: ${report.broken.map((b) => `${b.engine} (${b.error})`).join(", ")}`));
  }
  // Three outcomes, three codes: CI has to tell a worse agent from a broken
  // harness, and one non-zero code cannot say both.
  if (report.outcome === "pass") return EXIT.matched;
  return report.outcome === "below" ? EXIT.below : EXIT.infra;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const VERBS = {
  // Lazy import: the UI pulls in escape-sequence machinery and only matters
  // when someone asks for it, and herd-ui imports roster() from this file.
  // `ui` is the sidebar workspace; the old modal list lives on as the fallback
  // inside it for machines with no tmux to swap panes on.
  ui: async (argv, options) => (await import("./herd-workspace.mjs")).herdUi(argv, options),
  sidebar: async (argv, options) => (await import("./herd-workspace.mjs")).herdSidebar(options),
  bar: async (argv, options) => (await import("./herd-bar.mjs")).herdBar(options),
  tile: async (argv, options) => (await import("./herd-tile.mjs")).herdTile(argv, options),
  untile: async (argv, options) => (await import("./herd-tile.mjs")).herdUntile(argv, options),
  ps: herdPs, list: herdPs, status: herdStatus,
  start: herdStart, run: herdRun, shell: herdShell,
  attach: herdAttach, kill: herdKill, prune: herdPrune,
  read: herdRead, prompt: herdPrompt, "send-keys": herdSendKeys,
  wait: herdWait, restore: herdRestore, report: herdReport,
  notify: herdNotify, watch: herdWatch, stop: herdStop,
  // PRD 0011. Same shape as everything above: one verb, `--json` on all of
  // them, and no second API anywhere — `serve` is this surface answering a
  // socket rather than a parallel one.
  hooks: herdHooks, doctor: herdDoctor,
  tasks: herdTasks, task: herdTask, log: herdLog, stats: herdStats,
  remote: herdRemote, serve: herdServe, eval: herdEval,
};

export async function herdCommand(argv = [], { write = console.log } = {}) {
  const [verb, ...rest] = argv;
  if (!verb || verb === "--json") return herdPs(argv, { write });
  const run = VERBS[verb];
  if (!run) {
    write(err(`unknown herd verb ${JSON.stringify(verb)}`));
    write(info(`verbs: ${Object.keys(VERBS).join(", ")}`));
    return EXIT.usage;
  }
  return run(rest, { write });
}
