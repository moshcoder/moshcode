// `moshcode herd ui` — a sidebar of members and actions, with the selected
// member's real terminal beside it.
//
// This replaces the modal list, which was the wrong answer to the question.
// The list showed you the herd OR a session and never both, so getting into one
// was a one-way trip and nothing on the list could start or stop anything.
//
// HOW THE SIDEBAR SURVIVES A SWITCH. tmux's model is session > window > pane,
// and a pane belongs to exactly one window — which is why moving between
// *windows* cannot keep anything on screen. But `join-pane` moves a running
// pane into an existing window, so swapping only the *content* pane leaves the
// sidebar untouched. Selecting a member parks the current content pane back
// into a session of its own and joins the new one in; both keep their processes
// and their scrollback, because tmux is moving the real pane rather than
// redrawing a picture of it.
//
// Two processes, therefore: the launcher below builds the window and attaches,
// and `herdSidebar` is what runs *inside* the left pane doing the swapping.
import { spawn, spawnSync } from "node:child_process";

import { HERD_SOCKET, detectSubstrate, paneIndex, readManifest, tmux } from "./herd.mjs";
import { roster } from "./herd-cli.mjs";
import { groupByHerd, parseInput } from "./herd-ui.mjs";
import { acid, amber, ash, bone, danger, dim, err, info, ok } from "./ui.mjs";

export const WORKSPACE = "herd";
export const WINDOW = "ui";
export const TARGET = `${WORKSPACE}:${WINDOW}`;
const SIDEBAR_WIDTH = 26;

/** The rows in the sidebar that are not members. */
export const ACTIONS = [
  { key: "s", label: "+ shell", run: "shell" },
  { key: "a", label: "+ agent", run: "agent" },
  { key: "x", label: "✕ stop", run: "stop" },
  { key: "t", label: "⊞ tile all", run: "tile" },
  { key: "q", label: "← detach", run: "detach" },
];

/* -------------------------------------------------------------- the layout */

/**
 * Build the window and attach to it.
 *
 * Falls back to the plain list where there is no tmux, because the swap this
 * is built on is a tmux operation and the script(1) substrate has one pty per
 * session with no way to put two of them side by side.
 */
export async function herdUi(argv = [], { write = console.log, spawner = spawn, runner = spawnSync } = {}) {
  const substrate = detectSubstrate();
  if (substrate !== "tmux") {
    const { herdUi: list } = await import("./herd-ui.mjs");
    return list({});
  }

  const existing = tmux(["has-session", "-t", WORKSPACE], { runner });
  if (!existing.ok) {
    const self = process.argv[1];
    const sidebar = `${process.execPath} ${self} herd sidebar`;
    const made = tmux(["new-session", "-d", "-s", WORKSPACE, "-n", WINDOW, sidebar], { runner });
    if (!made.ok) { write(err(made.stderr.trim() || "could not open the workspace")); return 1; }
    // The sidebar is the "main" pane of a main-vertical layout, which is what
    // pins it to the left at a fixed width while the content pane takes the
    // rest and follows the terminal when it resizes.
    tmux(["set-option", "-t", WORKSPACE, "main-pane-width", String(SIDEBAR_WIDTH)], { runner });
    tmux(["set-option", "-t", WORKSPACE, "mouse", "on"], { runner });
    tmux(["set-option", "-t", WORKSPACE, "status", "off"], { runner });
    tmux(["set-option", "-t", WORKSPACE, "pane-border-status", "top"], { runner });
    tmux(["set-option", "-t", WORKSPACE, "pane-border-format", " #{pane_title} "], { runner });
    tmux(["select-pane", "-t", `${TARGET}.0`, "-T", "herd"], { runner });
  }

  return new Promise((resolve) => {
    let child;
    try { child = spawner("tmux", ["-L", HERD_SOCKET, "attach-session", "-t", WORKSPACE], { stdio: "inherit" }); }
    catch (error) { write(err(String(error.message || error))); resolve(1); return; }
    child.on("error", (error) => { write(err(String(error.message || error))); resolve(1); });
    child.on("exit", () => {
      write(info(`detached — everything is still running. ${acid("moshcode ps")} · ${acid("moshcode herd ui")}`));
      resolve(0);
    });
  });
}

/* ------------------------------------------------------------- the swapping */

/** The content pane currently on the right, if there is one. */
export function contentPane({ runner = spawnSync, me = process.env.TMUX_PANE } = {}) {
  const r = tmux(["list-panes", "-t", TARGET, "-F", "#{pane_id}\t#{pane_title}"], { runner });
  if (!r.ok) return null;
  for (const line of r.stdout.split("\n")) {
    const [paneId, title] = line.split("\t");
    if (!paneId || paneId === me) continue;
    return { paneId, title };
  }
  return null;
}

/**
 * Send a pane back to a session of its own.
 *
 * `break-pane` cannot do this: its `-t` is a destination window that has to
 * exist already, not a name to create. So it is the join dance backwards —
 * make the session, move the pane in, drop the placeholder the session was
 * born with.
 */
export function parkPane(paneId, name, { runner = spawnSync } = {}) {
  if (!name) return false;
  const made = tmux(["new-session", "-d", "-s", name, "-n", name], { runner });
  if (!made.ok && !/duplicate session/i.test(made.stderr || "")) return false;
  const placeholder = made.ok
    ? tmux(["list-panes", "-t", name, "-F", "#{pane_id}"], { runner }).stdout.trim().split("\n")[0]
    : null;
  const joined = tmux(["join-pane", "-s", paneId, "-t", `${name}:${name}`], { runner });
  if (!joined.ok) return false;
  if (placeholder) tmux(["kill-pane", "-t", placeholder], { runner });
  return true;
}

/** Put `name` in the content pane, parking whatever was there. */
export function showMember(name, { runner = spawnSync, me = process.env.TMUX_PANE } = {}) {
  const current = contentPane({ runner, me });
  if (current?.title === name) return true; // already showing
  const panes = paneIndex({ runner });
  const wanted = panes.get(name);
  if (!wanted) return false;

  if (current) parkPane(current.paneId, current.title, { runner });
  const joined = tmux(["join-pane", "-s", wanted.paneId, "-t", TARGET], { runner });
  if (!joined.ok) return false;
  tmux(["select-layout", "-t", TARGET, "main-vertical"], { runner });
  // main-vertical resets the main pane's width from the option, so re-assert it
  // after every swap or the sidebar creeps wider each time.
  tmux(["set-option", "-t", WORKSPACE, "main-pane-width", String(SIDEBAR_WIDTH)], { runner });
  tmux(["select-pane", "-t", me], { runner });
  return true;
}

/* --------------------------------------------------------------- the render */

const MARK = { blocked: "!", working: "~", done: "✓", idle: "·", gone: "×", unknown: "?" };
const paintState = (state, text) =>
  state === "blocked" ? amber(text)
  : state === "working" ? acid(text)
  : state === "done" ? bone(text)
  : state === "gone" ? danger(text)
  : ash(text);

/**
 * The sidebar's rows, and the line each one sits on — one list so a click and
 * the highlight cannot disagree (the bug that made the first list send every
 * click to the row below the pointer).
 */
export function sidebarRows(sessions) {
  const rows = [{ kind: "title" }, { kind: "gap" }];
  for (const group of groupByHerd(sessions)) {
    rows.push({ kind: "herd", herd: group.name });
    for (const session of group.members) rows.push({ kind: "session", session });
  }
  rows.push({ kind: "gap" }, { kind: "heading", text: "ACTIONS" });
  for (const action of ACTIONS) rows.push({ kind: "action", action });
  return rows.map((row, i) => ({ ...row, line: i + 1 }));
}

export function renderSidebar(rows, { selected, showing, width = SIDEBAR_WIDTH } = {}) {
  const out = [];
  for (const row of rows) {
    if (row.kind === "title") { out.push(` ${bone("herd")}`); continue; }
    if (row.kind === "gap") { out.push(""); continue; }
    if (row.kind === "heading") { out.push(` ${ash(row.text)}`); continue; }
    if (row.kind === "herd") { out.push(` ${ash(row.herd.toUpperCase())}`); continue; }
    if (row.kind === "session") {
      const s = row.session;
      const here = s.name === showing ? acid("▸") : " ";
      const label = s.name.slice(0, width - 7);
      const text = s.name === selected ? bone(label) : ash(label);
      out.push(`${here} ${paintState(s.state, MARK[s.state] || "?")} ${text}`);
      continue;
    }
    const isSel = row.action.key === selected;
    out.push(`  ${isSel ? bone(row.action.label) : ash(row.action.label)}`);
  }
  return out.join("\r\n");
}

/* -------------------------------------------------------- the sidebar itself */

/**
 * Runs inside the left pane. Draws the list, and turns a click into a swap.
 *
 * It does not take the alternate screen: it *is* a pane, and the pane is the
 * screen. Mouse reporting is enabled for this program specifically, which tmux
 * forwards rather than consuming once an application asks for it.
 */
export async function herdSidebar({
  stdin = process.stdin, stdout = process.stdout, read = roster, refreshMs = 2000, runner = spawnSync,
} = {}) {
  const me = process.env.TMUX_PANE;
  let sessions = read();
  let rows = sidebarRows(sessions);
  let selected = sessions[0]?.name || ACTIONS[0].key;
  let showing = null;

  const draw = () => {
    stdout.write("\x1b[2J\x1b[H" + renderSidebar(rows, { selected, showing }));
  };
  const refresh = () => {
    sessions = read();
    rows = sidebarRows(sessions);
    const current = contentPane({ runner, me });
    showing = current?.title || null;
    draw();
  };

  // Open on something rather than an empty right-hand side.
  const first = sessions.find((s) => s.alive);
  if (first) { showMember(first.name, { runner, me }); showing = first.name; }

  stdout.write("\x1b[?1000h\x1b[?1006h\x1b[?25l");
  try { stdin.setRawMode?.(true); } catch { /* not a tty */ }
  stdin.resume();
  const restore = () => stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?25h");
  process.on("exit", restore);

  draw();
  const timer = setInterval(refresh, refreshMs);

  const act = async (what) => {
    if (what === "detach") { tmux(["detach-client"], { runner }); return; }
    if (what === "tile") {
      const { herdTile } = await import("./herd-tile.mjs");
      await herdTile([], { write: () => {}, spawner: () => ({ on: (e, cb) => e === "exit" && cb(0) }) });
      refresh();
      return;
    }
    if (what === "stop") {
      const target = sessions.find((s) => s.name === selected);
      if (!target) return;
      const { killSession } = await import("./herd.mjs");
      killSession(target.name);
      refresh();
      const next = read().find((s) => s.alive);
      if (next) { showMember(next.name, { runner, me }); }
      refresh();
      return;
    }
    // shell / agent: start it detached, then bring it into the content pane so
    // the thing you just asked for is the thing you are looking at.
    const { herdShell, herdStart } = await import("./herd-cli.mjs");
    let created = null;
    const capture = (line) => { const m = /^\S*\s*(\S+)\s+—/.exec(String(line).replace(/\x1b\[[0-9;]*m/g, "")); if (m) created = m[1]; };
    if (what === "shell") herdShell([], { write: capture });
    else herdStart(["claude", "--agent"], { write: capture });
    refresh();
    if (created) { showMember(created, { runner, me }); refresh(); }
  };

  await new Promise((resolve) => {
    stdin.on("data", async (buf) => {
      for (const event of parseInput(buf)) {
        if (event.kind === "click") {
          const hit = rows.find((r) => r.line === event.row && (r.kind === "session" || r.kind === "action"));
          if (!hit) continue;
          if (hit.kind === "session") {
            selected = hit.session.name;
            if (hit.session.alive) { showMember(hit.session.name, { runner, me }); showing = hit.session.name; }
            draw();
          } else {
            selected = hit.action.key;
            draw();
            await act(hit.action.run);
          }
          continue;
        }
        if (event.kind !== "key") continue;
        const action = ACTIONS.find((a) => a.key === event.key);
        if (action) { await act(action.run); if (action.run === "detach") { resolve(); return; } continue; }
        if (event.key === "\x03") { resolve(); return; }
        const names = sessions.filter((s) => s.alive).map((s) => s.name);
        const at = names.indexOf(selected);
        if (event.key === "\x1b[A" || event.key === "k") selected = names[Math.max(0, at - 1)] || selected;
        if (event.key === "\x1b[B" || event.key === "j") selected = names[Math.min(names.length - 1, at + 1)] || selected;
        if (event.key === "\r" || event.key === "\n") { showMember(selected, { runner, me }); showing = selected; }
        draw();
      }
    });
  });

  clearInterval(timer);
  restore();
  return 0;
}
