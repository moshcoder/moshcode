// Choplifter. Fly out, land, load them up, fly home. Do it before the tanks
// work out where you are going.
//
// The world is wider than the screen, which is the whole point — the camera
// follows the chopper and the base sits off the left edge, so "get back" is a
// real journey rather than a step. Everything is stored in world columns and
// only turned into screen columns at the very end, in render().
import { acid, amber, ash, bone, danger, dim, rgb } from "./ui.mjs";

export const WIDTH = 46;          // what you can see
export const HEIGHT = 14;
export const WORLD = 150;         // how far it actually goes

export const GROUND = HEIGHT - 2;
export const BASE = 6;            // the pad, at the left-hand end of the world
const BASE_W = 7;
export const SEATS = 4;           // how many fit in the back
const LIVES = 3;
const SHELL_EVERY = 46;           // ticks between a tank taking a shot

const sand = rgb(200, 170, 110);

export const onPad = (x) => x >= BASE - 1 && x <= BASE + BASE_W;

/** Hostages waiting in the desert, and the tanks that would rather they stayed. */
export function populate(rng) {
  const people = [];
  for (let i = 0; i < 12; i++) {
    people.push({ x: 40 + Math.floor(rng() * (WORLD - 55)), waving: true });
  }
  const tanks = [];
  for (let i = 0; i < 4; i++) {
    tanks.push({ x: 55 + Math.floor(rng() * (WORLD - 70)), dir: rng() < 0.5 ? -1 : 1 });
  }
  return { people, tanks };
}

function hit(state, why) {
  state.lives--;
  // Anybody in the back goes down with it. That is the cost of one more pickup.
  state.aboard = 0;
  if (state.lives <= 0) {
    state.lives = 0;
    state.over = `${why} · ${state.home} home`;
    return state;
  }
  state.chopper = { x: BASE + 2, y: GROUND - 1, vy: 0 };
  state.shells = [];
  return state;
}

/** One tick. Exported so a test can fly a whole rescue with no clock. */
export function step(state) {
  const chop = state.chopper;
  chop.x = Math.max(0, Math.min(WORLD - 1, chop.x + state.throttle));
  chop.y = Math.max(1, Math.min(GROUND, chop.y + chop.vy));
  // Both axes drift to a stop rather than stopping dead, so it hovers when you
  // let go instead of dropping out of the sky the moment you stop pressing up.
  state.throttle *= 0.72;
  if (Math.abs(state.throttle) < 0.05) state.throttle = 0;
  chop.vy *= 0.72;
  if (Math.abs(chop.vy) < 0.05) chop.vy = 0;

  const landed = chop.y >= GROUND;

  if (landed) {
    // On the ground at the base: everybody out, and that is the score.
    if (onPad(Math.round(chop.x))) {
      state.home += state.aboard;
      state.score += state.aboard * 100;
      state.aboard = 0;
    } else {
      // Out in the desert: anybody close enough climbs in.
      for (const person of state.people) {
        if (state.aboard >= SEATS) break;
        if (Math.abs(person.x - chop.x) > 2 || person.rescued) continue;
        person.rescued = true;
        state.aboard++;
      }
      state.people = state.people.filter((p) => !p.rescued);
    }
  }

  state.clock++;
  for (const tank of state.tanks) {
    if (state.clock % 5 === 0) {
      tank.x += tank.dir;
      if (tank.x < 30 || tank.x > WORLD - 4) tank.dir *= -1;
    }
    // A tank shoots when you are overhead, and only then — you can outrun them.
    if (state.clock % SHELL_EVERY === 0 && Math.abs(tank.x - chop.x) < 12) {
      state.shells.push({ x: tank.x, y: GROUND - 1, vy: -0.55 });
    }
  }

  for (const shell of state.shells) shell.y += shell.vy;
  state.shells = state.shells.filter((s) => s.y > 0);
  const struck = state.shells.find((s) => Math.abs(s.x - chop.x) < 2 && Math.abs(s.y - chop.y) < 1);
  if (struck) return hit(state, "shot down");

  const run_over = state.tanks.find((t) => landed && Math.abs(t.x - chop.x) < 2);
  if (run_over) return hit(state, "flattened on the ground");

  if (!state.people.length && !state.aboard) {
    state.over = `everyone out · ${state.home} home`;
  }
  return state;
}

export const CHOPLIFTER = {
  key: "choplifter",
  aliases: ["chopper", "rescue", "heli"],
  title: "CHOPLIFTER",
  blurb: "fly out, land, fill the back, and get them home",
  keys: "← → fly · ↑ ↓ climb and land · q quit",
  tickMs: 55,

  create({ rng = Math.random } = {}) {
    const { people, tanks } = populate(rng);
    return {
      chopper: { x: BASE + 2, y: GROUND - 1, vy: 0 },
      throttle: 0,
      people,
      tanks,
      shells: [],
      aboard: 0,
      home: 0,
      score: 0,
      lives: LIVES,
      clock: 0,
      over: null,
      rng,
    };
  },

  tick: step,

  onKey(state, pressed) {
    const chop = state.chopper;
    if (pressed === "left") state.throttle = Math.max(-1.4, state.throttle - 0.7);
    else if (pressed === "right") state.throttle = Math.min(1.4, state.throttle + 0.7);
    else if (pressed === "up") chop.vy = Math.max(-0.7, chop.vy - 0.45);
    else if (pressed === "down") chop.vy = Math.min(0.7, chop.vy + 0.45);
    return state;
  },

  status(state) {
    if (state.over) return state.over;
    return `${state.home} home · ${state.aboard}/${SEATS} aboard · ${state.people.length} waiting · ${"▲".repeat(state.lives)}`;
  },

  render(state) {
    // The camera keeps the chopper in the middle until the world runs out.
    const camera = Math.max(0, Math.min(WORLD - WIDTH, Math.round(state.chopper.x) - Math.floor(WIDTH / 2)));
    const grid = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => null));
    const put = (worldX, y, glyph) => {
      const x = Math.round(worldX) - camera;
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      grid[y][x] = glyph;
    };

    for (let i = 0; i < BASE_W; i++) put(BASE + i, GROUND, acid("═"));
    for (const person of state.people) put(person.x, GROUND - 1, bone("Ω"));
    for (const tank of state.tanks) put(tank.x, GROUND - 1, danger("▙"));
    for (const shell of state.shells) put(shell.x, shell.y, amber("•"));
    const chop = state.chopper;
    put(chop.x, Math.round(chop.y), state.over ? danger("✷") : acid("╤"));
    put(chop.x - 1, Math.round(chop.y), state.over ? danger("✷") : ash("─"));
    put(chop.x + 1, Math.round(chop.y), state.over ? danger("✷") : ash("─"));

    return grid.map((row, y) => row.map((cell, x) => {
      if (cell) return cell;
      if (y === GROUND) return sand("▀");
      if (y > GROUND) return sand("░");
      // A horizon marker every ten columns of world, so flying feels like it.
      return (x + camera) % 12 === 0 && y === 1 ? dim("│") : " ";
    }).join(""));
  },
};
