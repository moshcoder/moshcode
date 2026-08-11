// OutRun. A road drawn in perspective, a clock that is always losing, and a
// checkpoint that gives you a bit of it back.
//
// This is the one game in the cabinet that fakes a third dimension, and it does
// it the way the eighties did: the road is not an object, it is a rule for
// drawing each row. Rows near the top are far away, so the tarmac is narrow
// there and the bend is wide; rows near the bottom are under your bumper, so the
// tarmac is wide and dead centre. Nothing is ever transformed — `roadHalf` and
// `centreAt` are the whole renderer, and the same two functions decide what you
// have hit.
import { acid, bone, danger, dim, rgb } from "./ui.mjs";

export const WIDTH = 48;
export const HEIGHT = 16;

const NEAR_HALF = 20;   // half the road's width under your bumper
const FAR_HALF = 3;     // and up at the horizon
const BEND = 15;        // how far a full-lock corner throws the far end sideways

const MAX_SPEED = 1.9;
const ACCEL = 0.06;
const BRAKE = 0.12;
const DRAG = 0.012;
const OFF_ROAD = 0.55;  // the fastest you will ever go with two wheels on the grass
const DRIFT = 0.5;      // how hard a corner pushes you towards the outside
const START_TIME = 900; // ticks
const CHECKPOINT = 320; // and how far apart the checkpoints are
const CHECK_BONUS = 220; // flat out, a checkpoint takes about 170 ticks to reach

const grass = rgb(60, 140, 70);
const road = rgb(90, 90, 95);

/** How far from the middle the tarmac reaches on a given row. */
export const roadHalf = (row) => {
  const p = (row + 1) / HEIGHT;
  return FAR_HALF + (NEAR_HALF - FAR_HALF) * p ** 1.7;
};

/**
 * Where the middle of the road is on a given row.
 *
 * The bend is squared against distance so it opens up towards the horizon and
 * closes to nothing under the car — which is exactly what a corner looks like
 * from the driver's seat, and why the bottom row never moves.
 */
export const centreAt = (row, curve) => {
  const p = (row + 1) / HEIGHT;
  return WIDTH / 2 + curve * BEND * (1 - p) ** 2;
};

export const PLAYER_ROW = HEIGHT - 1;
export const CAR_W = 3;

/** A stretch of road: how long it runs, and how hard it bends. */
export function nextSegment(rng) {
  return { left: 40 + Math.floor(rng() * 60), curve: (rng() * 2 - 1) * (rng() < 0.35 ? 1 : 0.45) };
}

/** Whether the car is on the tarmac at all. */
export const onRoad = (x, curve) => Math.abs(x - centreAt(PLAYER_ROW, curve)) <= roadHalf(PLAYER_ROW) - 1;

/** Where a car at depth `z` (1 at the horizon, 0 at your bumper) is drawn. */
export const rowAt = (z) => Math.round(PLAYER_ROW - z * (PLAYER_ROW - 1));

function spin(state) {
  state.speed = 0;
  state.spins++;
  state.stunned = 30;
  return state;
}

/** One tick of road. Exported so a test can drive the whole stage with no clock. */
export function step(state) {
  state.clock--;
  if (state.clock <= 0) {
    state.clock = 0;
    state.over = `time up · ${Math.round(state.dist)} miles`;
    return state;
  }
  if (state.stunned > 0) state.stunned--;

  // The road ahead, one segment at a time, eased towards rather than snapped to.
  state.segment.left -= state.speed;
  if (state.segment.left <= 0) state.segment = nextSegment(state.rng);
  state.curve += (state.segment.curve - state.curve) * 0.04;

  state.speed = Math.max(0, state.speed - DRAG);
  const off = !onRoad(state.car, state.curve);
  if (off) state.speed = Math.min(state.speed, OFF_ROAD);
  if (state.stunned) state.speed = Math.min(state.speed, 0.2);

  state.dist += state.speed;
  // A corner throws you at the outside of it. Steering is how you stay in.
  state.car += state.curve * state.speed * DRIFT;
  state.car = Math.max(0, Math.min(WIDTH - 1, state.car));

  for (const car of state.traffic) car.z -= (state.speed - car.speed) * 0.012;
  state.traffic = state.traffic.filter((c) => c.z > -0.05 && c.z < 1.2);
  if (state.traffic.length < 3 && state.rng() < 0.03) {
    state.traffic.push({ z: 1.1, lane: state.rng() * 1.4 - 0.7, speed: 0.35 + state.rng() * 0.5 });
  }

  if (!state.stunned) {
    const hit = state.traffic.find((c) => {
      if (c.z > 0.08) return false;
      const at = centreAt(PLAYER_ROW, state.curve) + c.lane * roadHalf(PLAYER_ROW);
      return Math.abs(at - state.car) < CAR_W;
    });
    if (hit) {
      state.traffic = state.traffic.filter((c) => c !== hit);
      spin(state);
    }
  }

  if (state.dist >= state.nextCheck) {
    state.nextCheck += CHECKPOINT;
    state.clock += CHECK_BONUS;
    state.checks++;
    state.score += 1000;
  }
  state.score += Math.floor(state.dist) - state.scored;
  state.scored = Math.floor(state.dist);
  return state;
}

export const OUTRUN = {
  key: "outrun",
  aliases: ["run", "coast", "racer"],
  title: "OUTRUN",
  blurb: "a road that bends, traffic that doesn't, and a clock that always wins",
  keys: "← → steer · ↑ throttle · ↓ brake · q quit",
  tickMs: 55,

  create({ rng = Math.random } = {}) {
    return {
      car: WIDTH / 2,
      speed: 0,
      curve: 0,
      segment: nextSegment(rng),
      traffic: [],
      dist: 0,
      scored: 0,
      nextCheck: CHECKPOINT,
      checks: 0,
      clock: START_TIME,
      stunned: 0,
      spins: 0,
      score: 0,
      over: null,
      rng,
    };
  },

  tick: step,

  onKey(state, pressed) {
    if (pressed === "left") state.car -= 0.9;
    else if (pressed === "right") state.car += 0.9;
    else if (pressed === "up") state.speed = Math.min(MAX_SPEED, state.speed + ACCEL * 4);
    else if (pressed === "down") state.speed = Math.max(0, state.speed - BRAKE * 2);
    state.car = Math.max(0, Math.min(WIDTH - 1, state.car));
    return state;
  },

  status(state) {
    if (state.over) return state.over;
    const kph = Math.round(state.speed * 120);
    return `${kph} kph · ${Math.round(state.clock / 20)}s · check ${state.checks} · ${Math.round(state.dist)} mi`;
  },

  render(state) {
    const grid = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => null));
    const put = (x, y, glyph) => {
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      grid[y][x] = glyph;
    };

    for (const car of state.traffic) {
      const row = rowAt(car.z);
      if (row < 1 || row > PLAYER_ROW) continue;
      const at = centreAt(row, state.curve) + car.lane * roadHalf(row);
      // Cars shrink with distance, the same way the road does.
      const w = Math.max(1, Math.round(CAR_W * ((row + 1) / HEIGHT)));
      for (let i = 0; i < w; i++) put(Math.round(at) - Math.floor(w / 2) + i, row, danger("▀"));
    }

    const nose = state.stunned ? danger("✷") : acid("▟▙");
    put(Math.round(state.car) - 1, PLAYER_ROW, state.stunned ? nose : acid("▟"));
    put(Math.round(state.car), PLAYER_ROW, state.stunned ? nose : acid("█"));
    put(Math.round(state.car) + 1, PLAYER_ROW, state.stunned ? nose : acid("▙"));

    return grid.map((row, y) => {
      const centre = centreAt(y, state.curve);
      const half = roadHalf(y);
      return row.map((cell, x) => {
        if (cell) return cell;
        const from = centre - half;
        const to = centre + half;
        if (x < from || x > to) return grass("░");
        // Kerbs, and a centre line that moves with you so the road runs.
        if (x < from + 1 || x > to - 1) return ((y + Math.floor(state.dist)) % 4 < 2 ? bone : danger)("│");
        const middle = Math.round(centre);
        if (x === middle && (y + Math.floor(state.dist * 1.5)) % 4 < 2) return dim("┆");
        return road(" ");
      }).join("");
    });
  },
};
