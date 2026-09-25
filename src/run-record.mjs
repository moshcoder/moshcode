// The run record and the heartbeat (PRD 0019 R2, R3).
//
// Two facts about a run moshcode started, kept in the files PRD 0016 already
// chose. The heartbeat is the liveness one: a run that beat recently is alive,
// and if the beat carried a state then that state is a report rather than a
// guess. The record is the history one: what ran, with which inputs, on which
// engine and model, every step, and what came out.
//
// WHY THIS IS NOT SQLITE. The open question PRD 0019 left for the first task
// was SQLite versus the JSON and append-only files OpenFleet already writes.
// Files won. PRD 0016 chose "no daemon, no database, one host" on purpose, and
// every other reader of these files (logicsrc fleet, a shell script, a person
// with `cat`) keeps working only while they stay plain. A run record is also
// append-only by nature, which is the one shape a JSONL ledger is already good
// at, and the searches R4 will want are over hundreds of runs on one box, not
// millions. A database would buy an index nobody is waiting on and cost the
// property the record exists to have: readable without moshcode installed.
// The full reasoning is written into the PRD's open questions as a resolution.
//
// WHY THE LEDGER AND NOT A SECOND STORE. R3 is explicit: extend the ledger.
// So a run's steps are `run.start`, `run.step` and `run.end` lines in the same
// per-fleet `ledger.jsonl` that carries `member.start` and `swarm.end`, and
// `moshcode fleet log` shows them without being taught anything new. The only
// file of its own a run gets is its immutable header under `runs/`, written
// with `wx` exactly the way a member's record is, because the header is the
// thing that must never change once the run has begun.
//
// WHY THE BEAT IS NOT IN THE LEDGER. A heartbeat is the one fact here that is
// worthless the moment it is superseded. Appending every beat would grow the
// ledger without bound to hold a value only its last line ever answers, so a
// beat is a small mutable file under `beats/` that is rewritten in place and
// deleted when the run ends. The ledger stays the history; the beat file is
// the present tense.
//
// RETENTION SHIPS WITH THIS, not after it. An immutable record grows forever,
// which PRD 0019 names as a risk to answer before the feature lands. `gcRuns`
// is omp's shape: keep the newest N per working directory, drop anything past
// a maximum age, and never touch a run that has not ended.
import fs from "node:fs";
import path from "node:path";

import {
  append, claimOnce, fleetDir, home, host, iso, listFleets, markPath, readRecord,
} from "./openfleet.mjs";
import { slugifyName } from "./herd.mjs";

/**
 * The record's own version, separate from OPENFLEET_VERSION.
 *
 * R3 asks for a versioned record and it is not the same axis as the spec's.
 * The OpenFleet version says which ledger dialect a reader is looking at; this
 * says which run-record shape it is, so a reader that meets a header from a
 * later moshcode can tell "newer than me" from "corrupt" without guessing.
 */
export const RUN_RECORD_VERSION = 1;

/**
 * How long a beat stays worth believing, and the ceiling on any beat's own ttl.
 *
 * Beats arrive on the engine's lifecycle events rather than on a timer, and a
 * long tool call is minutes of silence from an engine that is perfectly fine.
 * Ten minutes is longer than that and shorter than a session anyone has
 * forgotten about. A beat past its ttl is not a lie, it is an absence: the run
 * falls back to inference and the roster says so.
 */
export const BEAT_TTL_MS = 10 * 60 * 1000;

/** How a run may end. The member end states, plus nothing new. */
export const RUN_END_STATES = ["done", "failed", "stopped", "budget", "timeout", "lost"];

/* ------------------------------------------------------------- where it lives */

export function runsDir(fleet, env = process.env) {
  return path.join(fleetDir(fleet, env), "runs");
}

export function runPath(fleet, run, env = process.env) {
  return path.join(runsDir(fleet, env), `${run}.json`);
}

export function beatsDir(fleet, env = process.env) {
  return path.join(fleetDir(fleet, env), "beats");
}

export function beatPath(fleet, run, env = process.env) {
  return path.join(beatsDir(fleet, env), `${run}.json`);
}

/**
 * 0700 on the way in, like every other directory under the fleet. A record
 * names a working directory and a beat names a pid, and neither is anyone
 * else's business on a shared box.
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* someone else's directory, fine */ }
}

/**
 * `<slug, at most 23 chars>-<HHMMSS UTC>-<4 hex>`, in the shape of swarmId.
 *
 * Seconds and a random tail where a swarm id stops at minutes, because a run
 * id is claimed with `wx` and two runs of the same task in the same minute is
 * an ordinary thing rather than a mistake worth failing on.
 */
export function runId(label, { now = Date.now(), rand = Math.random } = {}) {
  const slug = slugifyName(label || "run").slice(0, 23).replace(/-+$/, "") || "run";
  const d = new Date(now);
  const p2 = (n) => String(n).padStart(2, "0");
  const hhmmss = `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
  const tail = Math.floor(rand() * 0x10000).toString(16).padStart(4, "0");
  return `${slug}-${hhmmss}-${tail}`;
}

/* -------------------------------------------------------------- the record */

/**
 * Open a run: the immutable header, then `run.start` on the fleet's ledger.
 *
 * `wx` on the header is what makes the record immutable rather than merely
 * documented as such. A second open of the same id fails, and the caller hears
 * about it instead of silently replacing the first run's inputs.
 *
 * `inputs` is whatever the caller wants recoverable later: the prompt, the
 * argv, the files a piece owns. It is copied verbatim and never inspected,
 * with one rule the caller owns too: no credentials. Nothing under
 * $OPENFLEET_HOME has ever held one and this does not start.
 */
export function openRun(run = {}, { env = process.env, now = Date.now() } = {}) {
  const id = run.run;
  const fleet = run.fleet;
  if (!id || !fleet) return { ok: false, error: new Error("a run needs a run id and a fleet") };

  const header = {
    openfleet: run.openfleet || "0.1",
    record_version: RUN_RECORD_VERSION,
    run: id,
    fleet,
    ...(run.member ? { member: run.member } : {}),
    ...(run.swarm ? { swarm: run.swarm } : {}),
    ...(run.session ? { session: run.session } : {}),
    engine: run.engine || "unknown",
    ...(run.model ? { model: run.model } : {}),
    ...(run.task ? { task: run.task } : {}),
    inputs: run.inputs && typeof run.inputs === "object" ? run.inputs : {},
    cwd: run.cwd || process.cwd(),
    host: run.host || host(),
    by: run.by || "sysop",
    started: run.started || iso(now),
  };

  const file = runPath(fleet, id, env);
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, `${JSON.stringify(header, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch (error) {
    return { ok: false, path: file, error };
  }

  // The marker is taken here rather than through markerFor() in openfleet.mjs
  // on purpose. claimOnce is exported and does the whole job, and leaving that
  // module untouched keeps this change cheap to rebase against the other work
  // landing in it. The marker names are the same shape the spec's do.
  appendRunLine(fleet, { event: "run.start", by: header.by, run: id, member: header.member, swarm: header.swarm,
    session: header.session, engine: header.engine, model: header.model, task: header.task,
    cwd: header.cwd, inputs: header.inputs }, { env, now, marker: `run.start.${id}` });

  return { ok: true, run: id, fleet, path: file, record: header };
}

/** A run's immutable header, or null when there is none. */
export function readRun(fleet, run, env = process.env) {
  return readRecord(runPath(fleet, run, env));
}

/** Every run header under a fleet, in file order. */
export function listRuns(fleet, env = process.env) {
  let names;
  try { names = fs.readdirSync(runsDir(fleet, env)).filter((n) => n.endsWith(".json")).sort(); }
  catch { return []; }
  return names.map((n) => readRecord(path.join(runsDir(fleet, env), n))).filter(Boolean);
}

/**
 * Append one run line to the fleet's ledger, taking a once-marker when the
 * event has one. `run.step` has none: steps are many and each is its own fact.
 */
function appendRunLine(fleet, line, { env, now, marker = null }) {
  if (marker && !claimOnce(fleet, marker, env)) return { line: null, already: true };
  const written = append(fleet, line, { env, now, once: false });
  return { line: written, already: false };
}

/**
 * Record one step of a run.
 *
 * A step is deliberately loose: `kind` says what sort of thing happened and
 * the rest is the caller's. Pinning a schema here would mean every new kind of
 * step waits for a release, and the value of the record is that it holds what
 * happened rather than what we predicted would.
 */
export function recordStep(fleet, run, step = {}, { env = process.env, now = Date.now(), by = null } = {}) {
  if (!fleet || !run) return null;
  const { kind, ...rest } = step;
  return appendRunLine(fleet, {
    event: "run.step", by: by || "sysop", run, kind: kind || "step", ...rest,
  }, { env, now }).line;
}

/**
 * Close a run: `run.end` once, and the beat file goes.
 *
 * The beat is deleted rather than left to expire because an ended run that is
 * still beating would read as known-and-alive for the rest of its ttl, which
 * is the exact class of confident lie this whole requirement exists to stop.
 */
export function closeRun(fleet, run, end = {}, { env = process.env, now = Date.now(), by = null } = {}) {
  if (!fleet || !run) return { line: null, already: false };
  const state = RUN_END_STATES.includes(end.state) ? end.state : "failed";
  const written = appendRunLine(fleet, {
    event: "run.end", by: by || "sysop", run, state,
    ...(end.summary ? { summary: end.summary } : {}),
    ...(end.outputs !== undefined ? { outputs: end.outputs } : {}),
  }, { env, now, marker: `run.end.${run}` });
  clearBeat(fleet, run, env);
  return written;
}

/** Every ledger line belonging to one run, in order. */
export function runLines(lines, run) {
  return (lines || []).filter((l) => l.run === run && String(l.event || "").startsWith("run."));
}

/**
 * A run rebuilt from its header and the ledger: inputs, steps, outputs.
 *
 * This is the R3 promise made good. Nothing here re-reads a vendor transcript,
 * so a run stays reconstructable after the engine that produced it has changed
 * its output format twice.
 */
export function replayRun(fleet, run, lines, env = process.env) {
  const header = readRun(fleet, run, env);
  const own = runLines(lines, run);
  const end = own.find((l) => l.event === "run.end") || null;
  return {
    run,
    fleet,
    record: header,
    steps: own.filter((l) => l.event === "run.step"),
    ended: end ? end.state : null,
    summary: end?.summary || null,
    outputs: end?.outputs ?? null,
  };
}

/* ----------------------------------------------------------- the heartbeat */

/**
 * Record that a run is alive, and optionally what it is doing.
 *
 * Written whole every time rather than appended, because only the last beat
 * has ever answered a question. `state` is passed through without being
 * checked against the herd's vocabulary: this module must not import
 * herd-state.mjs, which imports this one, and the reader validates anyway.
 */
export function beat(fleet, run, info = {}, { env = process.env, now = Date.now() } = {}) {
  if (!fleet || !run) return { ok: false, error: new Error("a beat needs a run id and a fleet") };
  const ttl = Math.min(Number(info.ttl) || BEAT_TTL_MS, BEAT_TTL_MS);
  const record = {
    run,
    fleet,
    at: now,
    ttl,
    ...(info.session ? { session: info.session } : {}),
    ...(info.member ? { member: info.member } : {}),
    ...(info.state ? { state: String(info.state) } : {}),
    ...(info.kind ? { kind: String(info.kind) } : {}),
    ...(info.pid ? { pid: Number(info.pid) } : {}),
  };
  const file = beatPath(fleet, run, env);
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return { ok: true, path: file, beat: record };
  } catch (error) {
    return { ok: false, path: file, error };
  }
}

/** The live beat for a run, or null when there is none or it has expired. */
export function readBeat(fleet, run, { env = process.env, now = Date.now() } = {}) {
  return liveBeat(readRecord(beatPath(fleet, run, env)), now);
}

function liveBeat(raw, now) {
  if (!raw || !raw.run) return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at)) return null;
  const ttl = Math.min(Number(raw.ttl) || BEAT_TTL_MS, BEAT_TTL_MS);
  if (now - at > ttl) return null;
  return raw;
}

export function clearBeat(fleet, run, env = process.env) {
  try { fs.rmSync(beatPath(fleet, run, env), { force: true }); return true; }
  catch { return false; }
}

/**
 * Every live beat on this box, keyed by the session name it names.
 *
 * Keyed by session rather than by run because the herd's roster is a list of
 * sessions and nothing on a row carries a run id. Computed once per roster
 * render and handed down, so the cost is one readdir per fleet rather than one
 * per row. Never throws: a fleet home that is missing, unreadable or half
 * written must leave the roster working exactly as it did before heartbeats.
 */
export function liveBeats({ env = process.env, now = Date.now() } = {}) {
  const found = new Map();
  let fleets;
  try { fleets = listFleets(env); }
  catch { return found; }
  for (const fleet of fleets) {
    let names;
    try { names = fs.readdirSync(beatsDir(fleet, env)).filter((n) => n.endsWith(".json")); }
    catch { continue; }
    for (const name of names) {
      const raw = liveBeat(readRecord(path.join(beatsDir(fleet, env), name)), now);
      if (!raw?.session) continue;
      // Newest wins. Two fleets can hold a beat for the same session name only
      // when a name has been reused, and the recent one is the live session.
      const seen = found.get(raw.session);
      if (!seen || Number(raw.at) > Number(seen.at)) found.set(raw.session, raw);
    }
  }
  return found;
}

/* ------------------------------------------------------------- the retention */

/** Keep this many ended runs per working directory before the age rule applies. */
export const GC_KEEP_PER_DIR = 20;

/** And drop any ended run older than this, however few there are. */
export const GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Prune ended runs, newest-first per working directory (PRD 0019's retention).
 *
 * omp's `gc` is the shape: retention is per directory rather than global,
 * because "the last twenty runs in this repo" is what somebody actually wants
 * kept and a global count would let one busy checkout evict every other one.
 *
 * THREE RULES it will not break:
 *
 *   AN OPEN RUN IS NEVER TOUCHED. No `run.end` means the run may still be
 *   going, and a record deleted out from under a live run is a worse outcome
 *   than a directory that grew.
 *
 *   ONLY THIS HOST'S LEDGER IS REWRITTEN. `ledger.<host>.jsonl` was copied in
 *   from another box which is running its own retention; editing it here would
 *   delete somebody else's history.
 *
 *   ONLY `run.*` LINES GO. member.start, swarm.end and ceiling.refuse are the
 *   spec's record of what agents were allowed to do, and no retention policy of
 *   ours gets to decide those have expired.
 */
export function gcRuns({
  env = process.env,
  now = Date.now(),
  keep = GC_KEEP_PER_DIR,
  maxAgeMs = GC_MAX_AGE_MS,
  fleet = null,
  dryRun = false,
} = {}) {
  const fleets = fleet ? [fleet] : listFleets(env);
  const report = { home: home(env), dryRun, removed: [], kept: 0, lines: 0, fleets: [] };

  for (const name of fleets) {
    const runs = listRuns(name, env);
    if (!runs.length) continue;
    const ends = endsByRun(name, env);

    // Only ended runs are candidates, newest end first inside each cwd.
    const byDir = new Map();
    for (const record of runs) {
      const ended = ends.get(record.run);
      if (!ended) { report.kept++; continue; }
      const dir = record.cwd || "";
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push({ record, endedAt: ended });
    }

    const doomed = [];
    for (const [dir, entries] of byDir) {
      entries.sort((a, b) => b.endedAt - a.endedAt);
      entries.forEach((entry, i) => {
        const tooMany = i >= Math.max(0, keep);
        const tooOld = now - entry.endedAt > maxAgeMs;
        if (tooMany || tooOld) doomed.push({ ...entry, dir, why: tooMany ? "count" : "age" });
        else report.kept++;
      });
    }
    if (!doomed.length) continue;

    const ids = new Set(doomed.map((d) => d.record.run));
    const dropped = dryRun ? countRunLines(name, ids, env) : pruneLedger(name, ids, env);
    report.lines += dropped;
    for (const d of doomed) {
      report.removed.push({ fleet: name, run: d.record.run, cwd: d.dir, why: d.why, ended: iso(d.endedAt) });
      if (dryRun) continue;
      try { fs.rmSync(runPath(name, d.record.run, env), { force: true }); } catch { /* already gone */ }
      clearBeat(name, d.record.run, env);
      for (const marker of [`run.start.${d.record.run}`, `run.end.${d.record.run}`]) {
        try { fs.rmSync(markPath(name, marker, env), { force: true }); } catch { /* already gone */ }
      }
    }
    report.fleets.push(name);
  }
  return report;
}

/** When each run ended, from this fleet's ledgers. Runs with no end are absent. */
function endsByRun(fleet, env) {
  const ends = new Map();
  for (const line of readOwnLedger(fleet, env)) {
    if (line.event !== "run.end" || !line.run) continue;
    const at = Date.parse(line.at || "");
    ends.set(line.run, Number.isFinite(at) ? at : 0);
  }
  return ends;
}

/** This host's ledger only, parsed. The merged read belongs to openfleet.mjs. */
function readOwnLedger(fleet, env) {
  const file = path.join(fleetDir(fleet, env), "ledger.jsonl");
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return []; }
  const out = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.event) out.push(parsed);
    } catch { /* a torn line is skipped, never fatal */ }
  }
  return out;
}

function isPruned(line, ids) {
  return String(line.event || "").startsWith("run.") && ids.has(line.run);
}

function countRunLines(fleet, ids, env) {
  return readOwnLedger(fleet, env).filter((l) => isPruned(l, ids)).length;
}

/**
 * Rewrite this host's ledger without the pruned runs' lines.
 *
 * Write-then-rename, so a crash halfway through leaves the old ledger intact.
 * A ledger that is being appended to while this runs can lose the lines
 * written in the gap, which is why gc is a verb somebody types rather than
 * something that happens on its own.
 */
function pruneLedger(fleet, ids, env) {
  const file = path.join(fleetDir(fleet, env), "ledger.jsonl");
  const lines = readOwnLedger(fleet, env);
  const keep = lines.filter((l) => !isPruned(l, ids));
  const dropped = lines.length - keep.length;
  if (!dropped) return 0;
  const tmp = `${file}.gc-${process.pid}`;
  try {
    fs.writeFileSync(tmp, keep.map((l) => `${JSON.stringify(l)}\n`).join(""), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    return 0;
  }
  return dropped;
}
