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

import {
  HERD_SOCKET, detectSubstrate, paneIndex, readManifest, slugifyName, tmux, tmuxCanPinTitle, validName,
} from "./herd.mjs";
import { roster } from "./herd-cli.mjs";
import { groupByHerd, parseInput } from "./herd-ui.mjs";
import { BAR_KEY, BAR_TITLE, SIDEBAR_TITLE, barCommand, bindJumpKey, ensureBar, paneRoles } from "./herd-bar.mjs";
import { acid, amber, ash, bone, danger, dim, err, info, reverse } from "./ui.mjs";

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
    tmux(["set-option", "-t", WORKSPACE, "mouse", "on"], { runner });
    tmux(["set-option", "-t", WORKSPACE, "status", "off"], { runner });
    tmux(["set-option", "-t", WORKSPACE, "pane-border-status", "top"], { runner });
    tmux(["set-option", "-t", WORKSPACE, "pane-border-format", " #{pane_title} "], { runner });
    tmux(["select-pane", "-t", `${TARGET}.0`, "-T", SIDEBAR_TITLE], { runner });
    buildBar({ runner });
  }
  // Outside the `if`, deliberately: a workspace built by an older moshcode is
  // still sitting in the tmux server and would otherwise never get this.
  pinTitles(TARGET, { runner });

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

/* ------------------------------------------------------------------ the bar */

/** Add the one-line mosh prompt under the content, and the key that reaches it. */
export function buildBar({ runner = spawnSync, command = barCommand() } = {}) {
  const { paneId } = ensureBar(TARGET, { runner, command });
  if (!paneId) return null;
  bindJumpKey({ runner });
  tmux(["select-pane", "-t", `${TARGET}.0`], { runner });
  return paneId;
}

/* ------------------------------------------------------------ pane identity */

/**
 * Stop a member renaming itself out of its own identity once it is in here.
 *
 * Every member is addressed by its PANE TITLE. paneIndex keys on it, the
 * border prints it, and parkPane uses it as the session name to park under.
 * startSession pins the title with `allow-set-title off`, but that option is
 * per WINDOW, and the whole trick this file is built on is moving a pane out of
 * that window into this one. The pin does not travel with the pane.
 *
 * So the first thing claude or a login shell did after being joined in was emit
 * OSC 2 and rename its own pane to something like `anthony@dev:~/src/moshcode`.
 * From that moment the member was invisible to paneIndex, and the next click
 * tried to park it under a "session name" containing `:` and `.`, which tmux
 * reads as target separators and refuses. The pane could not leave, the new one
 * arrived anyway, and the window ended up with two content panes and a squeezed
 * sidebar. That is what "it crashed when I clicked an agent" looks like.
 *
 * tmux gained `allow-set-title` in 3.5, so this is a no-op on 3.4 (which is
 * what Ubuntu 24.04 ships); parkPane below covers that case instead of relying
 * on it.
 */
export function pinTitles(target = TARGET, { runner = spawnSync } = {}) {
  if (!tmuxCanPinTitle({ runner })) return false;
  return tmux(["set-option", "-w", "-t", target, "allow-set-title", "off"], { runner }).ok;
}

/* ------------------------------------------------------------- the swapping */

/**
 * The content pane — the one that is neither the sidebar nor the bar.
 *
 * Excluding by title rather than "any pane that is not me": the bar made that
 * shortcut wrong, and wrong here means a swap parks the bar into a session
 * named after it and the prompt vanishes off the bottom of the screen.
 */
export function contentPane({ runner = spawnSync, me = process.env.TMUX_PANE } = {}) {
  const r = tmux(["list-panes", "-t", TARGET, "-F", "#{pane_id}\t#{pane_title}"], { runner });
  if (!r.ok) return null;
  for (const line of r.stdout.split("\n")) {
    const [paneId, title] = line.split("\t");
    if (!paneId || paneId === me) continue;
    if (title === BAR_TITLE || title === SIDEBAR_TITLE) continue;
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
  if (!paneId) return false;
  // A pane whose title is not a legal session name still has to be able to
  // leave. On tmux 3.4 there is no `allow-set-title`, so a member CAN rename
  // itself in here, and `new-session -s "anthony@dev:~/src"` fails outright:
  // tmux reads `:` and `.` as target separators. Before this, that failure left
  // the pane sitting in the workspace while the next one joined in beside it:
  // two content panes and a sidebar squeezed to nothing. Parking it under a
  // slug is strictly better than leaving it wedged: the pane keeps its title,
  // so paneIndex and the roster still find the member by the only name they
  // ever knew it by.
  const session = validName(name) ? name : slugifyName(name || "parked");
  const made = tmux(["new-session", "-d", "-s", session, "-n", session], { runner });
  if (!made.ok && !/duplicate session/i.test(made.stderr || "")) return false;
  const placeholder = made.ok
    ? tmux(["list-panes", "-t", session, "-F", "#{pane_id}"], { runner }).stdout.trim().split("\n")[0]
    : null;
  const joined = tmux(["join-pane", "-s", paneId, "-t", `${session}:${session}`], { runner });
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

  // Split the SIDEBAR rather than laying the window out.
  //
  // `select-layout main-vertical` was the obvious way to do this and it is the
  // wrong one once a footer exists: it owns every pane in the window, so it
  // dragged the bar into the right-hand column and gave it an equal share, and
  // putting it back was a second fight every swap. Splitting the sidebar
  // touches only the region above the footer, which leaves the bar a full-width
  // row at the bottom and needs no correction afterwards.
  const roles = paneRoles(TARGET, { runner });
  const anchor = roles.sidebar?.paneId || me;
  const joined = anchor
    ? tmux(["join-pane", "-h", "-s", wanted.paneId, "-t", anchor], { runner })
    : tmux(["join-pane", "-s", wanted.paneId, "-t", TARGET], { runner });
  if (!joined.ok) return false;
  if (anchor) tmux(["resize-pane", "-t", anchor, "-x", String(SIDEBAR_WIDTH)], { runner });
  tmux(["select-pane", "-t", me], { runner });
  return true;
}

/** Hand the keyboard to the session on screen. */
export function focusContent({ runner = spawnSync, me = process.env.TMUX_PANE } = {}) {
  const current = contentPane({ runner, me });
  if (!current) return false;
  tmux(["select-pane", "-t", current.paneId], { runner });
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
  // The two keys that stop the workspace being a one-way trip, on screen at all
  // times. Everything else here is discoverable by looking; these are not.
  rows.push({ kind: "gap" });
  rows.push({ kind: "hint", text: "click or ↵ ▸ open" });
  rows.push({ kind: "hint", text: `${BAR_KEY} ▸ mosh bar` });
  return rows.map((row, i) => ({ ...row, line: i + 1 }));
}

/**
 * One frame.
 *
 * `hovered` is a LINE number rather than a name because the pointer is over a
 * position on the screen, not over a member: there is nothing else it could
 * mean, and looking the row up by line is the same lookup a click does, so the
 * highlight and the click can never disagree about which row is under the
 * pointer.
 */
export function renderSidebar(rows, { selected, showing, hovered = null, error = "", width = SIDEBAR_WIDTH } = {}) {
  const out = [];
  const lit = (line, text) => (line === hovered ? reverse(text) : text);
  for (const row of rows) {
    if (row.kind === "title") { out.push(` ${bone("herd")}`); continue; }
    if (row.kind === "gap") { out.push(""); continue; }
    if (row.kind === "heading") { out.push(` ${ash(row.text)}`); continue; }
    if (row.kind === "hint") { out.push(` ${dim(row.text)}`); continue; }
    if (row.kind === "herd") { out.push(` ${ash(row.herd.toUpperCase())}`); continue; }
    if (row.kind === "session") {
      const s = row.session;
      const here = s.name === showing ? acid("▸") : " ";
      // PRD 0019 gave every state a confidence. A state a regex guessed off a
      // screen scrape and a state the run itself reported must not look
      // identical here, or the sidebar quietly re-tells the confident lie the
      // heartbeat exists to stop. Same mark the roster uses, for the same
      // reason: one convention, learned once.
      // Not on `unknown`, which already prints "?" as its state: "??" is two
      // marks for one fact, and a state nobody can name is self-evidently not
      // one anything reported.
      const guess = s.confidence === "inferred" && s.state !== "unknown" ? dim("?") : " ";
      const label = s.name.slice(0, width - 8);
      const text = s.name === selected ? bone(label) : ash(label);
      out.push(lit(row.line, `${here} ${paintState(s.state, MARK[s.state] || "?")}${guess} ${text}`));
      continue;
    }
    out.push(lit(row.line, `  ${ash(row.action.label)}`));
  }
  if (error) out.push("", ` ${danger(String(error).slice(0, width - 2))}`);
  return out.join("\r\n");
}


/* -------------------------------------------------------- the sidebar itself */

/** The keys the sidebar reads, which are not the keys the plain list reads. */
export const SIDEBAR_KEYS = [
  "\x1b[A", "\x1b[B", "\r", "\n", "\x03", "j", "k",
  ...ACTIONS.map((a) => a.key),
];

/**
 * Runs inside the left pane. Draws the list, and turns a click into a swap.
 *
 * It does not take the alternate screen: it *is* a pane, and the pane is the
 * screen. Mouse reporting is enabled for this program specifically, which tmux
 * forwards rather than consuming once an application asks for it.
 *
 * WHY THE WHOLE BODY IS INSIDE A GUARD. Every interesting thing this does is a
 * spawnSync out to tmux, and a click runs half a dozen of them. The input
 * handler is async, so before this a throw from any one of them became an
 * unhandled promise rejection, which Node treats as fatal. The process died
 * mid-click, and because the only thing that put the terminal back was a
 * write of escape sequences, RAW MODE was never lifted: the pane was left with
 * no echo, no cursor and the mouse still captured by a program that was gone.
 * A tmux call failing is ordinary (a pane dies between two refreshes and every
 * `-t` naming it starts returning "can't find pane"); it must cost you a line
 * of red in the sidebar, never the sidebar.
 */
export async function herdSidebar({
  stdin = process.stdin, stdout = process.stdout, read = roster, refreshMs = 2000, runner = spawnSync,
} = {}) {
  const me = process.env.TMUX_PANE;
  let sessions = [];
  let rows = [];
  let selected = null;
  let showing = null;
  let hovered = null;
  let error = "";

  // Nothing above the guard, so a throw out of the very first roster read is
  // handled the same way as one out of the hundredth click.
  const say = (thrown) => { error = String(thrown?.message || thrown || "").split("\n")[0].slice(0, 60); };

  const draw = () => {
    try { stdout.write("\x1b[2J\x1b[H" + renderSidebar(rows, { selected, showing, hovered, error })); }
    catch { /* the pane went away mid-frame; the exit path still runs */ }
  };
  const reload = () => {
    sessions = read();
    rows = sidebarRows(sessions);
    if (!selected || !sessions.some((s) => s.name === selected)) selected = sessions[0]?.name || null;
  };
  const refresh = () => {
    try {
      reload();
      showing = contentPane({ runner, me })?.title || null;
      error = "";
    } catch (thrown) {
      // A timer callback is the other way a throw here kills the process: it is
      // not inside the awaited promise at all, so no catch downstream can see
      // it. This one has to hold.
      say(thrown);
    }
    draw();
  };

  // Members joined into this window have to keep their names (see pinTitles).
  try { pinTitles(TARGET, { runner }); reload(); } catch (thrown) { say(thrown); }

  // Open on something rather than an empty right-hand side.
  const first = sessions.find((s) => s.alive);
  if (first) {
    try { if (showMember(first.name, { runner, me })) showing = first.name; }
    catch (thrown) { say(thrown); }
  }

  // 1003 as well as 1000: 1000 reports presses only, and a hover highlight
  // needs motion. It is a 26-column pane, so the traffic this adds is a few
  // bytes per pointer move and the redraw is skipped unless the row changed.
  stdout.write("\x1b[?1000h\x1b[?1003h\x1b[?1006h\x1b[?25l");
  const wasRaw = Boolean(stdin.isRaw);
  try { stdin.setRawMode?.(true); } catch { /* not a tty */ }
  stdin.resume();

  // ONE restore, idempotent, and it puts back everything that was changed
  // rather than only the escape sequences. The old one left raw mode on, which
  // is the half that makes a crash here destructive: escape sequences are
  // undone by the next full-screen program to run, a terminal with no echo is
  // not.
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { stdout.write("\x1b[?1006l\x1b[?1003l\x1b[?1000l\x1b[?25h"); } catch { /* gone */ }
    try { stdin.setRawMode?.(wasRaw); } catch { /* gone */ }
    try { stdin.pause(); } catch { /* gone */ }
  };
  const onSignal = () => { restore(); process.exit(130); };
  // `exit` covers a clean return and an uncaught throw; the signals cover the
  // ways a pane is torn down from outside, which do not run exit handlers.
  process.on("exit", restore);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

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
      if (!target) { error = "nothing selected to stop"; draw(); return; }
      const { killSession } = await import("./herd.mjs");
      killSession(target.name, { runner });
      refresh();
      const next = read().find((s) => s.alive);
      if (next) showMember(next.name, { runner, me });
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
    if (created) { selected = created; showMember(created, { runner, me }); refresh(); }
  };

  /** Show a member and hand it the keyboard. The whole of what "open" means. */
  const open = (name) => {
    selected = name;
    if (!showMember(name, { runner, me })) { error = `could not open ${name}`; draw(); return; }
    showing = name;
    error = "";
    draw();
    focusContent({ runner, me });
  };

  await new Promise((resolve) => {
    const handle = async (event) => {
      if (event.kind === "move") {
        // Redraw only when the row under the pointer actually changes, or a
        // pointer dragged across the pane would repaint the sidebar per cell.
        const over = rows.find((r) => r.line === event.row && (r.kind === "session" || r.kind === "action"));
        const line = over ? over.line : null;
        if (line !== hovered) { hovered = line; draw(); }
        return false;
      }
      if (event.kind === "click") {
        const hit = rows.find((r) => r.line === event.row && (r.kind === "session" || r.kind === "action"));
        if (!hit) return false;
        if (hit.kind === "session") {
          // ONE click opens it. The old behaviour was "first click browses,
          // clicking the one already on screen opens it", which is the
          // double-click affordance Anthony rejected in diskpush 0.7.0 ("i had
          // to double click that was odd"). A pointer that has to be told twice
          // is not a pointer. Browsing without opening is what hover is for
          // now, and it costs no click at all.
          if (!hit.session.alive) { error = `${hit.session.name} is not running`; selected = hit.session.name; draw(); return false; }
          open(hit.session.name);
          return false;
        }
        // Actions do NOT move the member selection. They used to, which is why
        // clicking "stop" could never stop anything: it set `selected` to the
        // action's key and then looked for a member by that name.
        await act(hit.action.run);
        return hit.action.run === "detach";
      }
      if (event.kind !== "key") return false;
      const action = ACTIONS.find((a) => a.key === event.key);
      if (action) { await act(action.run); return action.run === "detach"; }
      if (event.key === "\x03") return true;
      const names = sessions.filter((s) => s.alive).map((s) => s.name);
      const at = names.indexOf(selected);
      if (event.key === "\x1b[A" || event.key === "k") selected = names[Math.max(0, at - 1)] || selected;
      if (event.key === "\x1b[B" || event.key === "j") selected = names[Math.min(names.length - 1, at + 1)] || selected;
      // The keyboard path to the same thing a click does, kept because reaching
      // for the mouse to get into an agent is not always possible over ssh.
      if ((event.key === "\r" || event.key === "\n") && selected) { open(selected); return false; }
      draw();
      return false;
    };

    stdin.on("data", (buf) => {
      // The catch IS the fix. See the note on this function: without it a throw
      // out of any tmux call below is an unhandled rejection and the process is
      // gone, terminal and all.
      (async () => {
        for (const event of parseInput(buf, { keys: SIDEBAR_KEYS })) {
          if (await handle(event)) { resolve(); return; }
        }
      })().catch((thrown) => { say(thrown); draw(); });
    });
  });

  clearInterval(timer);
  restore();
  process.off("exit", restore);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  process.off("SIGHUP", onSignal);
  return 0;
}
