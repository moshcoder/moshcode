// The herd in your pocket (PRD 0020, phase 1): the box half.
//
// `moshcode herd relay` is a long-lived process that dials OUT to
// app.moshcode.sh. Nothing listens on the box, so there is no port to open, no
// Tailscale and no SSH key on the phone. It does three things:
//
//   roster   POST /api/herd/roster on every change and every 30 s, carrying
//            each session's state, what it is blocked on, and the last lines
//            of its screen.
//   commands long-polls GET /api/herd/commands and runs what the phone asked
//            for — approve, prompt, keys, open-stream — through the herd verbs
//            that already exist (send-keys, prompt). No new pty code.
//   screens  while a phone is looking at one pane, POSTs that pane's screen
//            when it changes. Nothing streams unless somebody is watching, and
//            a stream that nobody reads stops on its own after a minute.
//
// `moshcode herd phone on` installs it as a user service so it outlives the
// shell that started it; see installRelayService.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCreds } from "./auth.mjs";
import { ENGINES } from "./engines.mjs";
import { capture, detectSubstrate, herdDir, sendKeys, sendPrompt } from "./herd.mjs";
import { stripAnsi } from "./herd-state.mjs";

export const HEARTBEAT_MS = 30 * 1000;
export const TICK_MS = 3 * 1000;
export const STREAM_TICK_MS = 700;
// A stream that no phone has asked about for this long stops (PRD §1).
export const STREAM_IDLE_MS = 60 * 1000;
export const LAST_LINES = 6;
const MAX_PROMPT = 4000;

const API = () => (process.env.MOSHCODE_API || loadCreds()?.api || "https://app.moshcode.sh").replace(/\/+$/, "");
const KEY = () => process.env.MOSHCODE_API_KEY || loadCreds()?.token || "";

/**
 * This box, as the phone will know it. The id is random and written once, so
 * a hostname change (a laptop renamed, a container rebuilt with the same
 * volume) is the same machine and not a second one in the list.
 */
export function machineIdentity({ dir = herdDir(), host = os.hostname(), user = os.userInfo().username } = {}) {
  const file = path.join(dir, "machine-id");
  let id = "";
  try { id = fs.readFileSync(file, "utf8").trim(); } catch { /* first run */ }
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    id = crypto.randomUUID();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
  }
  return { id, name: `${user}@${host}` };
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** The bottom of a screen, where a live dialog is. Same window classify reads. */
function tail(screen, lines = 25) {
  const all = stripAnsi(screen).split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

/**
 * Is `screen` showing this engine's permission dialog right now, and which
 * answers does it accept? Null when it is not, which is the stale guard: the
 * phone's tap is only ever turned into keys while this says yes.
 */
export function approvalFor(engine, screen) {
  const spec = ENGINES[engine]?.approve;
  if (!spec || !screen) return null;
  const text = tail(screen);
  if (!spec.prompt.some((re) => re.test(text))) return null;
  if (spec.options && !spec.options.some((re) => re.test(text))) return null;
  // The dialog has to be the last thing on the screen, not merely somewhere in
  // its bottom 25 lines: an answered dialog leaves its text behind until the
  // engine redraws, and a second tap must not type `1` into what came next.
  // So below the menu's last numbered option there may be only box borders and
  // the engine's own footer (`approve.footer`, e.g. Codex's "Press enter to
  // confirm or esc to cancel"); any other line means the dialog is history.
  const lines = text.split("\n").filter((l) => l.trim() && !/^[\s─━═╰╯╭╮└┘┌┐│|]+$/.test(l));
  let last = -1;
  lines.forEach((l, i) => { if (/^[\s│|]*[❯›▸>]?\s*\d+\.\s+\S/.test(l)) last = i; });
  if (last < 0) return null;
  const footer = spec.footer || [];
  if (!lines.slice(last + 1).every((l) => footer.some((re) => re.test(l)))) return null;
  return { allowAll: Boolean(spec.allowAll && (!spec.allowAllWhen || spec.allowAllWhen.test(text))) };
}

export const INTENTS = ["allow", "allowAll", "deny"];

// The phone's key bar, by name. Each key is spelled twice because the two
// substrates take different things: tmux reads key names, and the pty fallback
// writes bytes. Only these names are accepted from the phone.
export const PHONE_KEYS = {
  esc: { tmux: "Escape", bytes: "\x1b" },
  tab: { tmux: "Tab", bytes: "\t" },
  "shift-tab": { tmux: "BTab", bytes: "\x1b[Z" },
  up: { tmux: "Up", bytes: "\x1b[A" },
  down: { tmux: "Down", bytes: "\x1b[B" },
  right: { tmux: "Right", bytes: "\x1b[C" },
  left: { tmux: "Left", bytes: "\x1b[D" },
  enter: { tmux: "Enter", bytes: "\r" },
  "ctrl-c": { tmux: "C-c", bytes: "\x03" },
  "ctrl-d": { tmux: "C-d", bytes: "\x04" },
  slash: { tmux: "/", bytes: "/" },
  backspace: { tmux: "BSpace", bytes: "\x7f" },
  y: { tmux: "y", bytes: "y" },
  n: { tmux: "n", bytes: "n" },
  1: { tmux: "1", bytes: "1" },
  2: { tmux: "2", bytes: "2" },
  3: { tmux: "3", bytes: "3" },
};

function keysFor(names, substrate) {
  return names.map((name) => (substrate === "tmux" ? PHONE_KEYS[name].tmux : PHONE_KEYS[name].bytes));
}

/** The engine's own keys for an intent, spelled for the substrate. */
function intentKeys(engine, intent, substrate) {
  const keys = ENGINES[engine]?.approve?.[intent] || [];
  if (substrate === "tmux") return keys;
  return keys.map((k) => (k === "Escape" ? "\x1b" : k === "Enter" ? "\r" : k));
}

// ---------------------------------------------------------------------------
// The relay's memory of the herd
// ---------------------------------------------------------------------------

/**
 * Per-session bookkeeping the server cannot do for us: when did the current
 * state start? `blockedAt` is what an approve command carries back, and a
 * session that left blocked and came back is a different question with a
 * different `blockedAt` — so an answer to the first can never land on the
 * second.
 */
export function createTracker({ now = () => Date.now() } = {}) {
  const seen = new Map(); // name -> { state, blockedOn, since }
  return {
    observe(session) {
      const prev = seen.get(session.name);
      const key = `${session.state}:${session.blockedOn || ""}`;
      if (!prev || prev.key !== key) {
        const entry = { key, since: now() };
        seen.set(session.name, entry);
        return entry.since;
      }
      return prev.since;
    },
    since(name) { return seen.get(name)?.since ?? null; },
    forget(present) { for (const name of [...seen.keys()]) if (!present.has(name)) seen.delete(name); },
  };
}

/** The last few non-blank lines of a screen, for the roster row. */
export function lastLinesOf(screen, count = LAST_LINES) {
  return stripAnsi(screen || "").split("\n")
    // A dialog's box is paint, not content: drop border-only lines and the
    // side rails, so the phone's one-line preview is words.
    .map((l) => l.replace(/^\s*[│┃|]\s?/, "").replace(/\s*[│┃|]\s*$/, "").replace(/\s+$/, ""))
    .filter((l) => l.trim() && !/^[\s─━═╰╯╭╮└┘┌┐│┃|]+$/.test(l))
    .slice(-count);
}

/**
 * One roster row per session, the shape the phone lists. `read` is the screen
 * capture, injected for tests.
 */
export function snapshot(rows, tracker, { read = (name) => capture(name, { lines: 40 }) } = {}) {
  const sessions = [];
  for (const s of rows) {
    if (s.state === "gone") continue;
    const since = tracker.observe(s);
    const screen = s.kind === "remote" || !s.alive ? "" : read(s.name);
    const approval = s.state === "blocked" ? approvalFor(s.engine, screen) : null;
    sessions.push({
      name: s.name,
      engine: String(s.engine || ""),
      state: s.state,
      blockedOn: s.blockedOn || null,
      confidence: s.confidence || null,
      cwd: s.cwd || "",
      kind: s.kind || "local",
      lastLines: lastLinesOf(screen),
      since,
      blockedAt: s.state === "blocked" ? since : null,
      approval,
    });
  }
  tracker.forget(new Set(rows.map((r) => r.name)));
  return sessions;
}

/** What has to change for a roster to be worth publishing before the heartbeat. */
export function fingerprint(sessions) {
  return JSON.stringify(sessions.map((s) => [s.name, s.state, s.blockedOn, s.lastLines, s.approval]));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Run one command from the phone. Returns what the phone is told:
 * `{ ok: true }`, `{ ok: false, stale: true }` (already answered, or the
 * dialog changed), or `{ ok: false, error }`.
 */
export function execute(command, {
  rows,
  tracker,
  streams,
  substrate = detectSubstrate(),
  read = (name) => capture(name, { lines: 40 }),
  keys = sendKeys,
  prompt = sendPrompt,
  now = () => Date.now(),
} = {}) {
  const args = command.args || {};
  const session = rows.find((r) => r.name === command.session);
  if (!session || session.state === "gone") return { ok: false, error: "no such session" };
  if (session.kind === "remote") return { ok: false, error: "that session is a remote member; answer it on its own box" };

  if (command.kind === "approve") {
    const intent = args.intent;
    if (!INTENTS.includes(intent)) return { ok: false, error: "unknown answer" };
    // Stale guard, part one: the session must still be in the same blocked
    // spell the phone saw. Part two: the dialog must still be on the screen.
    if (session.state !== "blocked") return { ok: false, stale: true };
    const since = tracker.since(session.name);
    if (args.blockedAt != null && since != null && Number(args.blockedAt) !== since) return { ok: false, stale: true };
    const approval = approvalFor(session.engine, read(session.name));
    if (!approval) return { ok: false, stale: true };
    if (intent === "allowAll" && !approval.allowAll) return { ok: false, error: "this dialog has no allow-all option" };
    const sent = keys(session.name, intentKeys(session.engine, intent, substrate), { substrate });
    return sent.ok ? { ok: true } : { ok: false, error: sent.error?.message || "send-keys failed" };
  }

  if (command.kind === "prompt") {
    const text = String(args.text || "").slice(0, MAX_PROMPT);
    if (!text.trim()) return { ok: false, error: "empty prompt" };
    const sent = prompt(session.name, text, { substrate });
    return sent.ok ? { ok: true } : { ok: false, error: sent.error?.message || "prompt failed" };
  }

  if (command.kind === "keys") {
    const names = Array.isArray(args.keys) ? args.keys.map(String) : [];
    if (!names.length || names.length > 16 || !names.every((n) => Object.hasOwn(PHONE_KEYS, n))) {
      return { ok: false, error: "unknown key" };
    }
    // One key per send-keys call on the pty side would interleave with output;
    // one call carrying all of them is what a fast typist would produce anyway.
    const sent = keys(session.name, keysFor(names, substrate), { substrate });
    return sent.ok ? { ok: true } : { ok: false, error: sent.error?.message || "send-keys failed" };
  }

  if (command.kind === "open-stream") {
    streams.open(session.name, now());
    return { ok: true };
  }

  return { ok: false, error: `unknown command ${JSON.stringify(command.kind)}` };
}

/** Which panes are being streamed, and until when. */
export function createStreams({ idleMs = STREAM_IDLE_MS } = {}) {
  const open = new Map(); // name -> { until, last }
  return {
    open(name, at) {
      const entry = open.get(name) || { last: null };
      entry.until = at + idleMs;
      open.set(name, entry);
    },
    extend(name, at) { const e = open.get(name); if (e) e.until = at + idleMs; },
    close(name) { open.delete(name); },
    active(at) {
      for (const [name, e] of open) if (e.until <= at) open.delete(name);
      return [...open.keys()];
    },
    entry(name) { return open.get(name) || null; },
  };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

async function call(fetchImpl, method, url, body, { key, signal } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

const pause = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * Run the relay until `signal` aborts. Three loops sharing one roster:
 * publish, command pull, and screen streams. Every network failure is
 * retried with a pause; the relay is supposed to be the thing that stays up.
 */
export async function runRelay({
  roster,
  fetchImpl = fetch,
  api = API(),
  key = KEY(),
  machine = machineIdentity(),
  version = "",
  signal: outer,
  write = console.log,
  read,
  screenRead = (name) => capture(name, { lines: 0, escapes: true }),
  keysImpl = sendKeys,
  promptImpl = sendPrompt,
  now = () => Date.now(),
  tickMs = TICK_MS,
  heartbeatMs = HEARTBEAT_MS,
  streamTickMs = STREAM_TICK_MS,
} = {}) {
  if (!key) throw new Error("not logged in — run `moshcode login` first");
  // One controller for all three loops, so a fatal error in one (a revoked
  // login) stops the other two instead of leaving them polling forever.
  const inner = new AbortController();
  const signal = inner.signal;
  if (outer?.aborted) inner.abort();
  outer?.addEventListener?.("abort", () => inner.abort(), { once: true });
  let fatal = null;
  const tracker = createTracker({ now });
  const streams = createStreams();
  const opts = read ? { read } : {};
  let rows = roster();
  let dirty = true;
  let lastPrint = "";
  let lastSent = 0;
  let failures = 0;

  const publish = async () => {
    rows = roster();
    const sessions = snapshot(rows, tracker, opts);
    const print = fingerprint(sessions);
    if (!dirty && print === lastPrint && now() - lastSent < heartbeatMs) return;
    const r = await call(fetchImpl, "POST", `${api}/api/herd/roster`, {
      machine: { id: machine.id, name: machine.name, platform: process.platform, version },
      sessions,
    }, { key, signal });
    if (r.status === 401) throw new Error("app.moshcode.sh refused this login (401) — run `moshcode login` again");
    if (!r.ok) throw new Error(`roster publish failed (${r.status})`);
    lastPrint = print;
    lastSent = now();
    dirty = false;
  };

  const publishLoop = async () => {
    while (!signal?.aborted) {
      try { await publish(); failures = 0; }
      catch (e) {
        if (signal?.aborted) return;
        failures++;
        if (failures === 1 || failures % 20 === 0) write(`relay: ${e.message}`);
        if (/401/.test(e.message)) { fatal = e; inner.abort(); return; }
      }
      await pause(tickMs, signal);
    }
  };

  const commandLoop = async () => {
    while (!signal?.aborted) {
      let r;
      try {
        r = await call(fetchImpl, "GET", `${api}/api/herd/commands?machine=${encodeURIComponent(machine.id)}`, null, { key, signal });
      } catch {
        if (signal?.aborted) return;
        await pause(5000, signal);
        continue;
      }
      if (!r.ok) { await pause(r.status === 404 ? 3000 : 5000, signal); continue; }
      for (const command of r.data?.commands || []) {
        let result;
        try {
          rows = roster();
          for (const s of rows) tracker.observe(s);
          result = execute(command, { rows, tracker, streams, read: opts.read, keys: keysImpl, prompt: promptImpl, now });
        } catch (e) {
          result = { ok: false, error: String(e.message || e) };
        }
        dirty = true;
        try {
          await call(fetchImpl, "POST", `${api}/api/herd/commands/${encodeURIComponent(command.id)}`,
            { machine: machine.id, ...result }, { key, signal });
        } catch { /* the phone will see it as unanswered and can retry */ }
        write(`relay: ${command.kind} ${command.session} → ${result.ok ? "ok" : result.stale ? "stale" : result.error}`);
      }
    }
  };

  const streamLoop = async () => {
    while (!signal?.aborted) {
      for (const name of streams.active(now())) {
        const entry = streams.entry(name);
        let screen = "";
        try { screen = screenRead(name); } catch { screen = ""; }
        if (screen === entry.last) continue;
        try {
          const r = await call(fetchImpl, "POST", `${api}/api/herd/screen`,
            { machine: machine.id, session: name, screen }, { key, signal });
          entry.last = screen;
          if (r.ok && r.data?.watching === false) streams.close(name);
          else if (r.ok) streams.extend(name, now());
        } catch { /* next tick */ }
      }
      await pause(streamTickMs, signal);
    }
  };

  write(`relay: ${machine.name} → ${api}/m`);
  await Promise.all([publishLoop(), commandLoop(), streamLoop()]);
  if (fatal) throw fatal;
}

// ---------------------------------------------------------------------------
// The service: `moshcode herd phone on|off|status`
// ---------------------------------------------------------------------------

export const RELAY_UNIT = "moshcode-herd-relay.service";
export const RELAY_LABEL = "sh.moshcode.herd-relay";

/** The entry script this install runs from. */
export function entryScript() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "moshcode.mjs");
}

/**
 * Where the service definition lives. Linux gets a systemd user unit, macOS a
 * LaunchAgent. Both are written from the running process (node and the entry
 * script), for the reason src/dns-service.mjs gives: nothing on a mise or nvm
 * box is on the service manager's PATH.
 */
export function relayServicePath({ platform = process.platform, home = os.homedir() } = {}) {
  if (platform === "darwin") return path.join(home, "Library", "LaunchAgents", `${RELAY_LABEL}.plist`);
  return path.join(home, ".config", "systemd", "user", RELAY_UNIT);
}

export function relayServiceFile({ platform = process.platform, execPath = process.execPath, entry = entryScript(), env = {} } = {}) {
  if (platform === "darwin") {
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const envXml = Object.entries(env).map(([k, v]) => `      <key>${esc(k)}</key><string>${esc(v)}</string>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by \`moshcode herd phone on\`. Regenerate it rather than editing. -->
<plist version="1.0">
  <dict>
    <key>Label</key><string>${RELAY_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${esc(execPath)}</string>
      <string>${esc(entry)}</string>
      <string>herd</string>
      <string>relay</string>
    </array>
${envXml ? `    <key>EnvironmentVariables</key>\n    <dict>\n${envXml}\n    </dict>\n` : ""}    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/tmp/moshcode-herd-relay.log</string>
    <key>StandardErrorPath</key><string>/tmp/moshcode-herd-relay.log</string>
  </dict>
</plist>
`;
  }
  const exec = [execPath, entry, "herd", "relay"].map((p) => (/\s/.test(p) ? JSON.stringify(p) : p)).join(" ");
  return [
    "# Generated by `moshcode herd phone on`. Regenerate it rather than editing:",
    "# the paths below are this install's.",
    "[Unit]",
    "Description=moshcode herd relay (your herd on your phone)",
    "Documentation=https://github.com/moshcoder/moshcode/blob/main/prd/0020-the-herd-in-your-pocket.md",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    ...Object.entries(env).map(([k, v]) => `Environment=${k}=${v}`),
    "Restart=always",
    "RestartSec=5",
    "NoNewPrivileges=yes",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * The environment the service needs that a service manager will not give it:
 * the herd's tmux socket and home, which are where `herd ps` looks.
 */
export function relayEnv(env = process.env) {
  const out = {};
  for (const k of ["MOSHCODE_HOME", "MOSHCODE_HERD_SOCKET", "MOSHCODE_API", "TMUX_TMPDIR"]) if (env[k]) out[k] = env[k];
  return out;
}

export function relayServiceCommands({ platform = process.platform, file = relayServicePath({ platform }), action }) {
  if (platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    if (action === "on") return [["launchctl", ["bootout", `gui/${uid}/${RELAY_LABEL}`], { optional: true }], ["launchctl", ["bootstrap", `gui/${uid}`, file]]];
    if (action === "off") return [["launchctl", ["bootout", `gui/${uid}/${RELAY_LABEL}`], { optional: true }]];
    return [["launchctl", ["print", `gui/${uid}/${RELAY_LABEL}`]]];
  }
  if (action === "on") {
    return [
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", RELAY_UNIT]],
      ["systemctl", ["--user", "restart", RELAY_UNIT]],
      // Without lingering, a user service stops when the last session ends —
      // which on a server is the moment you log out, and the whole point of
      // this is that you are not logged in. Allowed for yourself by default
      // polkit policy; harmless when it is refused.
      ["loginctl", ["enable-linger", os.userInfo().username], { optional: true }],
    ];
  }
  if (action === "off") return [["systemctl", ["--user", "disable", "--now", RELAY_UNIT], { optional: true }]];
  return [["systemctl", ["--user", "is-active", RELAY_UNIT]]];
}
