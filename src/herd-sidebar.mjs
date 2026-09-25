// The herd sidebar, on hqtui.
//
// WHAT THIS REPLACES. The sidebar used to be hand-rolled escape sequences: a
// string of rows joined with \r\n, a hand-written SGR mouse parser, a hand-kept
// map of "which line is which row", and a restore path that had to remember
// every mode it had turned on. Three separate bugs came out of that shape and
// none of them were about the herd:
//
//   - the click map and the screen were two pieces of code that had to agree,
//     and when they drifted every click landed on the row below the pointer;
//   - mouse motion was never decoded at all, so there was no hover, so a click
//     had to be spent moving the highlight before a second one could open
//     anything, which is the double-click Anthony rejected outright;
//   - the restore path was escape sequences only, so a throw anywhere left the
//     pane in raw mode with the mouse still captured.
//
// hqtui answers all three as properties of the library rather than as things
// this file has to keep getting right. The tree widget reports the row it drew
// each node on, so the click map IS the screen by construction. `onHoverRow`
// plus `hovered` is the hover. And the terminal is restored on SIGINT, SIGTERM
// and an uncaught error by the Terminal itself.
//
// WHAT IT DOES NOT REPLACE. The right-hand side is a real tmux pane running a
// real agent, and no renderer can substitute for that: it has a real cursor, a
// real mouse inside the agent, and its own full-screen UI. So this owns the
// LEFT pane only, and the pane swapping underneath it is still the tmux work in
// herd-workspace.mjs, untouched.
//
// A FOLDING TREE, NOT A LIST THAT GETS REPLACED. The herd is herds containing
// members, which is a tree, and Anthony's standing expectation for a pane of
// things-containing-things is that it unfolds in place on ONE click with the
// row under the pointer lit. Clicking a herd folds it; clicking a member opens
// it. Nothing is ever swapped out for a different screen.
import { spawnSync } from "node:child_process";

import { roster } from "./herd-cli.mjs";
import { tmux } from "./herd.mjs";
import { groupByHerd } from "./herd-ui.mjs";
import { BAR_KEY } from "./herd-bar.mjs";
import { ACTIONS, TARGET, contentPane, focusContent, pinTitles, showMember } from "./herd-workspace.mjs";

/**
 * The moshcoding palette, as hqtui colours.
 *
 * The same hexes src/ui.mjs paints with. They are repeated rather than imported
 * because ui.mjs exports painters (string in, escape-wrapped string out) and
 * hqtui wants colour values it can put in a cell's attributes; one of the two
 * has to be written twice and a hex is the smaller thing to duplicate.
 */
export const PALETTE = {
  acid: "#9EF01A",
  bone: "#EEF2E8",
  ash: "#8B938A",
  danger: "#FF4D3D",
  amber: "#FFD53D",
};

const MARK = { blocked: "!", working: "~", done: "✓", idle: "·", gone: "×", unknown: "?" };
const STATE_COLOR = {
  blocked: PALETTE.amber,
  working: PALETTE.acid,
  done: PALETTE.bone,
  gone: PALETTE.danger,
};

/**
 * One member's state, as the two columns that sit to the right of its name.
 *
 * The trailing "?" is PRD 0019's: a state a regex guessed off a screen scrape
 * must not look like one the run itself reported. Not on `unknown`, whose mark
 * is already "?" and which is self-evidently nobody's report.
 */
export function stateCell(session) {
  const mark = MARK[session.state] || "?";
  const guess = session.confidence === "inferred" && session.state !== "unknown" ? "?" : "";
  return { text: `${mark}${guess}`, width: 2, align: "right", color: STATE_COLOR[session.state] || PALETTE.ash };
}

/**
 * The tree, and the flat list of what each of its rows means.
 *
 * The two are built in one pass and in the same order hqtui flattens an
 * expanded tree in (parent, then its children, depth first), so `rows[i]`
 * describes the node at flat index `i`. That correspondence is the whole click
 * map: the old sidebar kept it by hand and it drifted.
 */
export function herdNodes(sessions, { collapsed = new Set(), showing = null, selected = null } = {}) {
  const nodes = [];
  const rows = [];
  for (const group of groupByHerd(sessions)) {
    const expanded = !collapsed.has(group.name);
    const node = {
      label: `${group.name.toUpperCase()} (${group.members.length})`,
      color: PALETTE.ash,
      expanded,
      children: [],
    };
    nodes.push(node);
    rows.push({ kind: "herd", herd: group.name });
    for (const session of group.members) {
      node.children.push({
        // The marker for "this is the one on screen" is part of the label
        // rather than another column: at 26 columns a member has about twenty
        // for its name once the tree guides have taken three, and a column
        // that is blank on every row but one is not worth one of them.
        label: `${session.name === showing ? "▸" : " "}${session.name}`,
        color: session.name === selected ? PALETTE.bone : PALETTE.ash,
        values: [stateCell(session)],
      });
      rows.push({ kind: "session", herd: group.name, session });
    }
    // A herd with nothing in it still has to be foldable, and a node with an
    // empty `children` array is drawn as a leaf. Leaving it undefined says the
    // same thing and does not lie about being expandable.
    if (!node.children.length) delete node.children;
  }
  return { nodes, rows };
}

/**
 * Everything the sidebar's view needs, with nothing in it that touches a
 * terminal, so a test can render a frame and click on it.
 *
 * `hit` maps a screen row inside the tree widget to a flat index. It is filled
 * in by the tree's own `onRow` callback as it draws, which is the only place
 * that knows where the visible window starts, and read back by `onSelectRow`,
 * which is told a row counted from the top of that window.
 */
export function sidebarView(state, handlers = {}) {
  const { onOpen = () => {}, onFold = () => {}, onHover = () => {}, onAction = () => {}, onScroll = () => {} } = handlers;
  return ({ ui }) => {
    const { nodes, rows } = herdNodes(state.sessions, state);
    const hit = new Map();
    ui.box({ padding: { left: 1, right: 1 } }, (box) => {
      box.heading("herd", { size: 1 });
      box.tree({
        nodes,
        guides: true,
        guideColor: PALETTE.ash,
        selected: rows.findIndex((r) => r.kind === "session" && r.session.name === state.selected),
        hovered: state.hovered,
        offset: state.offset,
        followSelection: true,
        scrollbar: true,
        onRow: (node, index, y) => hit.set(y, index),
        onScroll,
        onHoverRow: (visible) => onHover(visible == null ? -1 : (hit.get(visible) ?? -1)),
        onSelectRow: (visible) => {
          const index = hit.get(visible);
          if (index == null) return;
          const row = rows[index];
          if (!row) return;
          // ONE click. A herd folds in place; a member opens. Nothing here
          // needs a second press to mean what it looked like it meant.
          if (row.kind === "herd") onFold(row.herd);
          else onOpen(row.session);
        },
      });
      box.spacer(1);
      box.divider({ label: "actions" });
      // The shortcut sits in a column of its own rather than two spaces after
      // a label, so five rows of different lengths read as a key map instead of
      // a ragged edge.
      const widest = Math.max(...ACTIONS.map((a) => [...a.label].length));
      for (const action of ACTIONS) {
        box.button({
          label: `${action.label.padEnd(widest + 2)}${action.key}`,
          align: "left",
          variant: "ghost",
          onPress: () => onAction(action.run),
        });
      }
      if (state.error) {
        box.spacer(1);
        box.text(state.error, { fg: PALETTE.danger, size: 2 });
      }
    });
    ui.statusBar({
      items: [{ key: "click", label: "open" }, { key: BAR_KEY, label: "bar" }],
      keyStyle: "caps",
      size: 1,
    });
  };
}

/**
 * Runs inside the left pane.
 *
 * `create` is the seam: the real one builds an hqtui App on this terminal, and
 * a test passes something that renders headlessly. Everything below it is state
 * and tmux calls, which is what this file is actually responsible for.
 */
export async function herdSidebar({
  read = roster,
  runner = spawnSync,
  refreshMs = 2000,
  create = null,
} = {}) {
  const me = process.env.TMUX_PANE;
  const state = {
    sessions: [],
    collapsed: new Set(),
    selected: null,
    showing: null,
    hovered: -1,
    offset: 0,
    error: "",
  };

  // Every tmux call this file makes goes through here. hqtui restores the
  // terminal on an uncaught error, so a throw is no longer destructive, but it
  // would still end the sidebar; a `join-pane` failing because a pane died
  // between two refreshes is ordinary and must cost a line of red instead.
  const guard = (what, fn) => {
    try { state.error = ""; return fn(); }
    catch (thrown) { state.error = `${what}: ${String(thrown?.message || thrown).split("\n")[0]}`; return null; }
  };

  const reload = () => guard("roster", () => {
    state.sessions = read();
    if (!state.selected || !state.sessions.some((s) => s.name === state.selected)) {
      state.selected = state.sessions[0]?.name || null;
    }
    state.showing = contentPane({ runner, me })?.title || null;
  });

  guard("workspace", () => pinTitles(TARGET, { runner }));
  reload();

  // Open on something rather than an empty right-hand side. Shown but NOT
  // focused: the keyboard belongs to the sidebar until someone asks for the
  // agent, or the workspace would start with every key going somewhere the
  // user has not looked at yet.
  if (!state.showing) {
    const first = state.sessions.find((s) => s.alive);
    if (first && guard("open", () => showMember(first.name, { runner, me }))) state.showing = first.name;
  }

  const open = (session) => {
    state.selected = session.name;
    if (!session.alive) { state.error = `${session.name} is not running`; return; }
    const shown = guard("open", () => showMember(session.name, { runner, me }));
    if (!shown) { state.error = state.error || `could not open ${session.name}`; return; }
    state.showing = session.name;
    // Showing it and handing it the keyboard are one act, which is what makes
    // this one click rather than two.
    guard("focus", () => focusContent({ runner, me }));
  };

  const fold = (herd) => {
    if (state.collapsed.has(herd)) state.collapsed.delete(herd);
    else state.collapsed.add(herd);
  };

  const act = async (what) => {
    if (what === "detach") { guard("detach", () => tmux(["detach-client"], { runner })); return true; }
    if (what === "tile") {
      const { herdTile } = await import("./herd-tile.mjs");
      await herdTile([], { write: () => {}, spawner: () => ({ on: (e, cb) => e === "exit" && cb(0) }) });
      reload();
      return false;
    }
    if (what === "stop") {
      const target = state.sessions.find((s) => s.name === state.selected);
      if (!target) { state.error = "nothing selected to stop"; return false; }
      const { killSession } = await import("./herd.mjs");
      guard("stop", () => killSession(target.name, { runner }));
      reload();
      const next = state.sessions.find((s) => s.alive);
      if (next) open(next);
      return false;
    }
    const { herdShell, herdStart } = await import("./herd-cli.mjs");
    let created = null;
    const capture = (line) => {
      const m = /^\S*\s*(\S+)\s+—/.exec(String(line).replace(/\x1b\[[0-9;]*m/g, ""));
      if (m) created = m[1];
    };
    guard("start", () => (what === "shell" ? herdShell([], { write: capture }) : herdStart(["claude", "--agent"], { write: capture })));
    reload();
    const born = state.sessions.find((s) => s.name === created);
    if (born) open(born);
    return false;
  };

  const app = create
    ? await create()
    : await (await import("@profullstack/hqtui")).createApp({
      // `q` is the detach action, not a bare quit: leaving the sidebar should
      // leave the herd running and say so, which act("detach") does.
      quitKeys: ["ctrl+c"],
      // A 26-column pane with one column of content. Collapsing only merges
      // where two BORDERED siblings touch, so there is nothing here for it to
      // merge and turning it on would only cost a repaint.
      collapseBorders: false,
      mouse: true,
    });

  const view = sidebarView(state, {
    onOpen: (session) => { open(session); app.invalidate(); },
    onFold: (herd) => { fold(herd); app.invalidate(); },
    onHover: (index) => {
      if (index === state.hovered) return; // do not repaint per cell of a drag
      state.hovered = index;
      app.invalidate();
    },
    onAction: (what) => { act(what).then((over) => { if (over) app.stop(); else app.invalidate(); }); },
    onScroll: (delta) => { state.offset = Math.max(0, state.offset + delta); app.invalidate(); },
  });
  app.render(view);

  app.on("key", (event) => {
    const action = ACTIONS.find((a) => a.key === event.key);
    if (action) { act(action.run).then((over) => { if (over) app.stop(); else app.invalidate(); }); return; }
    const alive = state.sessions.filter((s) => s.alive);
    const at = alive.findIndex((s) => s.name === state.selected);
    if (event.key === "up" || event.key === "k") state.selected = alive[Math.max(0, at - 1)]?.name || state.selected;
    else if (event.key === "down" || event.key === "j") state.selected = alive[Math.min(alive.length - 1, at + 1)]?.name || state.selected;
    else if (event.key === "enter" || event.key === "space") {
      const chosen = state.sessions.find((s) => s.name === state.selected);
      if (chosen) open(chosen);
    } else return;
    app.invalidate();
  });

  // A hover left behind when the pointer moves off the tree and onto the
  // actions is deliberately not chased. The widget only hears about the pointer
  // while it is inside itself, and the alternative is a second hit region over
  // the whole pane whose only job is to un-light a row nobody is looking at.
  // Moving back over the tree corrects it on the first cell.
  const timer = setInterval(() => { reload(); app.invalidate(); }, refreshMs);
  try { await app.start(); } finally { clearInterval(timer); }
  return 0;
}
