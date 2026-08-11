// Excitebike. The throttle is not the interesting part — the temperature gauge
// is, and so is what your front wheel is doing when you land.
//
// Two things make this game rather than a side-scroller with ramps. Turbo is
// free until it isn't: heat climbs while you hold it and the engine seizes at
// the top of the gauge, so the fast lap is the one that cools off in the right
// places. And a jump is only as good as its landing: you pitch the bike in the
// air, and coming down nose-first puts you over the handlebars.
import { acid, ash, bone, danger, dim, rgb } from "./ui.mjs";

export const WIDTH = 46;
export const HEIGHT = 12;

export const GROUND = HEIGHT - 3;
export const RIDER = 8;          // your column; the track comes to you

const BASE_SPEED = 0.35;
const MAX_SPEED = 1.5;
const TURBO = 0.55;              // extra columns per tick while it is held
const HEAT_UP = 1.6;
const HEAT_DOWN = 0.8;
export const SEIZE_TICKS = 70;   // how long a cooked engine costs you
const PITCH_LIMIT = 2.2;
// The nose drops on its own all the way down. Without this the pitch you leave
// the ramp with is the pitch you land on, and the landing — the whole second
// half of this game — is something you can simply ignore.
const PITCH_DROP = 0.075;
export const LAND_OK = 1.1;      // how far from level you may land
const CRASH_TICKS = 45;
export const FINISH = 900;       // columns of track in a race
const TIME = 2600;

const dirt = rgb(170, 130, 90);

/** A ramp is three columns of take-off; hit one moving and you are airborne. */
export const RAMP_W = 3;

export function spawn(state) {
  const { rng } = state;
  state.things.push({ kind: "ramp", x: WIDTH + 2 });
  state.next = 18 + rng() * 22;
  return state;
}

export const rampSpan = (thing) => {
  const x = Math.round(thing.x);
  return [x, x + RAMP_W - 1];
};

/** Speed right now, with everything that is holding it back applied. */
export function speedOf(state) {
  if (state.crash > 0) return 0;
  if (state.seized > 0) return BASE_SPEED * 0.4;
  return Math.min(MAX_SPEED, state.throttle + (state.turbo ? TURBO : 0));
}

function crash(state, why) {
  state.crash = CRASH_TICKS;
  state.air = 0;
  state.pitch = 0;
  state.throttle = BASE_SPEED;
  state.spills++;
  state.last = why;
  return state;
}

/** One tick of track. Exported so a test can ride a whole race with no clock. */
export function step(state) {
  state.clock++;
  if (state.clock >= TIME) {
    state.over = `out of time · ${Math.round(state.dist)} of ${FINISH}`;
    return state;
  }
  if (state.crash > 0) { state.crash--; return state; }

  // The gauge. Turbo is a loan, and this is where it is called in.
  if (state.turbo && !state.seized) state.heat = Math.min(100, state.heat + HEAT_UP);
  else state.heat = Math.max(0, state.heat - HEAT_DOWN);
  if (state.heat >= 100 && !state.seized) { state.seized = SEIZE_TICKS; state.turbo = false; }
  if (state.seized > 0) { state.seized--; if (!state.seized) state.heat = 40; }

  const speed = speedOf(state);
  state.dist += speed;
  for (const thing of state.things) thing.x -= speed;
  state.things = state.things.filter((t) => rampSpan(t)[1] > -3);
  state.next -= speed;
  if (state.next <= 0) spawn(state);

  if (state.air > 0) {
    state.air--;
    state.pitch = Math.min(PITCH_LIMIT, state.pitch + PITCH_DROP);
    if (!state.air) {
      // Landing: level enough is a landing, anything else is a tumble.
      if (Math.abs(state.pitch) > LAND_OK) return crash(state, "over the handlebars");
      // A flat landing carries the speed; a wobbly one scrubs some off.
      state.throttle = Math.min(MAX_SPEED, state.throttle + (Math.abs(state.pitch) < 0.4 ? 0.12 : -0.1));
      state.score += 50;
      state.pitch = 0;
    }
  } else {
    const ramp = state.things.find((t) => {
      const [from, to] = rampSpan(t);
      return RIDER >= from && RIDER <= to;
    });
    if (ramp && !ramp.used) {
      ramp.used = true;
      // The faster you hit it, the longer you are in the air — and the more time
      // you have to get the pitch wrong.
      state.air = Math.round(10 + speed * 14);
      state.pitch = 0.6;   // it launches you nose-up, and you ride it down
    }
  }

  if (state.dist >= FINISH) {
    state.race++;
    state.score += Math.max(200, 2000 - state.clock);
    state.dist = 0;
    state.clock = 0;
    state.things = [];
    state.heat = 0;
  }
  return state;
}

export const EXCITEBIKE = {
  key: "excitebike",
  aliases: ["bike", "moto", "excite"],
  title: "EXCITEBIKE",
  blurb: "turbo until it cooks, and land the way you took off",
  keys: "← → throttle · space turbo · ↑ ↓ pitch in the air · q quit",
  tickMs: 55,

  create({ rng = Math.random } = {}) {
    return {
      things: [],
      next: 16,
      throttle: BASE_SPEED,
      turbo: false,
      heat: 0,
      seized: 0,
      air: 0,
      pitch: 0,
      crash: 0,
      spills: 0,
      dist: 0,
      race: 1,
      clock: 0,
      score: 0,
      last: null,
      over: null,
      rng,
    };
  },

  tick: step,

  onKey(state, pressed) {
    if (state.crash > 0) return state;
    if (pressed === "right") state.throttle = Math.min(MAX_SPEED, state.throttle + 0.12);
    else if (pressed === "left") state.throttle = Math.max(BASE_SPEED * 0.5, state.throttle - 0.12);
    else if (pressed === "space" || pressed === "enter") state.turbo = !state.turbo;
    else if (pressed === "up" || pressed === "down") {
      // Pitch only means anything off the ground; on it, this does nothing at
      // all, which is the honest answer.
      if (!state.air) return state;
      state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, state.pitch + (pressed === "up" ? -0.35 : 0.35)));
    }
    return state;
  },

  status(state) {
    if (state.over) return state.over;
    const gauge = Math.round(state.heat / 10);
    const bar = `${"█".repeat(gauge)}${"░".repeat(10 - gauge)}`;
    return `race ${state.race} · ${Math.round(state.dist)}/${FINISH} · heat ${bar}${state.seized ? " seized" : ""}`;
  },

  render(state) {
    const grid = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => null));
    const put = (x, y, glyph) => {
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      grid[y][x] = glyph;
    };

    for (const thing of state.things) {
      const [from] = rampSpan(thing);
      // A ramp climbs, so it is drawn climbing.
      [...("▁▄█")].forEach((c, i) => put(from + i, GROUND - (i > 1 ? 1 : 0), dirt(c)));
    }

    const height = state.air ? Math.min(4, 1 + Math.round(state.air / 6)) : 0;
    const nose = state.pitch < -LAND_OK ? "◜" : state.pitch > LAND_OK ? "◞" : state.air ? "◠" : "◉";
    put(RIDER, GROUND - 1 - height, state.crash ? danger("✷") : acid(nose));
    if (!state.air && !state.crash) put(RIDER + 1, GROUND - 1, ash("·"));

    return grid.map((row, y) => row.map((cell, x) => {
      if (cell) return cell;
      if (y === GROUND) return dirt("▀");
      if (y > GROUND) return dim("░");
      // The finish, coming up the track.
      const toGo = FINISH - state.dist;
      if (toGo < WIDTH - RIDER && x === RIDER + Math.round(toGo)) return bone("┋");
      return " ";
    }).join(""));
  },
};
