// Persistent SSH workspaces — one authenticated transport, many clean commands
// (PRD 0013).
//
// A coding run against a remote box is a few hundred small operations: read a
// file, `git status`, apply a patch, run the tests. Spawning `ssh` for each one
// is fine; paying for a TCP handshake, key exchange, host-key check and
// authentication for each one is not, and that is what a fresh `ssh user@host
// cmd` costs every time. OpenSSH has carried the fix for twenty years:
// ControlMaster keeps one authenticated connection alive and later clients
// open channels on it through a Unix socket, so the second command costs a
// socket connect instead of a handshake. Measured on a loopback sshd, that is
// ~12ms a command against ~96ms — and on a real network the handshake is the
// part that grows.
//
// So this module is a thin, careful wrapper over that feature. It owns:
//
//   · the registry of named targets (~/.moshcode/ssh/targets.json) — a name,
//     a host or ssh_config alias, a port, a default cwd. Never a password or a
//     key: OpenSSH already has ~/.ssh, an agent, and a known_hosts, and every
//     one of those stays authoritative;
//   · the control socket for each target, in a directory only this user can
//     read, at a path short enough for sun_path;
//   · open / check / close, spelled with ssh's own `-O` control operations
//     rather than by tracking and killing PIDs;
//   · exec: a remote command built from argv with real quoting, no PTY unless
//     asked, stdin forwarded raw, stdout/stderr/exit status returned as data;
//   · attach, put/get over scp, and an optional remote tmux shell for the
//     workflows that genuinely need shell state.
//
// It does NOT implement SSH, and never will. No ssh2, no node-pty, no libssh.
// The `ssh` on PATH is the implementation; this file decides what to ask it.
//
// Two OpenSSH facts shaped the invocations below, both found by running them:
//
//   1. `-M` and `-o ControlMaster=yes` together do not mean "yes, twice". ssh
//      reads a second request for master mode as a request for *ask* mode —
//      every later client then triggers an askpass prompt, and with no askpass
//      the answer is "Master refused session request: Permission denied". The
//      master here is `-o ControlMaster=yes -N -f`, and `-M` never appears.
//
//   2. `ControlMaster=auto` on a client is the stale-socket recovery the PRD
//      asks for, natively: a socket nobody is listening on gets unlinked and
//      the client becomes the new master. exec runs with `auto` so a master
//      that died between two commands costs one reconnect, not an error.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ash, bone, err, info, ok, table, warn } from "./ui.mjs";

/* ------------------------------------------------------------ constants */

/** Where the last client's disconnect leaves the master alive, by default. */
export const DEFAULT_PERSIST = "10m";

/** Keepalives for a transport an unattended agent is relying on (R14). */
export const KEEPALIVE = { ServerAliveInterval: 30, ServerAliveCountMax: 3 };

/** `MOSHCODE_SSH_PERSIST=30m` overrides the default persist window. */
export const PERSIST_ENV = "MOSHCODE_SSH_PERSIST";

/** `MOSHCODE_SSH_CONFIG=<file>` points ssh at a config other than ~/.ssh/config. */
export const CONFIG_ENV = "MOSHCODE_SSH_CONFIG";

/** `MOSHCODE_SSH_DEBUG=1` prints each ssh argv to stderr — redacted, see debugLine. */
export const DEBUG_ENV = "MOSHCODE_SSH_DEBUG";

/** How long ssh itself waits on a TCP connect before giving up. */
export const CONNECT_TIMEOUT = 20;

/** 64 MiB of stdout is a file listing gone wrong, not a use case. */
const MAX_OUTPUT = 64 * 1024 * 1024;

/** The longest control-socket path we will ask the kernel to bind (R16). */
const MAX_SOCKET_PATH = 100;

/**
 * Target names are typed at a prompt, used as a filename component, and hashed
 * into a socket path. The herd's shape, for the same reasons: nothing that
 * could be a path separator, a traversal, or a tmux target separator (R66).
 */
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const validName = (name) => NAME_RE.test(String(name || ""));

/** Session names for remote tmux shells: same alphabet, so `dev/app` parses cleanly. */
export const SESSION_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** POSIX shell variable names, for --env K=V. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/* ------------------------------------------------------------- registry */

/** Where the registry and, by default, the control sockets live. */
export function sshDir() {
  return process.env.MOSHCODE_SSH_DIR || path.join(os.homedir(), ".moshcode", "ssh");
}

const targetsPath = () => path.join(sshDir(), "targets.json");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies on create; an older, looser directory is fixed
  // here rather than trusted (R17, R65).
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to fix */ }
  return dir;
}

/**
 * Read the registry. Never throws: a corrupt or absent file is "no targets",
 * which the caller can recover from, and every field is re-validated so a
 * hand-edited file cannot smuggle a name the rest of this module refuses.
 */
export function readTargets() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(targetsPath(), "utf8")); } catch { return {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!validName(name) || !entry || typeof entry !== "object" || !entry.target) continue;
    out[name] = normalizeEntry(entry);
  }
  return out;
}

function normalizeEntry(entry) {
  const port = Number.parseInt(entry.port, 10);
  const out = { target: String(entry.target) };
  if (Number.isInteger(port) && port > 0 && port < 65536) out.port = port;
  if (entry.cwd) out.cwd = String(entry.cwd);
  if (entry.persist) out.persist = String(entry.persist);
  return out;
}

/**
 * Write the registry: to a sibling temp file, then rename over the real one,
 * both at 0600 (R67). Two pits saving at once cannot leave a half-written file
 * behind, and `mode` on the temp file means the finished file never spends a
 * moment world-readable. Nothing in it is secret today; the contract is that
 * nothing ever will be, and the permissions say so anyway.
 */
export function writeTargets(targets) {
  const dir = ensureDir(sshDir());
  const file = targetsPath();
  const tmp = path.join(dir, `.targets.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(targets, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return true;
}

/** Fields the registry is allowed to hold. Anything else is dropped on write (R4). */
const ALLOWED_FIELDS = ["target", "port", "cwd", "persist"];

/** Names that read as a secret, refused as target fields no matter the value. */
const SECRET_FIELDS = /pass|secret|token|key|identity|phrase/i;

/**
 * Add or replace a target. `target` is whatever ssh accepts after its options —
 * `user@host`, a bare host, or an alias from ~/.ssh/config (R5). It is not
 * parsed here on purpose: ssh_config is the authority on what it means.
 */
export function addTarget(name, target, { port, cwd, persist } = {}) {
  if (!validName(name)) {
    throw new Error(`ssh: ${JSON.stringify(String(name))} is not a target name — lowercase letters, digits, - and _ only`);
  }
  const host = String(target || "").trim();
  if (!host) throw new Error("ssh: a target needs a host — moshcode ssh add <name> <user@host | ssh-config alias>");
  if (host.startsWith("-")) throw new Error(`ssh: ${JSON.stringify(host)} looks like a flag, not a host`);
  const entry = { target: host };
  if (port !== undefined && port !== null && port !== "") {
    const n = Number.parseInt(port, 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`ssh: --port ${JSON.stringify(String(port))} is not a port`);
    entry.port = n;
  }
  if (cwd) entry.cwd = String(cwd);
  if (persist) entry.persist = String(parsePersist(persist).text);
  for (const field of Object.keys(entry)) {
    if (!ALLOWED_FIELDS.includes(field) || SECRET_FIELDS.test(field)) delete entry[field];
  }
  const targets = readTargets();
  const replaced = Boolean(targets[name]);
  targets[name] = entry;
  writeTargets(targets);
  return { name, ...entry, replaced };
}

export function removeTarget(name) {
  const targets = readTargets();
  if (!targets[name]) return false;
  delete targets[name];
  writeTargets(targets);
  return true;
}

/** One target, or null. */
export function getTarget(name) {
  const entry = readTargets()[String(name)];
  return entry ? { name: String(name), ...entry } : null;
}

/** Every target, name first, in registry order. */
export function listTargets() {
  return Object.entries(readTargets()).map(([name, entry]) => ({ name, ...entry }));
}

/* --------------------------------------------------------- durations */

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i;

/**
 * "10m" → seconds. Bare numbers are seconds, which is also what ssh's own
 * ControlPersist takes, so the value can be handed straight through.
 */
export function parsePersist(text) {
  const m = DURATION_RE.exec(String(text ?? "").trim());
  if (!m) throw new Error(`ssh: ${JSON.stringify(String(text))} is not a duration — try 10m, 90s, 2h`);
  const unit = (m[2] || "s").toLowerCase();
  const mult = { ms: 1 / 1000, s: 1, m: 60, h: 3600, d: 86400 }[unit];
  const seconds = Math.round(Number(m[1]) * mult);
  if (seconds < 1) throw new Error(`ssh: a persist window under a second (${text}) would close the master before it is used`);
  return { seconds, text: String(text).trim() };
}

/** "2m" → milliseconds, for --timeout. Bare numbers are seconds. */
export function parseTimeout(text) {
  if (text === undefined || text === null || text === "") return undefined;
  const m = DURATION_RE.exec(String(text).trim());
  if (!m) throw new Error(`ssh: ${JSON.stringify(String(text))} is not a duration — try 30s, 2m, 1h`);
  const unit = (m[2] || "s").toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  const ms = Math.round(Number(m[1]) * mult);
  if (ms < 1) throw new Error(`ssh: --timeout ${text} is not a usable timeout`);
  return ms;
}

/** The persist window in effect: flag, then target, then env, then default. */
export function persistFor(entry, flag, env = process.env) {
  return parsePersist(flag || entry?.persist || env[PERSIST_ENV] || DEFAULT_PERSIST);
}

/* --------------------------------------------------------- control socket */

/**
 * Where the sockets go. ~/.moshcode/ssh/control unless the home directory is
 * long enough to push the socket past sun_path (R16) — a NFS home like
 * /net/filers/home/dept/anthony gets there — in which case a per-user
 * directory under the OS temp dir. Overridable for tests and odd setups.
 */
export function controlDir() {
  if (process.env.MOSHCODE_SSH_CONTROL_DIR) return process.env.MOSHCODE_SSH_CONTROL_DIR;
  const preferred = path.join(sshDir(), "control");
  if (path.join(preferred, "x".repeat(12)).length <= MAX_SOCKET_PATH) return preferred;
  const uid = typeof process.getuid === "function" ? process.getuid() : "u";
  return path.join(os.tmpdir(), `moshcode-ssh-${uid}`);
}

/**
 * The socket for a target: a short hash of the name and where it points, so
 * `ssh add dev` pointing somewhere new never reuses the master for where it
 * used to point, and the path never carries `user@host:/srv/app` (R16).
 */
export function controlPath(entry) {
  const key = [entry.name, entry.target, entry.port || ""].join("\0");
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
  return path.join(controlDir(), hash);
}

function ensureControlDir() {
  return ensureDir(controlDir());
}

/* ------------------------------------------------------------- quoting */

/**
 * POSIX single-quoting: the only escape is `'` → `'\''`, and everything else
 * is literal — including `$`, backticks, newlines, and the glob characters
 * a model puts into a `sed` expression. Exactly what a remote command built
 * from argv needs (R68).
 */
export function shellQuote(arg) {
  const s = String(arg);
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `cd` to a path that may start with `~`, which must stay outside the quotes to expand. */
export function cdCommand(cwd) {
  const p = String(cwd);
  if (p === "~") return "cd";
  if (p.startsWith("~/")) return `cd -- ~/${shellQuote(p.slice(2))}`;
  return `cd -- ${shellQuote(p)}`;
}

/**
 * The string ssh hands the remote login shell. Built as
 *
 *   cd -- '/srv/app' && K='v' exec 'git' 'apply' '-'
 *
 * so the cwd, the environment, and the argv each arrive exactly as given.
 * `exec` keeps the shell from lingering as a parent — signals reach the
 * command, and the exit status is the command's, not sh's opinion of it. With
 * `sh: true` the single argument is a shell snippet and is passed verbatim,
 * which is the one place a caller can mean `a | b`; it is a flag, never a
 * guess about whether the argv "looks like" a pipeline.
 */
export function remoteCommand(argv, { cwd, env = {}, sh = false } = {}) {
  const parts = [];
  if (cwd) parts.push(cdCommand(cwd));
  const assignments = Object.entries(env).map(([k, v]) => {
    if (!ENV_KEY_RE.test(k)) throw new Error(`ssh: ${JSON.stringify(k)} is not an environment variable name`);
    return `${k}=${shellQuote(v)}`;
  });
  let command;
  if (sh) {
    if (argv.length !== 1) throw new Error("ssh: --sh takes exactly one argument, the shell snippet");
    command = assignments.length ? `export ${assignments.join(" ")} && ${argv[0]}` : String(argv[0]);
  } else {
    if (!argv.length) throw new Error("ssh: nothing to run — moshcode ssh exec <name> -- <command> [args…]");
    command = [...assignments, "exec", ...argv.map(shellQuote)].join(" ");
  }
  parts.push(command);
  return parts.join(" && ");
}

/** `--env K=V` pairs → object. */
export function parseEnvPairs(pairs = []) {
  const env = {};
  for (const pair of pairs) {
    const i = String(pair).indexOf("=");
    if (i < 1) throw new Error(`ssh: --env wants KEY=VALUE, got ${JSON.stringify(String(pair))}`);
    const key = String(pair).slice(0, i);
    if (!ENV_KEY_RE.test(key)) throw new Error(`ssh: ${JSON.stringify(key)} is not an environment variable name`);
    env[key] = String(pair).slice(i + 1);
  }
  return env;
}

/* ---------------------------------------------------------- invocations */

/** Options every ssh we spawn carries: which socket, and which config. */
function baseOptions(entry, { env = process.env } = {}) {
  const args = [];
  if (env[CONFIG_ENV]) args.push("-F", env[CONFIG_ENV]);
  args.push("-o", `ControlPath=${controlPath(entry)}`);
  return args;
}

/** `-p N` only when the registry says so; otherwise ssh_config decides. */
function portArgs(entry) {
  return entry.port ? ["-p", String(entry.port)] : [];
}

/**
 * Keepalive options, unless the user's own config already sets an interval
 * (R14). `ssh -G` prints the effective configuration for a host without
 * connecting, so this is a config parse, not a round trip.
 */
export function keepaliveArgs(entry, { runner = spawnSync, env = process.env } = {}) {
  const probe = runner("ssh", [...(env[CONFIG_ENV] ? ["-F", env[CONFIG_ENV]] : []), "-G", ...portArgs(entry), entry.target], {
    encoding: "utf8", env, timeout: 5000,
  });
  const configured = /^serveraliveinterval\s+([1-9]\d*)/mi.test(String(probe?.stdout || ""));
  if (configured) return [];
  return Object.entries(KEEPALIVE).flatMap(([k, v]) => ["-o", `${k}=${v}`]);
}

/** argv for `ssh -O <op>` against the target's socket. */
export function controlArgs(entry, op, { env = process.env } = {}) {
  return [...baseOptions(entry, { env }), "-O", op, ...portArgs(entry), entry.target];
}

/**
 * argv for the master. `-N` (no command) and `-f` (background after auth), a
 * finite ControlPersist, keepalives, and a connect timeout so a black-holed
 * host answers in seconds rather than the kernel's minutes. `BatchMode=yes`
 * only when nobody is at a terminal: it turns a password or passphrase prompt
 * into a clean failure, which is right for an agent and wrong for a person
 * who was about to type it (R70; see the PRD's open question).
 */
export function masterArgs(entry, { persist, batch, keepalive = [], env = process.env } = {}) {
  const window = persistFor(entry, persist, env);
  return [
    ...baseOptions(entry, { env }),
    "-o", "ControlMaster=yes",
    "-o", `ControlPersist=${window.seconds}`,
    "-o", `ConnectTimeout=${CONNECT_TIMEOUT}`,
    ...(batch ? ["-o", "BatchMode=yes"] : []),
    ...keepalive,
    ...portArgs(entry),
    "-N", "-f",
    entry.target,
  ];
}

/**
 * argv for one command over the master. `-T` — no PTY — is the default and
 * the point: stdout and stderr stay separate, stdin stays binary, and nothing
 * on the remote side thinks a person is watching (R20). `ControlMaster=auto`
 * is the stale-socket fallback described at the top of the file.
 */
export function execArgs(entry, command, { tty = false, batch = true, persist, keepalive = [], env = process.env } = {}) {
  const window = persistFor(entry, persist, env);
  return [
    ...baseOptions(entry, { env }),
    "-o", "ControlMaster=auto",
    "-o", `ControlPersist=${window.seconds}`,
    "-o", `ConnectTimeout=${CONNECT_TIMEOUT}`,
    ...(batch ? ["-o", "BatchMode=yes"] : []),
    ...keepalive,
    ...portArgs(entry),
    tty ? "-t" : "-T",
    entry.target,
    "--",
    command,
  ];
}

/**
 * argv for an interactive session (R36–R40). ssh gets the terminal whole; the
 * only thing added is a `cd` to the target's cwd, so `/ssh dev` lands where
 * the work is. The login shell is the remote user's own — `$SHELL` there, not
 * anything this side has an opinion about.
 */
export function attachArgs(entry, { persist, keepalive = [], env = process.env } = {}) {
  const window = persistFor(entry, persist, env);
  const args = [
    ...baseOptions(entry, { env }),
    "-o", "ControlMaster=auto",
    "-o", `ControlPersist=${window.seconds}`,
    ...keepalive,
    ...portArgs(entry),
  ];
  if (entry.cwd) {
    args.push("-t", entry.target, "--", `${cdCommand(entry.cwd)} && exec "\${SHELL:-sh}" -l`);
  } else {
    args.push(entry.target);
  }
  return args;
}

/**
 * argv for scp over the same socket. `-p` on scp is "preserve times", so the
 * port is spelled `-P`; everything else rides on ControlPath and the config.
 */
export function scpArgs(entry, from, to, { env = process.env } = {}) {
  const args = [];
  if (env[CONFIG_ENV]) args.push("-F", env[CONFIG_ENV]);
  args.push("-o", `ControlPath=${controlPath(entry)}`, "-o", "ControlMaster=auto", "-q");
  if (entry.port) args.push("-P", String(entry.port));
  return [...args, from, to];
}

/* --------------------------------------------------------------- results */

/**
 * What a spawn result means, in the two words an agent needs: did the
 * *transport* work, and what did the *command* say (R24, R25). ssh reserves
 * exit 255 for its own failures — connect, host key, auth — and everything
 * else is the remote command's own status. The cases that are neither
 * (ssh not installed, our timeout) are named as such.
 */
export function classify(res) {
  if (!res) return { transportOk: false, code: null, signal: null, error: "ssh did not run" };
  if (res.error?.code === "ENOENT") {
    return { transportOk: false, code: null, signal: null, error: "ssh not found — install an OpenSSH client", missing: true };
  }
  if (res.error?.code === "ETIMEDOUT") {
    return { transportOk: true, code: null, signal: res.signal || "SIGTERM", error: "timed out", timedOut: true };
  }
  if (res.error) {
    return { transportOk: false, code: res.status ?? null, signal: res.signal || null, error: String(res.error.message || res.error) };
  }
  if (res.status === 255) {
    return { transportOk: false, code: 255, signal: null, error: transportError(res.stderr) };
  }
  if (res.status === null && res.signal) {
    return { transportOk: true, code: null, signal: res.signal, error: `killed by ${res.signal}` };
  }
  return { transportOk: true, code: res.status ?? 0, signal: null, error: null };
}

/** ssh's last line of complaint, or a fallback, as a one-line reason. */
function transportError(stderr) {
  const lines = String(stderr || "").split("\n").map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^Warning: Permanently added/.test(l));
  const last = lines.at(-1) || "";
  if (/Permission denied|no supported authentication|Too many authentication/i.test(last)) return `ssh authentication failed: ${last}`;
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(String(stderr))) return "ssh host key verification failed";
  if (/Connection timed out|Operation timed out|Connection refused|Could not resolve|No route to host|Network is unreachable/i.test(last)) return `ssh could not connect: ${last}`;
  return last ? `ssh failed: ${last}` : "ssh failed (exit 255)";
}

/* ---------------------------------------------------------------- debug */

/**
 * One line per spawn to stderr when MOSHCODE_SSH_DEBUG is set. The remote
 * command is summarised by length, not printed: it can carry `--env` values,
 * and a debug log is exactly where a secret would otherwise end up (R63, R64,
 * R69). stdin is never logged at all.
 */
export function debugLine(bin, args) {
  const shown = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") { shown.push("--", `<remote command: ${Buffer.byteLength(String(args[i + 1] ?? ""))} bytes>`); break; }
    shown.push(args[i]);
  }
  return `ssh▸ ${bin} ${shown.join(" ")}`;
}

function debug(env, bin, args) {
  if (env[DEBUG_ENV] && env[DEBUG_ENV] !== "0") process.stderr.write(`${debugLine(bin, args)}\n`);
}

/* -------------------------------------------------------------- transport */

/** Resolve a target name, or explain why not. */
export function resolveTarget(name) {
  if (!validName(name)) return { error: `ssh: ${JSON.stringify(String(name))} is not a target name` };
  const entry = getTarget(name);
  if (!entry) return { error: `ssh: no target named ${JSON.stringify(String(name))} — moshcode ssh add ${name} user@host` };
  return { entry };
}

/**
 * Is the master alive? `ssh -O check` asks the socket, locally, and answers
 * in a millisecond. A socket that exists but nobody answers on is stale — the
 * master died, the box rebooted — and is unlinked here, because it is ours
 * and because ssh's own fallback would otherwise print "already exists,
 * disabling multiplexing" and quietly reconnect for every command (R15).
 */
export function checkMaster(entry, { runner = spawnSync, env = process.env } = {}) {
  const socket = controlPath(entry);
  const exists = fs.existsSync(socket);
  if (!exists) return { connected: false, socket, stale: false };
  const args = controlArgs(entry, "check", { env });
  debug(env, "ssh", args);
  const res = runner("ssh", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  if (res.status === 0) {
    const pid = Number.parseInt(/pid=(\d+)/.exec(String(res.stderr || ""))?.[1], 10);
    return { connected: true, socket, pid: Number.isInteger(pid) ? pid : null, stale: false };
  }
  try { fs.unlinkSync(socket); } catch { /* gone already, or not ours */ }
  return { connected: false, socket, stale: true };
}

/**
 * Establish the master (R8–R10). Idempotent: a live master is reported as
 * `alreadyOpen` and left alone. Prompts — a passphrase, a host key — reach
 * the user through /dev/tty when there is one, which is why stdin is
 * inherited and only the pipes are captured.
 */
export function openMaster(entry, { runner = spawnSync, env = process.env, persist, batch, stdin = process.stdin } = {}) {
  const started = Date.now();
  const status = checkMaster(entry, { runner, env });
  if (status.connected) return { ok: true, target: entry.name, connected: true, alreadyOpen: true, pid: status.pid, socket: status.socket, durationMs: Date.now() - started };
  ensureControlDir();
  const headless = batch ?? !stdin?.isTTY;
  const keepalive = keepaliveArgs(entry, { runner, env });
  const args = masterArgs(entry, { persist, batch: headless, keepalive, env });
  debug(env, "ssh", args);
  const res = runner("ssh", args, { encoding: "utf8", env, stdio: [headless ? "ignore" : "inherit", "pipe", "pipe"], timeout: 120_000 });
  const verdict = classify(res);
  if (!verdict.transportOk || (res.status ?? 0) !== 0) {
    return {
      ok: false, target: entry.name, connected: false, alreadyOpen: false,
      error: verdict.error || transportError(res.stderr), stderr: String(res.stderr || ""), durationMs: Date.now() - started,
    };
  }
  const after = checkMaster(entry, { runner, env });
  return {
    ok: after.connected, target: entry.name, connected: after.connected, alreadyOpen: false,
    pid: after.pid ?? null, socket: after.socket, durationMs: Date.now() - started,
    ...(after.connected ? {} : { error: "ssh returned but no master is answering on the control socket" }),
  };
}

/**
 * Close the master with `ssh -O exit` (R12). Nothing here knows or kills a
 * PID: the master is told to leave, and it takes its socket with it.
 */
export function closeMaster(entry, { runner = spawnSync, env = process.env } = {}) {
  const status = checkMaster(entry, { runner, env });
  if (!status.connected) return { ok: true, target: entry.name, closed: false, wasOpen: false, stale: status.stale };
  const args = controlArgs(entry, "exit", { env });
  debug(env, "ssh", args);
  const res = runner("ssh", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  const gone = !checkMaster(entry, { runner, env }).connected;
  return {
    ok: res.status === 0 && gone, target: entry.name, closed: gone, wasOpen: true,
    ...(res.status === 0 && gone ? {} : { error: transportError(res.stderr) }),
  };
}

/**
 * Run one command over the target's master (R18–R32).
 *
 * The shape of the answer is the whole feature: `ok` is the command's verdict,
 * `transportOk` is ssh's, `code`/`signal` are the remote exit, stdout and
 * stderr are separate strings, and `durationMs` is wall time. A `grep` that
 * found nothing is `ok: false, transportOk: true, code: 1` — a fact about the
 * files, not about the network — and an agent branching on the difference is
 * why the two fields exist.
 *
 * Recovery (R15): a master that is not answering is reopened before the
 * command runs; a transport failure on a master that *was* answering gets the
 * socket re-checked and the command retried once. No retry on a command that
 * merely failed, and none on a timeout — the remote side may have done the
 * work, and doing it twice is worse than reporting it once.
 */
export function exec(entry, argv, {
  cwd, remoteEnv = {}, stdin, tty = false, sh = false, timeoutMs, persist, batch,
  runner = spawnSync, env = process.env, retry = true,
} = {}) {
  const started = Date.now();
  const finish = (fields) => ({ target: entry.name, ...fields, durationMs: Date.now() - started });

  // `cwd: null` means "no cd at all" — for the tmux verbs and put/get's
  // rename, which address absolute things and must not fail because the
  // target's cwd happens not to exist yet. Undefined means the target's cwd.
  const where = cwd === null ? undefined : (cwd ?? entry.cwd);
  let command;
  try { command = remoteCommand(argv, { cwd: where, env: remoteEnv, sh }); }
  catch (e) { return finish({ ok: false, transportOk: false, connected: false, code: null, signal: null, stdout: "", stderr: "", error: e.message }); }

  let status = checkMaster(entry, { runner, env });
  let opened = false;
  if (!status.connected) {
    const open = openMaster(entry, { runner, env, persist, batch });
    if (!open.ok) {
      return finish({ ok: false, transportOk: false, connected: false, code: 255, signal: null, stdout: "", stderr: open.stderr || "", error: open.error, opened: false });
    }
    opened = true;
    status = { connected: true };
  }

  const headless = batch ?? (tty ? !process.stdin?.isTTY : true);
  const args = execArgs(entry, command, { tty, batch: headless, persist, env });
  const input = stdin === undefined || stdin === null ? undefined : (Buffer.isBuffer(stdin) ? stdin : Buffer.from(String(stdin)));
  const run = () => {
    debug(env, "ssh", args);
    const options = { env, maxBuffer: MAX_OUTPUT, killSignal: "SIGTERM" };
    if (timeoutMs) options.timeout = timeoutMs;
    if (tty) {
      // A terminal command owns the terminal; there is nothing to capture.
      options.stdio = "inherit";
    } else if (input !== undefined) {
      options.input = input;
    } else {
      options.stdio = ["ignore", "pipe", "pipe"];
    }
    const res = runner("ssh", args, options);
    return { res, verdict: classify(res) };
  };

  let { res, verdict } = run();
  let retried = false;
  if (!verdict.transportOk && !verdict.missing && retry && !opened) {
    // The master answered a moment ago and the command still failed at the
    // transport: it died in between. Re-check (which unlinks a stale socket),
    // reopen, and try the command once more.
    const again = checkMaster(entry, { runner, env });
    const open = again.connected ? { ok: true } : openMaster(entry, { runner, env, persist, batch });
    if (open.ok) { ({ res, verdict } = run()); retried = true; }
  }

  const stdout = tty ? "" : bufferToString(res.stdout);
  const stderr = tty ? "" : bufferToString(res.stderr);
  return finish({
    ok: verdict.transportOk && verdict.code === 0,
    transportOk: verdict.transportOk,
    connected: verdict.transportOk || status.connected,
    code: verdict.code,
    signal: verdict.signal,
    stdout,
    stderr,
    ...(verdict.error ? { error: verdict.error } : {}),
    ...(verdict.timedOut ? { timedOut: true } : {}),
    ...(opened ? { opened: true } : {}),
    ...(retried ? { retried: true } : {}),
    ...(tty ? { tty: true } : {}),
  });
}

const bufferToString = (b) => (b == null ? "" : Buffer.isBuffer(b) ? b.toString("utf8") : String(b));

/** Hand the terminal to ssh (R36–R40). Returns the exit code. */
export function attach(entry, { runner = spawnSync, env = process.env, persist } = {}) {
  const status = checkMaster(entry, { runner, env });
  if (!status.connected) ensureControlDir();
  const keepalive = status.connected ? [] : keepaliveArgs(entry, { runner, env });
  const args = attachArgs(entry, { persist, keepalive, env });
  debug(env, "ssh", args);
  const res = runner("ssh", args, { stdio: "inherit", env });
  if (res.error?.code === "ENOENT") return { ok: false, code: 127, error: "ssh not found — install an OpenSSH client" };
  return { ok: res.status === 0, code: res.status ?? 1, signal: res.signal || null };
}

/* ------------------------------------------------------------- transfer */

/**
 * Copy a local file up, atomically (R33, R34): scp to a sibling temp path
 * over the shared master, then `mv` it into place with one exec. A reader on
 * the remote side sees the old file or the new one, never a half-written one.
 */
export function put(entry, local, remote, { runner = spawnSync, env = process.env, persist, batch } = {}) {
  const started = Date.now();
  if (!fs.existsSync(local)) return { ok: false, target: entry.name, error: `no such local file: ${local}`, durationMs: 0 };
  const status = checkMaster(entry, { runner, env });
  if (!status.connected) {
    const open = openMaster(entry, { runner, env, persist, batch });
    if (!open.ok) return { ok: false, target: entry.name, transportOk: false, error: open.error, durationMs: Date.now() - started };
  }
  const dest = remotePath(entry, remote);
  const tmp = `${dest}.moshcode-${process.pid}-${Date.now()}.tmp`;
  const args = scpArgs(entry, local, `${entry.target}:${tmp}`, { env });
  debug(env, "scp", args);
  const res = runner("scp", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_OUTPUT });
  const verdict = classify(res);
  if (!verdict.transportOk || verdict.code !== 0) {
    return { ok: false, target: entry.name, transportOk: verdict.transportOk, code: verdict.code, error: verdict.error || transportError(res.stderr) || "scp failed", stderr: String(res.stderr || ""), durationMs: Date.now() - started };
  }
  const moved = exec(entry, ["mv", "-f", "--", tmp, dest], { runner, env, cwd: null, retry: false });
  if (!moved.ok) {
    exec(entry, ["rm", "-f", "--", tmp], { runner, env, cwd: null, retry: false });
    return { ok: false, target: entry.name, transportOk: moved.transportOk, code: moved.code, error: moved.error || moved.stderr.trim() || "rename failed", durationMs: Date.now() - started };
  }
  return { ok: true, target: entry.name, transportOk: true, local, remote: dest, durationMs: Date.now() - started };
}

/** Copy a remote file down over the shared master. */
export function get(entry, remote, local, { runner = spawnSync, env = process.env, persist, batch } = {}) {
  const started = Date.now();
  const status = checkMaster(entry, { runner, env });
  if (!status.connected) {
    const open = openMaster(entry, { runner, env, persist, batch });
    if (!open.ok) return { ok: false, target: entry.name, transportOk: false, error: open.error, durationMs: Date.now() - started };
  }
  const src = remotePath(entry, remote);
  const args = scpArgs(entry, `${entry.target}:${src}`, local, { env });
  debug(env, "scp", args);
  const res = runner("scp", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_OUTPUT });
  const verdict = classify(res);
  if (!verdict.transportOk || verdict.code !== 0) {
    return { ok: false, target: entry.name, transportOk: verdict.transportOk, code: verdict.code, error: verdict.error || transportError(res.stderr) || "scp failed", stderr: String(res.stderr || ""), durationMs: Date.now() - started };
  }
  return { ok: true, target: entry.name, transportOk: true, remote: src, local, durationMs: Date.now() - started };
}

/**
 * A relative remote path is relative to the target's cwd, the way `exec` is.
 * scp has no cwd of its own, so the join happens here; `~` is left for the
 * remote shell, which scp hands paths to.
 */
export function remotePath(entry, p) {
  const s = String(p);
  if (s.startsWith("/") || s.startsWith("~") || !entry.cwd) return s;
  return `${entry.cwd.replace(/\/+$/, "")}/${s}`;
}

/* ------------------------------------------------------- remote shells */

/** The remote tmux session name for `<target>/<session>` (R42). */
export function remoteSessionName(entry, session) {
  return `moshcode-ssh-${entry.name}-${session}`;
}

/** `dev/app` → { name: "dev", session: "app" }, or an error. */
export function parseSessionRef(ref) {
  const [name, session, ...rest] = String(ref || "").split("/");
  if (!name || !session || rest.length) return { error: `ssh: a shell is named <target>/<session>, got ${JSON.stringify(String(ref))}` };
  if (!validName(name)) return { error: `ssh: ${JSON.stringify(name)} is not a target name` };
  if (!SESSION_RE.test(session)) return { error: `ssh: ${JSON.stringify(session)} is not a session name — lowercase letters, digits, - and _` };
  return { name, session };
}

/** Is tmux on the remote box? One exec, cached nowhere — it is cheap over the master. */
export function remoteHasTmux(entry, opts = {}) {
  const r = exec(entry, ["tmux", "-V"], { ...opts, cwd: null });
  if (!r.transportOk) return { ok: false, has: false, error: r.error };
  return { ok: true, has: r.ok, version: r.ok ? r.stdout.trim() : null };
}

const NO_TMUX = (entry) => `ssh: tmux is not installed on ${entry.name} — a persistent shell needs it; moshcode ssh exec still works, and so does moshcode ssh ${entry.name}`;

/**
 * Create-or-attach a persistent remote shell (R41–R43). `tmux new-session -A`
 * attaches when the session exists and creates it when it does not, in one
 * word; the session lives on the remote box under tmux's own server and
 * survives this terminal, this master, and this laptop's lid.
 */
export function shellAttach(entry, session, { runner = spawnSync, env = process.env, persist } = {}) {
  const probe = remoteHasTmux(entry, { runner, env, persist });
  if (!probe.ok) return { ok: false, code: 255, error: probe.error };
  if (!probe.has) return { ok: false, code: 1, error: NO_TMUX(entry) };
  const name = remoteSessionName(entry, session);
  const tmuxCmd = ["tmux", "new-session", "-A", "-s", name, ...(entry.cwd ? ["-c", entry.cwd] : [])];
  const command = tmuxCmd.map((a, i) => (i === tmuxCmd.length - 1 && entry.cwd ? tildeQuote(a) : shellQuote(a))).join(" ");
  const status = checkMaster(entry, { runner, env });
  const keepalive = status.connected ? [] : keepaliveArgs(entry, { runner, env });
  const args = execArgs(entry, command, { tty: true, batch: false, persist, keepalive, env });
  debug(env, "ssh", args);
  const res = runner("ssh", args, { stdio: "inherit", env });
  return { ok: res.status === 0, code: res.status ?? 1, session: name };
}

/** Like shellQuote, but a leading `~/` stays outside the quotes so the remote shell expands it. */
function tildeQuote(p) {
  const s = String(p);
  if (s === "~") return "~";
  if (s.startsWith("~/")) return `~/${shellQuote(s.slice(2))}`;
  return shellQuote(s);
}

/**
 * Type into a remote shell without attaching (R44, R45). Two send-keys: the
 * text literally (`-l`, so `pnpm test` is five keystrokes and a space, not a
 * key name), then Enter. The herd's model exactly, one hop further away.
 */
export function shellSend(entry, session, text, opts = {}) {
  const name = remoteSessionName(entry, session);
  const r = exec(entry, ["tmux", "send-keys", "-t", name, "-l", "--", String(text)], { ...opts, cwd: null });
  if (!r.ok) return sessionFailure(entry, session, r);
  const enter = exec(entry, ["tmux", "send-keys", "-t", name, "Enter"], { ...opts, cwd: null, retry: false });
  if (!enter.ok) return sessionFailure(entry, session, enter);
  return { ok: true, target: entry.name, session, sent: String(text) };
}

/** The screen of a remote shell, as text (R46). */
export function shellRead(entry, session, { lines = 60, ...opts } = {}) {
  const name = remoteSessionName(entry, session);
  const n = Math.max(1, Number.parseInt(lines, 10) || 60);
  const r = exec(entry, ["tmux", "capture-pane", "-p", "-t", name, "-S", `-${n}`], { ...opts, cwd: null });
  if (!r.ok) return sessionFailure(entry, session, r);
  return { ok: true, target: entry.name, session, screen: r.stdout.replace(/\s+$/, "") };
}

/** End a remote shell and everything in it. */
export function shellKill(entry, session, opts = {}) {
  const name = remoteSessionName(entry, session);
  const r = exec(entry, ["tmux", "kill-session", "-t", name], { ...opts, cwd: null });
  if (!r.ok) return sessionFailure(entry, session, r);
  return { ok: true, target: entry.name, session, killed: true };
}

/** Every moshcode shell on the target. */
export function shellList(entry, opts = {}) {
  const prefix = `moshcode-ssh-${entry.name}-`;
  // Space-separated, not tab: a literal tab does not survive the trip through
  // the remote login shell intact, and session names cannot contain a space.
  const r = exec(entry, ["tmux", "list-sessions", "-F", "#{session_name} #{session_created} #{session_attached}"], { ...opts, cwd: null });
  if (!r.transportOk) return { ok: false, target: entry.name, error: r.error, sessions: [] };
  if (r.code === 127) return { ok: false, target: entry.name, error: NO_TMUX(entry), sessions: [] };
  // "no server running" is tmux's way of saying zero sessions, and exits 1.
  if (!r.ok && !/no server running|no sessions/i.test(r.stderr)) return { ok: false, target: entry.name, error: r.stderr.trim() || "tmux list-sessions failed", sessions: [] };
  const sessions = r.stdout.split("\n").filter((l) => l.startsWith(prefix)).map((l) => {
    const [name, created, attached] = l.split(" ");
    return { session: name.slice(prefix.length), created: Number(created) * 1000 || null, attached: attached === "1" };
  });
  return { ok: true, target: entry.name, sessions };
}

function sessionFailure(entry, session, r) {
  if (!r.transportOk) return { ok: false, target: entry.name, session, transportOk: false, error: r.error };
  if (r.code === 127) return { ok: false, target: entry.name, session, transportOk: true, error: NO_TMUX(entry) };
  // tmux's spellings for "that session is not there" vary with what else the
  // server has: with other sessions it cannot find this one; with none it
  // has no current target; with no server it says so.
  if (/can't find (session|pane|window)|no current target|no server running|session not found/i.test(r.stderr)) {
    return { ok: false, target: entry.name, session, transportOk: true, error: `ssh: no shell ${entry.name}/${session} — moshcode ssh shell ${entry.name} --name ${session} starts one` };
  }
  return { ok: false, target: entry.name, session, transportOk: true, code: r.code, error: r.stderr.trim() || r.error || "tmux failed" };
}

/* ---------------------------------------------------------------- bench */

/**
 * The number the feature exists for, measured rather than claimed: N fresh
 * connections against N commands over one master, on this host, now.
 */
export function bench(entry, { n = 20, runner = spawnSync, env = process.env, persist, batch } = {}) {
  const count = Math.max(1, Number.parseInt(n, 10) || 20);
  const timings = (fn) => {
    const samples = [];
    let failures = 0;
    for (let i = 0; i < count; i++) {
      const t = process.hrtime.bigint();
      if (!fn()) failures++;
      samples.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { runs: count, failures, totalMs: Math.round(samples.reduce((a, b) => a + b, 0)), medianMs: round(at(0.5)), p95Ms: round(at(0.95)) };
  };
  const command = remoteCommand(["true"], {});
  const fresh = () => {
    const args = [
      ...(env[CONFIG_ENV] ? ["-F", env[CONFIG_ENV]] : []),
      "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "BatchMode=yes", "-o", `ConnectTimeout=${CONNECT_TIMEOUT}`,
      ...portArgs(entry), "-T", entry.target, "--", command,
    ];
    const res = runner("ssh", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    return res.status === 0;
  };
  const open = openMaster(entry, { runner, env, persist, batch });
  if (!open.ok) return { ok: false, target: entry.name, error: open.error };
  const muxed = () => exec(entry, ["true"], { runner, env, cwd: null, retry: false }).ok;
  const freshStats = timings(fresh);
  const muxedStats = timings(muxed);
  return {
    ok: true, target: entry.name, fresh: freshStats, multiplexed: muxedStats,
    speedup: muxedStats.medianMs > 0 ? round(freshStats.medianMs / muxedStats.medianMs) : null,
    authentications: { fresh: count, multiplexed: open.alreadyOpen ? 0 : 1 },
  };
}

const round = (n) => Math.round(n * 10) / 10;

/* ----------------------------------------------------------------- CLI */

const VERBS = ["list", "ls", "add", "remove", "rm", "show", "open", "check", "close", "exec", "put", "get", "shell", "bench", "help"];

/** Does this argv end up handing the terminal to ssh? The pit closes readline around those. */
export function takesTerminal(argv = []) {
  const verb = String(argv[0] || "");
  if (!verb || VERBS.includes(verb)) {
    if (verb === "exec") return argv.includes("--tty");
    if (verb === "shell") return !["send", "read", "kill", "list", "ls"].includes(String(argv[1] || ""));
    return false;
  }
  return true; // `moshcode ssh <name>` attaches
}

/**
 * Split flags from positionals. `valued` flags take the next word (or
 * `--flag=value`); `repeat` flags collect; everything else is a boolean. `--`
 * ends flag parsing and the rest is the command — which is what makes
 * `moshcode ssh exec dev -- git log --oneline` hand `--oneline` to git.
 */
export function parseArgs(argv, { valued = [], repeat = [] } = {}) {
  const flags = {};
  const positional = [];
  let rest = null;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (rest) { rest.push(a); continue; }
    if (a === "--") { rest = []; continue; }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      const key = (eq > 0 ? a.slice(2, eq) : a.slice(2));
      if (valued.includes(key) || repeat.includes(key)) {
        const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (value === undefined) throw new Error(`ssh: --${key} needs a value`);
        if (repeat.includes(key)) (flags[key] ||= []).push(String(value));
        else flags[key] = String(value);
      } else {
        flags[key] = true;
      }
      continue;
    }
    positional.push(a);
  }
  return { flags, positional, rest };
}

const USAGE = [
  "usage:",
  "  moshcode ssh                                  targets and whether each is connected",
  "  moshcode ssh add <name> <user@host|alias> [--port N] [--cwd PATH] [--persist 10m]",
  "  moshcode ssh remove <name> · show <name>",
  "  moshcode ssh open <name> [--persist 10m] · check <name> · close <name>",
  "  moshcode ssh <name>                           an interactive shell over the shared connection",
  "  moshcode ssh exec <name> [--cwd PATH] [--env K=V] [--stdin] [--tty] [--timeout 2m] [--sh] -- <command…>",
  "  moshcode ssh put <name> <local> <remote> · get <name> <remote> <local>",
  "  moshcode ssh shell <name> --name <session> · shell send|read|kill <name>/<session>",
  "  moshcode ssh bench <name> [--n 20]",
  "  --json on any of the above that does not take the terminal",
];

/**
 * The CLI: `moshcode ssh …` and the pit's `/ssh …`. Returns the exit code.
 * Every verb that can answer in JSON does under --json, and the JSON is the
 * same object the moshscript helpers return.
 */
export async function sshCommand(rawArgv = [], { write = console.log, writeErr = (l) => console.error(l), env = process.env, stdin = process.stdin, runner = spawnSync } = {}) {
  // `--json` is global — `moshcode ssh --json` and `moshcode ssh list --json`
  // are the same question — so it is lifted out before the verb is read.
  // Only up to `--`: after that the words belong to the remote command.
  const json = argv0Has(rawArgv, "--json");
  const argv = stripGlobal(rawArgv, "--json");
  const first = String(argv[0] ?? "");
  const emit = (obj) => { write(JSON.stringify(obj, null, 2)); };

  try {
    if (!first || first === "list" || first === "ls") return listCommand({ json, write, env, runner });
    if (first === "help" || first === "--help" || first === "-h") { USAGE.forEach(write); return 0; }

    if (first === "add") {
      const { flags, positional } = parseArgs(argv.slice(1), { valued: ["port", "cwd", "persist"] });
      const [name, target] = positional;
      if (!name || !target) { writeErr(err("moshcode ssh add <name> <user@host | ssh-config alias> [--port N] [--cwd PATH]")); return 2; }
      const added = addTarget(name, target, flags);
      if (json) emit({ ok: true, ...added });
      else write(ok(`${bone(added.name)} → ${added.target}${added.port ? `:${added.port}` : ""}${added.cwd ? ash(`  ${added.cwd}`) : ""}${added.replaced ? ash("  (replaced)") : ""}`));
      return 0;
    }
    if (first === "remove" || first === "rm") {
      const { positional } = parseArgs(argv.slice(1));
      const name = positional[0];
      if (!name) { writeErr(err("moshcode ssh remove <name>")); return 2; }
      const entry = getTarget(name);
      if (entry) closeMaster(entry, { runner, env });
      const removed = removeTarget(name);
      if (json) emit({ ok: removed, name, removed });
      else write(removed ? ok(`forgot ${bone(name)}`) : warn(`no target named ${name}`));
      return removed ? 0 : 1;
    }
    if (first === "show") {
      const { positional } = parseArgs(argv.slice(1));
      const found = resolveTarget(positional[0]);
      if (found.error) { writeErr(err(found.error)); return 1; }
      const status = checkMaster(found.entry, { runner, env });
      const row = { ...found.entry, connected: status.connected, socket: status.socket, pid: status.pid ?? null };
      if (json) emit({ ok: true, ...row });
      else {
        write(`${bone(row.name)}  ${row.target}${row.port ? `:${row.port}` : ""}`);
        write(ash(`  cwd      ${row.cwd || "(remote default)"}`));
        write(ash(`  persist  ${row.persist || env[PERSIST_ENV] || DEFAULT_PERSIST}`));
        write(ash(`  state    ${row.connected ? "connected" : "closed"}${row.pid ? ` (master pid ${row.pid})` : ""}`));
        write(ash(`  socket   ${row.socket}`));
      }
      return 0;
    }

    if (first === "open" || first === "check" || first === "close") {
      const { flags, positional } = parseArgs(argv.slice(1), { valued: ["persist"] });
      const found = resolveTarget(positional[0]);
      if (found.error) { writeErr(err(found.error)); return 1; }
      const { entry } = found;
      if (first === "open") {
        const r = openMaster(entry, { runner, env, persist: flags.persist, batch: flags.batch ? true : undefined, stdin });
        if (json) emit(r);
        else if (r.ok) write(ok(`${bone(entry.name)} ${r.alreadyOpen ? "already connected" : "connected"}${r.pid ? ash(`  (master pid ${r.pid})`) : ""}`));
        else { writeErr(err(`${entry.name}: ${r.error}`)); if (r.stderr?.trim() && !json) writeErr(ash(r.stderr.trim())); }
        return r.ok ? 0 : 1;
      }
      if (first === "check") {
        const status = checkMaster(entry, { runner, env });
        if (json) emit({ ok: true, target: entry.name, connected: status.connected, stale: status.stale, pid: status.pid ?? null, socket: status.socket });
        else write(status.connected ? ok(`${bone(entry.name)} connected${status.pid ? ash(`  (master pid ${status.pid})`) : ""}`) : info(`${bone(entry.name)} closed${status.stale ? ash("  (a stale socket was cleaned up)") : ""}`));
        return status.connected ? 0 : 1;
      }
      const r = closeMaster(entry, { runner, env });
      if (json) emit(r);
      else if (!r.ok) writeErr(err(`${entry.name}: ${r.error}`));
      else write(r.wasOpen ? ok(`${bone(entry.name)} closed`) : info(`${bone(entry.name)} was not connected`));
      return r.ok ? 0 : 1;
    }

    if (first === "exec") {
      const { flags, positional, rest } = parseArgs(argv.slice(1), { valued: ["cwd", "timeout", "persist"], repeat: ["env"] });
      const found = resolveTarget(positional[0]);
      if (found.error) { writeErr(err(found.error)); return 1; }
      // Without `--`, everything after the name is the command. `--` is still
      // the safe spelling: it is the only way to hand the command a flag this
      // parser would otherwise claim.
      const command = rest ?? positional.slice(1);
      if (!command.length) { writeErr(err("moshcode ssh exec <name> [flags] -- <command> [args…]")); return 2; }
      const input = flags.stdin ? readAllStdin(stdin) : undefined;
      const r = exec(found.entry, command, {
        cwd: flags.cwd, remoteEnv: parseEnvPairs(flags.env || []), stdin: input, tty: Boolean(flags.tty), sh: Boolean(flags.sh),
        timeoutMs: parseTimeout(flags.timeout), persist: flags.persist, batch: flags.batch ? true : undefined, runner, env,
      });
      if (json) { emit(r); return exitCodeFor(r); }
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      if (r.error && !r.transportOk) writeErr(err(`${found.entry.name}: ${r.error}`));
      else if (r.timedOut) writeErr(err(`${found.entry.name}: timed out after ${flags.timeout}`));
      return exitCodeFor(r);
    }

    if (first === "put" || first === "get") {
      const { flags, positional } = parseArgs(argv.slice(1), { valued: ["persist"] });
      const found = resolveTarget(positional[0]);
      if (found.error) { writeErr(err(found.error)); return 1; }
      const [, a, b] = positional;
      if (!a || !b) { writeErr(err(first === "put" ? "moshcode ssh put <name> <local> <remote>" : "moshcode ssh get <name> <remote> <local>")); return 2; }
      const r = first === "put"
        ? put(found.entry, a, b, { runner, env, persist: flags.persist })
        : get(found.entry, a, b, { runner, env, persist: flags.persist });
      if (json) emit(r);
      else if (r.ok) write(ok(first === "put" ? `${a} → ${bone(found.entry.name)}:${r.remote}` : `${bone(found.entry.name)}:${r.remote} → ${r.local}`));
      else writeErr(err(`${found.entry.name}: ${r.error}`));
      return r.ok ? 0 : 1;
    }

    if (first === "shell") return shellCommand(argv.slice(1), { json, write, writeErr, env, runner, emit });

    if (first === "bench") {
      const { flags, positional } = parseArgs(argv.slice(1), { valued: ["n", "persist"] });
      const found = resolveTarget(positional[0]);
      if (found.error) { writeErr(err(found.error)); return 1; }
      const r = bench(found.entry, { n: flags.n, runner, env, persist: flags.persist });
      if (json) emit(r);
      else if (!r.ok) writeErr(err(`${found.entry.name}: ${r.error}`));
      else {
        write(table([
          ["fresh connection", r.fresh.runs, r.fresh.totalMs, r.fresh.medianMs, r.fresh.p95Ms, r.authentications.fresh, r.fresh.failures],
          ["over one master", r.multiplexed.runs, r.multiplexed.totalMs, r.multiplexed.medianMs, r.multiplexed.p95Ms, r.authentications.multiplexed, r.multiplexed.failures],
        ], { columns: ["", "runs", "total ms", "median ms", "p95 ms", "auths", "failed"] }));
        if (r.speedup) write(ash(`  median is ${r.speedup}× faster over the master, on ${found.entry.target} from here`));
      }
      return r.ok ? 0 : 1;
    }

    // Anything else is a target name: attach.
    if (first.startsWith("-")) { writeErr(err(`ssh: unknown flag ${first}`)); USAGE.forEach(writeErr); return 2; }
    const found = resolveTarget(first);
    if (found.error) {
      writeErr(err(found.error));
      if (!VERBS.includes(first)) USAGE.forEach(writeErr);
      return 1;
    }
    const { flags } = parseArgs(argv.slice(1), { valued: ["persist"] });
    const r = attach(found.entry, { runner, env, persist: flags.persist });
    if (r.error) writeErr(err(r.error));
    return r.code;
  } catch (e) {
    if (json) { emit({ ok: false, error: e.message }); return 1; }
    writeErr(err(e.message));
    return 1;
  }
}

/** Is `flag` among the words before `--`? */
function argv0Has(argv, flag) {
  for (const a of argv) {
    if (a === "--") return false;
    if (a === flag) return true;
  }
  return false;
}

/** The argv without `flag`, leaving everything after `--` untouched. */
function stripGlobal(argv, flag) {
  const out = [];
  let passthrough = false;
  for (const a of argv) {
    if (passthrough) { out.push(a); continue; }
    if (a === "--") { passthrough = true; out.push(a); continue; }
    if (a !== flag) out.push(a);
  }
  return out;
}

function exitCodeFor(r) {
  if (r.ok) return 0;
  if (!r.transportOk) return 255;
  if (r.timedOut) return 124;
  if (typeof r.code === "number") return r.code;
  return 1;
}

function readAllStdin(stdin) {
  try { return fs.readFileSync(stdin?.fd ?? 0); } catch { return Buffer.alloc(0); }
}

function listCommand({ json, write, env, runner }) {
  const targets = listTargets();
  const rows = targets.map((entry) => {
    const status = checkMaster(entry, { runner, env });
    return { name: entry.name, target: entry.target, port: entry.port ?? null, cwd: entry.cwd ?? null, connected: status.connected };
  });
  if (json) { write(JSON.stringify({ targets: rows }, null, 2)); return 0; }
  if (!rows.length) {
    write(info("no ssh targets yet — moshcode ssh add <name> user@host [--cwd /srv/app]"));
    return 0;
  }
  write(table(rows.map((r) => [
    bone(r.name), r.target + (r.port ? `:${r.port}` : ""), r.connected ? ok("connected") : ash("closed"), r.cwd || ash("—"),
  ]), { columns: ["name", "target", "state", "cwd"] }));
  return 0;
}

async function shellCommand(argv, { json, write, writeErr, env, runner, emit }) {
  const sub = String(argv[0] || "");
  if (["send", "read", "kill", "list", "ls"].includes(sub)) {
    const { flags, positional } = parseArgs(argv.slice(1), { valued: ["lines"] });
    if (sub === "list" || sub === "ls") {
      const found = resolveTarget(positional[0]);
      if (found.error) { writeErr(err(found.error)); return 1; }
      const r = shellList(found.entry, { runner, env });
      if (json) emit(r);
      else if (!r.ok) writeErr(err(r.error));
      else if (!r.sessions.length) write(info(`no shells on ${found.entry.name} — moshcode ssh shell ${found.entry.name} --name app starts one`));
      else write(table(r.sessions.map((s) => [`${found.entry.name}/${s.session}`, s.attached ? "attached" : "detached"]), { columns: ["shell", "state"] }));
      return r.ok ? 0 : 1;
    }
    const ref = parseSessionRef(positional[0]);
    if (ref.error) { writeErr(err(ref.error)); return 2; }
    const found = resolveTarget(ref.name);
    if (found.error) { writeErr(err(found.error)); return 1; }
    let r;
    if (sub === "send") {
      const text = positional.slice(1).join(" ");
      if (!text) { writeErr(err("moshcode ssh shell send <name>/<session> <text>")); return 2; }
      r = shellSend(found.entry, ref.session, text, { runner, env });
    } else if (sub === "read") {
      r = shellRead(found.entry, ref.session, { lines: flags.lines, runner, env });
    } else {
      r = shellKill(found.entry, ref.session, { runner, env });
    }
    if (json) emit(r);
    else if (!r.ok) writeErr(err(r.error));
    else if (sub === "read") write(r.screen);
    else write(ok(sub === "send" ? `sent to ${bone(`${ref.name}/${ref.session}`)}` : `killed ${bone(`${ref.name}/${ref.session}`)}`));
    return r.ok ? 0 : 1;
  }
  const { flags, positional } = parseArgs(argv, { valued: ["name", "persist"] });
  const found = resolveTarget(positional[0]);
  if (found.error) { writeErr(err(found.error)); return 1; }
  const session = String(flags.name || positional[1] || "main");
  if (!SESSION_RE.test(session)) { writeErr(err(`ssh: ${JSON.stringify(session)} is not a session name`)); return 2; }
  const r = shellAttach(found.entry, session, { runner, env, persist: flags.persist });
  if (!r.ok && r.error) writeErr(err(r.error));
  return r.code;
}
