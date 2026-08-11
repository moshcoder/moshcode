// The moshcode arcade — `/games` in the pit, `moshcode games` from a shell.
//
// Eighteen games, one frame. Every game here is the same shape (see GAME_SHAPE
// below) and is drawn by the same `frame()`, so they look like one arcade
// rather than eighteen weekend projects: a title, a status line, a boxed board, and
// one line of keys along the bottom. There is no menu, no options screen and no
// difficulty prompt — `/games tetris` is already playing by the time the frame
// lands, and `q` is always the way out.
//
// The split is deliberate: the games themselves (games-*.mjs) are pure — create
// a state, hand it a key, hand it a tick, ask it for rows — and everything that
// touches a terminal lives in `runGame` down the bottom. That is what makes an
// arcade testable: test/games.test.mjs plays entire games without a TTY.
import { acid, amber, ash, bone, danger, dim, rgb } from "./ui.mjs";
import { TETRIS } from "./games-tetris.mjs";
import { SNAKE } from "./games-snake.mjs";
import { PACMAN } from "./games-pacman.mjs";
import { TICTACTOE } from "./games-tictactoe.mjs";
import { HANGMAN } from "./games-hangman.mjs";
import { CHESS } from "./games-chess.mjs";
import { ASTEROIDS } from "./games-asteroids.mjs";
import { BLACKJACK } from "./games-blackjack.mjs";
import { STAGEDIVE } from "./games-stagedive.mjs";
import { INVADERS } from "./games-invaders.mjs";
import { BREAKOUT } from "./games-breakout.mjs";
import { PONG } from "./games-pong.mjs";
import { TANK } from "./games-tank.mjs";
import { SPYHUNTER } from "./games-spyhunter.mjs";
import { CENTIPEDE } from "./games-centipede.mjs";
import { FROGGER } from "./games-frogger.mjs";
import { DIGDUG } from "./games-digdug.mjs";
import { KONG } from "./games-kong.mjs";

/**
 * @typedef {object} Game  — the whole contract, so a seventh game is an import.
 * @property {string} key        the name typed after /games
 * @property {string[]} aliases  other spellings (tiktaktoe is a real thing people type)
 * @property {string} title      shown in the frame's header
 * @property {string} blurb      one line, for /games list
 * @property {string} keys       the footer; the only place controls are ever explained
 * @property {number|Function} [tickMs]  real-time games only — a number, or (state) => number
 * @property {boolean} [vim]     false when a game wants h/j/k/l as letters, not arrows
 * @property {boolean} [restartable]  false when `r` is only a restart once the game is over
 * @property {Function} create   ({ rng }) => state
 * @property {Function} onKey    (state, key, { rng }) => state
 * @property {Function} [tick]   (state, { rng }) => state
 * @property {Function} render   (state) => string[]   the board, already coloured
 * @property {Function} status   (state) => string     right of the title
 */

/** The cabinet. Order is the order `/games` lists them. */
export const GAMES = [
  TETRIS, SNAKE, PACMAN, INVADERS, CENTIPEDE, ASTEROIDS, BREAKOUT, PONG, TANK, DIGDUG,
  FROGGER, KONG, SPYHUNTER, STAGEDIVE,
  TICTACTOE, BLACKJACK, CHESS, HANGMAN,
];

/** Games by name, following aliases. Case- and slash-insensitive. */
export function resolveGame(name) {
  const wanted = String(name ?? "").toLowerCase().replace(/^\//, "").replace(/[-_\s]/g, "");
  if (!wanted) return null;
  return GAMES.find((g) => g.key === wanted || (g.aliases || []).includes(wanted)) ?? null;
}

/* ------------------------------------------------------------------- frame */

// Colour codes are invisible but not zero-width to `.length`, so every pad in
// here measures the stripped string. Getting this wrong is how a board's right
// edge ends up ragged the moment someone wins.
const ANSI = /\x1b\[[0-9;]*m/g;
export const strip = (s) => String(s).replace(ANSI, "");
export const visible = (s) => strip(s).length;
const pad = (s, width) => s + " ".repeat(Math.max(0, width - visible(s)));

/**
 * The one frame every game is drawn in.
 *
 * ```
 *   TETRIS                    score 1200 · lines 12
 *   ┌────────────────────┐
 *   │ ██████             │
 *   └────────────────────┘
 *   ← → move · ↑ rotate · space slam · q quit
 * ```
 *
 * Returns a string with no trailing newline; `runGame` owns the cursor.
 */
export function frame({ title = "", status = "", rows = [], keys = "" } = {}) {
  const body = rows.map((r) => String(r));
  // The board sets the width. The header and the key line sit outside the box,
  // so letting either of them stretch it is how a 20-column tetris well ends up
  // in a 54-column frame.
  const inner = Math.max(...body.map(visible), 20);
  const gap = inner - visible(title) - visible(status);
  const head = !visible(status) ? acid(title)
    // Right-align the status to the box edge when there is room for it, and
    // fall back to a caption rather than pushing the board around when a long
    // status (chess, mid-game) would not fit.
    : gap >= 2 ? pad(acid(title), inner - visible(status)) + ash(status)
      : `${acid(title)}  ${ash(status)}`;
  const out = [
    `  ${head}`,
    `  ${ash(`┌${"─".repeat(inner + 2)}┐`)}`,
    ...body.map((row) => `  ${ash("│")} ${pad(row, inner)} ${ash("│")}`),
    `  ${ash(`└${"─".repeat(inner + 2)}┘`)}`,
    `  ${ash(keys)}`,
  ];
  return out.join("\n");
}

/* --------------------------------------------------------------------- keys */

/**
 * Raw terminal bytes → key names the games understand.
 *
 * Games never see an escape sequence; they see "up", "enter", "a". A chunk can
 * hold several keypresses (hold an arrow key down and they arrive in batches),
 * which is why this returns a list.
 *
 * `vim: false` is for the games that read letters — hangman cannot ask for a
 * word with an `h` in it while `h` means left, and blackjack wants `h` to be
 * hit. Arrows are unaffected either way; they arrive as escape sequences.
 */
export function decodeKeys(chunk, { vim = true } = {}) {
  const input = String(chunk);
  const keys = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "\x1b") {
      const seq = input.slice(i, i + 3);
      const arrow = { "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left" }[seq];
      if (arrow) { keys.push(arrow); i += 2; continue; }
      // A bare escape is a quit everywhere in the arcade; a longer sequence we
      // don't know (mouse, function key) is swallowed rather than misread.
      if (input[i + 1] === "[" || input[i + 1] === "O") { i += 2; continue; }
      keys.push("escape");
      continue;
    }
    if (c === "\r" || c === "\n") { keys.push("enter"); continue; }
    if (c === " ") { keys.push("space"); continue; }
    if (c === "\x03" || c === "\x04") { keys.push("quit"); continue; }
    if (c === "\x7f" || c === "\b") { keys.push("backspace"); continue; }
    if (c === "\t") { keys.push("tab"); continue; }
    // vim keys, everywhere, for free — every game that reads arrows gets them
    // without knowing about them. A game that reads letters opts out.
    const vimKey = vim ? { h: "left", j: "down", k: "up", l: "right" }[c] : null;
    if (vimKey) { keys.push(vimKey); continue; }
    if (c >= " " && c <= "~") keys.push(c.toLowerCase());
  }
  return keys;
}

/* -------------------------------------------------------------------- list */

/**
 * `/games` with no argument: the cabinet, and how to start one.
 *
 * `prefix` is how the caller is spelled — the pit says `/games tetris` and a
 * shell says `moshcode games tetris`, and printing the wrong one is how a list
 * teaches somebody a command that does not work where they are standing.
 */
export function renderList({ prefix = "moshcode games" } = {}) {
  const width = Math.max(...GAMES.map((g) => g.key.length));
  return [
    `  ${acid("moshcode arcade")} ${ash(`— ${GAMES.length} games, no menus, no options screens`)}`,
    "",
    ...GAMES.map((g) => `  ${bone(g.key.padEnd(width))}  ${ash(g.blurb)}`),
    "",
    `  ${ash("play one:")} ${acid(`${prefix} ${GAMES[0].key}`)}`,
    `  ${ash("every game: arrows move · q quits · r starts another")}`,
  ].join("\n");
}

/** The same cabinet, for something that cannot read a terminal. */
export function gamesModel() {
  return {
    games: GAMES.map((g) => ({
      name: g.key,
      aliases: g.aliases || [],
      description: g.blurb,
      keys: g.keys,
      realtime: Boolean(g.tickMs),
    })),
  };
}

/* ------------------------------------------------------------------ driver */

const ESC = {
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  up: (n) => (n > 0 ? `\x1b[${n}A` : ""),
  eraseDown: "\x1b[0J",
};

/**
 * Play one game until `q`.
 *
 * Drawn in place rather than on the alternate screen, so the final board — the
 * score, the checkmate, the word you didn't get — stays in the pit's scrollback
 * where you can look at it. Redrawing is "jump back up over the frame and
 * write it again", which is why every frame is the same height.
 */
export async function runGame(game, deps = {}) {
  const {
    input = process.stdin,
    output = process.stdout,
    rng = Math.random,
    // Tests hand in their own clock so a "real-time" game can be played turn by
    // turn, deterministically, with no timers left running after the assertion.
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
  } = deps;

  const ctx = { rng };
  let state = game.create(ctx);
  let height = 0;
  let timer = null;
  let closed = false;

  let painted = null;
  const draw = () => {
    if (closed) return;
    const text = frame({
      title: game.title,
      status: game.status(state),
      rows: game.render(state),
      keys: state.over ? `${game.keys}  ·  ${bone("r")} again` : game.keys,
    });
    // A frame identical to the one already on the screen is not written at all.
    // Chess idles on its clock while it is your move, and repainting the same
    // board twice a second is exactly the flicker that would make it feel busy.
    if (text === painted) return;
    output.write(`${ESC.up(height)}${ESC.eraseDown}${text}\n`);
    painted = text;
    height = text.split("\n").length;
  };

  const stop = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const schedule = () => {
    stop();
    if (!game.tickMs || state.over) return;
    const ms = typeof game.tickMs === "function" ? game.tickMs(state) : game.tickMs;
    timer = setTimer(() => {
      timer = null;
      if (closed || state.over) return;
      state = game.tick(state, ctx) || state;
      draw();
      schedule();
    }, ms);
  };

  const wasRaw = Boolean(input.isRaw);
  const restore = () => {
    if (closed) return;
    closed = true;
    stop();
    output.write(ESC.showCursor);
    try { input.setRawMode?.(wasRaw); } catch { /* already gone */ }
    input.off?.("data", onData);
    input.pause?.();
  };
  const onSignal = () => { restore(); process.exit(130); };

  function onData(chunk) {
    for (const key of decodeKeys(chunk, { vim: game.vim !== false })) {
      if (key === "quit" || key === "q" || key === "escape") { restore(); resolve(); return; }
      if (key === "r" && (state.over || game.restartable !== false)) {
        state = game.create(ctx);
        draw();
        schedule();
        continue;
      }
      if (state.over) continue; // a finished board takes r and q, nothing else
      state = game.onKey(state, key, ctx) || state;
      draw();
      // A key can end a real-time game (a hard drop into the ceiling) or start
      // one moving again, so the clock is re-armed off every keypress.
      if (game.tickMs) schedule();
    }
  }

  let resolve;
  const done = new Promise((res) => { resolve = res; });

  output.write(ESC.hideCursor);
  try { input.setRawMode?.(true); } catch { /* not a tty */ }
  input.setEncoding?.("utf8");
  input.resume?.();
  input.on?.("data", onData);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  draw();
  schedule();
  await done;
  restore();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  output.write(`  ${ash("thanks for playing 🤘")}\n`);
  return 0;
}

/* ----------------------------------------------------------------- command */

/**
 * `/games [name]` in the pit, `moshcode games [name]` from a shell.
 *
 * The two are the same call; only the exit code is read by the CLI. Listing
 * works anywhere, including a pipe — starting a game does not, because raw mode
 * is how every one of them reads a key.
 */
export async function gamesCommand(argv = [], deps = {}) {
  const {
    out = (s) => console.log(s),
    fail = (s) => console.error(s),
    input = process.stdin,
    output = process.stdout,
    interactive = Boolean(input.isTTY && output.isTTY),
    prefix,
    ...rest
  } = deps;

  const args = argv.filter((a) => a !== undefined && a !== null).map(String);
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("-"));
  const [name] = positional;

  if (json && (!name || name === "list")) { out(JSON.stringify(gamesModel(), null, 2)); return 0; }
  if (!name || name === "list" || name === "ls" || name === "games") { out(renderList({ prefix })); return 0; }

  const game = resolveGame(name);
  if (!game) {
    fail(`${danger("✗ ")}no game called "${name}". ${ash(`try: ${GAMES.map((g) => g.key).join(" · ")}`)}`);
    return 1;
  }
  if (!interactive) {
    fail(`${danger("✗ ")}${game.key} needs an interactive terminal — it reads single keypresses.`);
    fail(`${ash("· ")}${ash("run it from the pit, or a real shell — `moshcode games list` works anywhere.")}`);
    return 1;
  }

  return runGame(game, { input, output, ...rest });
}

/* Shared by more than one game, and kept here so they agree on what a wall or a
 * hazard looks like. A game that invents its own palette stops looking like the
 * arcade it is in. */
export const PALETTE = {
  wall: (s) => ash(s),
  empty: (s) => dim(s),
  you: (s) => acid(s),
  prize: (s) => amber(s),
  hazard: (s) => danger(s),
  piece: (s) => bone(s),
  cool: rgb(90, 200, 250),
  violet: rgb(190, 130, 255),
  rose: rgb(255, 120, 180),
};
