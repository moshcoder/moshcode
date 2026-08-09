// `moshcode herd ui` — the clickable list of herds and their members.
//
// The roster answers "what is running" in a line each, which is right for a
// pipe and wrong for a person with five sessions who wants to get into one of
// them. This is the same information as a place you can point at: herds as
// headings, members under them, click one to go in, detach to come back.
//
// WHY THIS AND NOT A SIDEBAR. tmux's model is session > window > pane, and a
// pane belongs to exactly one window — so nothing can stay on screen across a
// switch. A list pinned beside a live session is therefore impossible with tmux
// underneath, and doing it anyway would mean rendering every session ourselves
// from `capture-pane` polls: no real cursor, no real mouse inside the agent,
// full-screen UIs flickering at the refresh rate. That is rebuilding herdr, and
// worse. So this list hands the whole terminal to a *real* attach and takes it
// back on detach — you lose side-by-side, you keep a real terminal.
//
// No dependencies, for the same reason as everything else here: moshcode
// installs by untarring a release and running node. Alternate screen, SGR mouse
// reporting and raw-mode keys are a few escape sequences, and every one of them
// is undone in a single restore path so a crash cannot leave a terminal with no
// cursor and the mouse captured.
import { attachSession, detectSubstrate, substrateNote } from "./herd.mjs";
import { roster } from "./herd-cli.mjs";
import { acid, amber, ash, bone, danger, dim } from "./ui.mjs";

/** The herd a session has no opinion about. */
export const DEFAULT_HERD = "main";

const ESC = {
  altOn: "\x1b[?1049h", altOff: "\x1b[?1049l",
  hideCursor: "\x1b[?25l", showCursor: "\x1b[?25h",
  // 1000 = report button press/release, 1006 = SGR encoding, which is the only
  // one that survives past column 95 — the older scheme packs coordinates into
  // single bytes and simply cannot express a click on a wide terminal.
  mouseOn: "\x1b[?1000h\x1b[?1006h", mouseOff: "\x1b[?1006l\x1b[?1000l",
  clear: "\x1b[2J\x1b[H",
};

/**
 * Group the roster into herds.
 *
 * Sessions carry their herd in the manifest; anything written before herds
 * existed has none, and lands in `main` rather than in a group called
 * "undefined".
 */
export function groupByHerd(sessions) {
  const herds = new Map();
  for (const session of sessions) {
    const key = session.herd || DEFAULT_HERD;
    if (!herds.has(key)) herds.set(key, []);
    herds.get(key).push(session);
  }
  return [...herds.entries()]
    .sort(([a], [b]) => (a === DEFAULT_HERD ? -1 : b === DEFAULT_HERD ? 1 : a.localeCompare(b)))
    .map(([name, members]) => ({ name, members: members.sort((a, b) => a.name.localeCompare(b.name)) }));
}

/**
 * Flatten the groups into the rows the screen actually shows, so a click at
 * line N and the highlighted row are the same lookup rather than two pieces of
 * arithmetic that can disagree.
 */
/**
 * How many lines render() prints before the first group heading — the title and
 * the blank under it.
 *
 * Shared by render() and layout() rather than written twice, because the two
 * disagreeing is not a cosmetic bug: layout() is the click map, so a
 * one-line drift silently sends every click to the row below the one under the
 * pointer. A test pins them together.
 */
export const HEADER_LINES = 2;

export function layout(groups, { top = HEADER_LINES + 1 } = {}) {
  const rows = [];
  for (const group of groups) {
    rows.push({ kind: "herd", herd: group.name, count: group.members.length });
    for (const session of group.members) rows.push({ kind: "session", session, herd: group.name });
    rows.push({ kind: "gap" });
  }
  if (rows.length) rows.pop(); // no trailing gap
  return rows.map((row, i) => ({ ...row, line: top + i }));
}

const MARK = { blocked: "!", working: "~", done: "✓", idle: "·", gone: "×", unknown: "?" };

const paint = (state, text) =>
  state === "blocked" ? amber(text)
  : state === "working" ? acid(text)
  : state === "done" ? bone(text)
  : state === "gone" ? danger(text)
  : ash(text);

/** One frame. Pure, so the whole screen can be asserted in a test. */
export function render(rows, { selected = 0, width = 80, substrate = "tmux" } = {}) {
  const out = [];
  const total = rows.filter((r) => r.kind === "session").length;
  const blocked = rows.filter((r) => r.kind === "session" && r.session.state === "blocked").length;
  out.push(`  ${bone("moshcode herd")}${ash(`   ${total} member${total === 1 ? "" : "s"}`)}${blocked ? amber(`   ${blocked} waiting on you`) : ""}`);
  out.push("");

  for (const row of rows) {
    if (row.kind === "gap") { out.push(""); continue; }
    if (row.kind === "herd") {
      out.push(`  ${ash(row.herd.toUpperCase())} ${dim(`(${row.count})`)}`);
      continue;
    }
    const s = row.session;
    const isSelected = rows[selected] === row;
    const cursor = isSelected ? acid("▸") : " ";
    const mark = paint(s.state, MARK[s.state] || "?");
    const name = isSelected ? bone(s.name.padEnd(12)) : ash(s.name.padEnd(12));
    const engine = ash(String(s.engine).padEnd(10));
    const state = paint(s.state, s.state.padEnd(8));
    const cwd = dim(tilde(s.cwd || "").slice(0, Math.max(10, width - 48)));
    out.push(`   ${cursor} ${mark} ${name} ${engine} ${state} ${cwd}`);
  }

  if (!total) {
    out.push(`  ${ash("the herd is empty.")}`);
    out.push(`  ${ash("start something with")} ${acid("moshcode herd shell")} ${ash("or")} ${acid("moshcode agents claude -d")}`);
  }
  out.push("");
  out.push(`  ${dim("click or ↑↓ to choose · enter to go in · r refresh · q quit")}`);
  if (substrate !== "tmux") out.push(`  ${dim(substrateNote(substrate) || "")}`);
  return out.join("\r\n");
}

const tilde = (p) => {
  const home = process.env.HOME || "";
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

/**
 * Decode one SGR mouse report: ESC [ < button ; col ; row (M press | m release).
 *
 * Only presses matter here, and only button 0 (left) and the wheel. Returning
 * null for everything else keeps the caller from acting on a release, which
 * would otherwise fire every click twice.
 */
export function parseMouse(sequence) {
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence);
  if (!m) return null;
  const [, button, col, row, kind] = m;
  if (kind === "m") return null; // release
  const b = Number(button);
  if (b === 64) return { kind: "wheel", direction: -1 };
  if (b === 65) return { kind: "wheel", direction: 1 };
  if (b !== 0) return null;
  return { kind: "click", col: Number(col), row: Number(row) };
}

/** Every mouse report in a chunk, so a fast click-drag cannot desync the parser. */
export function parseInput(buffer) {
  const events = [];
  const text = String(buffer);
  const mouse = /\x1b\[<\d+;\d+;\d+[Mm]/g;
  let match;
  while ((match = mouse.exec(text))) {
    const parsed = parseMouse(match[0]);
    if (parsed) events.push(parsed);
  }
  if (events.length) return events;
  for (const key of ["\x1b[A", "\x1b[B", "\r", "\n", "q", "\x03", "r", "j", "k"]) {
    if (text.includes(key)) events.push({ kind: "key", key });
  }
  return events;
}

/** Move the selection to the next/previous *session* row, skipping headings. */
export function moveSelection(rows, from, delta) {
  const selectable = rows.map((r, i) => (r.kind === "session" ? i : -1)).filter((i) => i >= 0);
  if (!selectable.length) return from;
  const at = selectable.indexOf(from);
  if (at < 0) return selectable[0];
  return selectable[Math.min(selectable.length - 1, Math.max(0, at + delta))];
}

/**
 * The interactive list.
 *
 * Everything the terminal had is restored through one `restore()`, wired to
 * normal exit and to the signals that otherwise kill a raw-mode process — a
 * crash here must not leave someone with no cursor, no echo, and the mouse
 * still captured by a program that is gone.
 */
export async function herdUi({
  stdin = process.stdin,
  stdout = process.stdout,
  attach = attachSession,
  read = roster,
  refreshMs = 2000,
} = {}) {
  const substrate = detectSubstrate();
  if (!stdin.isTTY || !stdout.isTTY) {
    stdout.write("moshcode herd ui needs an interactive terminal — try `moshcode ps`\n");
    return 1;
  }

  let rows = layout(groupByHerd(read()));
  let selected = rows.findIndex((r) => r.kind === "session");
  if (selected < 0) selected = 0;
  let done = false;
  let restored = false;

  const wasRaw = Boolean(stdin.isRaw);
  const restore = () => {
    if (restored) return;
    restored = true;
    stdout.write(ESC.mouseOff + ESC.showCursor + ESC.altOff);
    try { stdin.setRawMode?.(wasRaw); } catch { /* already gone */ }
    stdin.pause();
  };
  const enter = () => {
    restored = false;
    stdout.write(ESC.altOn + ESC.hideCursor + ESC.mouseOn);
    try { stdin.setRawMode?.(true); } catch { /* not a tty */ }
    stdin.resume();
  };
  const onSignal = () => { restore(); process.exit(130); };
  process.on("exit", restore);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const draw = () => {
    if (done) return;
    stdout.write(ESC.clear + render(rows, { selected, width: stdout.columns || 80, substrate }));
  };

  const refresh = () => {
    const previous = rows[selected];
    rows = layout(groupByHerd(read()));
    // Keep the highlight on the same session across a refresh, not on the same
    // line number — a session finishing above it would otherwise slide the
    // selection onto something else just as someone pressed enter.
    const again = rows.findIndex((r) => r.kind === "session" && r.session?.name === previous?.session?.name);
    selected = again >= 0 ? again : Math.max(0, rows.findIndex((r) => r.kind === "session"));
    draw();
  };

  enter();
  draw();
  const timer = setInterval(refresh, refreshMs);
  const onResize = () => draw();
  stdout.on("resize", onResize);

  const openSelected = async () => {
    const row = rows[selected];
    if (row?.kind !== "session" || !row.session.alive) return;
    // Give the terminal back before handing it to tmux, and take it again after
    // — attaching inside our alternate screen with the mouse captured would put
    // the agent's own mouse handling in a fight with ours.
    restore();
    await attach(row.session.name, { substrate });
    if (done) return;
    enter();
    refresh();
  };

  await new Promise((resolve) => {
    const onData = async (buf) => {
      for (const event of parseInput(buf)) {
        if (event.kind === "key" && (event.key === "q" || event.key === "\x03")) {
          done = true;
          resolve();
          return;
        }
        if (event.kind === "key" && (event.key === "\x1b[A" || event.key === "k")) selected = moveSelection(rows, selected, -1);
        else if (event.kind === "key" && (event.key === "\x1b[B" || event.key === "j")) selected = moveSelection(rows, selected, 1);
        else if (event.kind === "key" && event.key === "r") { refresh(); continue; }
        else if (event.kind === "wheel") selected = moveSelection(rows, selected, event.direction);
        else if (event.kind === "click") {
          const hit = rows.find((r) => r.kind === "session" && r.line === event.row);
          if (!hit) continue;
          selected = rows.indexOf(hit);
          draw();
          await openSelected();
          continue;
        }
        else if (event.kind === "key") { await openSelected(); continue; }
        draw();
      }
    };
    stdin.on("data", onData);
  });

  clearInterval(timer);
  stdout.off("resize", onResize);
  stdin.off("data", () => {});
  restore();
  process.off("exit", restore);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  stdout.write("\n");
  return 0;
}
