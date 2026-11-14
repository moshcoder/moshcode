// Arrow-key list and live viewer for `moshcode agents c0mpute` (/tasks,
// /agents). Both draw on the terminal's alternate screen, the way a TUI does,
// so the conversation's scrollback is untouched, and both take the keyboard
// from readline while open and hand it back on exit.
//
//   pickList   ↑/↓ (j/k), PgUp/PgDn, Home/End, enter or → opens, extra letter keys,
//              esc/q goes back. Items are re-read every second, so a running
//              task's state updates in place.
//   viewLines  a scrollable page that follows the end while you are at the
//              bottom (a running task streams in), ↑/↓ PgUp/PgDn g/G to read.

import readline from "node:readline";
import { ash, bone, reverse } from "./ui.mjs";

const ALT_ON = "\x1b[?1049h\x1b[?25l";
const ALT_OFF = "\x1b[?25h\x1b[?1049l";
const ESC_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/y;

/**
 * Split one line (colour codes allowed) into rows of at most `width`
 * printable columns. A colour open at a break is closed and reopened on the
 * next row, so wrapped coloured text stays coloured.
 */
export function wrapAnsi(line, width) {
  const s = String(line ?? "").replace(/\t/g, "  ");
  if (width <= 0) return [s];
  const rows = [];
  let cur = "";
  let n = 0;
  let sgr = "";
  for (let i = 0; i < s.length;) {
    ESC_RE.lastIndex = i;
    const m = ESC_RE.exec(s);
    if (m) {
      cur += m[0];
      if (m[0].endsWith("m")) sgr = /^\x1b\[0?m$/.test(m[0]) ? "" : sgr + m[0];
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i));
    if (n >= width) {
      rows.push(sgr ? `${cur}\x1b[0m` : cur);
      cur = sgr;
      n = 0;
    }
    cur += ch;
    n += 1;
    i += ch.length;
  }
  rows.push(cur);
  return rows;
}

/** Take every keypress from readline until the returned release() runs. */
function takeKeys(input, onKey) {
  // Without a readline session (`moshcode agents c0mpute tasks`) nothing turns
  // stdin into keypress events yet; this is a no-op when readline already did.
  if (input.isTTY) readline.emitKeypressEvents(input);
  const others = input.listeners("keypress");
  for (const l of others) input.off("keypress", l);
  input.on("keypress", onKey);
  const wasRaw = Boolean(input.isRaw);
  if (input.isTTY && input.setRawMode) input.setRawMode(true);
  input.resume();
  return () => {
    input.off("keypress", onKey);
    for (const l of others) input.on("keypress", l);
    if (input.isTTY && input.setRawMode && !wasRaw) input.setRawMode(false);
  };
}

const keyName = (s, key) => (key?.name ?? s ?? "");

/**
 * An arrow-key list. `getItems()` → [{ header } | { id, label, sub? }].
 * `keys`: { letter: action } extra actions (shown in the footer via `help`).
 * Resolves { action: "open" | <extra>, item } or null (esc / q).
 */
export function pickList({ title, getItems, keys = {}, help = "", input = process.stdin, output = process.stdout, refreshMs = 1000, startId = null }) {
  return new Promise((resolve) => {
    let selId = startId;
    let top = 0;
    let items = [];
    const selectable = () => items.filter((x) => !x.header);
    const draw = () => {
      items = getItems();
      const sel = selectable();
      if (!sel.length) selId = null;
      else if (!sel.some((x) => x.id === selId)) selId = sel[0].id;
      const cols = Math.max(20, (output.columns || 80) - 1);
      const height = Math.max(5, (output.rows || 24) - 3);
      // Rows: a header is one row; an item is its label plus an optional sub line.
      const rows = [];
      let selRow = 0;
      for (const it of items) {
        if (it.header) { rows.push({ text: bone(it.header) }); continue; }
        const on = it.id === selId;
        if (on) selRow = rows.length;
        const label = wrapAnsi(`${on ? "❯" : " "} ${it.label}`, cols)[0];
        rows.push({ text: on ? reverse(label) : label });
        if (it.sub) rows.push({ text: wrapAnsi(`      ${it.sub}`, cols)[0] });
      }
      if (selRow < top) top = Math.max(0, selRow - 1);
      if (selRow >= top + height) top = selRow - height + 2;
      top = Math.max(0, Math.min(top, Math.max(0, rows.length - height)));
      const view = rows.slice(top, top + height).map((r) => r.text);
      const footer = ash(`↑↓ move · → or enter open${help ? ` · ${help}` : ""} · ← back${rows.length > height ? ` · ${top + 1}-${Math.min(rows.length, top + height)}/${rows.length}` : ""}`);
      output.write(`\x1b[H\x1b[2J${bone(title)}\r\n${view.join("\r\n")}\r\n${footer}`);
    };
    const move = (d) => {
      const sel = selectable();
      if (!sel.length) return;
      let i = sel.findIndex((x) => x.id === selId);
      i = Math.max(0, Math.min(sel.length - 1, (i < 0 ? 0 : i) + d));
      selId = sel[i].id;
      draw();
    };
    const finish = (r) => {
      clearInterval(timer);
      release();
      output.write(ALT_OFF);
      resolve(r);
    };
    const onKey = (s, key) => {
      const k = keyName(s, key);
      if (key?.ctrl && k === "c") return finish(null);
      if (k === "escape" || k === "q" || k === "left" || k === "backspace" || k === "h") return finish(null);
      if (k === "up" || k === "k") return move(-1);
      if (k === "down" || k === "j") return move(1);
      if (k === "pageup") return move(-10);
      if (k === "pagedown") return move(10);
      if (k === "home") return move(-1e9);
      if (k === "end") return move(1e9);
      const item = selectable().find((x) => x.id === selId);
      if ((k === "return" || k === "enter" || k === "right" || k === "l") && item) return finish({ action: "open", item });
      if (keys[k] && item) return finish({ action: keys[k], item });
    };
    output.write(ALT_ON);
    const release = takeKeys(input, onKey);
    draw();
    const timer = setInterval(draw, refreshMs);
    const onResize = () => draw();
    output.on?.("resize", onResize);
    const done = resolve;
    resolve = (r) => { output.off?.("resize", onResize); done(r); };
  });
}

/**
 * A scrollable page of `getLines()` (re-read every `refreshMs` while `live()`),
 * following the end while you are at the bottom. Resolves "back" or the
 * action of an extra key from `keys`.
 */
export function viewLines({ title, getLines, live = () => false, keys = {}, help = "", input = process.stdin, output = process.stdout, refreshMs = 500 }) {
  return new Promise((resolve) => {
    let top = 0;
    let follow = true;
    let rows = [];
    const height = () => Math.max(3, (output.rows || 24) - 2);
    const layout = () => {
      const cols = Math.max(20, (output.columns || 80) - 1);
      rows = getLines().flatMap((l) => wrapAnsi(l, cols));
    };
    const maxTop = () => Math.max(0, rows.length - height());
    const draw = () => {
      layout();
      if (follow) top = maxTop();
      top = Math.max(0, Math.min(top, maxTop()));
      const view = rows.slice(top, top + height());
      const pos = rows.length > height() ? ` · ${Math.round(((top + view.length) / rows.length) * 100)}%` : "";
      const liveTag = live() ? (follow ? " · live, following" : " · live (G to follow)") : "";
      const footer = ash(`↑↓ PgUp/PgDn g/G scroll${help ? ` · ${help}` : ""} · ← back${liveTag}${pos}`);
      output.write(`\x1b[H\x1b[2J${bone(title)}\r\n${view.join("\r\n")}${"\r\n".repeat(Math.max(0, height() - view.length))}\r\n${footer}`);
    };
    const scroll = (d) => { top = Math.max(0, Math.min(maxTop(), top + d)); follow = top >= maxTop(); draw(); };
    const finish = (r) => {
      clearInterval(timer);
      output.off?.("resize", draw);
      release();
      output.write(ALT_OFF);
      resolve(r);
    };
    const onKey = (s, key) => {
      const k = keyName(s, key);
      if (key?.ctrl && k === "c") return finish("back");
      if (k === "escape" || k === "q" || k === "left" || k === "backspace" || k === "h") return finish("back");
      if (k === "up" || k === "k") return scroll(-1);
      if (k === "down" || k === "j") return scroll(1);
      if (k === "pageup" || (k === "b" && !keys.b)) return scroll(-(height() - 1));
      if (k === "pagedown" || k === "space") return scroll(height() - 1);
      if (k === "end" || s === "G") { follow = true; return draw(); }
      if (k === "home" || k === "g") { top = 0; follow = false; return draw(); }
      if (keys[k]) return finish(keys[k]);
    };
    output.write(ALT_ON);
    const release = takeKeys(input, onKey);
    draw();
    const timer = setInterval(() => { if (live()) draw(); }, refreshMs);
    output.on?.("resize", draw);
  });
}
