// Centipede. It comes down through the mushrooms, and every piece you shoot out
// of the middle leaves you two of them.
//
// The trick that makes this cheap: the centipede is not a linked body, it is a
// list of segments that each obey the same rule — walk sideways, and when
// something is in the way, drop a row and turn round. Kept that way, a shot to
// the middle needs no surgery at all. You remove one segment and the ones
// behind it simply carry on, which is exactly what splitting looks like.
import { acid, amber, danger, dim, rgb } from "./ui.mjs";

export const WIDTH = 38;
export const HEIGHT = 18;

/** The bottom strip is yours; the centipede comes down into it. */
export const ZONE_TOP = HEIGHT - 5;
const MUSHROOM_HP = 4;
const LIVES = 3;
const SHOTS = 3;
const SHOT_SPEED = 2;

const shroom = rgb(120, 190, 40);
const MUSH_ART = ["▁", "▄", "▆", "█"]; // fuller the healthier

const key = (x, y) => `${x},${y}`;

/** A field of mushrooms, none of them in the row you stand on. */
export function seedField(rng, count = 34) {
  const field = new Map();
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rng() * WIDTH);
    const y = 1 + Math.floor(rng() * (HEIGHT - 3));
    if (y >= HEIGHT - 1) continue;
    field.set(key(x, y), MUSHROOM_HP);
  }
  return field;
}

/** Chip a mushroom, and say whether one was there. A dead one is worth points. */
export function bite(field, x, y) {
  const hp = field.get(key(x, y));
  if (!hp) return 0;
  if (hp <= 1) { field.delete(key(x, y)); return 5; }
  field.set(key(x, y), hp - 1);
  return 1;
}

/** A fresh centipede, strung out along the top row. */
export function newCentipede(length = 10) {
  return Array.from({ length }, (_, i) => ({ x: length - 1 - i, y: 0, dir: 1, down: 1 }));
}

const blocked = (state, x, y) => x < 0 || x >= WIDTH || state.field.has(key(x, y));

/** Walk one segment: sideways if it can, otherwise down a row and about turn. */
export function walk(state, seg) {
  if (!blocked(state, seg.x + seg.dir, seg.y)) { seg.x += seg.dir; return seg; }
  seg.dir *= -1;
  seg.y += seg.down;
  // It bounces off the floor and climbs back up rather than vanishing, which is
  // what keeps the bottom of the board dangerous instead of a safe corner.
  if (seg.y >= HEIGHT - 1) { seg.y = HEIGHT - 1; seg.down = -1; }
  if (seg.y <= 0) { seg.y = 0; seg.down = 1; }
  return seg;
}

/** How many ticks between steps — shorter as the wave goes on. */
export const cadence = (state) => Math.max(2, 7 - state.wave);

/**
 * The spider: in from the side, bouncing diagonally through your strip, eating
 * mushrooms as it goes.
 *
 * It is here because without it the bottom of the board is safe. The centipede
 * only reaches your row on the sweeps it happens to end on, so a player who
 * simply never moves can survive a long time — which is not a game. The spider
 * is the reason you cannot stand still.
 */
export function spiderStep(state) {
  const spider = state.spider;
  if (!spider) return state;
  spider.x += spider.dx;
  spider.y += spider.dy;
  if (spider.y < ZONE_TOP) { spider.y = ZONE_TOP; spider.dy = 1; }
  if (spider.y > HEIGHT - 1) { spider.y = HEIGHT - 1; spider.dy = -1; }
  // It leaves the way it came in rather than turning round at the wall, so it
  // is a visitor and not a permanent resident.
  if (spider.x < 0 || spider.x >= WIDTH) { state.spider = null; return state; }
  state.field.delete(key(spider.x, spider.y));
  return state;
}

export function spawnSpider(state) {
  const fromLeft = state.rng() < 0.5;
  state.spider = {
    x: fromLeft ? 0 : WIDTH - 1,
    y: HEIGHT - 1 - Math.floor(state.rng() * 3),
    dx: fromLeft ? 1 : -1,
    dy: state.rng() < 0.5 ? -1 : 1,
  };
  return state;
}

function hitPlayer(state) {
  state.lives--;
  if (state.lives <= 0) {
    state.lives = 0;
    state.over = `eaten · ${state.score} points`;
    return state;
  }
  state.centipede = newCentipede(10);
  state.shots = [];
  state.spider = null;
  state.player = { x: Math.floor(WIDTH / 2), y: HEIGHT - 1 };
  return state;
}

/** One tick. Exported so a test can clear a wave with no clock. */
export function step(state) {
  for (let i = 0; i < SHOT_SPEED; i++) {
    for (const shot of [...state.shots]) {
      shot.y -= 1;
      if (shot.y < 0) { state.shots = state.shots.filter((s) => s !== shot); continue; }
      const points = bite(state.field, shot.x, shot.y);
      if (points) { state.score += points; state.shots = state.shots.filter((s) => s !== shot); continue; }
      if (state.spider && state.spider.x === shot.x && state.spider.y === shot.y) {
        state.spider = null;
        state.shots = state.shots.filter((s) => s !== shot);
        state.score += 300;
        continue;
      }
      const seg = state.centipede.find((s) => s.x === shot.x && s.y === shot.y);
      if (!seg) continue;
      state.shots = state.shots.filter((s) => s !== shot);
      state.centipede = state.centipede.filter((s) => s !== seg);
      state.score += 10;
      // Every piece you take out of it leaves a mushroom where it fell, which
      // is how the field thickens and the next wave gets harder for free.
      state.field.set(key(seg.x, seg.y), MUSHROOM_HP);
    }
  }

  if (!state.centipede.length) {
    state.wave++;
    state.centipede = newCentipede(10);
    state.score += 100;
    return state;
  }

  state.clock++;
  if (state.clock >= cadence(state)) {
    state.clock = 0;
    for (const seg of state.centipede) walk(state, seg);
    if (state.centipede.some((s) => s.x === state.player.x && s.y === state.player.y)) return hitPlayer(state);
  }

  state.spiderClock++;
  if (state.spiderClock % 3 === 0) {
    spiderStep(state);
    const spider = state.spider;
    if (spider && spider.x === state.player.x && spider.y === state.player.y) return hitPlayer(state);
  }
  if (!state.spider && state.rng() < 0.02) spawnSpider(state);
  return state;
}

export const CENTIPEDE = {
  key: "centipede",
  aliases: ["cent", "bug", "millipede"],
  title: "CENTIPEDE",
  blurb: "shoot it in the middle and now there are two of them",
  keys: "← ↑ ↓ → move · space fire · q quit",
  tickMs: 55,

  create({ rng = Math.random } = {}) {
    return {
      field: seedField(rng),
      centipede: newCentipede(10),
      player: { x: Math.floor(WIDTH / 2), y: HEIGHT - 1 },
      shots: [],
      spider: null,
      spiderClock: 0,
      score: 0,
      lives: LIVES,
      wave: 1,
      clock: 0,
      over: null,
      rng,
    };
  },

  tick: step,

  onKey(state, pressed) {
    const p = state.player;
    // You are free in the bottom strip and nowhere else — the whole game is
    // fought in five rows.
    if (pressed === "left") p.x = Math.max(0, p.x - 1);
    else if (pressed === "right") p.x = Math.min(WIDTH - 1, p.x + 1);
    else if (pressed === "up") p.y = Math.max(ZONE_TOP, p.y - 1);
    else if (pressed === "down") p.y = Math.min(HEIGHT - 1, p.y + 1);
    else if (pressed === "space" || pressed === "enter") {
      if (state.shots.length < SHOTS) state.shots.push({ x: p.x, y: p.y - 1 });
      return state;
    }
    // Walking into a mushroom is walking into a wall.
    if (state.field.has(key(p.x, p.y))) {
      if (pressed === "left") p.x += 1;
      else if (pressed === "right") p.x -= 1;
      else if (pressed === "up") p.y += 1;
      else if (pressed === "down") p.y -= 1;
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

    for (const [at, hp] of state.field) {
      const [x, y] = at.split(",").map(Number);
      put(x, y, shroom(MUSH_ART[hp - 1] ?? "▁"));
    }
    for (const seg of state.centipede) put(seg.x, seg.y, danger("◍"));
    if (state.spider) put(state.spider.x, state.spider.y, rgb(190, 130, 255)("✻"));
    for (const shot of state.shots) put(shot.x, shot.y, amber("│"));
    put(state.player.x, state.player.y, state.over ? danger("✷") : acid("▲"));

    return grid.map((row, y) => row.map((cell) => (
      cell ?? (y === ZONE_TOP - 1 ? dim("┈") : " ")
    )).join(""));
  },
};
