// `moshcode rss` — the reader's frame and its keys.
//
// The frame is asserted rather than eyeballed for one specific reason: the
// screen is repainted by clearing and writing, so a frame that is not exactly
// as tall as the terminal either leaves the previous frame's tail on screen or
// scrolls the terminal and tears every line below it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  decodeKeys, renderReader, rssUi, sidebarRows, visibleItems, visibleWidth, wrap,
} from "../src/rss-ui.mjs";
import { loadFeeds } from "../src/news.mjs";

const NOW = Date.parse("2026-08-11T12:00:00Z");

/** A feed for the argument tests to subscribe to. */
const FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example Wire</title>
  <link>https://a.example</link>
  <item><title>A story</title><link>https://a.example/1</link></item>
</channel></rss>`;

function state(overrides = {}) {
  return {
    feeds: [
      { name: "wire", title: "Example Wire", url: "https://a.example/rss" },
      { name: "atom", title: "Atom Daily", url: "https://b.example/rss" },
    ],
    usingDefaults: false,
    query: null,
    items: [
      { title: "First story", feed: "wire", feedTitle: "Example Wire", date: NOW - 3_600_000, summary: "A summary", author: "", link: "https://a.example/1" },
      { title: "Second story", feed: "atom", feedTitle: "Atom Daily", date: NOW - 7_200_000, summary: "", author: "R. Eporter", link: "https://b.example/2" },
    ],
    failures: [],
    selected: 0,
    offset: 0,
    sideSelected: 0,
    sideOffset: 0,
    filter: null,
    pane: "list",
    mode: "browse",
    input: "",
    loading: false,
    now: NOW,
    ...overrides,
  };
}

/** The frame with colour stripped, for matching against plain text. */
const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

// --- the frame ---------------------------------------------------------------

test("a frame is exactly as tall as the terminal, whatever is in it", () => {
  for (const rows of [10, 24, 60]) {
    assert.equal(renderReader(state(), { rows, cols: 100 }).length, rows,
      `a ${rows}-row terminal got a frame of the wrong height`);
  }
  // An empty reader and a loading one must not collapse the frame either.
  assert.equal(renderReader(state({ items: [], loading: true }), { rows: 24, cols: 100 }).length, 24);
  assert.equal(renderReader(state({ items: [] }), { rows: 24, cols: 100 }).length, 24);
});

test("no line is wider than the terminal — one that is would wrap and tear the layout", () => {
  const long = state({
    items: [{ title: "x".repeat(400), feed: "wire", date: NOW, summary: "y".repeat(400), link: `https://e.example/${"z".repeat(300)}` }],
  });
  for (const pane of ["list", "article"]) {
    for (const cols of [60, 80, 132]) {
      for (const line of renderReader({ ...long, pane }, { rows: 20, cols })) {
        assert.ok(visibleWidth(line) <= cols, `${pane} pane at ${cols} cols produced a ${visibleWidth(line)}-wide line`);
      }
    }
  }
});

test("the header counts what is on show and names where it came from", () => {
  assert.match(plain(renderReader(state(), { rows: 24, cols: 100 })), /2 headlines · all feeds/);
  assert.match(plain(renderReader(state({ usingDefaults: true }), { rows: 24, cols: 100 })), /default feeds/);
  assert.match(plain(renderReader(state({ query: "tariffs" }), { rows: 24, cols: 100 })), /“tariffs”/);
  assert.match(plain(renderReader(state({ filter: "wire" }), { rows: 24, cols: 100 })), /1 headline · wire/);
});

test("failing feeds are visible in the header rather than silently absent", () => {
  const frame = plain(renderReader(state({ failures: [{ name: "down", error: "timed out" }] }), { rows: 24, cols: 100 }));
  assert.match(frame, /1 feed down/);
});

test("the sidebar counts per feed, with an all row on top", () => {
  assert.deepEqual(sidebarRows(state()), [
    { key: null, label: "all", count: 2 },
    { key: "wire", label: "wire", count: 1 },
    { key: "atom", label: "atom", count: 1 },
  ]);
});

test("a filter narrows the headlines and nothing else", () => {
  assert.deepEqual(visibleItems(state({ filter: "wire" })).map((i) => i.title), ["First story"]);
  assert.deepEqual(visibleItems(state()).map((i) => i.title), ["First story", "Second story"]);
});

test("the article pane shows the story, its source, and the link to open", () => {
  const frame = plain(renderReader(state({ pane: "article", selected: 1 }), { rows: 24, cols: 100 }));
  assert.match(frame, /Second story/);
  assert.match(frame, /Atom Daily/);
  assert.match(frame, /by R\. Eporter/);
  assert.match(frame, /https:\/\/b\.example\/2/);
  // The list's keys would be wrong here, so the footer changes with the pane.
  assert.match(frame, /back/);
});

test("the search prompt replaces the key hints while it is up", () => {
  const frame = plain(renderReader(state({ mode: "search", input: "tarif" }), { rows: 24, cols: 100 }));
  assert.match(frame, /search: tarif/);
  assert.match(frame, /esc cancel/);
});

test("an empty listing explains itself instead of showing a blank column", () => {
  const frame = plain(renderReader(state({ items: [], failures: [{ name: "down", error: "timed out" }] }), { rows: 24, cols: 100 }));
  assert.match(frame, /nothing here/);
  assert.match(frame, /down — timed out/);
});

// --- text --------------------------------------------------------------------

test("width ignores the colour codes ui.mjs wraps text in", () => {
  assert.equal(visibleWidth("\x1b[38;2;158;240;26mabc\x1b[39m"), 3);
  assert.equal(visibleWidth("abc"), 3);
});

test("wrapping breaks on words, and a word longer than the pane is split, not cut", () => {
  assert.deepEqual(wrap("one two three four", 9), ["one two", "three", "four"]);
  // Split rather than truncated: the over-long word is usually the link, and
  // half a link is not a link.
  assert.deepEqual(wrap("x".repeat(25), 10), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  assert.equal(wrap("x".repeat(25), 10).join(""), "x".repeat(25));
  assert.deepEqual(wrap("", 10), []);
  assert.deepEqual(wrap("keep https://e.example/" + "z".repeat(30), 20).join("").replace(/\s/g, ""),
    "keephttps://e.example/" + "z".repeat(30));
  for (const line of wrap("a ".repeat(200), 40)) assert.ok(line.length <= 40);
});

// --- keys --------------------------------------------------------------------

test("arrows, enter and control keys decode to names", () => {
  assert.deepEqual(decodeKeys("\x1b[A"), [{ kind: "key", name: "up" }]);
  assert.deepEqual(decodeKeys("\x1b[B"), [{ kind: "key", name: "down" }]);
  assert.deepEqual(decodeKeys("\x1b[5~"), [{ kind: "key", name: "pageup" }]);
  assert.deepEqual(decodeKeys("\r"), [{ kind: "key", name: "enter" }]);
  assert.deepEqual(decodeKeys("\x7f"), [{ kind: "key", name: "backspace" }]);
  assert.deepEqual(decodeKeys("\x03"), [{ kind: "key", name: "ctrl-c" }]);
  assert.deepEqual(decodeKeys("\x1b"), [{ kind: "key", name: "escape" }]);
});

test("an arrow is one key, not an escape followed by two letters", () => {
  // The whole reason sequences are matched longest-first: decoding ESC [ A as
  // three keys would quit on the "A" of a cursor key.
  assert.deepEqual(decodeKeys("\x1b[A\x1b[B"), [
    { kind: "key", name: "up" },
    { kind: "key", name: "down" },
  ]);
});

test("typed characters carry their character, so the search box can collect them", () => {
  assert.deepEqual(decodeKeys("hi"), [
    { kind: "key", name: "h", char: "h" },
    { kind: "key", name: "i", char: "i" },
  ]);
});

test("a mouse report is a mouse event, and never also a keystroke", () => {
  // "M" and "m" live inside every SGR report; leaking them as keys would make
  // clicking the screen type letters into the search box.
  assert.deepEqual(decodeKeys("\x1b[<0;10;5M"), [{ kind: "click", col: 10, row: 5 }]);
  assert.deepEqual(decodeKeys("\x1b[<64;1;1M"), [{ kind: "wheel", direction: -1 }]);
  assert.deepEqual(decodeKeys("\x1b[<65;1;1M"), [{ kind: "wheel", direction: 1 }]);
  assert.deepEqual(decodeKeys("\x1b[<0;10;5m"), []); // release, not a second click
});

// --- the command line --------------------------------------------------------

/** A non-TTY stdin/stdout, so only the paths that avoid the reader can run. */
function pipes() {
  return { stdin: { isTTY: false }, stdout: { isTTY: false } };
}

test("`rss add <url>` subscribes instead of searching for the words", async () => {
  // The bug this exists to stop: every argument was read as a search phrase, so
  // `/rss add https://…` opened a reader on the literal text "add https://…"
  // and silently subscribed to nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-rss-"));
  const env = { MOSHCODE_NEWS_OPML: path.join(dir, "news.opml") };
  const lines = [];

  const code = await rssUi(["add", "https://a.example/rss"], {
    ...pipes(),
    env,
    write: (s) => lines.push(String(s)),
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => FEED }),
  });

  assert.equal(code, 0);
  assert.deepEqual(loadFeeds(env).map((f) => f.url), ["https://a.example/rss"]);
  assert.match(lines.join("\n"), /subscribed/);
});

test("management verbs run without a terminal; reading still needs one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-rss-"));
  const env = { MOSHCODE_NEWS_OPML: path.join(dir, "news.opml") };
  const lines = [];
  const write = (s) => lines.push(String(s));

  assert.equal(await rssUi(["list"], { ...pipes(), env, write }), 0);
  // Nothing subscribed yet, so this is the defaults standing in — the point is
  // that it printed the list at all rather than demanding a terminal.
  assert.match(lines.join("\n"), /nothing subscribed yet/);

  // The reader itself is still refused rather than rendered into a pipe.
  const reading = [];
  const code = await rssUi([], { ...pipes(), env, write: (s) => reading.push(String(s)) });
  assert.equal(code, 1);
  assert.match(reading.join("\n"), /needs an interactive terminal/);
});

test("`rss search` looks for feeds to add, not for headlines", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-rss-"));
  const env = { MOSHCODE_NEWS_OPML: path.join(dir, "news.opml") };
  const lines = [];
  const fetched = [];

  const code = await rssUi(["search", "example,rust"], {
    ...pipes(),
    env,
    write: (s) => lines.push(String(s)),
    fetchImpl: async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, text: async () => "https://example.com/feed.xml\n" };
    },
  });

  assert.equal(code, 0);
  // It read the published lists, not a news search engine.
  assert.equal(fetched.some((u) => u.includes("news.google.com")), false);
  assert.match(lines.join("\n"), /example\.com\/feed\.xml/);
});

test("`rss search` with no keyword says how to use it", async () => {
  const lines = [];
  const code = await rssUi(["search"], { ...pipes(), write: (s) => lines.push(String(s)) });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /usage: moshcode rss search/);
});
