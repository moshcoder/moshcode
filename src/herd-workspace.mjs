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
// and `herd sidebar` is what runs *inside* the left pane doing the swapping.
//
// This file is the tmux half and only the tmux half: which pane is which, how
// one is parked and another joined in, and how a member is stopped from
// renaming itself out of its own identity while it is here. What the left pane
// LOOKS like lives in src/herd-sidebar.mjs, which is an hqtui app. The split is
// the point of that port: the drawing, the mouse decoding, the hover and the
// terminal restore are all somebody else's solved problems, and none of them
// were ever about herds.
import { spawn, spawnSync } from "node:child_process";

import {
  HERD_SOCKET, detectSubstrate, paneIndex, slugifyName, tmux, tmuxCanPinTitle, validName,
} from "./herd.mjs";
import { BAR_TITLE, SIDEBAR_TITLE, barCommand, bindJumpKey, ensureBar, paneRoles } from "./herd-bar.mjs";
import { acid, err, info } from "./ui.mjs";

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

