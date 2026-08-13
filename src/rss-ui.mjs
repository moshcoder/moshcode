// `moshcode rss` — the headlines as a place you can sit in.
//
// `/news` prints a list and gives the terminal back, which is the right shape
// for "what happened" and the wrong one for reading. This is the same data as
// somewhere you point at: feeds down the left, headlines in the middle, the
// story itself in place of the list when you pick one.
//
// The same terminal discipline as src/herd-ui.mjs, and for the same reasons:
// no dependencies, alternate screen and SGR mouse reporting written by hand,
// and every escape sequence undone in a single restore path so a crash cannot
// leave a terminal with no cursor and the mouse still captured.
//
// Rendering is a pure function of state (`renderReader`), so a frame can be
// asserted in a test without a tty, a fetch, or a keystroke.
import { parseMouse } from "./herd-ui.mjs";
import { acid, amber, ash, bone, danger, dim } from "./ui.mjs";
import {
  ago,
  collectNews,
  findFeed,
  newsCommand,
  readingList,
  resolveVerb,
  searchFeeds,
  wrap,
} from "./news.mjs";

// Written here, and moved to news.mjs when the plain listing needed the same
// wrapping — re-exported so the name this module published stays where callers
// and tests already look for it.
export { wrap };

/**
 * Verbs `/rss` hands straight to `moshcode news`.
 *
 * Everything that manages the subscription list rather than reading it. They
 * print and exit, so they work with no TTY — which is why this runs before the
 * interactive-terminal check.
 */
const MANAGEMENT_VERBS = new Set(["add", "rm", "list", "lists", "find", "sources", "export", "open"]);

const ESC = {
  altOn: "\x1b[?1049h", altOff: "\x1b[?1049l",
  hideCursor: "\x1b[?25l", showCursor: "\x1b[?25h",
  mouseOn: "\x1b[?1000h\x1b[?1006h", mouseOff: "\x1b[?1006l\x1b[?1000l",
  clear: "\x1b[2J\x1b[H",
};

/** Columns given to the feed sidebar, and the fixed chrome around the list. */
const SIDEBAR = 20;
const HEADER_LINES = 2; // title + rule
const FOOTER_LINES = 2; // rule + keys

/** Printable width, ignoring the SGR sequences ui.mjs wraps text in. */
export function visibleWidth(text) {
  return String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Pad to `width` printable columns, colour codes not counted. */
function pad(text, width) {
  const short = width - visibleWidth(text);
  return short > 0 ? text + " ".repeat(short) : text;
}

/** Truncate to `width` printable columns. Only ever called on uncoloured text. */
function clip(text, width) {
  const s = String(text ?? "");
  return s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;
}

/**
 * Decode a chunk of raw-mode input.
 *
 * herd-ui's parseInput is deliberately narrow — it answers a nine-key screen —
 * so this reads the keys a reader needs instead of widening that one and
 * changing what the herd list responds to. Mouse reports are shared, because
 * SGR decoding has exactly one correct answer.
 */
export function decodeKeys(buffer) {
  const events = [];
  // Mouse reports are removed from the text, not merely read out of it. A
  // release (`…m`) decodes to no event at all, so leaving the sequence behind
  // would hand `[ < 0 ; 1 0 ; 5 m` to the key decoder below — which, with the
  // search box open, types the mouse position into the query.
  const text = String(buffer).replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, (sequence) => {
    const parsed = parseMouse(sequence);
    if (parsed) events.push(parsed);
    return "";
  });
  if (!text) return events;

  // Escape sequences first, longest first, so ESC [ A is an arrow rather than
  // an escape followed by two letters.
  const SEQUENCES = [
    ["\x1b[A", "up"], ["\x1b[B", "down"], ["\x1b[C", "right"], ["\x1b[D", "left"],
    ["\x1b[5~", "pageup"], ["\x1b[6~", "pagedown"],
    ["\x1b[H", "home"], ["\x1b[F", "end"],
  ];
  let i = 0;
  while (i < text.length) {
    const seq = SEQUENCES.find(([code]) => text.startsWith(code, i));
    if (seq) { events.push({ kind: "key", name: seq[1] }); i += seq[0].length; continue; }
    const ch = text[i];
    if (ch === "\x1b") { events.push({ kind: "key", name: "escape" }); i += 1; continue; }
    if (ch === "\r" || ch === "\n") { events.push({ kind: "key", name: "enter" }); i += 1; continue; }
    if (ch === "\x7f" || ch === "\b") { events.push({ kind: "key", name: "backspace" }); i += 1; continue; }
    if (ch === "\x03") { events.push({ kind: "key", name: "ctrl-c" }); i += 1; continue; }
    events.push({ kind: "key", name: ch, char: ch });
    i += 1;
  }
  return events;
}

/**
 * What a headline is grouped and filtered by.
 *
 * The feed it came from, except on a search — there every result arrives on the
 * one search feed, so grouping by feed puts all of them in a single row called
 * "bing" and the sidebar becomes a label rather than a filter. The publisher is
 * the useful split instead.
 *
 * Only on a search, because the reverse is worse the rest of the time: a feed
 * like Hacker News links out to a different host on nearly every item, so
 * grouping subscribed feeds by publisher would replace thirteen feed names with
 * several hundred one-item rows.
 */
export function groupOf(state, item) {
  return (state.query ? item.host || item.feed : item.feed) || "";
}

/** Feeds down the left, with a count each and an "all" row on top. */
export function sidebarRows(state) {
  const counts = new Map();
  for (const item of state.items) {
    const key = groupOf(state, item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const rows = [{ key: null, label: "all", count: state.items.length }];
  if (state.query) {
    // Publishers, busiest first — there is no subscription order to fall back
    // on, and the site that carried five of the results is the one worth seeing.
    for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      if (key) rows.push({ key, label: key, count });
    }
    return rows;
  }
  for (const feed of state.feeds) {
    rows.push({ key: feed.name, label: feed.name, count: counts.get(feed.name) || 0 });
  }
  return rows;
}

/** The headlines currently on show — everything, or one feed's (one publisher's, on a search). */
export function visibleItems(state) {
  return state.filter ? state.items.filter((i) => groupOf(state, i) === state.filter) : state.items;
}

/**
 * One frame, as an array of exactly `rows` lines.
 *
 * Exactly, not at most: the screen is repainted by clearing and writing, so a
 * short frame leaves the tail of the previous one on screen and a long one
 * scrolls the terminal and tears the whole layout.
 */
export function renderReader(state, { rows = 24, cols = 80 } = {}) {
  const width = Math.max(60, cols);
  const bodyHeight = Math.max(3, rows - HEADER_LINES - FOOTER_LINES);
  const listWidth = width - SIDEBAR - 3;
  const out = [];

  // Header ------------------------------------------------------------------
  const items = visibleItems(state);
  const where = state.query ? `“${state.query}”`
    : state.filter ? state.filter
    : state.usingDefaults ? "default feeds" : "all feeds";
  // The quote pages collectNews set aside are counted here too — a reader that
  // hides results without saying so is a reader you cannot trust the count of.
  const aside = state.skipped ? ` · ${state.skipped} quote page${state.skipped === 1 ? "" : "s"} skipped` : "";
  const title = `  ${bone("moshcode rss")}${ash(`   ${items.length} headline${items.length === 1 ? "" : "s"} · ${where}${aside}`)}`;
  const status = state.loading ? acid("loading…")
    : state.failures.length ? amber(`${state.failures.length} feed${state.failures.length === 1 ? "" : "s"} down`)
    : "";
  out.push(pad(title, width - visibleWidth(status) - 2) + status + "  ");
  out.push(`  ${dim("─".repeat(Math.max(10, width - 4)))}`);

  // Body --------------------------------------------------------------------
  const side = sidebarRows(state);
  const bodyLines = state.pane === "article"
    ? articleLines(state, { width: width - 4, height: bodyHeight })
    : listLines(state, items, { width: listWidth, height: bodyHeight });

  for (let row = 0; row < bodyHeight; row++) {
    if (state.pane === "article") { out.push(bodyLines[row] ?? ""); continue; }
    const feedRow = side[row + state.sideOffset];
    let left = "";
    if (feedRow) {
      const selected = state.pane === "feeds" && row + state.sideOffset === state.sideSelected;
      const active = (feedRow.key ?? null) === (state.filter ?? null);
      const cursor = selected ? acid("▸") : " ";
      // 2 indent + cursor + space + label + space + 3 count = SIDEBAR exactly.
      // Building it one wider than the column it is padded into is how every
      // body row ends up a column past the edge of the terminal.
      const label = clip(feedRow.label, SIDEBAR - 8);
      const paint = active ? bone : ash;
      left = `  ${cursor} ${paint(pad(label, SIDEBAR - 8))} ${dim(String(feedRow.count).padStart(3))}`;
    }
    out.push(`${pad(left, SIDEBAR)} ${dim("│")} ${bodyLines[row] ?? ""}`);
  }

  // Footer ------------------------------------------------------------------
  out.push(`  ${dim("─".repeat(Math.max(10, width - 4)))}`);
  out.push(`  ${keyHint(state, width - 4)}`);
  return out.slice(0, rows);
}

/**
 * The footer, trimmed to fit.
 *
 * Hints are dropped from the right until the line fits the terminal, rather
 * than being allowed to run past it — a footer one column too wide wraps onto a
 * line the frame did not budget for, which scrolls the screen and puts every
 * row of the next frame one off. They are ordered least-guessable first, so
 * what survives on a narrow terminal is what someone could not have guessed.
 */
function keyHint(state, width) {
  if (state.mode === "search") {
    const prompt = `${ash("search:")} ${bone(state.input)}${acid("▏")}`;
    const help = dim("   ⏎ run · esc cancel");
    return visibleWidth(prompt + help) <= width ? prompt + help : prompt;
  }
  const keys = state.pane === "article"
    ? [["⏎/esc", "back"], ["o", "open"], ["j/k", "next/prev"], ["q", "quit"]]
    : [["↑↓", "move"], ["⏎", "read"], ["o", "open"], ["/", "search"], ["tab", "feeds"], ["r", "refresh"], ["q", "quit"]];

  const sep = dim("  ·  ");
  let line = "";
  for (const [key, what] of keys) {
    const next = (line ? line + sep : "") + `${acid(key)} ${ash(what)}`;
    if (visibleWidth(next) > width) break;
    line = next;
  }
  return line;
}

/** The headline list, as `height` lines. */
function listLines(state, items, { width, height }) {
  if (state.loading && !items.length) return [ash("fetching feeds…")];
  if (!items.length) {
    const lines = [ash("nothing here")];
    if (state.failures.length) {
      lines.push("", amber(`${state.failures.length} feed${state.failures.length === 1 ? "" : "s"} didn't answer:`));
      for (const f of state.failures.slice(0, height - 3)) lines.push(`  ${dim(`${f.name} — ${f.error}`)}`);
    }
    return lines;
  }
  const window = items.slice(state.offset, state.offset + height);
  // One tail column for the whole viewport, so the feed names line up instead
  // of ending wherever each headline happens to stop. Capped at half the pane
  // so a feed with a long name cannot squeeze the headline out of its own list,
  // and the title takes whatever is left — floored at nothing, because a floor
  // above the available width is how a line ends up wider than the terminal.
  const tails = window.map((item) => {
    const when = ago(item.date, state.now);
    return `${groupOf(state, item)}${when ? ` · ${when}` : ""}`.trim();
  });
  const tailWidth = Math.min(Math.max(0, ...tails.map((t) => t.length)), Math.floor(width / 2));
  const room = Math.max(1, width - tailWidth - 4);

  return window.map((item, i) => {
    const selected = state.offset + i === state.selected;
    const cursor = selected ? acid("▸") : " ";
    const title = pad(clip(item.title, room), room);
    const tail = clip(tails[i], tailWidth).padStart(tailWidth);
    return `${cursor} ${selected ? bone(title) : ash(title)}  ${dim(tail)}`;
  });
}

/** The selected story, as `height` lines. */
function articleLines(state, { width, height }) {
  const items = visibleItems(state);
  const item = items[state.selected];
  if (!item) return [ash("nothing selected")];
  const lines = [""];
  for (const line of wrap(item.title, width - 4)) lines.push(`  ${bone(line)}`);
  lines.push("");
  const when = item.date ? `${new Date(item.date).toLocaleString()} · ${ago(item.date, state.now)}` : "no date";
  lines.push(`  ${ash(`${item.feedTitle || item.feed} · ${when}`)}`);
  if (item.author) lines.push(`  ${ash(`by ${item.author}`)}`);
  lines.push("");
  if (item.summary) {
    for (const line of wrap(item.summary, width - 4)) lines.push(`  ${ash(line)}`);
    lines.push("");
  }
  // Wrapped, not clipped: this is the line someone copies out of the reader.
  if (item.link) for (const line of wrap(item.link, width - 4)) lines.push(`  ${acid(line)}`);
  else lines.push(`  ${dim("this item has no link")}`);
  return lines.slice(0, height);
}

/** Keep the selection inside the list, and the viewport around the selection. */
function clampView(state, height) {
  const items = visibleItems(state);
  state.selected = Math.max(0, Math.min(state.selected, Math.max(0, items.length - 1)));
  if (state.selected < state.offset) state.offset = state.selected;
  if (state.selected >= state.offset + height) state.offset = state.selected - height + 1;
  state.offset = Math.max(0, Math.min(state.offset, Math.max(0, items.length - height)));
}

/**
 * Run the reader. Returns a process exit code.
 *
 * `deps` mirrors herdUi's: injectable stdin/stdout and an injectable fetch, so
 * the loop can be driven in a test with no terminal and no network.
 */
export async function rssUi(argv = [], deps = {}) {
  const {
    stdin = process.stdin,
    stdout = process.stdout,
    fetchImpl,
    openUrl,
    env = process.env,
    write = (s) => process.stdout.write(`${s}\n`),
  } = deps;

  const args = (Array.isArray(argv) ? argv : []).map(String);
  const words = args.filter((a) => !a.startsWith("-"));
  const verb = resolveVerb(words[0]);

  // Managing subscriptions is the same work under either name, and `/rss add
  // <url>` is what people type — the reader is where you are when you decide to
  // subscribe to something. Handing these to newsCommand rather than reading
  // them as a search is the whole difference between `/rss add <url>` working
  // and it silently opening a reader on the literal phrase "add <url>".
  //
  // `search` is deliberately not among them. On `/news` it searches headlines;
  // here it searches the published lists for feeds to add, because a reader
  // already has `/` for searching what it is showing.
  if (verb && MANAGEMENT_VERBS.has(verb)) {
    return newsCommand(args, { fetchImpl, openUrl, env, out: write, fail: write });
  }
  if (verb === "search") {
    const keywords = words.slice(1).join(" ").trim();
    if (!keywords) { write("usage: moshcode rss search <keyword[,keyword…]>"); return 1; }
    return newsCommand(["find", ...words.slice(1)], { fetchImpl, openUrl, env, out: write, fail: write });
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    write("moshcode rss needs an interactive terminal — try `moshcode news`");
    return 1;
  }

  // A query on the command line (`moshcode rss tariffs`) opens straight into
  // the search, which is the same shape `/news <keyword>` has. `latest` is the
  // verb for "no query", so it is dropped rather than searched for.
  const query = (verb === "latest" ? "" : words.join(" ")).trim();
  const list = readingList(env);

  const state = {
    feeds: query ? searchFeeds(query) : list.feeds,
    usingDefaults: query ? false : list.usingDefaults,
    query: query || null,
    items: [],
    failures: [],
    skipped: 0,
    selected: 0,
    offset: 0,
    sideSelected: 0,
    sideOffset: 0,
    filter: null,
    pane: "list",
    mode: "browse",
    input: "",
    loading: true,
    now: Date.now(),
  };

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

  const height = () => Math.max(3, (stdout.rows || 24) - HEADER_LINES - FOOTER_LINES);
  const draw = () => {
    if (done) return;
    clampView(state, height());
    stdout.write(ESC.clear + renderReader(state, { rows: stdout.rows || 24, cols: stdout.columns || 80 }).join("\r\n"));
  };

  const load = async () => {
    state.loading = true;
    draw();
    const { items, failures, skipped } = await collectNews(state.feeds, { fetchImpl });
    state.items = items;
    state.failures = failures;
    state.skipped = skipped || 0;
    state.now = Date.now();
    state.loading = false;
    state.selected = 0;
    state.offset = 0;
    draw();
  };

  enter();
  draw();
  const onResize = () => draw();
  stdout.on("resize", onResize);
  await load();

  await new Promise((resolve) => {
    const onData = async (buf) => {
      for (const event of decodeKeys(buf)) {
        if (done) return;

        // The search prompt owns every key while it is up, or typing "q" into
        // it would quit instead of searching for the letter q.
        if (state.mode === "search") {
          if (event.kind !== "key") continue;
          if (event.name === "escape") { state.mode = "browse"; state.input = ""; draw(); continue; }
          if (event.name === "backspace") { state.input = state.input.slice(0, -1); draw(); continue; }
          if (event.name === "enter") {
            const q = state.input.trim();
            state.mode = "browse";
            state.input = "";
            if (!q) { draw(); continue; }
            state.query = q;
            state.feeds = searchFeeds(q);
            state.usingDefaults = false;
            state.filter = null;
            state.pane = "list";
            await load();
            continue;
          }
          if (event.char && event.char >= " ") { state.input += event.char; draw(); }
          continue;
        }

        if (event.kind === "wheel") {
          state.selected += event.direction;
          draw();
          continue;
        }
        if (event.kind === "click") {
          // Row 1-2 are the header, so the first list row is line 3.
          const index = state.offset + (event.row - HEADER_LINES - 1);
          if (event.col <= SIDEBAR) {
            const side = sidebarRows(state)[state.sideOffset + (event.row - HEADER_LINES - 1)];
            if (side) { state.filter = side.key; state.selected = 0; state.offset = 0; state.pane = "list"; draw(); }
            continue;
          }
          const items = visibleItems(state);
          if (index >= 0 && index < items.length) {
            // A single click selects; a second on the same row reads it — the
            // rule herd-ui settled on, so one stray click is never a trip.
            const opening = index === state.selected && state.pane === "list";
            state.selected = index;
            state.pane = opening ? "article" : "list";
            draw();
          }
          continue;
        }
        if (event.kind !== "key") continue;

        const name = event.name;
        if (name === "q" || name === "ctrl-c") { done = true; resolve(); return; }

        if (state.pane === "article") {
          if (name === "enter" || name === "escape" || name === "left" || name === "h") { state.pane = "list"; draw(); continue; }
          if (name === "j" || name === "down") { state.selected += 1; draw(); continue; }
          if (name === "k" || name === "up") { state.selected -= 1; draw(); continue; }
        }

        if (name === "/") { state.mode = "search"; state.input = ""; draw(); continue; }
        if (name === "r") { await load(); continue; }
        if (name === "tab" || name === "\t") {
          state.pane = state.pane === "feeds" ? "list" : "feeds";
          draw();
          continue;
        }

        // The sidebar has its own selection, so it has to claim the movement
        // keys before the headline list does — otherwise tab would highlight a
        // feed and j/k would scroll the headlines beside it.
        if (state.pane === "feeds") {
          const side = sidebarRows(state);
          const move = (delta) => {
            state.sideSelected = Math.max(0, Math.min(state.sideSelected + delta, side.length - 1));
            const rows = height();
            if (state.sideSelected < state.sideOffset) state.sideOffset = state.sideSelected;
            if (state.sideSelected >= state.sideOffset + rows) state.sideOffset = state.sideSelected - rows + 1;
            draw();
          };
          if (name === "j" || name === "down") { move(1); continue; }
          if (name === "k" || name === "up") { move(-1); continue; }
          if (name === "g" || name === "home") { state.sideSelected = 0; state.sideOffset = 0; draw(); continue; }
          if (name === "G" || name === "end") { move(side.length); continue; }
          if (name === "enter" || name === "right" || name === "l") {
            const row = side[state.sideSelected];
            state.filter = row ? row.key : null;
            state.selected = 0;
            state.offset = 0;
            state.pane = "list";
            draw();
            continue;
          }
          if (name === "escape") { state.pane = "list"; draw(); continue; }
          continue;
        }

        if (name === "j" || name === "down") { state.selected += 1; draw(); continue; }
        if (name === "k" || name === "up") { state.selected -= 1; draw(); continue; }
        if (name === "pagedown" || name === " ") { state.selected += height(); draw(); continue; }
        if (name === "pageup") { state.selected -= height(); draw(); continue; }
        if (name === "g" || name === "home") { state.selected = 0; draw(); continue; }
        if (name === "G" || name === "end") { state.selected = visibleItems(state).length - 1; draw(); continue; }
        if (name === "enter") { state.pane = "article"; draw(); continue; }
        if (name === "o") {
          const item = visibleItems(state)[state.selected];
          if (!item?.link) continue;
          // The browser gets the terminal only for as long as the opener runs;
          // a headless box just falls through with nothing opened.
          const opened = openUrl ? openUrl(item.link) : false;
          if (!opened) {
            restore();
            write(`open this in a browser:\n  ${item.link}`);
            enter();
          }
          draw();
          continue;
        }
        if (name === "a") { state.filter = null; state.selected = 0; draw(); continue; }
      }
    };
    stdin.on("data", onData);
  });

  stdout.off("resize", onResize);
  restore();
  process.off("exit", restore);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  stdout.write("\n");
  return 0;
}
