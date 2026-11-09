// Task states for the c0mpute agent, shaped after Claude Code's agents view:
// every turn and every background job is a task that is Working, Needs input,
// Completed, Failed or Stopped.
//
// The board is in memory for the session that owns the tasks and mirrored to
// ~/.moshcode/c0mpute-tasks.json, so `moshcode agents c0mpute tasks` and other
// sessions see them too. A task left Working by a process that is gone reads
// as Stopped, never as Working forever.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acid, amber, ash, bone, danger, dim } from "./ui.mjs";

export const STATES = ["needs_input", "working", "completed", "failed", "stopped"];
export const STATE_LABEL = {
  needs_input: "Needs input",
  working: "Working",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};
const LIVE = new Set(["working", "needs_input"]);
const KEEP = 50;

export const tasksFile = (home = os.homedir()) => path.join(home, ".moshcode", "c0mpute-tasks.json");

function pidAlive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Read the saved board. Live tasks whose process has died come back as Stopped. */
export function readTasks({ file = tasksFile(), alive = pidAlive } = {}) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter((t) => t && t.id && STATES.includes(t.state)).map((t) => (
    LIVE.has(t.state) && !alive(t.pid) ? { ...t, state: "stopped", activity: "session ended", endedAt: t.endedAt ?? t.updatedAt } : t
  ));
}

/** What gets saved: no resolvers, no abort controllers, no unbounded logs. */
function serializable(t) {
  const { pending, controller, ...rest } = t;
  return { ...rest, log: (rest.log ?? []).slice(-40), pendingTitle: pending?.req?.title ?? null };
}

/**
 * A board owned by one process. `add` makes a task; `update` changes it and
 * notifies `onChange(task, previousState)`. Saving merges with what other
 * sessions wrote, replacing only this process's own tasks.
 */
export function createTaskBoard({ file = tasksFile(), pid = process.pid, now = () => Date.now(), persist = true, onChange = () => {} } = {}) {
  const tasks = [];
  const newId = () => {
    let id;
    do { id = Math.random().toString(16).slice(2, 6); } while (tasks.some((t) => t.id === id));
    return id;
  };
  const save = () => {
    if (!persist) return;
    try {
      const mine = new Set(tasks.map((t) => t.id));
      const others = readTasks({ file }).filter((t) => t.pid !== pid && !mine.has(t.id));
      const all = [...others, ...tasks.map(serializable)]
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, KEEP);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* the board is a convenience; never fail a turn over it */ }
  };
  const board = {
    tasks,
    add({ title, agent = "c0mpute", background = false, cwd = process.cwd() }) {
      const t = {
        id: newId(), pid, title: String(title).split("\n")[0].slice(0, 200), agent, background, cwd,
        state: "working", activity: "starting", startedAt: now(), updatedAt: now(), endedAt: null,
        result: null, error: null, log: [],
      };
      tasks.push(t);
      save();
      onChange(t, null);
      return t;
    },
    update(t, patch) {
      const before = t.state;
      Object.assign(t, patch, { updatedAt: now() });
      if (!LIVE.has(t.state) && !t.endedAt) t.endedAt = now();
      // Activity changes are frequent (every tool call): only save on state changes.
      if (patch.state && patch.state !== before) { save(); onChange(t, before); }
    },
    note(t, line) {
      t.log.push(line);
      if (t.log.length > 200) t.log.splice(0, t.log.length - 200);
    },
    find(id) {
      const k = String(id ?? "").replace(/^#/, "");
      return tasks.find((x) => x.id === k) ?? null;
    },
    /** Drop finished tasks from this session (and the saved board). */
    clearFinished() {
      const before = tasks.length;
      for (let i = tasks.length - 1; i >= 0; i--) if (!LIVE.has(tasks[i].state)) tasks.splice(i, 1);
      if (persist) {
        try {
          const keep = readTasks({ file }).filter((t) => LIVE.has(t.state));
          const ours = new Set(tasks.map((t) => t.id));
          const all = [...keep.filter((t) => !ours.has(t.id)), ...tasks.map(serializable)];
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
        } catch { /* best effort */ }
      }
      return before - tasks.length;
    },
    counts() {
      const c = Object.fromEntries(STATES.map((s) => [s, 0]));
      for (const t of tasks) c[t.state] += 1;
      return c;
    },
    save,
  };
  return board;
}

// ─── rendering ───────────────────────────────────────────────────────────────

export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const ICON = {
  needs_input: () => amber("●"),
  working: () => acid("◐"),
  completed: () => acid("✓"),
  failed: () => danger("✗"),
  stopped: () => ash("■"),
};

/** One line per task, grouped by state, live states first. */
export function renderTasks(tasks, write, { now = Date.now(), showPid = false } = {}) {
  if (!tasks.length) { write(ash("  no tasks yet · type a task, or & <task> to run one in the background")); return; }
  for (const state of STATES) {
    const list = tasks.filter((t) => t.state === state).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    if (!list.length) continue;
    write(bone(`${STATE_LABEL[state]} (${list.length})`));
    for (const t of list) {
      const title = t.title.length > 70 ? `${t.title.slice(0, 69)}…` : t.title;
      const since = LIVE.has(state) ? ago(now - t.startedAt) : `${ago(now - (t.endedAt ?? t.updatedAt))} ago`;
      const who = t.agent && t.agent !== "c0mpute" ? ` ${dim(`@${t.agent}`)}` : "";
      const bg = t.background ? "" : ` ${ash("(fg)")}`;
      const pid = showPid && t.pid !== process.pid ? ` ${ash(`pid ${t.pid}`)}` : "";
      write(`  ${ICON[state]()} ${ash(`#${t.id}`)} ${title}${who}${bg} ${ash(`· ${since}`)}${pid}`);
      const detail = state === "needs_input" ? `waiting on: ${t.pending?.req?.title ?? t.pendingTitle ?? "an answer"}`
        : state === "failed" ? t.error
        : state === "working" ? t.activity
        : null;
      if (detail) write(`      ${ash("⎿")}  ${state === "failed" ? danger(detail) : dim(detail)}`);
    }
  }
}

/** "2 working · 1 needs input" for the prompt, or "" when nothing runs in the background. */
export function liveSummary(tasks) {
  const bg = tasks.filter((t) => t.background);
  const n = (s) => bg.filter((t) => t.state === s).length;
  const parts = [];
  if (n("needs_input")) parts.push(amber(`${n("needs_input")} needs input`));
  if (n("working")) parts.push(acid(`${n("working")} working`));
  return parts.join(ash(" · "));
}
