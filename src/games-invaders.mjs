// Space Invaders. Forty of them, coming down a row at a time, and the fewer are
// left the faster the rest move — which is the joke the original hardware told by
// accident and every version since has kept on purpose.
//
// Nothing here moves on a fraction of a cell. The fleet steps a whole column at
// a time on a counter, shots move a whole row per tick, and every hit is one
// grid cell against another. A game whose whole tension is "will it get to the
// bottom before I do" should never lose a shot to a rounding error.
import { acid, amber, ash, bone, danger, dim, rgb } from "./ui.mjs";

export const WIDTH = 44;
export const HEIGHT = 16;

export const ROWS = 5;
export const COLS = 8;
const PITCH_X = 4;     // an alien is two cells wide, with two between them
// One row per rank. At two the fleet stood nine rows tall on a board with eleven
// above the bunkers, so it "landed" after two drops and no wave was survivable.
const PITCH_Y = 1;

export const CANNON_ROW = HEIGHT - 2;
const FLOOR_ROW = HEIGHT - 1;
export const BUNKER_ROW = HEIGHT - 4;
const LIVES = 3;
const BOMB_EVERY = 2;  // bombs fall on every other tick, so they can be dodged
const SHOT_SPEED = 2;  // rows per tick — a slow shot makes the whole game a queue

/** Top rows are worth more, and look meaner. */
export const KINDS = [
  { art: "▛▜", points: 30, paint: rgb(190, 130, 255) },
  { art: "▛▜", points: 20, paint: rgb(90, 200, 250) },
  { art: "▙▟", points: 20, paint: acid },
  { art: "▙▟", points: 10, paint: amber },
  { art: "▞▚", points: 10, paint: ash },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Where an alien sits, given the fleet's corner. */
export const alienAt = (fleet, row, col) => ({
  x: fleet.x + col * PITCH_X,
  y: fleet.y + row * PITCH_Y,
});

export const aliveCount = (fleet) => fleet.alive.reduce((n, row) => n + row.filter(Boolean).length, 0);

/**
 * How many ticks between steps. Forty aliens crawl; the last one sprints. This
 * is the entire difficulty curve of the game and it costs one line.
 */
export const cadence = (fleet) => Math.max(2, Math.round(aliveCount(fleet) / 2.4));

const newFleet = (wave) => ({
  x: 3,
  y: 1 + Math.min(3, wave - 1), // each wave starts closer to the floor
  dir: 1,
  alive: Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => true)),
  clock: 0,
});

/** Four bunkers, each cell able to take two hits before it is gone. */
export function buildBunkers() {
  const bunkers = new Map();
  for (let b = 0; b < 4; b++) {
    const left = 5 + b * 10;
    for (let i = 0; i < 5; i++) bunkers.set(left + i, 2);
  }
  return bunkers;
}

/** Chip a bunker cell, and say whether there was one there to chip. */
export function chip(bunkers, x, y) {
  if (y !== BUNKER_ROW) return false;
  const hp = bunkers.get(x);
  if (!hp) return false;
  if (hp <= 1) bunkers.delete(x); else bunkers.set(x, hp - 1);
  return true;
}

/** The lowest live alien in each column — the only ones that can drop a bomb. */
export function frontLine(fleet) {
  const front = [];
  for (let col = 0; col < COLS; col++) {
    for (let row = ROWS - 1; row >= 0; row--) {
      if (fleet.alive[row][col]) { front.push({ row, col }); break; }
    }
  }
  return front;
}

/** Whether a shot at (x, y) hits an alien, and which one. */
export function alienHit(fleet, x, y) {
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!fleet.alive[row][col]) continue;
      const at = alienAt(fleet, row, col);
      if (y === at.y && x >= at.x && x <= at.x + 1) return { row, col };
    }
  }
  return null;
}

function marchFleet(state) {
  const fleet = state.fleet;
  const cols = [];
  for (let col = 0; col < COLS; col++) if (fleet.alive.some((row) => row[col])) cols.push(col);
  if (!cols.length) return state;
  const leftMost = fleet.x + cols[0] * PITCH_X;
  const rightMost = fleet.x + cols[cols.length - 1] * PITCH_X + 1;

  if ((fleet.dir > 0 && rightMost >= WIDTH - 1) || (fleet.dir < 0 && leftMost <= 0)) {
    fleet.dir *= -1;
    fleet.y += 1;
  } else {
    fleet.x += fleet.dir;
  }

  // The fleet landing is the loss condition, and it beats having lives left.
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (fleet.alive[row][col] && alienAt(fleet, row, col).y >= BUNKER_ROW) {
        state.over = `the fleet landed · ${state.score} points`;
        return state;
      }
    }
  }
  return state;
}

/** One tick. Exported so a test can clear a wave with no clock. */
export function step(state) {
  const { rng } = state;

  // The shot climbs a row at a time even though it covers two, so it can never
  // skip over the row an alien is standing on.
  for (let i = 0; i < SHOT_SPEED && state.shot; i++) {
    state.shot.y -= 1;
    if (state.shot.y < 0) { state.shot = null; break; }
    if (chip(state.bunkers, state.shot.x, state.shot.y)) { state.shot = null; break; }
    const hit = alienHit(state.fleet, state.shot.x, state.shot.y);
    if (!hit) continue;
    state.fleet.alive[hit.row][hit.col] = false;
    state.score += KINDS[hit.row].points;
    state.shot = null;
    if (!aliveCount(state.fleet)) {
      state.wave++;
      state.fleet = newFleet(state.wave);
      state.bombs = [];
      return state;
    }
  }

  state.tick++;
  if (state.tick % BOMB_EVERY === 0) {
    for (const bomb of state.bombs) bomb.y += 1;
    state.bombs = state.bombs.filter((bomb) => {
      if (chip(state.bunkers, bomb.x, bomb.y)) return false;
      if (bomb.y >= FLOOR_ROW) return false;
      if (bomb.y === CANNON_ROW && Math.abs(bomb.x - state.cannon) <= 1) {
        state.lives--;
        if (state.lives <= 0) { state.lives = 0; state.over = `out of cannons · ${state.score} points`; }
        return false;
      }
      return true;
    });
  }
  if (state.over) return state;

  // Somebody on the front line lets one go, more often the fewer are left.
  const front = frontLine(state.fleet);
  if (front.length && state.bombs.length < 3 && rng() < 0.02 + (COLS - front.length) * 0.004) {
    const from = front[Math.floor(rng() * front.length) % front.length];
    const at = alienAt(state.fleet, from.row, from.col);
    state.bombs.push({ x: at.x, y: at.y + 1 });
  }

  state.fleet.clock++;
  if (state.fleet.clock >= cadence(state.fleet)) {
    state.fleet.clock = 0;
    marchFleet(state);
  }
  return state;
}

export const INVADERS = {
  key: "invaders",
  aliases: ["spaceinvaders", "space", "aliens"],
  title: "SPACE INVADERS",
  blurb: "forty of them, and the last one moves fastest",
  keys: "← → move · space fire · q quit",
  tickMs: 55,

  create({ rng = Math.random } = {}) {
    return {
      fleet: newFleet(1),
      bunkers: buildBunkers(),
      cannon: Math.floor(WIDTH / 2),
      shot: null,
      bombs: [],
      score: 0,
      lives: LIVES,
      wave: 1,
      tick: 0,
      over: null,
      rng,
    };
  },

  tick: step,

  onKey(state, key) {
    if (key === "left") state.cannon = clamp(state.cannon - 1, 1, WIDTH - 2);
    else if (key === "right") state.cannon = clamp(state.cannon + 1, 1, WIDTH - 2);
    else if (key === "space" || key === "up" || key === "enter") {
      // One shot in the air at a time. Everything about the pacing of this game
      // comes from that single rule.
      if (!state.shot) state.shot = { x: state.cannon, y: CANNON_ROW - 1 };
    }
    return state;
  },

  status(state) {
    return state.over
      ? state.over
      : `${state.score} · wave ${state.wave} · ${"▲".repeat(state.lives)}`;
  },

  render(state) {
    const grid = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => null));
    const put = (x, y, glyph) => {
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      grid[y][x] = glyph;
    };

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        if (!state.fleet.alive[row][col]) continue;
        const at = alienAt(state.fleet, row, col);
        const kind = KINDS[row];
        [...kind.art].forEach((c, i) => put(at.x + i, at.y, kind.paint(c)));
      }
    }

    for (const [x, hp] of state.bunkers) put(x, BUNKER_ROW, hp > 1 ? acid("█") : dim("▓"));
    for (const bomb of state.bombs) put(bomb.x, bomb.y, danger("╽"));
    if (state.shot) put(state.shot.x, state.shot.y, bone("│"));

    if (state.over) {
      put(state.cannon, CANNON_ROW, danger("✷"));
    } else {
      [...("▟█▙")].forEach((c, i) => put(state.cannon - 1 + i, CANNON_ROW, acid(c)));
    }

    return grid.map((row, y) => row.map((cell) => (
      cell ?? (y === FLOOR_ROW ? ash("═") : " ")
    )).join(""));
  },
};
