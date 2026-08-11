// Frogger. Five lanes of traffic that kill you if they touch you, then five of
// river that kill you if they don't.
//
// That inversion is the whole game and it is worth stating plainly in the code:
// on the road, being on something is death; on the river, being on nothing is.
// Everything else here — the lanes, the hops, the homes — is bookkeeping.
import { acid, amber, ash, bone, danger, dim, rgb } from "./ui.mjs";

export const WIDTH = 40;

/**
 * The board, bottom to top. Row 0 is the top (the homes), and the frog starts
 * on the bank at the bottom.
 */
export const HOME_ROW = 0;
export const RIVER = [1, 2, 3, 4, 5];
export const MEDIAN = 6;
export const ROAD = [7, 8, 9, 10, 11];
export const BANK = 12;
export const HEIGHT = BANK + 1;

/** Five places to get to, evenly spaced along the top. */
export const HOMES = [3, 11, 19, 27, 35];
const HOME_W = 3;

const LIVES = 3;
const water = rgb(60, 130, 220);
const log = rgb(150, 100, 60);

/** Each lane: which way it runs, how fast, and how thick the things in it are. */
export const LANES = {
  1: { dir: 1, speed: 0.16, len: 4, gap: 11, kind: "log" },
  2: { dir: -1, speed: 0.22, len: 3, gap: 9, kind: "turtle" },
  3: { dir: 1, speed: 0.13, len: 6, gap: 14, kind: "log" },
  4: { dir: -1, speed: 0.28, len: 3, gap: 10, kind: "turtle" },
  5: { dir: 1, speed: 0.2, len: 5, gap: 13, kind: "log" },
  7: { dir: -1, speed: 0.26, len: 2, gap: 9, kind: "car" },
  8: { dir: 1, speed: 0.19, len: 3, gap: 11, kind: "truck" },
  9: { dir: -1, speed: 0.33, len: 2, gap: 12, kind: "car" },
  10: { dir: 1, speed: 0.15, len: 4, gap: 13, kind: "truck" },
  11: { dir: -1, speed: 0.24, len: 2, gap: 10, kind: "car" },
};

const ART = {
  car: { paint: danger, art: "▄▄▄▄▄▄" },
  truck: { paint: amber, art: "██████" },
  log: { paint: log, art: "▓▓▓▓▓▓" },
  turtle: { paint: acid, art: "◠◠◠◠◠◠" },
};

/** Every lane laid out end to end, evenly spaced. */
export function buildTraffic() {
  const things = [];
  for (const [row, lane] of Object.entries(LANES)) {
    for (let x = 0; x < WIDTH + lane.gap; x += lane.gap) {
      things.push({ row: Number(row), x, len: lane.len, kind: lane.kind });
    }
  }
  return things;
}

/** The thing under a cell, if there is one. */
export const thingAt = (things, row, x) => things.find(
  (t) => t.row === row && x >= Math.round(t.x) && x < Math.round(t.x) + t.len,
) ?? null;

/** Which home a frog at `x` has reached, or -1. */
export const homeAt = (x) => HOMES.findIndex((h) => x >= h && x < h + HOME_W);

const start = () => ({ x: Math.floor(WIDTH / 2), row: BANK });

function drown(state, why) {
  state.lives--;
  if (state.lives <= 0) {
    state.lives = 0;
    state.over = `${why} · ${state.score} points`;
    return state;
  }
  state.frog = start();
  return state;
}

/** One tick. Exported so a test can get a frog home with no clock. */
export function step(state) {
  for (const thing of state.traffic) {
    const lane = LANES[thing.row];
    thing.x += lane.dir * lane.speed;
    if (thing.x > WIDTH + 2) thing.x = -thing.len - 2;
    if (thing.x < -thing.len - 2) thing.x = WIDTH + 2;
  }

  const frog = state.frog;
  if (RIVER.includes(frog.row)) {
    // The river carries you. Riding a log off the edge of the world still
    // counts as losing the frog, which is the lesson every player learns twice.
    const ride = thingAt(state.traffic, frog.row, Math.round(frog.drift ?? frog.x));
    if (!ride) return drown(state, "into the river");
    frog.drift = (frog.drift ?? frog.x) + LANES[frog.row].dir * LANES[frog.row].speed;
    frog.x = Math.round(frog.drift);
    if (frog.x < 0 || frog.x >= WIDTH) return drown(state, "carried off the edge");
  } else if (ROAD.includes(frog.row)) {
    if (thingAt(state.traffic, frog.row, frog.x)) return drown(state, "flattened");
  }
  return state;
}

/** Hop, and settle what the frog landed on. */
export function hop(state, dx, dy) {
  const frog = state.frog;
  const row = Math.min(BANK, Math.max(HOME_ROW, frog.row + dy));
  const x = Math.min(WIDTH - 1, Math.max(0, frog.x + dx));
  frog.row = row;
  frog.x = x;
  frog.drift = RIVER.includes(row) ? x : null;

  if (row === HOME_ROW) {
    const home = homeAt(x);
    if (home < 0 || state.homes[home]) {
      // The bank between the homes is not a home, and neither is one you have
      // already filled.
      return drown(state, "nowhere to land");
    }
    state.homes[home] = true;
    state.score += 100;
    if (state.homes.every(Boolean)) {
      state.level++;
      state.homes = HOMES.map(() => false);
      state.score += 500;
    }
    state.frog = start();
    return state;
  }
  if (dy < 0) state.score += 10; // forwards only, so hopping on the spot pays nothing
  return step(state);
}

export const FROGGER = {
  key: "frogger",
  aliases: ["frog", "hop"],
  title: "FROGGER",
  blurb: "the road kills what it touches, the river kills what it doesn't",
  keys: "← ↑ ↓ → hop · q quit",
  tickMs: 60,

  create() {
    return {
      traffic: buildTraffic(),
      frog: start(),
      homes: HOMES.map(() => false),
      score: 0,
      lives: LIVES,
      level: 1,
      over: null,
    };
  },

  tick: step,

  onKey(state, pressed) {
    const moves = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
    const move = moves[pressed];
    if (!move) return state;
    return hop(state, move[0], move[1]);
  },

  status(state) {
    return state.over
      ? state.over
      : `${state.score} · level ${state.level} · ${state.homes.filter(Boolean).length}/5 home · ${"▲".repeat(state.lives)}`;
  },

  render(state) {
    const grid = Array.from({ length: HEIGHT }, (_, row) => Array.from({ length: WIDTH }, () => (
      RIVER.includes(row) ? water("░") : ROAD.includes(row) ? dim("·") : null
    )));
    const put = (x, y, glyph) => {
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      grid[y][x] = glyph;
    };

    for (const [i, home] of HOMES.entries()) {
      for (let j = 0; j < HOME_W; j++) put(home + j, HOME_ROW, state.homes[i] ? acid("▓") : ash("▒"));
    }
    for (const thing of state.traffic) {
      const { paint, art } = ART[thing.kind];
      for (let i = 0; i < thing.len; i++) put(Math.round(thing.x) + i, thing.row, paint(art[i % art.length]));
    }
    put(state.frog.x, state.frog.row, state.over ? danger("✷") : bone("◉"));

    return grid.map((row, y) => row.map((cell) => (
      cell ?? (y === MEDIAN || y === BANK ? ash("═") : " ")
    )).join(""));
  },
};
