// Kong. Girders, ladders, barrels, and a climb you have done before.
//
// The girders here are flat. The originals slope, and a slope is the one thing
// this board cannot honestly draw — a terminal row is a terminal row, and faking
// it with half-blocks would make a game that looks like the arcade and plays
// like a bug report. What the slope actually *does* is kept: each girder has a
// direction, they alternate, and the ladder down sits at the far end of each
// one. So barrels cross a whole girder and drop, and a player climbing the same
// ladders walks every girder the opposite way — which is why you meet them head
// on instead of following them around.
import { acid, amber, ash, bone, danger, rgb } from "./ui.mjs";

export const WIDTH = 34;
export const HEIGHT = 17;

/**
 * Top to bottom: the row, the way barrels roll along it, the column of the
 * ladder barrels come down, and a second ladder that only you use.
 *
 * The second one is not decoration. With a single ladder per girder, the only
 * way up is the chute the barrels fall down, and climbing it is a coin toss you
 * cannot jump out of — the board becomes unplayable rather than hard.
 */
export const GIRDERS = [
  { y: 3, dir: -1, ladder: 3, climb: WIDTH - 12 },
  { y: 6, dir: 1, ladder: WIDTH - 4, climb: 8 },
  { y: 9, dir: -1, ladder: 3, climb: WIDTH - 12 },
  { y: 12, dir: 1, ladder: WIDTH - 4, climb: 8 },
  { y: 15, dir: -1, ladder: null, climb: null },
];

export const TOP = GIRDERS[0].y;
export const FLOOR = GIRDERS[GIRDERS.length - 1].y;

/** Where Kong stands and throws from, and the way out beside him. */
export const KONG_X = WIDTH - 3;
const GOAL_X = WIDTH - 6;

const LIVES = 3;
const JUMP_TICKS = 6;
const kong = rgb(190, 130, 255);

export const girderAt = (y) => GIRDERS.find((g) => g.y === y) ?? null;

/** The ladders, derived from the girders so the two can never disagree. */
export const LADDERS = GIRDERS.slice(0, -1).flatMap((g, i) => (
  [g.ladder, g.climb].map((x) => ({ x, top: g.y, bottom: GIRDERS[i + 1].y, barrels: x === g.ladder }))
));

export const ladderAt = (x, y) => LADDERS.find((l) => l.x === x && y >= l.top && y <= l.bottom) ?? null;

/** A barrel starts at Kong's end of the top girder and works its way down. */
export const newBarrel = () => ({ x: KONG_X, y: TOP, falling: null, jumped: false });

/**
 * One barrel step: along its girder in that girder's direction, and down the
 * ladder at the end of it. Rolling off the bottom girder is how a barrel leaves.
 */
export function rollBarrel(state, barrel) {
  if (barrel.falling !== null) {
    barrel.y += 1;
    if (barrel.y >= barrel.falling) barrel.falling = null;
    return barrel;
  }
  const girder = girderAt(barrel.y);
  if (!girder) { barrel.done = true; return barrel; }
  if (girder.ladder !== null && barrel.x === girder.ladder) {
    // Mostly it takes the ladder; sometimes it carries on and rolls off the end,
    // which is the only thing that makes two barrels behave differently.
    if (state.rng() < 0.8) {
      barrel.falling = GIRDERS[GIRDERS.indexOf(girder) + 1].y;
      return barrel;
    }
  }
  barrel.x += girder.dir;
  if (barrel.x < 0 || barrel.x >= WIDTH) barrel.done = true;
  return barrel;
}

function lose(state, why) {
  state.lives--;
  if (state.lives <= 0) {
    state.lives = 0;
    state.over = `${why} · ${state.score} points`;
    return state;
  }
  state.player = { x: 1, y: FLOOR, jump: 0 };
  state.barrels = [];
  return state;
}

/** Barrels roll this often, and a level makes them quicker. */
export const rollEvery = (state) => Math.max(2, 5 - Math.floor(state.level / 2));
export const throwEvery = (state) => Math.max(14, 40 - state.level * 5);

/** One tick. Exported so a test can climb the whole board with no clock. */
export function step(state) {
  state.clock++;
  if (state.player.jump > 0) state.player.jump--;

  if (state.clock % rollEvery(state) === 0) {
    for (const barrel of state.barrels) rollBarrel(state, barrel);
    state.barrels = state.barrels.filter((b) => !b.done);
  }
  if (state.clock % throwEvery(state) === 0) state.barrels.push(newBarrel());

  for (const barrel of state.barrels) {
    if (barrel.x !== state.player.x || barrel.y !== state.player.y) continue;
    // A barrel you are in the air over is a barrel you have jumped.
    if (!state.player.jump) return lose(state, "flattened by a barrel");
    if (!barrel.jumped) { barrel.jumped = true; state.score += 100; }
  }

  if (state.player.y === TOP && state.player.x >= GOAL_X) {
    state.level++;
    state.score += 1000;
    state.player = { x: 1, y: FLOOR, jump: 0 };
    state.barrels = [];
  }
  return state;
}

export const KONG = {
  key: "kong",
  aliases: ["dk", "barrels", "climb"],
  title: "KONG",
  blurb: "five girders, four ladders, and a barrel with your name on it",
  keys: "← → walk · ↑ ↓ ladders · space jump · q quit",
  tickMs: 60,

  create({ rng = Math.random } = {}) {
    return {
      player: { x: 1, y: FLOOR, jump: 0 },
      barrels: [],
      score: 0,
      lives: LIVES,
      level: 1,
      clock: 0,
      over: null,
      rng,
    };
  },

  tick: step,

  onKey(state, pressed) {
    const p = state.player;
    if (pressed === "space" || pressed === "enter") {
      if (!p.jump) p.jump = JUMP_TICKS;
      return state;
    }
    if (pressed === "left" && p.x > 0) p.x -= 1;
    else if (pressed === "right" && p.x < WIDTH - 1) p.x += 1;
    else if (pressed === "up" || pressed === "down") {
      // Ladders are the only way between girders, and you have to be standing on
      // one to use it.
      const ladder = ladderAt(p.x, p.y);
      if (!ladder) return state;
      const next = pressed === "up" ? p.y - 1 : p.y + 1;
      if (next >= ladder.top && next <= ladder.bottom) p.y = next;
    }
    return state;
  },

  status(state) {
    return state.over
      ? state.over
      : `${state.score} · level ${state.level} · ${"▲".repeat(state.lives)}`;
  },

  render(state) {
    const grid = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => null));
    const put = (x, y, glyph) => {
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      grid[y][x] = glyph;
    };

    for (const girder of GIRDERS) for (let x = 0; x < WIDTH; x++) put(x, girder.y, ash("═"));
    for (const ladder of LADDERS) {
      for (let y = ladder.top; y <= ladder.bottom; y++) put(ladder.x, y, bone("╫"));
    }
    put(KONG_X, TOP - 1, kong("♜"));
    put(GOAL_X, TOP - 1, amber("♥"));

    for (const barrel of state.barrels) put(barrel.x, barrel.y, danger("◍"));
    const p = state.player;
    put(p.x, p.jump ? p.y - 1 : p.y, state.over ? danger("✷") : acid(p.jump ? "⌃" : "◉"));

    return grid.map((row) => row.map((cell) => cell ?? " ").join(""));
  },
};
