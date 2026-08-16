// The task ledger — what happened, not just what is happening (PRD 0011 R5–R7).
//
// `moshcode ps` answers "now". It is the whole reason the roster exists and it
// is genuinely all most people need at 11pm. It is also everything the herd
// remembered: `herd prompt api "…" --wait` returned, and then the evidence
// evaporated. Which prompts were submitted, when each one blocked, what came
// back, how long the human took to answer — none of it was anywhere, which made
// the herd's party trick (fan four engines out overnight) unauditable by
// construction.
//
// So every prompt mints a TASK: an id, the text that was submitted, its state
// transitions with timestamps, and the output it produced. The watch loop
// already observed every one of those transitions and threw each away after
// deciding whether to buzz a phone; this is the write inserted at that same
// decision, not a second poller.
//
// WHAT THIS IS NOT. It is not a trace of the engine. We do not own those
// runtimes, and pretending to see inside one would be paint-reading with extra
// steps. What the herd can attest to honestly is: this text went in at this
// time, the session moved through these states, and this is what was on the
// screen that had not been there before. That is what is recorded.
//
// JSONL, one file per session, 0600. The manifest's reason for 0600 applies one
// step harder here: the manifest records the argv an engine was launched with,
// and this records what the engine *said*, which regularly contains secrets the
// user never typed.
import fs from "node:fs";
import path from "node:path";

import { herdDir } from "./herd.mjs";

/** Terminal states for a task: the engine stopped needing the CPU. */
export const TERMINAL_STATES = ["blocked", "done", "idle"];

/**
 * Retention. An append-only file with no cap is a disk-eater with a delay on
 * it, and the delay is however long the operator finds this feature useful.
 */
export const MAX_TASKS_PER_SESSION = 500;
export const MAX_LEDGER_BYTES = 2 * 1024 * 1024;

/**
 * How much of an artifact goes inline.
 *
 * The tail, not the head: an agent's answer is the last thing it printed, and
 * the first 8KB of a long run is the part you already watched. Truncation is
 * recorded rather than hidden, because an artifact that silently lost its
 * middle is worse than one that says it did.
 */
export const MAX_ARTIFACT_CHARS = 8000;

const tasksDir = () => path.join(herdDir(), "tasks");
const ledgerFile = (session) => path.join(tasksDir(), `${session}.jsonl`);
const seqFile = () => path.join(tasksDir(), "seq");

function ensureDir() {
  fs.mkdirSync(tasksDir(), { recursive: true, mode: 0o700 });
}

/**
 * The next task id, herd-wide.
 *
 * Herd-wide rather than per-session so that `herd task t-07` means one task and
 * not one per member — the id is a handle people paste, and an ambiguous handle
 * is not one. The counter is a file with a lock beside it; if the lock cannot
 * be taken (a genuinely concurrent fan-out, or a stale lock), the id gets a
 * random suffix instead of blocking. A collision is a cosmetic problem and a
 * hang is not.
 */
export function mintTaskId({ now = Date.now() } = {}) {
  ensureDir();
  const lock = `${seqFile()}.lock`;
  let held = false;
  for (let attempt = 0; attempt < 50 && !held; attempt++) {
    try { fs.closeSync(fs.openSync(lock, "wx")); held = true; }
    catch {
      // A lock older than a few seconds belonged to a process that died.
      try {
        if (now - fs.statSync(lock).mtimeMs > 5000) fs.rmSync(lock, { force: true });
      } catch { /* it went away on its own */ }
    }
  }
  try {
    let next = 1;
    try { next = Math.max(1, Number(JSON.parse(fs.readFileSync(seqFile(), "utf8")).next) || 1); }
    catch { /* first task on this box */ }
    const id = held ? `t-${String(next).padStart(2, "0")}` : `t-${String(next).padStart(2, "0")}-${Math.random().toString(36).slice(2, 6)}`;
    if (held) {
      try { fs.writeFileSync(seqFile(), JSON.stringify({ next: next + 1 }), { mode: 0o600 }); }
      catch { /* the id is still ours; the next one may repeat it */ }
    }
    return id;
  } finally {
    if (held) { try { fs.rmSync(lock, { force: true }); } catch { /* best effort */ } }
  }
}

/** Append one event. Never throws — a lost ledger line must not fail a prompt. */
function append(session, event) {
  try {
    ensureDir();
    const file = ledgerFile(session);
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    compact(session);
    return true;
  } catch { return false; }
}

function readLines(session) {
  let text;
  try { text = fs.readFileSync(ledgerFile(session), "utf8"); }
  catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    // One unparseable line loses that line, not the ledger. A truncated last
    // write is the ordinary way this happens and it must not hide the history
    // above it.
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

/** Trim to the retention cap, keeping the newest tasks whole. */
export function compact(session, { maxTasks = MAX_TASKS_PER_SESSION, maxBytes = MAX_LEDGER_BYTES } = {}) {
  const file = ledgerFile(session);
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return false; }
  // This runs on every append, so the common case has to cost one stat. A task
  // cannot be smaller than its own submit line, so a ledger under the byte cap
  // and under `maxTasks` submit-lines' worth of bytes cannot be over either.
  if (size <= maxBytes && size < maxTasks * 120) return false;
  const lines = readLines(session);
  const ids = [];
  for (const line of lines) if (line.id && !ids.includes(line.id)) ids.push(line.id);
  const overTasks = ids.length > maxTasks;
  if (!overTasks && size <= maxBytes) return false;

  // Keep whole tasks, newest first, until the budget is spent. A ledger cut
  // mid-task would show a submission with no outcome, which reads as an agent
  // that never answered rather than as a file that was trimmed.
  const keep = new Set(ids.slice(-maxTasks));
  let kept = lines.filter((line) => !line.id || keep.has(line.id));
  while (kept.length && Buffer.byteLength(kept.map((l) => JSON.stringify(l)).join("\n")) > maxBytes) {
    const oldest = kept.find((l) => l.id)?.id;
    if (!oldest) break;
    keep.delete(oldest);
    kept = kept.filter((line) => !line.id || keep.has(line.id));
  }
  try {
    fs.writeFileSync(file, kept.length ? `${kept.map((l) => JSON.stringify(l)).join("\n")}\n` : "", { mode: 0o600 });
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * A prompt was submitted. Returns the task id, which the caller carries so
 * later transitions can be attributed to it.
 *
 * `screen` is the session's screen at submission time, kept as the baseline the
 * artifact is a delta against. Storing the whole thing would double every
 * ledger for the sake of text the operator has already seen.
 */
export function startTask(session, text, { screen = "", now = Date.now(), state = null, id = mintTaskId({ now }) } = {}) {
  append(session, { e: "submit", id, ts: now, text: String(text), state, baseline: baselineOf(screen) });
  return id;
}

/**
 * A state change worth remembering, attributed to a task when one is open.
 *
 * A *change*: repeating the state already at the end of the ledger is dropped.
 * Several things poll the same session at once — a `--wait` prompt runs two
 * waits back to back, and the watcher is looking at all of them anyway — and
 * each keeps its own idea of what it last saw. Without this, one prompt writes
 * `idle` three times and `herd task` prints a transition list where two of the
 * three rows lasted zero seconds.
 */
export function recordTransition(session, state, { id = null, ts = Date.now(), kind = null } = {}) {
  const previous = lastRecordedState(session);
  if (previous && previous.state === state && previous.id === id) return false;
  const event = { e: "state", id, ts, state };
  if (kind) event.kind = kind;
  append(session, event);
  return true;
}

/** The state at the end of the ledger, whatever wrote it. */
function lastRecordedState(session) {
  const lines = readLines(session);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].e === "state" || lines[i].e === "end") return { state: lines[i].state, id: lines[i].id ?? null };
  }
  return null;
}

/** The task is over. `artifact` is what the session produced while it ran. */
export function endTask(session, id, { state = "done", artifact = "", ts = Date.now() } = {}) {
  const text = String(artifact ?? "");
  const truncated = text.length > MAX_ARTIFACT_CHARS;
  append(session, {
    e: "end", id, ts, state,
    artifact: truncated ? text.slice(-MAX_ARTIFACT_CHARS) : text,
    ...(truncated ? { truncated: true, artifactChars: text.length } : {}),
  });
  return true;
}

/**
 * The last few lines of a screen, which is all a delta needs to anchor on.
 *
 * A whole capture as the baseline would make the ledger as big as the
 * transcript. The bottom of the screen is where the new output starts, so that
 * is what has to be remembered to find it again.
 */
function baselineOf(screen) {
  const lines = String(screen ?? "").replace(/\s+$/, "").split("\n");
  return lines.slice(Math.max(0, lines.length - 8)).join("\n");
}

/**
 * What appeared on screen after the baseline — the task's output.
 *
 * The engine redraws its whole screen constantly, so "everything after the last
 * line I saw" is the only definition of new output available to something
 * reading a terminal from outside. When the baseline cannot be found (a
 * full-screen repaint scrolled it away, or the session cleared), the honest
 * answer is the whole current screen rather than an empty artifact.
 */
export function screenDelta(baseline, screen) {
  const after = String(screen ?? "").replace(/\s+$/, "");
  const anchor = String(baseline ?? "").replace(/\s+$/, "");
  if (!anchor) return after;
  // The FIRST occurrence, not the last. A short baseline — a bare shell prompt,
  // an engine that had just been cleared — can appear again inside the output
  // it produced, and anchoring on the last match then returns everything after
  // the final prompt glyph, which is nothing. Both failures are possible; only
  // one of them is safe. A few extra lines of context is an artifact somebody
  // can still read, and an empty one is a lie about an agent that answered.
  const at = after.indexOf(anchor);
  if (at < 0) return after;
  // The baseline usually ends mid-line, on the prompt glyph the engine was
  // sitting at (`… $`), so the delta opens with the space between that glyph
  // and what got typed. Leading blank lines and that one space are prompt
  // residue, not output.
  return after.slice(at + anchor.length).replace(/^\n+/, "").replace(/^[ \t]+/, "");
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Every task in one session's ledger, oldest first.
 *
 * A task with no `end` event is `open`: either it is still running, or nothing
 * has looked at that session since it finished. Both are true statements and
 * the caller can tell them apart by asking the roster; inventing an outcome
 * here would put a guess in the one place that exists to hold evidence.
 */
export function readTasks(session) {
  const byId = new Map();
  const order = [];
  for (const line of readLines(session)) {
    if (!line.id) continue;
    if (!byId.has(line.id)) {
      byId.set(line.id, {
        id: line.id, session, text: "", submitted: null, baseline: "",
        transitions: [], state: null, artifact: null, truncated: false, status: "open", endedAt: null,
      });
      order.push(line.id);
    }
    const task = byId.get(line.id);
    if (line.e === "submit") {
      task.text = String(line.text ?? "");
      task.submitted = line.ts ?? null;
      task.baseline = String(line.baseline ?? "");
      if (line.state) task.state = line.state;
    } else if (line.e === "state") {
      task.transitions.push({ ts: line.ts ?? null, state: line.state, ...(line.kind ? { kind: line.kind } : {}) });
      task.state = line.state;
    } else if (line.e === "end") {
      task.status = "closed";
      task.endedAt = line.ts ?? null;
      task.state = line.state || task.state;
      task.artifact = String(line.artifact ?? "");
      task.truncated = Boolean(line.truncated);
      task.artifactChars = line.artifactChars ?? task.artifact.length;
    }
  }
  return order.map((id) => {
    const task = byId.get(id);
    return { ...task, durationMs: task.submitted && task.endedAt ? task.endedAt - task.submitted : null };
  });
}

/** Every session that has a ledger. */
export function ledgerSessions() {
  try {
    return fs.readdirSync(tasksDir())
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length))
      .sort();
  } catch { return []; }
}

/** One task by id, wherever it lives. Ids are herd-wide, so this can search. */
export function findTask(id, { sessions = ledgerSessions() } = {}) {
  for (const session of sessions) {
    const found = readTasks(session).find((t) => t.id === id);
    if (found) return found;
  }
  return null;
}

/** The open task for a session, if it has one. */
export function openTask(session) {
  const tasks = readTasks(session);
  for (let i = tasks.length - 1; i >= 0; i--) if (tasks[i].status === "open") return tasks[i];
  return null;
}

/** The raw state history for `herd log` — transitions, task-bound or not. */
export function readLog(session) {
  return readLines(session)
    .filter((line) => line.e === "state" || line.e === "submit" || line.e === "end")
    .map((line) => ({
      ts: line.ts ?? null,
      id: line.id ?? null,
      state: line.e === "submit" ? (line.state || "submitted") : line.state,
      event: line.e,
      ...(line.kind ? { kind: line.kind } : {}),
      ...(line.e === "submit" ? { text: String(line.text ?? "") } : {}),
    }));
}

/**
 * Time in state, per session.
 *
 * The interesting number is `blocked`, which is the herd's name for *human
 * latency*: the agent was ready and the operator was asleep. It is the one
 * figure here that is entirely within the operator's power to change, which is
 * why the roster prints it with "blocked = you" next to it.
 */
export function stats(session, { now = Date.now() } = {}) {
  const log = readLog(session).filter((entry) => entry.state && Number.isFinite(entry.ts));
  const totals = {};
  let tasks = 0, blockedSpells = 0;
  for (const entry of log) if (entry.event === "submit") tasks++;
  for (let i = 0; i < log.length; i++) {
    const state = log[i].state === "submitted" ? null : log[i].state;
    if (!state) continue;
    const until = log[i + 1]?.ts ?? now;
    const span = Math.max(0, until - log[i].ts);
    totals[state] = (totals[state] || 0) + span;
    if (state === "blocked") blockedSpells++;
  }
  return {
    session,
    tasks,
    blockedSpells,
    totals,
    from: log.length ? log[0].ts : null,
    to: log.length ? now : null,
  };
}

/** Drop a session's ledger — used by `kill`/`prune`, never on its own. */
export function forgetTasks(session) {
  try { fs.rmSync(ledgerFile(session), { force: true }); return true; }
  catch { return false; }
}
