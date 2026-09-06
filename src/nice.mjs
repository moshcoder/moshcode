// Run the CLIs the pit launches at a lower priority than everything else.
//
// The pit's whole job is starting other people's programs, and some of them are
// not shy: a coding engine holding a big context, a bundler, a browser under
// test. Start a few at once on a box you also want to type on and you get the
// failure everyone knows — the machine stops answering. Nothing crashed. Every
// core is busy, the last of the RAM went to swap, and the swap went to disk.
//
// `nice` is the classic answer to that and it is *half* of one. It reorders CPU
// and nothing else, so it fixes the part of the freeze you can wait out and not
// the part that kills a process. The stall that actually costs you an afternoon
// is memory: once free RAM runs out the kernel starts reclaiming, reclaim goes
// to disk, and no scheduling priority on earth makes that faster. So a throttle
// worth the name has to cover three resources, not one:
//
//   CPU     nice -n 10          the engine yields to whatever you are typing in
//   I/O     ionice -c 2 -n 7    its reads stop starving the rest of the box
//   memory  systemd-run scope   a ceiling, so a runaway dies alone
//
// Only the first two are free. A memory ceiling needs a cgroup, which on a
// normal login means a systemd user session, which not every box has — an ssh
// login without lingering enabled is the common way to not have one. So the
// memory cap is opt-in (`/nice mem 2G`) rather than default: a throttle that
// refuses to launch anything on a box without systemd would be worse than no
// throttle at all. CPU and I/O work everywhere that has the binaries, and
// degrade to "no wrapper" where they don't.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Same 0600 as aliases and history: this file records how you run things. */
const FILE_MODE = 0o600;

/**
 * `nice -n 10` and `ionice -c 2 -n 7` — deliberately not the extremes.
 *
 * nice 19 and ionice class 3 (idle) both mean "run only when nothing else
 * wants the machine", which sounds right and is not: an engine that yields
 * *completely* can take minutes to answer while a single background job holds
 * the box, and a coding CLI that never finishes reads as broken rather than as
 * polite. 10 and 7 are "last in line among normal work", which is the actual
 * intent — you keep your terminal, the engine keeps making progress.
 */
export const DEFAULTS = Object.freeze({ cpu: 10, io: 7, memoryMax: "", memoryHigh: "" });

/** A memory size systemd would accept: 512M, 2G, 1500K, or a byte count. */
const MEM_RE = /^\d+(\.\d+)?[KMGT]?$/i;

/** Where the throttle setting lives. Derived per call so tests can move $HOME. */
export function niceFile() {
  return path.join(os.homedir(), ".moshcode", "nice.json");
}

/**
 * `/nice <line>` throttles one line without changing the saved setting.
 *
 * Module-level rather than threaded through every call because the thing being
 * throttled is not a function argument -- it is whatever that line eventually
 * spawns, which may be an alias that expands to a pit command that starts an
 * engine, three dispatch rounds later. The pit reads one line at a time and
 * fully awaits it, so "armed until the next line the user types" is both the
 * simplest implementation and exactly the intent.
 */
let oneShot = false;

/** Throttle whatever the current line ends up spawning. */
export function armOneShot() { oneShot = true; }

/**
 * Stop throttling. The pit calls this when it reads a fresh line, NOT when a
 * command finishes: one typed line can dispatch several times through alias
 * expansion, and all of it is the line the user asked to be nice.
 */
export function disarmOneShot() { oneShot = false; }

/** Is a one-shot throttle in force? */
export function oneShotArmed() { return oneShot; }

/**
 * The settings a spawn should actually use: what is saved, plus a one-shot.
 *
 * `/nice on` and `/nice <cmd>` end in the same place by design -- a spawn does
 * not need to know which of the two asked for it.
 */
export function effectiveNice() {
  const saved = loadNice();
  return oneShot ? { ...saved, on: true } : saved;
}

/**
 * The current settings, always a complete object.
 *
 * Read on the spawn path for every CLI the pit starts, so a missing,
 * unreadable, or hand-mangled file has to read as "throttle off" rather than
 * throw. A file that says something we don't recognise loses only the field it
 * got wrong: the point of this object is to decide how to launch a program, and
 * one bad key must not stop the program launching.
 */
export function loadNice() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(niceFile(), "utf8")); }
  catch { return { on: false, ...DEFAULTS }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { on: false, ...DEFAULTS };
  const num = (v, fallback) => (Number.isInteger(v) ? v : fallback);
  const mem = (v) => (typeof v === "string" && MEM_RE.test(v.trim()) ? v.trim().toUpperCase() : "");
  return {
    on: parsed.on === true,
    cpu: clampCpu(num(parsed.cpu, DEFAULTS.cpu)),
    io: clampIo(num(parsed.io, DEFAULTS.io)),
    memoryMax: mem(parsed.memoryMax),
    memoryHigh: mem(parsed.memoryHigh),
  };
}

/** nice(1) accepts -20..19; anything else is a typo, not an intention. */
export function clampCpu(n) { return Math.min(19, Math.max(-20, n)); }
/** ionice best-effort levels are 0..7. */
export function clampIo(n) { return Math.min(7, Math.max(0, n)); }

/** Persist settings, creating ~/.moshcode on first use. */
export function saveNice(settings) {
  const file = niceFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = {
    on: settings.on === true,
    cpu: clampCpu(Number.isInteger(settings.cpu) ? settings.cpu : DEFAULTS.cpu),
    io: clampIo(Number.isInteger(settings.io) ? settings.io : DEFAULTS.io),
    memoryMax: settings.memoryMax || "",
    memoryHigh: settings.memoryHigh || "",
  };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: FILE_MODE });
  // `mode` only applies at creation; tighten every write the way aliases does.
  try { fs.chmodSync(file, FILE_MODE); } catch { /* best effort */ }
  return body;
}

/** Is `bin` runnable here? Cached, because this is asked on every spawn. */
const lookupCache = new Map();
export function haveBin(bin, { spawn = spawnSync } = {}) {
  if (lookupCache.has(bin)) return lookupCache.get(bin);
  let found = false;
  try { found = spawn("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0; }
  catch { found = false; }
  lookupCache.set(bin, found);
  return found;
}

/** Only used by tests, which need to ask about a box they are pretending about. */
export function resetBinCache() { lookupCache.clear(); }

/** Is a memory ceiling actually enforceable here? Needs a systemd user cgroup. */
export function canCapMemory({ has = haveBin, env = process.env } = {}) {
  if (!has("systemd-run")) return false;
  // --user needs a session bus to place the scope in. Over ssh without
  // lingering there is none, and systemd-run fails rather than degrading —
  // which would take the engine down with it. Check before, not after.
  return Boolean(env.XDG_RUNTIME_DIR || env.DBUS_SESSION_BUS_ADDRESS);
}

/**
 * Wrap a spawn spec so the child runs throttled. Returns a new spec plus a
 * short `how` describing what was actually applied.
 *
 * Everything here is best-effort by design: each wrapper is added only if its
 * binary exists, and a box with none of them gets the original spec back. The
 * alternative — refusing to launch, or launching a command line referencing a
 * binary that isn't there — turns a comfort feature into an outage.
 *
 * Windows has no nice/ionice/cgroups in this form, so it is a no-op there
 * rather than a wrong guess.
 */
export function throttleSpec(spec, {
  settings = effectiveNice(),
  has = haveBin,
  env = process.env,
  platform = process.platform,
} = {}) {
  const plain = { cmd: spec.cmd, args: spec.args ?? [], throttled: false, how: "" };
  if (!settings.on || platform === "win32") return plain;

  let cmd = spec.cmd;
  let args = [...(spec.args ?? [])];
  const how = [];

  // Innermost first: each wrapper below prepends, so build outward.
  if (has("ionice")) {
    args = ["-c", "2", "-n", String(settings.io), cmd, ...args];
    cmd = "ionice";
    how.push(`ionice -c2 -n${settings.io}`);
  }
  if (has("nice")) {
    args = ["-n", String(settings.cpu), cmd, ...args];
    cmd = "nice";
    how.push(`nice -n${settings.cpu}`);
  }
  // Outermost, so the scope contains the whole niced pipeline rather than
  // sitting inside it — a cgroup only accounts for what it encloses.
  const caps = [];
  if (settings.memoryHigh) caps.push(`MemoryHigh=${settings.memoryHigh}`);
  if (settings.memoryMax) caps.push(`MemoryMax=${settings.memoryMax}`);
  if (caps.length && canCapMemory({ has, env })) {
    const props = caps.flatMap((p) => ["-p", p]);
    args = ["--user", "--scope", "--quiet", ...props, "--", cmd, ...args];
    cmd = "systemd-run";
    how.push(caps.join(" "));
  }

  if (cmd === spec.cmd) return plain;
  return { cmd, args, throttled: true, how: how.join(" ") };
}

/** One line for `/nice` with no arguments. */
export function describeNice(settings = loadNice(), opts = {}) {
  if (!settings.on) return "throttle is off — CLIs run at normal priority";
  const parts = [`nice -n${settings.cpu}`, `ionice -c2 -n${settings.io}`];
  if (settings.memoryMax || settings.memoryHigh) {
    const caps = [
      settings.memoryHigh ? `MemoryHigh=${settings.memoryHigh}` : "",
      settings.memoryMax ? `MemoryMax=${settings.memoryMax}` : "",
    ].filter(Boolean).join(" ");
    parts.push(canCapMemory(opts) ? caps : `${caps} (no systemd user session here — not applied)`);
  }
  return `throttle is on — ${parts.join(", ")}`;
}

/** Validate a memory size the way the command wants to report it. */
export function parseMemory(value) {
  const clean = String(value ?? "").trim().toUpperCase();
  if (!clean || clean === "OFF" || clean === "NONE") return { ok: true, value: "" };
  if (!MEM_RE.test(clean)) {
    return { ok: false, error: `"${value}" isn't a memory size — try 2G, 1500M, or off` };
  }
  return { ok: true, value: clean };
}
