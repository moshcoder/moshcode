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
/** Each task's full context (prompt, conversation, log) lives beside the board, one file per task. */
export const contextDir = (file = tasksFile()) => path.join(path.dirname(file), "c0mpute-tasks");
const contextPath = (dir, t) => path.join(dir, `${t.pid}-${t.id}.json`);
const CONTENT_CAP = 40_000;
const CONTEXT_CAP = 400_000;

/** A task's context: the conversation from its own first message on, capped. */
export function snapshotContext(t) {
  const ref = t.contextRef;
  let messages = ref ? ref.messages.slice(ref.from) : (t.messages ?? []);
  messages = messages.map((m) => {
    const c = String(m.content ?? "");
    return { role: m.role, content: c.length > CONTENT_CAP ? `${c.slice(0, CONTENT_CAP)}\n… (${c.length - CONTENT_CAP} more chars)` : c };
  });
  // Keep the newest messages when the whole thing is too big.
  let total = messages.reduce((n, m) => n + m.content.length, 0);
  let dropped = 0;
  while (messages.length > 1 && total > CONTEXT_CAP) { total -= messages[0].content.length; messages.shift(); dropped += 1; }
  return {
    id: t.id, pid: t.pid, title: t.title, prompt: t.prompt ?? t.title, agent: t.agent, background: t.background, cwd: t.cwd,
    state: t.state, startedAt: t.startedAt, endedAt: t.endedAt, activity: t.activity,
    result: t.result, error: t.error, log: t.log ?? [], messages, dropped, streaming: t.streaming || "",
  };
}

/** The saved context of a task (this session's or another's), or null. */
export function readTaskContext(t, { file = tasksFile() } = {}) {
  try { return JSON.parse(fs.readFileSync(contextPath(contextDir(file), t), "utf8")); } catch { return null; }
}

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
  const { pending, controller, contextRef, messages, streaming, ...rest } = t;
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
  const dir = contextDir(file);
  const saveContext = (t) => {
    if (!persist) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(contextPath(dir, t), `${JSON.stringify(snapshotContext(t))}\n`, { mode: 0o600 });
    } catch { /* best effort */ }
  };
  // Context files of tasks that fell off the board go with them.
  const pruneContexts = (keep) => {
    try {
      const names = new Set(keep.map((t) => `${t.pid}-${t.id}.json`));
      for (const f of fs.readdirSync(dir)) if (f.endsWith(".json") && !names.has(f)) fs.rmSync(path.join(dir, f), { force: true });
    } catch { /* none yet */ }
  };
  // Progress lines and streamed text save the context at most this often, so
  // another terminal following a running task sees it move.
  const lastCtx = new Map();
  const saveContextSoon = (t) => {
    const at = now();
    if (at - (lastCtx.get(t.id) ?? 0) < 1500) return;
    lastCtx.set(t.id, at);
    saveContext(t);
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
      pruneContexts(all);
    } catch { /* the board is a convenience; never fail a turn over it */ }
  };
  const board = {
    tasks,
    add({ title, prompt, agent = "c0mpute", background = false, cwd = process.cwd() }) {
      const t = {
        id: newId(), pid, title: String(title).split("\n")[0].slice(0, 200), prompt: String(prompt ?? title).slice(0, 20_000), agent, background, cwd,
        state: "working", activity: "starting", startedAt: now(), updatedAt: now(), endedAt: null,
        result: null, error: null, log: [],
      };
      tasks.push(t);
      save();
      saveContext(t);
      onChange(t, null);
      return t;
    },
    /** Follow the conversation this task runs in, from message `from` on. */
    attach(t, messages, from = 0) {
      t.contextRef = { messages, from };
    },
    /** Live text of a reply still arriving (cleared when the reply ends). */
    stream(t, text) {
      t.streaming = text == null ? "" : `${t.streaming || ""}${text}`.slice(-20_000);
      saveContextSoon(t);
    },
    /** The full context of one of this session's tasks, live. */
    contextOf(t) {
      return snapshotContext(t);
    },
    update(t, patch) {
      const before = t.state;
      Object.assign(t, patch, { updatedAt: now() });
      if (!LIVE.has(t.state) && !t.endedAt) t.endedAt = now();
      // Activity changes are frequent (every tool call): only save on state changes.
      if (patch.state && patch.state !== before) { save(); saveContext(t); onChange(t, before); }
    },
    note(t, line) {
      t.log.push(line);
      if (t.log.length > 200) t.log.splice(0, t.log.length - 200);
      saveContextSoon(t);
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
          pruneContexts(all);
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

const when = (ms) => (ms ? new Date(ms).toLocaleString() : "—");

/**
 * Everything about one task as lines: header, the prompt in full, the
 * conversation (your messages, c0mpute's replies, tool results), a reply
 * still arriving, the progress log and the result.
 */
export function renderTaskContext(ctx, { now = Date.now() } = {}) {
  const out = [];
  const rule = (label) => { out.push(""); out.push(bone(`── ${label} ${"─".repeat(Math.max(3, 60 - label.length))}`)); };
  out.push(`${(ICON[ctx.state] ?? ICON.stopped)()} ${ash(`#${ctx.id}`)} ${bone(ctx.title ?? "")}`);
  out.push(`${ash("state")} ${STATE_LABEL[ctx.state] ?? ctx.state}   ${ash("agent")} ${ctx.agent}   ${ash(ctx.background ? "background" : "foreground")}${ctx.pid && ctx.pid !== process.pid ? `   ${ash(`pid ${ctx.pid}`)}` : ""}`);
  out.push(`${ash("cwd")} ${ctx.cwd}`);
  out.push(`${ash("started")} ${when(ctx.startedAt)}   ${ash(ctx.endedAt ? "ended" : "running for")} ${ctx.endedAt ? when(ctx.endedAt) : ago(now - (ctx.startedAt ?? now))}`);
  rule("prompt");
  for (const l of String(ctx.prompt ?? ctx.title ?? "").split("\n")) out.push(l);
  const msgs = (ctx.messages ?? []).slice();
  // The first message is the prompt itself: don't print it twice.
  if (msgs.length && msgs[0].role === "user" && String(msgs[0].content).trim() === String(ctx.prompt ?? "").trim()) msgs.shift();
  if (msgs.length || ctx.dropped || ctx.streaming) {
    rule("conversation");
    if (ctx.dropped) out.push(ash(`(${ctx.dropped} older messages not kept)`));
    for (const m of msgs) {
      const text = String(m.content ?? "");
      out.push("");
      if (m.role === "user" && text.includes("<tool_result")) {
        out.push(ash("⎿ tool results"));
        for (const l of text.split("\n")) out.push(dim(`  ${l}`));
      } else {
        out.push(m.role === "user" ? acid("> you") : acid("● c0mpute"));
        for (const l of text.split("\n")) out.push(l);
      }
    }
    if (ctx.streaming) {
      out.push("");
      out.push(amber("● c0mpute (writing…)"));
      for (const l of String(ctx.streaming).split("\n")) out.push(l);
    }
  }
  if (ctx.log?.length) { rule("progress"); for (const l of ctx.log) out.push(dim(l)); }
  if (ctx.state === "working" && ctx.activity) { out.push(""); out.push(`${acid("◐")} ${ctx.activity}`); }
  if (ctx.state === "needs_input") { out.push(""); out.push(amber(`● waiting on: ${ctx.pendingTitle ?? "an answer"} — enter to answer`)); }
  if (ctx.error) { rule("error"); out.push(danger(ctx.error)); }
  if (ctx.result) { rule("result"); for (const l of String(ctx.result).split("\n")) out.push(l); }
  return out;
}

/** Picker rows for a task list: a header per state, then one row per task (same order as renderTasks). */
export function taskItems(tasks, { now = Date.now() } = {}) {
  const items = [];
  for (const state of STATES) {
    const list = tasks.filter((t) => t.state === state).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    if (!list.length) continue;
    items.push({ header: `${STATE_LABEL[state]} (${list.length})` });
    for (const t of list) {
      const since = LIVE.has(state) ? ago(now - t.startedAt) : `${ago(now - (t.endedAt ?? t.updatedAt))} ago`;
      const who = t.agent && t.agent !== "c0mpute" ? ` ${dim(`@${t.agent}`)}` : "";
      const pid = t.pid !== process.pid ? ` ${ash(`pid ${t.pid}`)}` : "";
      const detail = state === "needs_input" ? `waiting on: ${t.pending?.req?.title ?? t.pendingTitle ?? "an answer"}`
        : state === "failed" ? t.error
        : state === "working" ? t.activity
        : null;
      items.push({
        id: `${t.pid}-${t.id}`,
        task: t,
        label: `${ICON[state]()} ${ash(`#${t.id}`)} ${t.title}${who}${t.background ? "" : ` ${ash("(fg)")}`} ${ash(`· ${since}`)}${pid}`,
        sub: detail ? `${ash("⎿")}  ${state === "failed" ? danger(detail) : dim(detail)}` : null,
      });
    }
  }
  return items;
}
