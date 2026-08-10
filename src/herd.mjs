// The herd — a persistent runtime for agent sessions (PRD 0009).
//
// Everything else in moshcode opens an engine with `stdio: "inherit"`: the
// child takes the terminal, you wait, and when it exits you get the prompt
// back. That is why an engine feels native, and it is also why the pit can only
// ever be doing one thing, and why closing the terminal kills the work.
//
// The herd inverts it. A session runs inside a runtime that outlives the pit,
// so starting one hands the prompt straight back and you carry on. `ps` shows
// the roster, `attach` puts you inside one, and detaching leaves it running.
//
// TWO SUBSTRATES, ONE INTERFACE. Persisting an interactive program means
// something other than your terminal has to own its pty:
//
//   "tmux" — a single named tmux server (socket `moshcode`, not the per-pid one
//     src/tabs.mjs opens). Full fidelity: real resizing, scrollback, native
//     attach. This is the recommended path.
//
//   "pty" — no tmux on the box. `script(1)` allocates the pty (the same
//     capability detection src/pty.mjs already does), the child is detached
//     with its stdin on a FIFO, and `attach` replays the transcript and relays
//     keystrokes. Works everywhere script(1) does. Its one real limit: nothing
//     outside the pty can ioctl the master, so the size is fixed at launch (to
//     the starting terminal, via stty from inside) and a later resize does not
//     reach it. Honest and useful, not equal.
//
//   null — neither. Callers fall back to today's foreground passthrough and say
//     so once. moshcode does not harden a soft dependency into a hard one.
//
// Metadata (engine, cwd, argv) lives in a 0600 manifest rather than in the
// substrate, because the manifest is needed anyway to rebuild the herd after a
// reboot, and because tmux user-options are a 3.0+ feature we would rather not
// require.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { followFile, scriptFlavor, shQuote, stripScriptBanner } from "./pty.mjs";

/** tmux server socket. Deliberately stable — the whole point is outliving pits. */
export const HERD_SOCKET = process.env.MOSHCODE_HERD_SOCKET || "moshcode";

/** Where the manifest, transcripts, FIFOs and hook reports live. */
export function herdDir() {
  return process.env.MOSHCODE_HERD_DIR || path.join(os.homedir(), ".moshcode", "herd");
}
const manifestPath = () => path.join(herdDir(), "sessions.json");

/**
 * Session names are a handle typed at a prompt, embedded in a tmux target, and
 * used as a filename. herdr's shape, and for the same reasons: anything looser
 * would let a name mean one thing to tmux (which reads `:` and `.` as target
 * separators) and another to the filesystem.
 */
export const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const validName = (name) => NAME_RE.test(String(name || ""));

/** Turn any string into something NAME_RE accepts, for auto-generated names. */
export function slugifyName(input) {
  const slug = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32);
  return slug || "agent";
}

/**
 * The default name for a session: `<engine>-<dir>`, suffixed on collision.
 * `taken` is whatever is already in the herd, so two claudes in two repos get
 * distinguishable names without anyone typing `--name`.
 */
export function defaultName(engine, cwd, taken = []) {
  const base = slugifyName(`${engine}-${path.basename(cwd || "") || "pit"}`);
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = slugifyName(`${base}-${n}`);
    if (!used.has(candidate)) return candidate;
  }
  return slugifyName(`${base}-${process.pid}`);
}

// ---------------------------------------------------------------------------
// Manifest — the metadata that has to survive the runtime, not just the pit.
// ---------------------------------------------------------------------------

function ensureDir() {
  const dir = herdDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Read the manifest. Never throws: a corrupt or absent manifest means "no
 * remembered sessions", which is recoverable, and the live substrate is still
 * the authority on what is actually running.
 */
export function readManifest() {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(), "utf8"));
    if (!raw || typeof raw !== "object" || typeof raw.sessions !== "object") return { version: 1, sessions: {} };
    return { version: 1, sessions: raw.sessions || {} };
  } catch {
    return { version: 1, sessions: {} };
  }
}

/**
 * Write the manifest at 0600.
 *
 * The same reasoning as .moshcode_history in src/tui.mjs, one step harder: this
 * records the argv an engine was launched with, and an engine is regularly
 * launched with a flag carrying a token. `mode` only applies on create, so
 * chmod every write to fix installs that predate this.
 */
export function writeManifest(manifest) {
  try {
    ensureDir();
    const file = manifestPath();
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: manifest.sessions || {} }, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}

export function rememberSession(name, entry) {
  const manifest = readManifest();
  manifest.sessions[name] = { ...(manifest.sessions[name] || {}), ...entry };
  writeManifest(manifest);
}

export function forgetSession(name) {
  const manifest = readManifest();
  if (!(name in manifest.sessions)) return false;
  delete manifest.sessions[name];
  writeManifest(manifest);
  return true;
}

// ---------------------------------------------------------------------------
// Substrate detection
// ---------------------------------------------------------------------------

let substrateCache;

/**
 * Which substrate this machine can run the herd on: "tmux", "pty", or null.
 *
 * Probed once and cached, like scriptFlavor() — every roster render would
 * otherwise fork a `tmux -V`. MOSHCODE_HERD=off forces the honest degradation
 * path, which is how the fallback gets tested on a box that has tmux.
 */
export function detectSubstrate({ runner = spawnSync, env = process.env, force = false } = {}) {
  if (!force && substrateCache !== undefined) return substrateCache;
  const chosen = (() => {
    if (env.MOSHCODE_HERD === "off") return null;
    if (env.MOSHCODE_HERD !== "pty") {
      try {
        const r = runner("tmux", ["-V"], { encoding: "utf8" });
        if (!r?.error && r?.status === 0) return "tmux";
      } catch { /* fall through */ }
    }
    if (env.MOSHCODE_HERD === "tmux") return null;
    // The pty substrate needs a script(1) we understand AND a mkfifo, because
    // the FIFO is how a detached child keeps a stdin that never sees EOF.
    if (!scriptFlavor({ runner })) return null;
    try {
      const r = runner("mkfifo", ["--version"], { encoding: "utf8" });
      // BSD mkfifo has no --version and exits non-zero on it; a usage message
      // still proves the binary is there, which is all this needs to know.
      if (r?.error?.code === "ENOENT") return null;
    } catch { return null; }
    return "pty";
  })();
  if (!force) substrateCache = chosen;
  return chosen;
}

/** Test seam: drop the memoised substrate. */
export function resetSubstrate() { substrateCache = undefined; }

/** One line explaining what the user loses, printed once when it matters. */
export function substrateNote(substrate = detectSubstrate()) {
  if (substrate === "tmux") return null;
  if (substrate === "pty") {
    return "no tmux — sessions run under script(1). they work, but their size is fixed when they start. install tmux to make them resizable.";
  }
  const how = process.platform === "darwin" ? "brew install tmux" : "sudo apt install tmux  (or your package manager)";
  return `no tmux and no usable script(1) — sessions will run in the foreground and end with this terminal. ${how}`;
}

// ---------------------------------------------------------------------------
// tmux substrate
// ---------------------------------------------------------------------------

const tmuxArgs = (args) => ["-L", HERD_SOCKET, ...args];

export function tmux(args, { runner = spawnSync, env = process.env, encoding = "utf8" } = {}) {
  try {
    const r = runner("tmux", tmuxArgs(args), { encoding, env });
    if (r?.error) return { ok: false, error: r.error, stdout: "", stderr: "" };
    return {
      ok: r.status === 0,
      code: r.status,
      stdout: String(r.stdout || ""),
      stderr: String(r.stderr || ""),
    };
  } catch (error) {
    return { ok: false, error, stdout: "", stderr: "" };
  }
}

/**
 * The shell-command tmux runs for a session.
 *
 * A single quoted string rather than an argv, matching src/tabs.mjs: tmux's
 * `shell-command` is one argument in every version we care about, and quoting
 * it ourselves is the only way an argument containing a space survives.
 *
 * `env -u` rather than tmux's `-e`: engines like claude need variables *removed*
 * (an inherited ANTHROPIC_API_KEY hijacks its stored login — see ENGINES), and
 * `-e KEY=` sets an empty value, which is not the same as unset.
 */
export function sessionCommand({ bin, args = [], stripEnv = [], exec = true }) {
  const unset = stripEnv.flatMap((key) => ["-u", key]);
  const command = [bin, ...args].map(shQuote).join(" ");
  const withEnv = unset.length ? `env ${unset.map(shQuote).join(" ")} ${command}` : command;
  // `exec` so the engine replaces the shell rather than sitting under it — one
  // less process between a signal and the thing meant to receive it. The pty
  // substrate passes exec:false because it needs the shell to outlive the
  // engine by exactly one command, to record that it finished.
  return exec ? `exec ${withEnv}` : withEnv;
}

/**
 * Argv that creates a detached session. Split out from the spawn so the
 * safety-sensitive part is testable without starting a real server.
 *
 * `-f /dev/null` for the same reason src/tabs.mjs does it: this server is
 * moshcode's, and the detach key we print has to be the one that works even
 * when the user's own tmux.conf rebinds prefix.
 */
export function tmuxStartPlan({ name, cwd, command }) {
  // ONE tmux invocation, not two. A finished agent must stay readable — "which
  // one is done?" is half the reason the roster exists, and a session that
  // evaporates on exit can only ever answer "gone". But a short-lived command
  // can finish before a second `tmux set-option` process has even started, and
  // then the option lands on a session that is already gone. tmux takes `;` as
  // its own argument to mean "and then", which closes the race by never letting
  // the session exist without the option.
  return [
    "-f", "/dev/null",
    "new-session", "-d", "-s", name, "-c", cwd, command,
    ";", "set-option", "-t", name, "remain-on-exit", "on",
    // Mouse on, so a click selects a pane and the status line's window list is
    // clickable once you are inside. This server is moshcode's and starts from
    // no config, so it is not overriding a preference anyone expressed.
    ";", "set-option", "-t", name, "mouse", "on",
    // The pane's title is the member's durable handle — it survives being
    // moved into a tiled window and back, which the session name does not.
    // Set in the same invocation as the rest so a fast-exiting command cannot
    // finish before it lands.
    ";", "select-pane", "-t", name, "-T", name,
  ];
}

// ---------------------------------------------------------------------------
// pty substrate — detached script(1) + a FIFO for stdin
// ---------------------------------------------------------------------------

const ptyPaths = (name) => ({
  transcript: path.join(herdDir(), `${name}.transcript`),
  fifo: path.join(herdDir(), `${name}.stdin`),
  meta: path.join(herdDir(), `${name}.pid`),
  // Written by the session itself on the way out. A dead pid alone cannot tell
  // "the agent finished" from "the box rebooted while it was working", and
  // those are different answers: one is `done`, the other is something
  // `restore` should bring back.
  exit: path.join(herdDir(), `${name}.exit`),
});

/** Is this pid still ours and alive? signal 0 asks without sending anything. */
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

/**
 * Start a session with no tmux in sight.
 *
 * The FIFO is opened O_RDWR *before* the spawn and handed to the child as fd 0.
 * That detail is load-bearing: a FIFO opened read-only returns EOF the moment
 * the last writer closes, so a child whose stdin is a plain reader would die as
 * soon as the pit that started it exited — the exact failure this whole module
 * exists to prevent. Holding it O_RDWR makes the child its own writer, so it
 * never sees EOF and waits for input forever, which is what an idle agent
 * should do.
 */
function ptyStart({ name, cwd, bin, args, stripEnv, env, spawner = spawn, runner = spawnSync, size = {} }) {
  ensureDir();
  const cols = Number(size.cols) || Number(env.COLUMNS) || process.stdout.columns || 80;
  const rows = Number(size.rows) || Number(env.LINES) || process.stdout.rows || 24;
  const { transcript, fifo, meta, exit } = ptyPaths(name);
  for (const file of [transcript, fifo, meta, exit]) {
    try { fs.rmSync(file, { force: true }); } catch { /* first run */ }
  }

  const made = runner("mkfifo", ["-m", "600", fifo], { encoding: "utf8" });
  if (made?.error || made?.status !== 0) {
    return { ok: false, error: new Error(`could not create the input pipe: ${made?.stderr?.trim() || made?.error?.message || "mkfifo failed"}`) };
  }
  fs.writeFileSync(transcript, "", { mode: 0o600 });

  const flavor = scriptFlavor({ runner });
  // script(1) sizes the pty from its own stdout, and ours is /dev/null, so the
  // child would otherwise start on a 0x0 terminal — which full-screen engines
  // do not survive. Nothing outside the pty can ioctl its master, but `stty`
  // running *inside* it can, so the session sizes itself on the way in. The
  // size is whatever the terminal that started it had; a later resize cannot
  // reach it, which is the pty substrate's one honest limitation.
  // Not `exec`: the shell has to outlive the engine by exactly one command, so
  // that a session which finishes on its own leaves proof it finished.
  const command = [
    `stty rows ${rows} cols ${cols} 2>/dev/null`,
    sessionCommand({ bin, args, stripEnv, exec: false }),
    `printf '%s' "$?" > ${shQuote(exit)}`,
  ].join("; ");
  // Reuse ptySpec's flag knowledge rather than re-deriving it: util-linux and
  // BSD disagree on both the flags and the argument order.
  const spec = flavor === "util-linux"
    ? { cmd: "script", args: ["-q", "-e", "-f", "-c", command, transcript] }
    : { cmd: "script", args: ["-q", "-F", transcript, "sh", "-c", command] };

  let stdin;
  try { stdin = fs.openSync(fifo, fs.constants.O_RDWR); }
  catch (error) { return { ok: false, error }; }

  let child;
  try {
    child = spawner(spec.cmd, spec.args, {
      cwd,
      // Belt and braces with the stty above: some toolkits read COLUMNS/LINES
      // before they ever ask the terminal.
      env: { ...env, COLUMNS: String(cols), LINES: String(rows), MOSHCODE_HERD_SESSION: name },
      stdio: [stdin, "ignore", "ignore"],
      detached: true,
    });
  } catch (error) {
    try { fs.closeSync(stdin); } catch { /* already gone */ }
    return { ok: false, error };
  }
  // Cut every tie to the pit: its own process group so a Ctrl-C in the pit does
  // not reach it, and unref'd so node will exit without waiting for it.
  child.unref();
  try { fs.closeSync(stdin); } catch { /* the child holds its own */ }

  try { fs.writeFileSync(meta, JSON.stringify({ pid: child.pid }), { mode: 0o600 }); }
  catch { /* liveness falls back to the manifest pid */ }
  return { ok: true, pid: child.pid };
}

function ptyPid(name) {
  try { return JSON.parse(fs.readFileSync(ptyPaths(name).meta, "utf8")).pid || null; }
  catch { return null; }
}

/** Did this session's own shell record an exit? */
function ptyFinished(name) {
  try { return fs.existsSync(ptyPaths(name).exit); }
  catch { return false; }
}

function ptyCleanup(name) {
  const { transcript, fifo, meta, exit } = ptyPaths(name);
  for (const file of [transcript, fifo, meta, exit]) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Everything the pty substrate has of a session's screen: its transcript.
 *
 * script(1)'s own header goes first. `-q` silences it on the terminal but still
 * writes it to the file, and it is not harmless bookkeeping here — it contains
 * the fully quoted command line, so leaving it in would put an engine's argv
 * (flags, tokens and all) at the top of every `read` and every notification.
 */
function ptyCapture(name, lines) {
  try {
    const text = stripScriptBanner(fs.readFileSync(ptyPaths(name).transcript, "utf8"), true);
    const all = text.split(/\r?\n/);
    return all.slice(Math.max(0, all.length - lines)).join("\n");
  } catch {
    return "";
  }
}

function ptyWrite(name, data) {
  let fd;
  try {
    // O_WRONLY on a FIFO blocks until a reader shows up; the child is that
    // reader and it is already there, so this returns immediately. It also
    // means writing to a session whose child has died fails fast rather than
    // hanging, which is the behaviour we want.
    fd = fs.openSync(ptyPaths(name).fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.writeSync(fd, data);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
}

// ---------------------------------------------------------------------------
// The interface the rest of moshcode uses
// ---------------------------------------------------------------------------

/** Names the substrate says are live right now. */
export function liveNames({ substrate = detectSubstrate(), runner = spawnSync } = {}) {
  if (substrate === "tmux") {
    // Panes, not sessions: a tiled member's session is gone but the member is
    // very much alive. Only names the manifest knows about count, so a stray
    // pane title on the server cannot invent a roster entry.
    const known = new Set(Object.keys(readManifest().sessions));
    return [...paneIndex({ runner }).keys()].filter((name) => known.has(name));
  }
  if (substrate === "pty") {
    // A finished session is still one the runtime has: it stays on the roster
    // reading `done` until someone kills or prunes it, exactly as a dead tmux
    // pane does. What drops off is a session whose process is gone *without*
    // having recorded an exit — which is what a reboot looks like.
    return Object.keys(readManifest().sessions).filter((name) => pidAlive(ptyPid(name)) || ptyFinished(name));
  }
  return [];
}

/**
 * Is the session's process finished? A finished agent is `done`, and that is a
 * fact about the process, not about what is on the screen — so it is answered
 * here and not by the classifier.
 */
export function sessionExited(name, { substrate = detectSubstrate(), runner = spawnSync } = {}) {
  if (substrate === "tmux") {
    const r = tmux(["list-panes", "-t", name, "-F", "#{pane_dead}"], { runner });
    if (!r.ok) return null; // gone entirely, not exited-but-present
    return r.stdout.split("\n").some((line) => line.trim() === "1");
  }
  if (substrate === "pty") {
    if (ptyFinished(name)) return true;
    const pid = ptyPid(name);
    if (!pid) return null;
    return !pidAlive(pid);
  }
  return null;
}

/**
 * Everything the roster needs from tmux, in two calls instead of two per
 * session.
 *
 * The roster renders on every pit start and on every poll of `wait`. Asking
 * tmux for one session's attached-count and one session's dead-pane status
 * meant a fork per field per row, so a herd of six cost thirteen processes to
 * draw one screen. tmux will format the whole server in one pass.
 */
/**
 * Where every member's pane actually is, keyed by member name.
 *
 * A member is a *pane*, not a session. It starts life as the only pane in a
 * session of the same name, but `herd tile` moves panes into one window to lay
 * them out side by side — and a session whose last pane leaves is gone. Keying
 * off session names would make every tiled member vanish from the roster, from
 * `read`, from `prompt` and from `wait`, which is a steep price for a layout.
 *
 * The pane's *title* is the durable handle: it is set at creation, it travels
 * with the pane through join-pane and break-pane, and tmux will report it from
 * anywhere on the server.
 */
export function paneIndex({ runner = spawnSync } = {}) {
  const r = tmux(["list-panes", "-a", "-F", "#{pane_title}\t#{pane_id}\t#{session_name}\t#{window_id}\t#{pane_dead}"], { runner });
  const index = new Map();
  if (!r.ok) return index;
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [title, paneId, session, windowId, dead] = line.split("\t");
    if (!title) continue;
    index.set(title, { paneId, session, windowId, dead: dead.trim() === "1" });
  }
  return index;
}

/**
 * The tmux target for a member: its pane id when we can find one, else its
 * session name. The fallback matters for a session created before pane titles
 * were set, which would otherwise become unreachable after an upgrade.
 */
export function target(name, { runner = spawnSync, index } = {}) {
  const found = (index || paneIndex({ runner })).get(name);
  return found ? found.paneId : name;
}

function tmuxSnapshot({ runner = spawnSync } = {}) {
  const sessions = tmux(["list-sessions", "-F", "#{session_name}\t#{session_attached}"], { runner });
  const attached = new Map();
  if (sessions.ok) {
    for (const line of sessions.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name, count] = line.split("\t");
      attached.set(name, Number(count) || 0);
    }
  }
  // `-a` is every pane on the server. A session is finished when it has no pane
  // that is still alive.
  const panes = tmux(["list-panes", "-a", "-F", "#{session_name}\t#{pane_dead}"], { runner });
  const anyLive = new Map();
  if (panes.ok) {
    for (const line of panes.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name, dead] = line.split("\t");
      anyLive.set(name, (anyLive.get(name) || false) || dead.trim() !== "1");
    }
  }
  return { attached, anyLive };
}

/**
 * Start a session in the herd and return immediately.
 *
 * This is the whole point of the module: the caller gets its prompt back while
 * the engine keeps running. Returns { ok, name } or { ok:false, error }.
 */
export function startSession({
  name,
  engine,
  bin,
  args = [],
  stripEnv = [],
  cwd = process.cwd(),
  substrate = detectSubstrate(),
  env = process.env,
  runner = spawnSync,
  spawner = spawn,
} = {}) {
  if (!substrate) return { ok: false, error: new Error("no herd substrate — install tmux") };
  if (!validName(name)) return { ok: false, error: new Error(`invalid session name ${JSON.stringify(name)} — ${NAME_RE}`) };
  if (liveNames({ substrate, runner }).includes(name)) {
    return { ok: false, error: new Error(`a session named "${name}" is already running — moshcode attach ${name}`) };
  }

  const entry = {
    engine,
    bin,
    args,
    cwd,
    substrate,
    created: Date.now(),
    stripEnv,
  };

  if (substrate === "tmux") {
    const command = sessionCommand({ bin, args, stripEnv });
    const started = tmux(tmuxStartPlan({ name, cwd, command }), { runner, env });
    if (!started.ok) {
      return { ok: false, error: new Error(started.stderr.trim() || started.error?.message || "tmux could not start the session") };
    }
    rememberSession(name, entry);
    return { ok: true, name, substrate };
  }

  const started = ptyStart({ name, cwd, bin, args, stripEnv, env, spawner, runner });
  if (!started.ok) return started;
  rememberSession(name, { ...entry, pid: started.pid });
  return { ok: true, name, substrate, pid: started.pid };
}

/** The last `lines` rows of a session's screen — what the classifier reads. */
export function capture(name, { lines = 60, substrate = detectSubstrate(), runner = spawnSync } = {}) {
  if (substrate === "tmux") {
    const r = tmux(["capture-pane", "-p", "-t", target(name, { runner }), "-S", `-${Math.max(0, lines)}`], { runner });
    return r.ok ? r.stdout.replace(/\n+$/, "") : "";
  }
  if (substrate === "pty") return ptyCapture(name, lines);
  return "";
}

/** Raw key relay. `keys` is passed through to tmux's own key vocabulary. */
export function sendKeys(name, keys, { substrate = detectSubstrate(), runner = spawnSync } = {}) {
  if (substrate === "tmux") {
    const r = tmux(["send-keys", "-t", target(name, { runner }), ...(Array.isArray(keys) ? keys : [keys])], { runner });
    return r.ok ? { ok: true } : { ok: false, error: new Error(r.stderr.trim() || "send-keys failed") };
  }
  if (substrate === "pty") {
    const literal = (Array.isArray(keys) ? keys : [keys])
      .map((k) => (k === "Enter" ? "\r" : k === "Escape" ? "\x1b" : k))
      .join("");
    return ptyWrite(name, literal);
  }
  return { ok: false, error: new Error("no herd substrate") };
}

/**
 * Type a prompt into a session and press Enter.
 *
 * Deliberately two calls with the text sent literally (`-l`): a prompt is user
 * text and regularly contains `;`, `$` or a bare `Enter`, all of which tmux
 * would otherwise read as key names rather than characters.
 */
export function sendPrompt(name, text, { substrate = detectSubstrate(), runner = spawnSync } = {}) {
  if (substrate === "tmux") {
    const pane = target(name, { runner });
    const typed = tmux(["send-keys", "-t", pane, "-l", String(text)], { runner });
    if (!typed.ok) return { ok: false, error: new Error(typed.stderr.trim() || "send-keys failed") };
    const entered = tmux(["send-keys", "-t", pane, "Enter"], { runner });
    return entered.ok ? { ok: true } : { ok: false, error: new Error(entered.stderr.trim() || "send-keys failed") };
  }
  if (substrate === "pty") return ptyWrite(name, `${String(text)}\r`);
  return { ok: false, error: new Error("no herd substrate") };
}

/** End a session and forget it. */
export function killSession(name, { substrate = detectSubstrate(), runner = spawnSync } = {}) {
  if (substrate === "tmux") {
    // kill-pane, not kill-session: a tiled member shares its session with
    // every other tiled member, and killing that would take the lot.
    const found = paneIndex({ runner }).get(name);
    const r = tmux(["kill-pane", "-t", target(name, { runner })], { runner });
    // A member being attached to has a mosh bar under it, and the bar would
    // hold the session open after its member is gone — an empty room still
    // answering to the dead member's name on the roster. If that is all that is
    // left, take the room too.
    if (r.ok && found) {
      const left = tmux(["list-panes", "-t", found.session, "-F", "#{pane_title}"], { runner });
      const titles = left.ok ? left.stdout.split("\n").filter(Boolean) : [];
      if (titles.length && titles.every((t) => t === "mosh-bar")) {
        tmux(["kill-session", "-t", found.session], { runner });
      }
    }
    forgetSession(name);
    return r.ok ? { ok: true } : { ok: false, error: new Error(r.stderr.trim() || "no such session") };
  }
  if (substrate === "pty") {
    const pid = ptyPid(name);
    let killed = false;
    if (pid && pidAlive(pid)) {
      // Negative pid: script(1) is a process group leader (detached), and the
      // engine is its child. Signalling the leader alone regularly leaves the
      // engine running with no way left to reach it.
      try { process.kill(-pid, "SIGTERM"); killed = true; }
      catch { try { process.kill(pid, "SIGTERM"); killed = true; } catch { /* already gone */ } }
    }
    ptyCleanup(name);
    forgetSession(name);
    return killed ? { ok: true } : { ok: false, error: new Error("no such session") };
  }
  return { ok: false, error: new Error("no herd substrate") };
}

/** Stop the whole runtime. Every session in it goes too — hence the name. */
export function stopRuntime({ substrate = detectSubstrate(), runner = spawnSync } = {}) {
  if (substrate === "tmux") {
    const r = tmux(["kill-server"], { runner });
    writeManifest({ sessions: {} });
    return { ok: r.ok };
  }
  if (substrate === "pty") {
    for (const name of Object.keys(readManifest().sessions)) killSession(name, { substrate, runner });
    return { ok: true };
  }
  return { ok: false };
}

/**
 * Attach the current terminal to a session, resolving when the user detaches
 * or the session ends. This is the one call that takes the terminal.
 */
export async function attachSession(name, {
  substrate = detectSubstrate(),
  env = process.env,
  spawner = spawn,
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  if (substrate === "tmux") {
    // A member that has been tiled shares a window with its neighbours, so
    // attaching has to select its pane and zoom it — otherwise you land on
    // whichever pane happened to have focus, at a quarter of the screen.
    const found = paneIndex().get(name);
    const argv = found
      ? ["attach-session", "-t", found.session,
         ";", "select-window", "-t", found.windowId,
         ";", "select-pane", "-t", found.paneId,
         ";", "resize-pane", "-Z", "-t", found.paneId]
      : ["attach-session", "-t", name];
    return new Promise((resolve) => {
      let child;
      try { child = spawner("tmux", tmuxArgs(argv), { stdio: "inherit", env }); }
      catch (error) { resolve({ ok: false, error }); return; }
      child.on("error", (error) => resolve({ ok: false, error }));
      child.on("exit", (code, signal) => resolve({ ok: code === 0, code, signal }));
    });
  }
  if (substrate === "pty") return ptyAttachSession(name, { stdin, stdout });
  return { ok: false, error: new Error("no herd substrate") };
}

/** The byte that detaches a pty-substrate session: Ctrl-]. */
export const PTY_DETACH_KEY = "\x1d";

/**
 * Attach without tmux: replay what is on screen, then relay.
 *
 * Everything typed goes to the FIFO and everything appended to the transcript
 * comes back out, which is a terminal in the only sense that matters here. The
 * replay is what makes it usable at all — an engine in its alternate screen
 * will not redraw for us, so without pushing the tail back you attach to a
 * blank rectangle.
 */
export function ptyAttachSession(name, { stdin = process.stdin, stdout = process.stdout } = {}) {
  return new Promise((resolve) => {
    if (!pidAlive(ptyPid(name))) { resolve({ ok: false, error: new Error(`no session named "${name}"`) }); return; }

    // Note the size *before* printing the context, and start the follow there.
    // Following from zero would replay everything the session has ever printed
    // on top of the tail we just showed — for an agent that has been running
    // for hours that is megabytes of scrollback. Anything written between the
    // stat and the follow starting is inside [size, …) and still arrives; at
    // worst a line or two is shown twice, which beats both a gap and a replay.
    let size = 0;
    try { size = fs.statSync(ptyPaths(name).transcript).size; } catch { /* first read */ }
    stdout.write(ptyCapture(name, 200));
    stdout.write(`\n\x1b[2m— attached to ${name} · Ctrl-] to detach —\x1b[22m\n`);

    const wasRaw = Boolean(stdin.isRaw);
    try { stdin.setRawMode?.(true); } catch { /* not a tty; relay still works */ }
    stdin.resume();

    let done = false;
    const cleanupTimers = [];
    const stopFollow = followFile(ptyPaths(name).transcript, (chunk) => stdout.write(chunk), {
      intervalMs: 40, startOffset: size,
    });

    const finish = (result) => {
      if (done) return;
      done = true;
      for (const timer of cleanupTimers) clearInterval(timer);
      stdin.off("data", onData);
      try { stdin.setRawMode?.(wasRaw); } catch { /* not a tty */ }
      stdin.pause();
      stopFollow();
      stdout.write("\n");
      resolve(result);
    };

    const onData = (buf) => {
      if (buf.includes(PTY_DETACH_KEY)) {
        const before = buf.subarray(0, buf.indexOf(PTY_DETACH_KEY));
        if (before.length) ptyWrite(name, before);
        finish({ ok: true, detached: true });
        return;
      }
      const written = ptyWrite(name, buf);
      if (!written.ok) finish({ ok: true, ended: true });
    };
    stdin.on("data", onData);

    // The child can exit while you are watching it; nothing else would notice.
    //
    // Not unref'd, for the same reason the poll timer in herd-cli is not: an
    // attach is a foreground act whose entire purpose is to stay. The follow
    // timer is unref'd (pty.mjs), so if this one were too, an attach whose
    // stdin did not hold the loop open would exit the instant it started.
    // finish() clears it, so it never outlives the attach either.
    const liveness = setInterval(() => {
      if (!pidAlive(ptyPid(name))) { finish({ ok: true, ended: true }); }
    }, 500);
    cleanupTimers.push(liveness);
  });
}

/**
 * The roster: every session the herd knows about, live or remembered.
 *
 * Remembered-but-not-live entries are kept rather than swept, because "the box
 * rebooted and these are what you were running" is exactly the question
 * `moshcode restore` answers.
 */
export function listSessions({ substrate = detectSubstrate(), runner = spawnSync, now = Date.now() } = {}) {
  const manifest = readManifest();
  const panes = substrate === "tmux" ? paneIndex({ runner }) : null;
  const snapshot = substrate === "tmux" ? tmuxSnapshot({ runner }) : null;
  const live = new Set(panes
    ? [...panes.keys()].filter((name) => name in manifest.sessions)
    : liveNames({ substrate, runner }));
  const names = [...new Set([...live, ...Object.keys(manifest.sessions)])].sort();
  return names.map((name) => {
    const meta = manifest.sessions[name] || {};
    const alive = live.has(name);
    const exited = !alive ? null
      : panes ? Boolean(panes.get(name)?.dead)
      : sessionExited(name, { substrate, runner });
    return {
      name,
      engine: meta.engine || "?",
      // Sessions started before herds existed have none. They belong to `main`
      // rather than to a group rendered as "undefined".
      herd: meta.herd || "main",
      cwd: meta.cwd || "",
      created: meta.created || null,
      age: meta.created ? now - meta.created : null,
      alive,
      exited,
      // Where it currently sits — null when it is in its own session, the
      // window it was tiled into otherwise. The UI needs this to know whether
      // a member is already on a layout somewhere.
      window: alive && panes ? panes.get(name)?.windowId || null : null,
      attached: alive && snapshot ? snapshot.attached.get(panes?.get(name)?.session) || 0 : 0,
      substrate: meta.substrate || substrate,
    };
  });
}
