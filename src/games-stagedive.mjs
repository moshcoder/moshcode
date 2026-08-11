// Stagedive. You are running the barricade, the stage is coming at you, and it
// does not stop. Hop the monitor wedges and the amp stacks, duck the
// crowdsurfers, take the picks. One mistake is the whole run.
//
// A side-scroller in a terminal is really a scrolling list: the runner never
// moves along the x axis at all. Everything else slides left past a fixed
// column, which is why `speed` is measured in columns per tick and why the gap
// between hazards is multiplied by it — a jump lasts a fixed number of ticks, so
// a fair gap has to get longer as the stage gets faster.
import { acid, amber, ash, bone, danger, dim, rgb } from "./ui.mjs";

export const WIDTH = 50;
export const HEIGHT = 9;

/** The row the runner's feet are on, and the stage edge under it. */
export const GROUND = 7;
const FLOOR = GROUND + 1;

/** The runner's column. It never changes — the stage moves, not you. */
export const RUNNER = 8;

const BASE_SPEED = 0.85;
const MAX_SPEED = 1.75;
const GRAVITY = 0.15;
const JUMP = -1.3;    // ~5 rows up and ~17 ticks in the air
const DUCK_TICKS = 8; // a tap of ↓ stays crouched this long, so a repeat holds it
const SLAM = 0.7;     // ↓ in mid-air comes down early, which is how you save a bad jump

const crowd = rgb(255, 120, 180);

/**
 * What is on the stage. `art` is one row's worth of cells and `rows` is which
 * rows it fills, so its width and its hitbox are the same number by
 * construction — a hazard that is drawn wider than it hits is the oldest bug in
 * the genre. `death` is what the status line says when it gets you.
 */
export const HAZARDS = {
  wedge: { art: "██", rows: [GROUND], paint: ash, death: "tripped over a monitor wedge" },
  stack: { art: "███", rows: [GROUND - 1, GROUND], paint: bone, death: "ran into an amp stack" },
  // Head height: a standing runner wears it, a crouched one does not.
  surfer: { art: "╾●╼", rows: [GROUND - 1], paint: crowd, death: "wore a crowdsurfer" },
};

const PICK = amber("♦");

/** The cells a thing covers, so a hit is decided by what the screen showed. */
export function cells(thing) {
  const x = Math.round(thing.x);
  if (thing.kind === "pick") return { cols: [x, x], rows: [thing.row] };
  const { art, rows } = HAZARDS[thing.kind];
  return { cols: [x, x + art.length - 1], rows };
}

/** The runner: two rows standing, one crouched — which is the whole point of ↓. */
export function runnerRows(state) {
  const y = Math.round(state.y);
  if (state.duck > 0 && !state.airborne) return [GROUND];
  return [y - 1, y];
}

const hits = (thing, rows) => {
  const { cols, rows: theirs } = cells(thing);
  return RUNNER >= cols[0] && RUNNER <= cols[1] && theirs.some((r) => rows.includes(r));
};

/**
 * Put the next thing on the far edge, and decide how far behind it the one
 * after that will be. The gap scales with speed because a jump is a fixed
 * number of ticks: without that, the stage eventually outruns the jump and the
 * game stops being losable-by-mistake and starts being unfair.
 */
export function spawn(state) {
  const { rng } = state;
  const edge = WIDTH + 2;
  const roll = rng();

  if (roll < 0.3) {
    // A line of picks. Low ones are free; a high arc is paid for with a jump.
    const high = rng() < 0.55;
    const count = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < count; i++) {
      state.things.push({ kind: "pick", x: edge + i * 2, row: high ? (i === 0 || i === count - 1 ? 5 : 4) : GROUND });
    }
    state.next = (10 + rng() * 8) * state.speed;
    return state;
  }

  const kind = roll < 0.55 ? "wedge" : roll < 0.8 ? "stack" : "surfer";
  state.things.push({ kind, x: edge });
  state.next = (16 + rng() * 14) * state.speed;
  return state;
}

export const meters = (state) => Math.floor(state.dist / 2);

/** One tick of stage. Exported so a test can run the whole set without a clock. */
export function step(state) {
  state.dist += state.speed;
  state.speed = Math.min(MAX_SPEED, BASE_SPEED + state.dist / 2200);

  if (state.airborne) {
    state.vy += GRAVITY;
    state.y += state.vy;
    if (state.y >= GROUND) { state.y = GROUND; state.vy = 0; state.airborne = false; }
  }
  if (state.duck > 0) state.duck--;

  for (const thing of state.things) thing.x -= state.speed;
  state.things = state.things.filter((t) => !t.taken && t.x > -4);

  state.next -= state.speed;
  if (state.next <= 0) spawn(state);

  const rows = runnerRows(state);
  for (const thing of state.things) {
    if (!hits(thing, rows)) continue;
    if (thing.kind === "pick") { thing.taken = true; state.picks++; continue; }
    state.over = `${HAZARDS[thing.kind].death} · ${meters(state)} m`;
    return state;
  }
  return state;
}

export const STAGEDIVE = {
  key: "stagedive",
  aliases: ["dive", "runner", "stage"],
  title: "STAGEDIVE",
  blurb: "run the barricade, hop the gear, duck the crowd, take the picks",
  keys: "↑ jump · ↓ duck (and slam) · space jump · q quit",
  tickMs: 55,

  create({ rng = Math.random } = {}) {
    return {
      y: GROUND,
      vy: 0,
      airborne: false,
      duck: 0,
      dist: 0,
      speed: BASE_SPEED,
      picks: 0,
      things: [],
      next: 24, // a moment of clear stage before the first thing arrives
      over: null,
      rng,
    };
  },

  tick: step,

  onKey(state, key) {
    if (key === "up" || key === "space" || key === "enter") {
      if (state.airborne) return state; // no second jump; the floor is the rule
      state.vy = JUMP;
      state.airborne = true;
      state.duck = 0;
      return state;
    }
    if (key === "down") {
      // In the air this is a slam, on the ground it is a crouch. Both are the
      // same key because both are "get low", and one key is easier to mean.
      if (state.airborne) state.vy = Math.max(state.vy, SLAM);
      else state.duck = DUCK_TICKS;
    }
    return state;
  },

  status(state) {
    return state.over
      ? `${state.over} · ${state.picks} picks`
      : `${meters(state)} m · ${state.picks} picks`;
  },

  render(state) {
    const grid = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => null));
    const put = (x, y, glyph) => {
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      grid[y][x] = glyph;
    };

    for (const thing of state.things) {
      const { cols, rows } = cells(thing);
      if (thing.kind === "pick") { put(cols[0], rows[0], PICK); continue; }
      const { art, paint } = HAZARDS[thing.kind];
      for (const row of rows) [...art].forEach((c, i) => put(cols[0] + i, row, paint(c)));
    }

    const y = Math.round(state.y);
    if (state.over) {
      put(RUNNER, GROUND, danger("✷"));
    } else if (state.duck > 0 && !state.airborne) {
      put(RUNNER, GROUND, acid("▄"));
    } else {
      put(RUNNER, y - 1, acid("○"));
      // The legs alternate with the stage, so standing still looks like running.
      put(RUNNER, y, acid(state.airborne ? "⋏" : Math.floor(state.dist) % 2 ? "⋀" : "⋏"));
    }

    return grid.map((row, ry) => row.map((cell, x) => {
      if (cell) return cell;
      if (ry !== FLOOR) return " ";
      // The stage edge, with a mark every few cells so the speed is visible even
      // when nothing else is on screen.
      return (x + Math.floor(state.dist)) % 7 === 0 ? dim("╪") : ash("═");
    }).join(""));
  },
};
