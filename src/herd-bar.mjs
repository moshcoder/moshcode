// `moshcode herd bar` — a one-line mosh prompt pinned under the session.
//
// WHY THIS EXISTS. The workspace put a real agent in the content pane, which is
// the point of it — but a real agent takes the keyboard. Click into claude and
// every sidebar key stops working, and with tmux's status line off there is
// nothing on screen that says how to get back out. You are looking at one agent
// with no visible way to leave it, which is exactly the complaint.
//
// A status line would have been the small fix: one line of text that never goes
// away. But a line you can only read answers "how do I get out" and nothing
// else — you still cannot start a second agent without leaving first. So the
// line takes input. It is the same surface as the CLI (every `moshcode herd`
// verb works here) which means the escape hatch and the command line are one
// thing rather than two.
//
// The bar is one row until it has something to say, then it grows over the
// content, then it collapses again. Output has to go somewhere, and stealing
// rows from the agent for a moment is cheaper than a pane that is mostly empty.
import { spawnSync } from "node:child_process";

import { tmux } from "./herd.mjs";
import { acid, ash, bone } from "./ui.mjs";

export const BAR_TITLE = "mosh-bar";
export const SIDEBAR_TITLE = "herd";
export const BAR_HEIGHT = 1;
export const BAR_OPEN_HEIGHT = 14;

/** The key that reaches the bar from anywhere, including from inside an agent. */
export const BAR_KEY = "F12";

export const HINT = "ps · start claude · show <n> · kill <n> · detach · help";

/* ------------------------------------------------------------- pane geometry */

/**
 * Which pane is which, by title.
 *
 * Titles rather than indexes or ids: a pane keeps its title across `join-pane`,
 * which is the whole reason the workspace can move panes around at all, and
 * indexes shift every time one arrives or leaves.
 */
export function paneRoles(target, { runner = spawnSync } = {}) {
  const roles = { sidebar: null, content: null, bar: null };
  const r = tmux(["list-panes", "-t", target, "-F", "#{pane_id}\t#{pane_title}"], { runner });
  if (!r.ok) return roles;
  for (const line of r.stdout.split("\n")) {
    const [paneId, title] = line.split("\t");
    if (!paneId) continue;
    if (title === BAR_TITLE) roles.bar = { paneId, title };
    else if (title === SIDEBAR_TITLE) roles.sidebar = { paneId, title };
    else roles.content = { paneId, title };
  }
  return roles;
}

/** How a bar pane starts itself. Separated so tests can run a stand-in. */
export function barCommand(self = process.argv[1]) {
  return `${process.execPath} ${self} herd bar`;
}

/** The window a pane lives in, as a target string. */
export function ownTarget({ runner = spawnSync, me = process.env.TMUX_PANE } = {}) {
  if (!me) return null;
  const r = tmux(["display-message", "-p", "-t", me, "#{session_name}:#{window_index}"], { runner });
  return r.ok ? r.stdout.trim() || null : null;
}

/**
 * Put a bar at the bottom of `target`, or find the one already there.
 *
 * Idempotent, because both the workspace and every attach want one and neither
 * should care which of them got there first.
 */
export function ensureBar(target, { runner = spawnSync, command = null } = {}) {
  const existing = paneRoles(target, { runner }).bar;
  if (existing) return { paneId: existing.paneId, created: false };
  const made = tmux(
    ["split-window", "-t", target, "-f", "-v", "-l", String(BAR_HEIGHT), "-P", "-F", "#{pane_id}", command],
    { runner },
  );
  if (!made.ok) return { paneId: null, created: false };
  const paneId = made.stdout.trim().split("\n")[0];
  if (!paneId) return { paneId: null, created: false };
  tmux(["select-pane", "-t", paneId, "-T", BAR_TITLE], { runner });
  return { paneId, created: true };
}

/**
 * Bind the key that reaches the bar.
 *
 * `{bottom-right}` rather than a pane id, so one binding serves the workspace
 * and every attached session — in both, the bar is the bottom row. A pane id
 * would have pinned the key to whichever bar happened to be built last.
 *
 * The root table is what makes it work at all: tmux claims the key before the
 * pane's application ever sees it, which is the whole point when the pane holds
 * an agent that has taken the keyboard.
 */
export function bindJumpKey({ runner = spawnSync } = {}) {
  return tmux(["bind-key", "-n", BAR_KEY, "select-pane", "-t", "{bottom-right}"], { runner }).ok;
}

/** Drop the bar from a window, leaving whatever else is in it alone. */
export function removeBar(target, { runner = spawnSync } = {}) {
  const roles = paneRoles(target, { runner });
  if (!roles.bar || !roles.content) return false;
  return tmux(["kill-pane", "-t", roles.bar.paneId], { runner }).ok;
}

/**
 * Take the bar back out of every session nobody is looking at.
 *
 * A bar left behind is not cosmetic: `kill` ends a member by killing its pane,
 * so a session holding a leftover bar outlives the member it was named for and
 * keeps showing up on the roster. Detaching cleans up after itself, but a
 * crashed client cannot, so this also runs on the way in.
 *
 * Sessions with a client attached are skipped — someone else is using that bar.
 */
export function sweepBars({ runner = spawnSync, except = null } = {}) {
  const r = tmux(["list-panes", "-a", "-F",
    "#{session_name}\t#{window_index}\t#{pane_title}\t#{session_attached}"], { runner });
  if (!r.ok) return 0;
  const windows = new Map();
  for (const line of r.stdout.split("\n")) {
    const [session, window, title, attached] = line.split("\t");
    if (!session || session === except || attached !== "0") continue;
    const key = `${session}:${window}`;
    const seen = windows.get(key) || { bars: 0, others: 0 };
    if (title === BAR_TITLE) seen.bars += 1; else seen.others += 1;
    windows.set(key, seen);
  }
  let removed = 0;
  for (const [target, seen] of windows) {
    if (seen.bars && seen.others && removeBar(target, { runner })) removed += 1;
  }
  return removed;
}

/* --------------------------------------------------------------- line editing */

/**
 * One keystroke against the current line. Pure, so the editor is testable
 * without a terminal — the bar itself is then only plumbing.
 */
export function editLine(line, key) {
  if (key === "\r" || key === "\n") return { line, action: "submit" };
  if (key === "\x1b") return { line: "", action: "escape" };
  if (key === "\x03") return { line: "", action: "escape" };          // Ctrl-C
  if (key === "\x15") return { line: "", action: "edit" };             // Ctrl-U
  if (key === "\x17") return { line: line.replace(/\S+\s*$/, ""), action: "edit" }; // Ctrl-W
  if (key === "\x7f" || key === "\b") return { line: line.slice(0, -1), action: "edit" };
  if (key.length === 1 && key >= " " && key !== "\x7f") return { line: line + key, action: "edit" };
  return { line, action: "none" };
}

/**
 * What a typed line means.
 *
 * `attach` deliberately becomes `show`. Running the real attach from in here
 * would start a tmux client inside the client already showing this pane, which
 * tmux refuses — and the thing the word means in a workspace is "put it in the
 * content pane" anyway.
 */
export function resolveCommand(input) {
  const argv = String(input || "").trim().split(/\s+/).filter(Boolean);
  if (!argv.length) return { kind: "empty", argv: [] };
  const [verb, ...rest] = argv;
  if (verb === "detach" || verb === "exit" || verb === "quit") return { kind: "detach", argv: rest };
  if (verb === "show" || verb === "attach" || verb === "fg") return { kind: "show", argv: rest };
  if (verb === "help" || verb === "?") return { kind: "help", argv: rest };
  if (verb === "clear") return { kind: "clear", argv: rest };
  return { kind: "herd", argv };
}

/** The prompt line. The hint is what makes the way out discoverable at rest. */
export function renderPrompt(line, { cols = 80, showHint = true } = {}) {
  const prompt = `${acid("mosh")} ${bone("▸")} `;
  if (!line && showHint) return `${prompt}${ash(HINT.slice(0, Math.max(0, cols - 8)))}`;
  return `${prompt}${line}`;
}

export function helpLines() {
  return [
    "the bar takes any moshcode herd verb:",
    "  ps                 the roster        start claude       new agent",
    "  show <name>        put it on screen  shell              new shell",
    "  kill <name>        end one           tile               all at once",
    "  read <name>        its last screen   prompt <n> <text>  type into it",
    "",
    `${BAR_KEY} comes back here from anywhere · Esc returns to the session · detach leaves`,
  ];
}

/* ----------------------------------------------------------------- the bar */

/**
 * Runs inside the one-line pane at the bottom of the workspace.
 */
export async function herdBar({
  stdin = process.stdin,
  stdout = process.stdout,
  runner = spawnSync,
  target = null,
  run = null,
} = {}) {
  const me = process.env.TMUX_PANE;
  // The bar runs in the workspace AND under a plain attach, so it asks where it
  // is rather than assuming. Everything below keys off that one answer.
  const here = target || ownTarget({ runner, me }) || "herd:ui";
  const inWorkspace = () => !!paneRoles(here, { runner }).sidebar;
  const herdCommand = run || (async (argv, options) => (await import("./herd-cli.mjs")).herdCommand(argv, options));

  let line = "";
  let open = false;

  const cols = () => stdout.columns || 80;
  const collapse = () => {
    if (!open) return;
    open = false;
    tmux(["resize-pane", "-t", me, "-y", String(BAR_HEIGHT)], { runner });
  };
  const expand = (rows) => {
    open = true;
    tmux(["resize-pane", "-t", me, "-y", String(Math.min(BAR_OPEN_HEIGHT, rows + 2))], { runner });
  };
  const draw = () => {
    stdout.write(`\x1b[2J\x1b[H${renderPrompt(line, { cols: cols() })}`);
  };
  const show = (lines) => {
    expand(lines.length);
    stdout.write(`\x1b[2J\x1b[H${lines.join("\r\n")}\r\n${renderPrompt("", { cols: cols(), showHint: false })}`);
  };
  /** Give the keyboard back to whatever is on screen. */
  const toContent = () => {
    const roles = paneRoles(here, { runner });
    if (roles.content) tmux(["select-pane", "-t", roles.content.paneId], { runner });
  };

  /**
   * `show` means two different things and both are right.
   *
   * In the workspace it swaps the content pane. Under a plain attach there is
   * no content pane to swap, so it switches the client to that member — and
   * gives that member a bar first, or you would arrive somewhere with no way
   * back out, which is the bug this whole thing exists to fix.
   */
  const showElsewhere = async (name) => {
    const { paneIndex } = await import("./herd.mjs");
    const found = paneIndex({ runner }).get(name);
    if (!found) return false;
    ensureBar(`${found.session}:${found.windowId}`, { runner, command: barCommand() });
    return tmux(["switch-client", "-t", found.session], { runner }).ok;
  };

  const submit = async () => {
    const typed = line;
    line = "";
    const command = resolveCommand(typed);
    if (command.kind === "empty") { collapse(); draw(); toContent(); return true; }
    if (command.kind === "clear") { collapse(); draw(); return true; }
    if (command.kind === "help") { show(helpLines()); return true; }
    if (command.kind === "detach") { tmux(["detach-client"], { runner }); return false; }
    if (command.kind === "show") {
      const [name] = command.argv;
      let okShown = false;
      if (name && inWorkspace()) {
        const { showMember } = await import("./herd-workspace.mjs");
        okShown = showMember(name, { runner, me });
      } else if (name) {
        okShown = await showElsewhere(name);
      }
      if (!okShown) { show([ash(`no session named ${JSON.stringify(name || "")} — try ps`)]); return true; }
      collapse(); draw(); toContent();
      return true;
    }
    const out = [];
    await herdCommand(command.argv, { write: (s) => out.push(...String(s).split("\n")) });
    if (out.length) show(out);
    else { collapse(); draw(); }
    return true;
  };

  /**
   * Keep the bar one row.
   *
   * tmux scales panes proportionally when the window resizes, so a bar built
   * before a client attached came back three rows tall once one did — the pane
   * was created against an 80x24 window and stretched to fit 100x30. Nothing
   * outside can predict when that happens, but the bar gets a resize event for
   * it, so the bar is the thing that fixes it.
   */
  const keepThin = () => {
    if (open) return;
    tmux(["resize-pane", "-t", me, "-y", String(BAR_HEIGHT)], { runner });
  };

  try { stdin.setRawMode?.(true); } catch { /* not a tty */ }
  stdin.resume();
  stdout.on?.("resize", () => { keepThin(); draw(); });
  keepThin();
  draw();

  await new Promise((resolve) => {
    stdin.on("data", async (buf) => {
      for (const key of String(buf)) {
        const next = editLine(line, key);
        line = next.line;
        if (next.action === "submit") {
          if (!(await submit())) { resolve(); return; }
          continue;
        }
        if (next.action === "escape") { collapse(); draw(); toContent(); continue; }
        if (next.action === "edit") { if (open) { collapse(); } draw(); }
      }
    });
  });

  return 0;
}
