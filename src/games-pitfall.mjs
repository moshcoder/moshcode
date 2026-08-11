// Pitfall. The jungle goes past whether you are ready or not: pits, logs,
// scorpions, and a vine over the worst of them.
//
// The vine is the reason this is not just another jumping game. A jump is short
// and you commit to it the moment you press it; a swing is long, and you can
// only start one where a vine is hanging — so the hazards that are too wide to
// jump are the ones that have a vine over them, and reading which is which as
// it comes at you is the game.
import { acid, ash, danger, dim, rgb } from "./ui.mjs";

export const WIDTH = 46;
export const HEIGHT = 13;

export const GROUND = 9;      // the row you run along
const CANOPY = 2;             // where the vines hang from
export const RUNNER = 9;      // your column; the jungle moves, you do not

const JUMP = 10;              // ticks in the air — about five columns of jungle
const SWING = 21;             // ticks on a vine — a five-wide pit takes about sixteen
const REACH = 1;              // how close to a vine you must be to catch it
const LIVES = 3;
const SPEED = 0.55;           // columns of jungle per tick
const TIME = 2400;            // ticks on the clock

const jungle = rgb(60, 140, 70);
const gold = rgb(255, 200, 60);

/** What the jungle throws at you, and what gets you past it. */
export const HAZARDS = {
  pit: { w: 5, art: "     ", paint: ash, cleared: "swing", death: "down a pit" },
  log: { w: 2, art: "◙◙", paint: rgb(150, 100, 60), cleared: "jump", death: "rolled over by a log" },
  scorpion: { w: 1, art: "%", paint: danger, cleared: "jump", death: "stung" },
};

/** The columns a thing covers. A vine and a bar of gold are one cell each. */
export const span = (thing) => {
  const x = Math.round(thing.x);
  return [x, x + (HAZARDS[thing.kind]?.w ?? 1) - 1];
};

const touching = (thing) => {
  const [from, to] = span(thing);
  return RUNNER >= from && RUNNER <= to;
};

/**
 * The next thing down the trail, and how far behind it the one after that will
 * be. A pit always comes with a vine over it: it is five columns wide and a
 * jump covers three, so a pit with no vine is a pit nobody gets past.
 */
export function spawn(state) {
  const { rng } = state;
  const edge = WIDTH + 2;
  const roll = rng();
  if (roll < 0.22) {
    state.things.push({ kind: "treasure", x: edge });
    state.next = 8 + rng() * 8;
  } else if (roll < 0.5) {
    state.things.push({ kind: "pit", x: edge });
    state.things.push({ kind: "vine", x: edge - 3 });
    state.next = 22 + rng() * 10;
  } else if (roll < 0.78) {
    state.things.push({ kind: "log", x: edge });
    state.next = 16 + rng() * 10;
  } else {
    state.things.push({ kind: "scorpion", x: edge });
    state.next = 16 + rng() * 10;
  }
  return state;
}

function lose(state, why) {
  state.lives--;
  if (state.lives <= 0) {
    state.lives = 0;
    state.over = `${why} · ${state.treasure} treasure`;
    return state;
  }
  state.things = state.things.filter((t) => span(t)[1] < RUNNER - 2 || span(t)[0] > RUNNER + 12);
  state.air = 0;
  state.swinging = false;
  state.clock = Math.max(0, state.clock - 120); // a fall costs you time as well
  return state;
}

/** One tick of jungle. Exported so a test can run the trail with no clock. */
export function step(state) {
  state.clock++;
  state.dist += SPEED;
  if (state.clock >= TIME) {
    state.over = `out of daylight · ${state.treasure} treasure`;
    return state;
  }

  if (state.air > 0) {
    state.air--;
    if (!state.air) state.swinging = false;
  }

  for (const thing of state.things) thing.x -= SPEED;
  state.things = state.things.filter((t) => !t.taken && span(t)[1] > -3);

  state.next -= SPEED;
  if (state.next <= 0) spawn(state);

  for (const thing of state.things) {
    if (!touching(thing)) continue;
    if (thing.kind === "vine") continue;             // a vine is scenery until you grab it
    if (thing.kind === "treasure") {
      if (state.air) continue;                       // you cannot scoop it up mid-swing
      thing.taken = true;
      state.treasure++;
      state.score += 500;
      continue;
    }
    // In the air is past it, whichever way you got there.
    if (state.air > 0) continue;
    return lose(state, HAZARDS[thing.kind].death);
  }
  return state;
}

/** Grab the vine you are under, if there is one. */
export function grab(state) {
  if (state.air) return state;
  const vine = state.things.find((t) => t.kind === "vine" && Math.abs(Math.round(t.x) - RUNNER) <= REACH);
  if (!vine) return state;
  state.air = SWING;
  state.swinging = true;
  return state;
}

export const PITFALL = {
  key: "pitfall",
  aliases: ["jungle", "vine"],
  title: "PITFALL",
  blurb: "jump the logs, swing the pits, and get the gold before dark",
  keys: "space jump · ↑ grab a vine · q quit",
  tickMs: 55,

  create({ rng = Math.random } = {}) {
    return {
      things: [],
      air: 0,
      swinging: false,
      next: 20,
      dist: 0,
      clock: 0,
      treasure: 0,
      score: 0,
      lives: LIVES,
      over: null,
      rng,
    };
  },

  tick: step,

  onKey(state, pressed) {
    if (pressed === "up") return grab(state);
    if (pressed === "space" || pressed === "enter") {
      if (!state.air) state.air = JUMP;
    }
    return state;
  },

  status(state) {
    if (state.over) return state.over;
    const left = Math.max(0, Math.round((TIME - state.clock) / 20));
    return `${state.score} · ${state.treasure} gold · ${left}s · ${"▲".repeat(state.lives)}`;
  },

  render(state) {
    const grid = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => null));
    const put = (x, y, glyph) => {
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      grid[y][x] = glyph;
    };

    for (const thing of state.things) {
      const [from] = span(thing);
      if (thing.kind === "vine") {
        for (let y = CANOPY; y < GROUND - 2; y++) put(from, y, jungle("│"));
        continue;
      }
      if (thing.kind === "treasure") { put(from, GROUND - 1, gold("▮")); continue; }
      const { art, paint, w } = HAZARDS[thing.kind];
      for (let i = 0; i < w; i++) {
        // A pit is a hole in the floor rather than something drawn on it.
        if (thing.kind === "pit") put(from + i, GROUND, dim(" "));
        else put(from + i, GROUND - 1, paint(art[i]));
      }
    }

    const y = state.swinging ? GROUND - 4 : state.air ? GROUND - 3 : GROUND - 1;
    put(RUNNER, y, state.over ? danger("✷") : acid(state.swinging ? "⌾" : "◉"));
    if (state.swinging) for (let v = CANOPY; v < y; v++) put(RUNNER, v, jungle("│"));

    return grid.map((row, ry) => row.map((cell, x) => {
      if (cell) return cell;
      if (ry === GROUND) {
        // The floor, with the pits left out of it.
        const overPit = state.things.some((t) => t.kind === "pit" && x >= span(t)[0] && x <= span(t)[1]);
        return overPit ? " " : jungle("▀");
      }
      if (ry === CANOPY - 1) return dim("╌");
      if (ry > GROUND) return ash("░");
      return " ";
    }).join(""));
  },
};
