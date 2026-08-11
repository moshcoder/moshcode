// Spy Hunter. A road that will not hold still, traffic that will not get out of
// the way, and a gun. Stay on the tarmac, shoot the ones shooting back, and do
// not shoot the ones just driving home.
//
// The road is a list of rows, each one a left and a right edge, scrolled down
// under a car that only ever moves sideways. Generating the next row from the
// last one — rather than from a function of distance — is what makes the verge
// bend instead of zig-zag, and it is the only reason it reads as a road.
import { acid, amber, ash, bone, danger, dim } from "./ui.mjs";

export const WIDTH = 40;
export const HEIGHT = 18;

/** The row your car is on. It never changes; the road comes to you. */
export const CAR_ROW = HEIGHT - 3;
export const CAR_W = 2;

const MIN_ROAD = 13;
const MAX_ROAD = 24;
const BASE_SPEED = 0.34;   // rows of road per tick
const MAX_SPEED = 0.75;
const LIVES = 3;
const GRACE = 25;          // ticks of "the road is clear" after a wreck
const SHOT_SPEED = 1.6;    // rows per tick, travelled in halves so nothing is skipped

/** The cars that are not you. */
export const TRAFFIC = {
  enemy: { art: "▜▛", paint: danger, points: 50, homing: 0.06 },
  civilian: { art: "▐▌", paint: bone, points: -100, homing: 0 },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The next row of road, bent a little from the one before it.
 *
 * The bend is random but pulled towards the middle of the screen, in proportion
 * to how far out it already is. A drift with no pull is a random walk, and a
 * random walk parks the road against one edge and leaves it there — which looks
 * less like a road than like a bug.
 */
export function nextRow(prev, rng) {
  const width = clamp(prev.right - prev.left + (rng() < 0.3 ? (rng() < 0.5 ? -1 : 1) : 0), MIN_ROAD, MAX_ROAD);
  const centre = (prev.left + prev.right) / 2;
  const pull = clamp((WIDTH / 2 - centre) / 8, -0.45, 0.45);
  const roll = rng() * 2 - 1 + pull;
  const drift = Math.abs(roll) < 0.55 ? 0 : Math.sign(roll);
  // One cell of verge on each side always stays on screen, so "the road bends"
  // never reads as "the road ends".
  const left = clamp(prev.left + drift, 1, WIDTH - width - 2);
  return { left, right: left + width };
}

/** A straight run of road to start on, so the first thing you meet is not a bend. */
export function openRoad() {
  const left = Math.floor((WIDTH - 20) / 2);
  return Array.from({ length: HEIGHT }, () => ({ left, right: left + 20 }));
}

export const onRoad = (row, x) => row && x >= row.left && x + CAR_W - 1 <= row.right;

/** Whether two cars, each CAR_W wide, are in the same place. */
export const overlaps = (ax, bx) => Math.abs(Math.round(ax) - Math.round(bx)) < CAR_W;

function wreck(state, why) {
  state.lives--;
  if (state.lives <= 0) {
    state.lives = 0;
    state.over = `${why} · ${state.score} points`;
    return state;
  }
  // A wreck clears the road ahead, or you respawn straight into the car that
  // just got you and lose the rest of your lives in three ticks.
  state.traffic = [];
  state.grace = GRACE;
  const row = state.road[CAR_ROW];
  state.car = Math.round((row.left + row.right) / 2) - 1;
  return state;
}

/** One tick of road. Exported so a test can drive a whole run with no clock. */
export function step(state) {
  const { rng } = state;
  state.dist += state.speed;
  state.speed = Math.min(MAX_SPEED, BASE_SPEED + state.dist / 900);
  if (state.grace > 0) state.grace--;

  // Scroll: the road only shifts on whole rows, so the verge never shimmers.
  state.scroll += state.speed;
  while (state.scroll >= 1) {
    state.scroll -= 1;
    state.road.pop();
    state.road.unshift(nextRow(state.road[0], rng));
    for (const car of state.traffic) car.y += 1;
    for (const shot of state.shots) shot.y += 1;
  }

  // Shots move faster than a car is tall, so they travel in half-steps and are
  // checked against the traffic after each one. Moving the whole way in one go
  // lets a shot pass clean through a car that was between the two positions.
  for (let half = 0; half < 2; half++) {
    for (const shot of state.shots) shot.y -= SHOT_SPEED / 2;
    hitTraffic(state);
  }
  state.shots = state.shots.filter((shot) => shot.y > -1);

  for (const car of state.traffic) {
    car.y += state.speed - car.speed;
    // An enemy leans towards you; traffic just drives.
    if (TRAFFIC[car.kind].homing) {
      car.x += Math.sign(state.car - car.x) * TRAFFIC[car.kind].homing;
    }
    const row = state.road[Math.round(car.y)];
    if (row) car.x = clamp(car.x, row.left, row.right - CAR_W + 1);
  }
  state.traffic = state.traffic.filter((car) => car.y < HEIGHT + 1 && car.y > -3);

  if (!state.grace) {
    const row = state.road[CAR_ROW];
    if (!onRoad(row, state.car)) return wreck(state, "off the road");
    const rammed = state.traffic.find((car) => Math.round(car.y) === CAR_ROW && overlaps(car.x, state.car));
    if (rammed) return wreck(state, `rammed ${rammed.kind === "enemy" ? "an enemy" : "a civilian"}`);
  }

  if (!state.grace && state.traffic.length < 4 && rng() < 0.05) {
    const row = state.road[0];
    const kind = rng() < 0.6 ? "enemy" : "civilian";
    state.traffic.push({
      kind,
      x: row.left + Math.floor(rng() * (row.right - row.left - CAR_W + 1)),
      y: 0,
      // Slower than you, or the road behind would never catch anybody up.
      speed: 0.1 + rng() * 0.18,
    });
  }

  state.score += Math.floor(state.dist / 10) - state.miles;
  state.miles = Math.floor(state.dist / 10);
  return state;
}

/** Shots meet traffic. A civilian you shoot is a civilian you pay for. */
function hitTraffic(state) {
  for (const shot of [...state.shots]) {
    const hit = state.traffic.find((car) => Math.abs(car.y - shot.y) < 0.9 && overlaps(car.x, shot.x - 0.5));
    if (!hit) continue;
    state.shots = state.shots.filter((s) => s !== shot);
    state.traffic = state.traffic.filter((c) => c !== hit);
    state.score = Math.max(0, state.score + TRAFFIC[hit.kind].points);
  }
  return state;
}

export const SPYHUNTER = {
  key: "spyhunter",
  aliases: ["spy", "chase", "hunter"],
  title: "SPY HUNTER",
  blurb: "keep it on the tarmac, shoot the ones shooting back",
  keys: "← → steer · space fire · q quit",
  tickMs: 55,

  create({ rng = Math.random } = {}) {
    const road = openRoad();
    return {
      road,
      traffic: [],
      shots: [],
      car: Math.round((road[CAR_ROW].left + road[CAR_ROW].right) / 2) - 1,
      speed: BASE_SPEED,
      scroll: 0,
      dist: 0,
      miles: 0,
      score: 0,
      lives: LIVES,
      grace: 0,
      over: null,
      rng,
    };
  },

  tick: step,

  onKey(state, key) {
    if (key === "left") state.car -= 1;
    else if (key === "right") state.car += 1;
    else if (key === "space" || key === "up" || key === "enter") {
      if (state.shots.length < 3) state.shots.push({ x: state.car + 0.5, y: CAR_ROW - 1 });
    }
    // Steering off the edge of the screen is a wreck like any other, so the car
    // is only kept on the board, not on the road.
    state.car = clamp(state.car, 0, WIDTH - CAR_W);
    return state;
  },

  status(state) {
    if (state.over) return state.over;
    return `${state.score} · ${state.miles} mi · ${"▲".repeat(state.lives)}`;
  },

  render(state) {
    const grid = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => null));
    const put = (x, y, glyph) => {
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      grid[y][x] = glyph;
    };

    for (const car of state.traffic) {
      const kind = TRAFFIC[car.kind];
      [...kind.art].forEach((c, i) => put(Math.round(car.x) + i, Math.round(car.y), kind.paint(c)));
    }
    for (const shot of state.shots) put(Math.round(shot.x), Math.round(shot.y), amber("•"));
    if (state.over) {
      [...("✷✷")].forEach((c, i) => put(state.car + i, CAR_ROW, danger(c)));
    } else if (!state.grace || Math.floor(state.grace / 3) % 2) {
      [...("▟▙")].forEach((c, i) => put(state.car + i, CAR_ROW, acid(c)));
    }

    return grid.map((row, y) => {
      const edge = state.road[y];
      return row.map((cell, x) => {
        if (cell) return cell;
        if (x < edge.left || x > edge.right) return ash("▒");
        // The centre line, dashed, and moving — without it the road is a
        // stationary corridor and you cannot tell you are going anywhere.
        const middle = Math.round((edge.left + edge.right) / 2);
        return x === middle && (y + Math.floor(state.dist)) % 4 < 2 ? dim("┆") : " ";
      }).join("");
    });
  },
};
