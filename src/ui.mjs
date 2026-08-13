// Metal terminal styling — poison acid-lime (#9EF01A) on near-black, the
// moshcoding palette. Truecolor ANSI with a NO_COLOR opt-out.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** moshcode's own version, read from package.json (best-effort). */
export function moshcodeVersion() {
  try {
    const pkg = fileURLToPath(new URL("../package.json", import.meta.url));
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version || null;
  } catch { return null; }
}

const useColor = process.env.NO_COLOR == null && process.stdout.isTTY === true;
// Exported so a module with its own hues (the arcade's seven tetrominoes) mixes
// them the same way, and honours NO_COLOR without knowing it exists.
export const rgb = (r, g, b) => (s) => (useColor ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : String(s));
const wrap = (o, c) => (s) => (useColor ? `\x1b[${o}m${s}\x1b[${c}m` : String(s));

export const acid = rgb(158, 240, 26);
export const bone = rgb(238, 242, 232);
export const ash = rgb(139, 147, 138);
export const danger = rgb(255, 77, 61);
export const amber = rgb(255, 213, 61);
export const spotify = rgb(29, 185, 84);
export const dim = wrap(2, 22);

export const ok = (s) => acid("✓ ") + s;
export const err = (s) => danger("✗ ") + s;
export const warn = (s) => amber("⚠ ") + s;
export const info = (s) => ash("· ") + s;

export function banner() {
  const version = moshcodeVersion();
  const name = bone("moshcode") + (version ? ash(" v" + version) : "");
  return [
    acid("  ███╗   ███╗ ██████╗ ███████╗██╗  ██╗"),
    acid("  ████╗ ████║██╔═══██╗██╔════╝██║  ██║") + ash("   code hard,"),
    acid("  ██╔████╔██║██║   ██║███████╗███████║") + ash("   mosh harder"),
    acid("  ██║╚██╔╝██║██║   ██║╚════██║██╔══██║"),
    acid("  ██║ ╚═╝ ██║╚██████╔╝███████║██║  ██║") + dim("  ⚡ #moshcoding"),
    acid("  ╚═╝     ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝"),
    "",
    "  " + name + ash("  ·  a wall of distortion for your coding agents"),
    "  " + acid("https://moshcode.sh"),
  ].join("\n");
}

export function hr() {
  return ash("─".repeat(Math.min(process.stdout.columns || 60, 60)));
}

/* ------------------------------------------------- measuring and padding */

// Colour codes are invisible but not zero-width to `.length`, so anything that
// lines columns up has to measure the stripped string. Three modules had each
// grown their own copy of this before it lived here — games.mjs, rss-ui.mjs and
// the herd-ui test — which is the usual sign it belongs in one place. Getting
// it wrong is how a table's right edge goes ragged the moment one cell is
// coloured, and every caller here paints cells.
const ANSI = /\x1b\[[0-9;]*m/g;

/** `text` with every SGR sequence removed. */
export const strip = (s) => String(s ?? "").replace(ANSI, "");

/** Printable width of `text` in terminal columns, colour codes not counted. */
export const visible = (s) => strip(s).length;

/**
 * Pad to `width` printable columns.
 *
 * Short-circuits rather than truncating when the text is already wider: a table
 * that silently ate a long name would be worse than one column of ragged edge,
 * and `clip` is right there for callers that would rather cut.
 */
export function pad(text, width, align = "left") {
  const s = String(text ?? "");
  const short = width - visible(s);
  if (short <= 0) return s;
  if (align === "right") return " ".repeat(short) + s;
  if (align === "center") {
    const left = Math.floor(short / 2);
    return " ".repeat(left) + s + " ".repeat(short - left);
  }
  return s + " ".repeat(short);
}

/**
 * Truncate to `width` printable columns, ellipsis included in the budget.
 *
 * Colour-aware on purpose. `slice` on a painted string can cut inside an escape
 * sequence or drop the reset that ends one, and a terminal handed a colour it
 * never gets told to stop using keeps it for everything printed afterwards —
 * including the next command's output. So this walks the escapes, counts only
 * what prints, and closes the run if the cut landed inside one.
 *
 * Whitespace is collapsed first, matching the copies in advisor.mjs and
 * crypto.mjs this replaces: these are table cells, and a cell containing a
 * newline breaks the row it sits in.
 */
export function clip(text, width, { collapse = true } = {}) {
  let s = String(text ?? "");
  // \s never appears inside an SGR sequence, so this cannot corrupt one.
  if (collapse) s = s.replace(/\s+/g, " ").trim();
  if (visible(s) <= width) return s;
  if (width <= 0) return "";

  const room = Math.max(1, width - 1); // one column reserved for the ellipsis
  let out = "";
  let printed = 0;
  let painted = false;
  for (let i = 0; i < s.length && printed < room; i++) {
    if (s[i] === "\x1b") {
      const match = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (match) {
        out += match[0];
        painted = true;
        i += match[0].length - 1;
        continue;
      }
    }
    out += s[i];
    printed++;
  }
  // A full reset rather than ui.mjs's narrower `\x1b[39m`: the cut may have
  // landed inside dim, or inside a colour some caller opened around us, and
  // leaking either is the bug this function exists to avoid.
  return out + (painted ? "\x1b[0m" : "") + "…";
}

/* --------------------------------------------------------------- layout */

/**
 * A column-aligned table, sized to its contents.
 *
 * The shape moshcode already prints by hand in advisor.mjs, crypto.mjs and
 * herd-cli.mjs: a heading row, then rows of padded cells. Those all hardcode
 * their widths, which is why a long ticker or a deep cwd pushes the columns out
 * of line — this measures instead.
 *
 * `rows` are objects (addressed by `column.key`) or arrays (by position).
 * Cells may be pre-painted; widths are measured with `visible`, so they line up
 * anyway. Returns a string with no trailing newline, like `banner()`.
 *
 * ```
 *   ticker   score   price
 *   NVDA        92   $1,203.44
 *   RIVN        41   $12.09
 * ```
 */
export function table(rows, {
  columns = [],
  gap = 2,
  indent = 2,
  header = true,
  rule = false,
  max = Infinity,
  paint = ash,
} = {}) {
  const cols = columns.map((c) => (typeof c === "string" ? { key: c, header: c } : c));
  if (!cols.length) return "";
  const body = Array.isArray(rows) ? rows : [];
  const shown = body.slice(0, max);

  const cell = (row, col, i) => {
    const raw = Array.isArray(row) ? row[i] : row?.[col.key];
    return raw == null ? "" : String(raw);
  };

  // A column is as wide as the widest thing in it, header included, unless the
  // caller pinned it. Measured across the rows actually printed — sizing to
  // rows cut by `max` would leave a gutter of dead space.
  const widths = cols.map((col, i) => col.width ?? Math.max(
    header ? visible(col.header ?? col.key ?? "") : 0,
    ...shown.map((row) => visible(cell(row, col, i))),
    0,
  ));

  const lead = " ".repeat(Math.max(0, indent));
  const sep = " ".repeat(Math.max(1, gap));
  const last = cols.length - 1;
  // The final left-aligned column is emitted unpadded. Trailing spaces are
  // invisible but real — they wrap early in a narrow terminal and show up in
  // every snapshot — and trimming the finished line cannot remove them once a
  // cell is painted, because the padding sits *inside* the colour codes, before
  // the reset. Not adding it is the only thing that works for painted cells.
  const fit = (text, i, align) => (i === last && (align ?? "left") === "left" ? String(text ?? "") : pad(text, widths[i], align));
  // An empty final cell still gets its separator, so the trim is still needed —
  // but it only has to remove literal spaces now, and with the last column left
  // unpadded there are never any hiding inside a colour run for it to miss.
  const line = (cells) => (lead + cells.join(sep)).replace(/ +$/, "");

  const out = [];
  if (header) {
    out.push(line(cols.map((col, i) => paint(fit(col.header ?? col.key ?? "", i, col.align)))));
    if (rule) out.push(line(widths.map((w) => ash("─".repeat(w)))));
  }
  for (const row of shown) {
    out.push(line(cols.map((col, i) => fit(cell(row, col, i), i, col.align))));
  }
  if (body.length > shown.length) {
    out.push(`${lead}${dim(`… ${body.length - shown.length} more`)}`);
  }
  return out.join("\n");
}

/** The box-drawing sets `panel` can frame with. */
const BORDERS = {
  round: "╭╮╰╯─│",
  single: "┌┐└┘─│",
  double: "╔╗╚╝═║",
  bold: "┏┓┗┛━┃",
};

/**
 * Frame `body` in a box, sized to its widest line.
 *
 * games.mjs has a `frame()` that does this for a game board with its own header
 * and key line; this is the plain version for everything else. The title sits
 * in the top edge rather than above it, which keeps a panel to one visual unit.
 *
 * ```
 *   ╭─ herd ──────────────╮
 *   │ api    claude  idle │
 *   ╰─────────────────────╯
 * ```
 */
export function panel(body, { title = "", width = 0, indent = 2, style = "round", paint = ash } = {}) {
  const lines = (Array.isArray(body) ? body : String(body ?? "").split("\n")).map(String);
  const [tl, tr, bl, br, h, v] = BORDERS[style] || BORDERS.round;
  // The title has to fit between the corners with its two spacers and at least
  // one run of edge on each side, or the top row comes out wider than the box.
  const inner = Math.max(width, visible(title) ? visible(title) + 4 : 0, ...lines.map(visible), 0);
  const lead = " ".repeat(Math.max(0, indent));

  // The bottom edge is `inner + 4` wide: two corners and the two spacer columns
  // the body sits between. A titled top has to come out the same, so its run of
  // edge is whatever is left after `╭─ title ` and the closing corner —
  // `inner - len - 1`, not `inner - len - 3`, which drew every titled panel two
  // columns narrow and visibly ragged.
  const top = visible(title)
    ? `${tl}${h} ${title} ${h.repeat(Math.max(0, inner - visible(title) - 1))}${tr}`
    : `${tl}${h.repeat(inner + 2)}${tr}`;

  return [
    lead + paint(top),
    ...lines.map((l) => `${lead}${paint(v)} ${pad(l, inner)} ${paint(v)}`),
    `${lead}${paint(`${bl}${h.repeat(inner + 2)}${br}`)}`,
  ].join("\n");
}

/* --------------------------------------------------------------- charts */

const SPARK_TICKS = "▁▂▃▄▅▆▇█";

/**
 * Render a series as one line of block characters.
 *
 * Lifted out of crypto.mjs, where it was the only chart in the codebase and
 * private to price history. Nothing about it is about prices.
 */
export function sparkline(points) {
  const values = (Array.isArray(points) ? points : []).map(Number).filter(Number.isFinite);
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series has no range to scale into; drawing it at the floor would
  // imply a crash, so it sits mid-band instead.
  if (max === min) return SPARK_TICKS[3].repeat(values.length);
  return values
    .map((v) => SPARK_TICKS[Math.min(SPARK_TICKS.length - 1, Math.floor(((v - min) / (max - min)) * SPARK_TICKS.length))])
    .join("");
}

/**
 * A horizontal meter: `████████░░░░  62%`.
 *
 * Clamped at both ends because the inputs are real — a download that reports
 * more bytes than its own content-length, a quota already overspent — and a bar
 * that renders past its track corrupts whatever is drawn to the right of it.
 */
export function gauge(value, { max = 1, width = 20, label = true, paint = acid } = {}) {
  const ratio = max > 0 && Number.isFinite(value / max) ? Math.min(1, Math.max(0, value / max)) : 0;
  const filled = Math.round(ratio * width);
  const bar = paint("█".repeat(filled)) + dim("░".repeat(Math.max(0, width - filled)));
  return label ? `${bar}  ${ash(`${Math.round(ratio * 100)}%`)}` : bar;
}
