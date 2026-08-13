// The layout primitives every other renderer measures with.
//
// The load-bearing property in here is that width means *printable* width. A
// pad or a clip that counts escape bytes as columns produces a table whose right
// edge moves depending on whether a cell happened to be coloured — which is
// exactly the bug that made games.mjs, rss-ui.mjs and the herd-ui test each grow
// a private copy of `visible` before it lived in ui.mjs.
//
// Colour is off in here: ui.mjs decides once, at import, from `isTTY`, and the
// test runner has no tty. So `acid("x")` returns a bare "x" and the painted
// cases below use literal escape sequences instead — which is what a real
// terminal run produces anyway.
import test from "node:test";
import assert from "node:assert/strict";

import { clip, gauge, pad, panel, sparkline, strip, table, visible } from "../src/ui.mjs";

// A red "abc" the way rgb() writes it, and a dim run the way wrap() does.
const RED = (s) => `\x1b[38;2;255;77;61m${s}\x1b[39m`;
const DIM = (s) => `\x1b[2m${s}\x1b[22m`;

/* ------------------------------------------------------------- measuring */

test("visible counts printable columns, not escape bytes", () => {
  assert.equal(visible(RED("abc")), 3);
  assert.equal(visible(DIM("abc")), 3);
  assert.equal(strip(RED("abc")), "abc");
});

test("visible treats null and undefined as empty rather than printing them", () => {
  // These arrive from real rows — a session with no cwd, a quote with no
  // exchange — and "undefined" is four columns wide and never what was meant.
  assert.equal(visible(null), 0);
  assert.equal(visible(undefined), 0);
  assert.equal(strip(undefined), "");
});

/* --------------------------------------------------------------- padding */

test("pad measures the stripped string, so a coloured cell lines up with a plain one", () => {
  assert.equal(visible(pad(RED("ab"), 6)), 6);
  assert.equal(visible(pad("ab", 6)), 6);
});

test("pad aligns left, right and centre", () => {
  assert.equal(pad("ab", 6), "ab    ");
  assert.equal(pad("ab", 6, "right"), "    ab");
  assert.equal(pad("ab", 6, "center"), "  ab  ");
  // An odd remainder goes right, so a column of centred cells stays flush left.
  assert.equal(pad("ab", 7, "center"), "  ab   ");
});

test("pad never truncates", () => {
  // A table that silently ate a long name would be worse than a ragged edge,
  // and clip() is the way to ask for a cut.
  assert.equal(pad("abcdefgh", 3), "abcdefgh");
});

/* -------------------------------------------------------------- clipping */

test("clip fits the ellipsis inside the width it was given", () => {
  // Off-by-one here is how a table blows its own column budget by one column
  // per row and wraps in a terminal that was exactly wide enough.
  assert.equal(visible(clip("abcdefgh", 4)), 4);
  assert.equal(clip("abcdefgh", 4), "abc…");
});

test("clip leaves text that already fits completely alone", () => {
  assert.equal(clip("abc", 8), "abc");
  assert.equal(clip("abcd", 4), "abcd");
});

test("clip collapses whitespace, because a newline in a cell breaks its row", () => {
  assert.equal(clip("a\n  b   c", 40), "a b c");
});

test("clip closes the colour it cut into", () => {
  // The failure this prevents: a truncated cell leaves the terminal in red and
  // everything printed afterwards — including the next command's output — is
  // red too, until something unrelated happens to reset it.
  const cut = clip(RED("abcdefgh"), 4);
  assert.equal(visible(cut), 4, "the ellipsis still costs exactly one column");
  assert.ok(cut.endsWith("\x1b[0m…"), `expected a reset before the ellipsis, got ${JSON.stringify(cut)}`);
});

test("clip never cuts inside an escape sequence", () => {
  // Half an escape sequence prints as garbage like "[38;2;255" mid-line.
  const cut = clip(RED("abcdefgh"), 5);
  assert.ok(!/\x1b\[[0-9;]*$/.test(cut), "trailing partial escape");
  assert.equal(strip(cut), "abcd…");
});

test("clip returns nothing for a zero or negative width", () => {
  assert.equal(clip("abc", 0), "");
  assert.equal(clip("abc", -3), "");
});

/* ----------------------------------------------------------------- table */

test("table sizes every column to its widest value, header included", () => {
  const out = table(
    [{ sym: "NVDA", n: 92 }, { sym: "F", n: 7 }],
    { columns: [{ key: "sym", header: "ticker" }, { key: "n", header: "score" }], indent: 0 },
  );
  assert.deepEqual(out.split("\n"), [
    "ticker  score",
    "NVDA    92",
    "F       7",
  ]);
});

test("table lines coloured cells up with plain ones", () => {
  // The whole reason this lives in ui.mjs. Two rows, one painted, and the
  // second column has to start at the same screen column in both.
  const out = table(
    [{ a: RED("NVDA"), b: "x" }, { a: "F", b: "y" }],
    { columns: ["a", "b"], indent: 0, header: false },
  );
  const [first, second] = out.split("\n").map((l) => strip(l).indexOf("x") + strip(l).indexOf("y") + 1);
  assert.equal(first, second, "the painted row put its second column somewhere else");
});

test("table accepts rows as arrays, addressed by position", () => {
  const out = table([["a", "bb"], ["ccc", "d"]], { columns: ["one", "two"], indent: 0, header: false });
  assert.deepEqual(out.split("\n"), ["a    bb", "ccc  d"]);
});

test("table leaves no trailing whitespace on a painted final column", () => {
  // Padding a painted last cell puts the spaces *inside* the colour codes,
  // where trimming the finished line cannot reach them. They wrap early in a
  // narrow terminal, so the column is left unpadded instead.
  const out = table(
    [{ a: "x", b: RED("short") }, { a: "y", b: RED("a much longer cell") }],
    { columns: ["a", "b"], indent: 0, header: false },
  );
  for (const line of out.split("\n")) {
    assert.ok(!/\s$/.test(strip(line)), `trailing whitespace in ${JSON.stringify(line)}`);
  }
});

test("table right-aligns a column when asked, including its header", () => {
  const out = table(
    [{ n: "7" }, { n: "1203" }],
    { columns: [{ key: "n", header: "px", align: "right" }], indent: 0 },
  );
  assert.deepEqual(out.split("\n"), ["  px", "   7", "1203"]);
});

test("table caps at max and says how many it dropped", () => {
  // Silently printing 20 of 400 rows reads as "that is all of them".
  const rows = Array.from({ length: 12 }, (_, i) => ({ a: `r${i}` }));
  const out = table(rows, { columns: ["a"], indent: 0, header: false, max: 3 });
  const lines = out.split("\n");
  assert.equal(lines.length, 4);
  assert.match(strip(lines[3]), /… 9 more/);
});

test("table sizes to the rows it prints, not the ones max cut", () => {
  // Sizing to a hidden row leaves a gutter of dead space no cell reaches into.
  const out = table(
    [{ a: "x" }, { a: "an extremely long hidden row" }],
    { columns: ["a"], indent: 0, header: false, max: 1 },
  );
  assert.equal(strip(out.split("\n")[0]), "x");
});

test("table renders empty cells for missing keys rather than the word undefined", () => {
  const out = table([{ a: "x" }], { columns: ["a", "b"], indent: 0, header: false });
  assert.equal(strip(out), "x");
});

test("table with no columns renders nothing", () => {
  assert.equal(table([{ a: 1 }], { columns: [] }), "");
});

test("table with a header rule underlines each column separately", () => {
  const out = table([{ a: "x", b: "yy" }], { columns: ["a", "b"], indent: 0, rule: true });
  // Per column, not one rule across the whole width: the gap between columns
  // stays open, which is what makes the rule read as a set of headings.
  assert.deepEqual(out.split("\n").map(strip), ["a  b", "─  ──", "x  yy"]);
});

/* ----------------------------------------------------------------- panel */

test("panel draws a rectangle — every line the same printable width", () => {
  // A box whose rows disagree is the one defect you cannot not see.
  const out = panel(["short", "a much longer line"], { title: "herd", indent: 0 });
  const widths = new Set(out.split("\n").map(visible));
  assert.equal(widths.size, 1, `ragged box: widths ${[...widths].join(", ")}`);
});

test("panel keeps its rectangle when the title is longer than the body", () => {
  const out = panel(["x"], { title: "a considerably longer title", indent: 0 });
  const widths = new Set(out.split("\n").map(visible));
  assert.equal(widths.size, 1, `ragged box: widths ${[...widths].join(", ")}`);
});

test("panel keeps its rectangle when a body line is painted", () => {
  const out = panel([RED("abc"), "abcdefghij"], { indent: 0 });
  const widths = new Set(out.split("\n").map(visible));
  assert.equal(widths.size, 1, `ragged box: widths ${[...widths].join(", ")}`);
});

test("panel puts the title in the top edge", () => {
  const out = panel(["x"], { title: "herd", indent: 0 });
  assert.match(strip(out.split("\n")[0]), /^╭─ herd ─*╮$/);
});

test("panel accepts a string body and splits it on newlines", () => {
  const out = panel("one\ntwo", { indent: 0 });
  assert.equal(out.split("\n").length, 4, "two body lines plus two edges");
});

/* ---------------------------------------------------------------- charts */

test("sparkline keeps the behaviour it had inside crypto.mjs", () => {
  // Moved verbatim; test/crypto.test.mjs asserts the same three facts through
  // the re-export, and they have to keep agreeing.
  assert.equal(sparkline([5, 5, 5]), "▄▄▄", "a flat series sits mid-band, not on the floor");
  assert.equal(sparkline([]), "");
  assert.equal(sparkline([1, 2, 3]).length, 3);
});

test("sparkline drops values that are not finite numbers", () => {
  // Real series arrive with gaps in them. Note `null` is *not* one of the
  // things dropped — Number(null) is 0, so a gap written as null plots as a
  // trough. That is the behaviour crypto.mjs has always had and this move kept;
  // it is pinned here so a future change to it is a deliberate one.
  assert.equal(sparkline([1, 2, "x", Infinity, undefined]).length, 2);
  assert.equal(sparkline([1, null, 3]).length, 3, "null plots as zero rather than being skipped");
});

test("gauge clamps at both ends", () => {
  // The inputs are real: a quota already overspent, a download reporting more
  // bytes than its own content-length. A bar drawn past its track corrupts
  // whatever is printed to the right of it.
  assert.equal(visible(gauge(2, { max: 1, width: 10, label: false })), 10);
  assert.equal(visible(gauge(-5, { max: 1, width: 10, label: false })), 10);
  assert.equal(strip(gauge(2, { max: 1, width: 10 })), "██████████  100%");
  assert.equal(strip(gauge(-5, { max: 1, width: 10 })), "░░░░░░░░░░  0%");
});

test("gauge survives a zero maximum instead of rendering NaN", () => {
  // An empty queue reports 0 of 0 and would otherwise divide by zero.
  assert.equal(strip(gauge(0, { max: 0, width: 4 })), "░░░░  0%");
});

test("gauge fills proportionally", () => {
  assert.equal(strip(gauge(0.5, { max: 1, width: 10, label: false })), "█████░░░░░");
});
