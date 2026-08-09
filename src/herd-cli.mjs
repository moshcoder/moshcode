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
  herdDir, killSession, listSessions, readManifest, rememberSession, sendKeys, sendPrompt,
  slugifyName, startSession, stopRuntime, substrateNote, validName, NAME_RE,
} from "./herd.mjs";
import { clearReport, reportState, STATES, withState } from "./herd-state.mjs";
import { ENGINES, resolveEngine, resolveExecutable, agentLaunchArgs } from "./engines.mjs";
import { ingestApproval, pollApproval } from "./notify.mjs";
import { acid, amber, ash, bone, danger, dim, err, info, ok, warn } from "./ui.mjs";

/** Distinct exit codes, because `wait` exists to be branched on (R10). */
export const EXIT = { matched: 0, usage: 1, timeout: 2, gone: 3 };

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
  const w = (key, min) => Math.max(min, ...rows.map((r) => String(r[key] ?? "").length));
  const nameW = w("name", 4);
  const engineW = w("engine", 6);
  return rows.map((r) => [
    indent,
    bone(r.name.padEnd(nameW)),
    "  ",
    ash(String(r.engine).padEnd(engineW)),
    "  ",
    paintState(r.state).padEnd(9 + (paintState(r.state).length - r.state.length)),
    "  ",
    ash(tilde(r.cwd || "").padEnd(24)),
    "  ",
    dim(humanAge(r.age)),
  ].join("")).join("\n");
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
  write(info(`attach: ${acid(`moshcode attach ${name}`)} · roster: ${acid("moshcode ps")}`));
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
  write(info(`attach: ${acid(`moshcode attach ${name}`)} · roster: ${acid("moshcode ps")}`));
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
    write(JSON.stringify(rows.map(({ name, engine, herd, state, authority, cwd, age, alive, attached, substrate }) => ({
      name, engine, herd, state, authority, cwd, ageMs: age, alive, attached, substrate,
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
  write(info(substrate === "tmux" ? "detach with Ctrl-b d — the session keeps running." : "detach with Ctrl-] — the session keeps running."));

  const result = await attachSession(name, { substrate });
  if (!result.ok) { write(err(String(result.error?.message || result.error))); return EXIT.usage; }

  const after = findSession(name);
  if (after?.alive) write(info(`detached — ${bone(name)} still ${after.state}. ${acid(`moshcode attach ${name}`)} to come back.`));
  else write(info(`${bone(name)} ended.`));
  return EXIT.matched;
}

export function herdKill(argv, { write = console.log } = {}) {
  const all = argv.includes("--all");
  const names = all ? roster().map((s) => s.name) : argv.filter((a) => !a.startsWith("-"));
  if (!names.length) { write(err("usage: moshcode kill <name> | --all")); return EXIT.usage; }
  let failed = 0;
  for (const name of names) {
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
  const session = findSession(name);
  if (!session?.alive) { write(err(`no live session named ${JSON.stringify(name)}`)); return EXIT.gone; }
  const screen = capture(name, { lines });
  write(json ? JSON.stringify({ name, state: session.state, screen }, null, 2) : screen);
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
} = {}) {
  const wanted = new Set(states);
  const deadline = now() + timeoutMs;
  for (;;) {
    const session = look(name);
    if (!session) return { outcome: "gone", state: "gone" };
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

export async function herdWait(argv, { write = console.log } = {}) {
  const positional = [];
  let states = ["blocked", "done"], timeoutMs = 30 * 60 * 1000, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--state") states = String(argv[++i] || "").split(",").filter(Boolean);
    else if (a.startsWith("--state=")) states = a.slice(8).split(",").filter(Boolean);
    else if (a === "--timeout") timeoutMs = parseDuration(argv[++i], timeoutMs);
    else if (a.startsWith("--timeout=")) timeoutMs = parseDuration(a.slice(10), timeoutMs);
    else if (a === "--json") json = true;
    else if (!a.startsWith("-")) positional.push(a);
  }
  const name = positional[0];
  if (!name) { write(err("usage: moshcode wait <name> [--state blocked,done] [--timeout 30m]")); return EXIT.usage; }
  const unknown = states.filter((s) => !STATES.includes(s));
  if (unknown.length) { write(err(`unknown state ${unknown[0]} — one of ${STATES.join(", ")}`)); return EXIT.usage; }

  const result = await waitFor(name, states, { timeoutMs });
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
  const session = findSession(name);
  if (!session?.alive) { write(err(`no live session named ${JSON.stringify(name)}`)); return EXIT.gone; }

  const sent = sendPrompt(name, text);
  if (!sent.ok) { write(err(String(sent.error?.message || sent.error))); return EXIT.usage; }
  if (!wait) {
    if (json) write(JSON.stringify({ name, sent: true }, null, 2));
    else write(ok(`sent to ${bone(name)}.`));
    return EXIT.matched;
  }

  await waitFor(name, ["working"], { timeoutMs: 8000, intervalMs: 500 });
  const result = await waitFor(name, ["blocked", "done", "idle"], { timeoutMs });
  if (json) write(JSON.stringify({ name, sent: true, ...result }, null, 2));
  else if (result.outcome === "matched") write(ok(`${name} is ${result.state}.`));
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
  if (!name || !state) {
    write(err(`usage: moshcode herd report <name> <${STATES.join("|")}> [--ttl 15m]`));
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
    // One roster per tick, not one per session: this loop runs forever, and
    // re-reading the herd inside the cleanup pass made a watcher on six
    // sessions shell out dozens of times every five seconds, all night.
    const current = roster();
    for (const session of current) {
      const previous = seen.get(session.name);
      seen.set(session.name, session.state);
      if (!shouldNotify(previous, session.state, interesting)) continue;
      await deliver(session, config, write);
    }
    const present = new Set(current.map((s) => s.name));
    for (const name of [...seen.keys()]) if (!present.has(name)) seen.delete(name);
    if (once) return EXIT.matched;
    await sleep(intervalMs);
  }
}

async function deliver(session, config, write) {
  const tail = capture(session.name, { lines: 30 }).split("\n").slice(-12).join("\n");
  const message = `${session.name} (${session.engine}) is ${session.state} in ${tilde(session.cwd)}\n\n${tail}`;
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
// Dispatch
// ---------------------------------------------------------------------------

const VERBS = {
  // Lazy import: the UI pulls in escape-sequence machinery and only matters
  // when someone asks for it, and herd-ui imports roster() from this file.
  ui: async (argv, options) => (await import("./herd-ui.mjs")).herdUi(options),
  ps: herdPs, list: herdPs, status: herdStatus,
  start: herdStart, run: herdRun, shell: herdShell,
  attach: herdAttach, kill: herdKill, prune: herdPrune,
  read: herdRead, prompt: herdPrompt, "send-keys": herdSendKeys,
  wait: herdWait, restore: herdRestore, report: herdReport,
  notify: herdNotify, watch: herdWatch, stop: herdStop,
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
