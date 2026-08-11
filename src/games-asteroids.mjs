// Asteroids. Turn, thrust, shoot, and watch the rocks you shot become two
// smaller rocks that are somehow worse.
//
// The one thing the 1979 cabinet did not have to worry about: a terminal cell is
// about twice as tall as it is wide. Everything here measures distance in
// columns, so a row counts double (see `span`) — without that, every rock is an
// egg and the collisions land in places the screen never showed you.
import { acid, amber, ash, bone, danger, dim, rgb } from "./ui.mjs";

export const WIDTH = 44;
export const HEIGHT = 18;

/** A row is worth this many columns. Half of everything vertical follows. */
export const ASPECT = 0.5;

const TURN = Math.PI / 8;      // 16 headings, which is as many as 8 glyphs can tell apart
const THRUST = 0.14;
const DRAG = 0.97;             // space has none; a 55ms terminal very much needs some
const MAX_SPEED = 1.15;
const BULLET_SPEED = 1.6;
const BULLET_LIFE = 22;
const BULLETS = 4;             // in flight at once — the arcade limit, and it is the game
const COOLDOWN = 2;
const INVULN = 30;             // ticks of blinking after a life is lost
const LIVES = 3;

/** Radius in columns, and what a hit is worth. Small ones pay most. */
export const ROCKS = {
  3: { r: 3.2, glyph: "█", points: 20, speed: 0.16 },
  2: { r: 2.1, glyph: "▓", points: 50, speed: 0.24 },
  1: { r: 1.1, glyph: "▒", points: 100, speed: 0.34 },
};

const HEADINGS = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];
const FLAME = ["◄", "◤", "▲", "◥", "►", "◢", "▼", "◣"];

export const wrap = (v, max) => ((v % max) + max) % max;

/**
 * The starfield: fixed, scattered, and free. Hashed from the coordinates rather
 * than stored or rolled, so the sky is the same on every repaint — and hashed
 * rather than `(x * 7 + y * 23) % 37`, which is a diagonal line, not a sky.
 */
export const star = (x, y) => ((((x * 73856093) ^ (y * 19349663)) >>> 4) % 53) === 0;

/** The shorter way round a wrapping axis — the screen has no edges. */
const delta = (a, b, max) => {
  const d = a - b;
  return d > max / 2 ? d - max : d < -max / 2 ? d + max : d;
};

/** Distance between two things, in columns, the short way round. */
export function span(a, b) {
  const dx = delta(a.x, b.x, WIDTH);
  const dy = delta(a.y, b.y, HEIGHT) / ASPECT;
  return Math.hypot(dx, dy);
}

const drift = (thing) => {
  thing.x = wrap(thing.x + thing.vx, WIDTH);
  thing.y = wrap(thing.y + thing.vy, HEIGHT);
};

/** A rock of `size`, moving somewhere, starting where it is put. */
export function rock(size, x, y, rng) {
  const angle = rng() * Math.PI * 2;
  const speed = ROCKS[size].speed * (0.7 + rng() * 0.6);
  return {
    size, x, y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed * ASPECT,
  };
}

/**
 * A wave. Rocks arrive at the edges of the screen and never on top of the ship —
 * spawning one on the ship is the cheapest way to make a game feel broken.
 */
export function spawnWave(wave, ship, rng) {
  const rocks = [];
  for (let i = 0; i < 3 + wave; i++) {
    let x = 0;
    let y = 0;
    let tries = 0;
    do {
      x = rng() * WIDTH;
      y = rng() * HEIGHT;
      tries++;
    } while (span({ x, y }, ship) < 14 && tries < 60);
    rocks.push(rock(3, x, y, rng));
  }
  return rocks;
}

const newShip = () => ({ x: WIDTH / 2, y: HEIGHT / 2, vx: 0, vy: 0, angle: -Math.PI / 2 });

/**
 * One tick: everything moves, then everything that touched something else
 * finds out. Exported so a test can fly a whole game without a clock.
 */
export function step(state) {
  const { rng } = state;
  const ship = state.ship;

  ship.vx *= DRAG;
  ship.vy *= DRAG;
  const speed = Math.hypot(ship.vx, ship.vy / ASPECT);
  if (speed > MAX_SPEED) {
    ship.vx *= MAX_SPEED / speed;
    ship.vy *= MAX_SPEED / speed;
  }
  drift(ship);

  for (const bullet of state.bullets) { drift(bullet); bullet.life--; }
  state.bullets = state.bullets.filter((b) => b.life > 0);
  for (const r of state.rocks) drift(r);

  if (state.cooldown > 0) state.cooldown--;
  if (state.thrusting > 0) state.thrusting--;
  if (state.invuln > 0) state.invuln--;

  // Bullets first: a rock shot on the same tick it reaches you does not also
  // get to take a life.
  for (const bullet of [...state.bullets]) {
    const hit = state.rocks.find((r) => span(bullet, r) <= ROCKS[r.size].r + 0.4);
    if (!hit) continue;
    state.bullets = state.bullets.filter((b) => b !== bullet);
    state.rocks = state.rocks.filter((r) => r !== hit);
    state.score += ROCKS[hit.size].points;
    if (hit.size > 1) {
      state.rocks.push(rock(hit.size - 1, hit.x, hit.y, rng), rock(hit.size - 1, hit.x, hit.y, rng));
    }
  }

  if (!state.invuln) {
    const struck = state.rocks.find((r) => span(ship, r) <= ROCKS[r.size].r + 0.9);
    if (struck) {
      state.lives--;
      if (state.lives <= 0) {
        state.lives = 0;
        state.over = `wrecked on wave ${state.wave}`;
        return state;
      }
      state.ship = newShip();
      state.bullets = [];
      state.invuln = INVULN;
      // The rock that got you is pushed clear rather than deleted, so the
      // respawn is not immediately fatal a second time.
      struck.x = wrap(struck.x + WIDTH / 2, WIDTH);
      struck.y = wrap(struck.y + HEIGHT / 2, HEIGHT);
    }
  }

  if (!state.rocks.length) {
    state.wave++;
    state.rocks = spawnWave(state.wave, state.ship, rng);
    state.invuln = Math.max(state.invuln, 12);
  }
  return state;
}

export const ASTEROIDS = {
  key: "asteroids",
  aliases: ["rocks", "asteroid"],
  title: "ASTEROIDS",
  blurb: "turn, thrust, shoot — every rock you break becomes two",
  keys: "← → turn · ↑ thrust · ↓ retro · space fire · q quit",
  tickMs: 55,

  create({ rng = Math.random } = {}) {
    const ship = newShip();
    return {
      ship,
      bullets: [],
      rocks: spawnWave(1, ship, rng),
      score: 0,
      lives: LIVES,
      wave: 1,
      cooldown: 0,
      thrusting: 0,
      invuln: INVULN,
      over: null,
      rng,
    };
  },

  tick: step,

  onKey(state, key) {
    const ship = state.ship;
    if (key === "left") ship.angle -= TURN;
    else if (key === "right") ship.angle += TURN;
    else if (key === "up" || key === "down") {
      // Retro is half power, because a reverse as strong as the throttle turns
      // the ship into something that cannot drift, and drifting is the game.
      const push = key === "up" ? THRUST : -THRUST / 2;
      ship.vx += Math.cos(ship.angle) * push;
      ship.vy += Math.sin(ship.angle) * push * ASPECT;
      if (key === "up") state.thrusting = 3;
    } else if (key === "space" || key === "enter") {
      if (state.cooldown > 0 || state.bullets.length >= BULLETS) return state;
      state.bullets.push({
        // Out of the nose, not the middle, or the ship shoots itself in the face
        // at close range and the muzzle flash lands inside the hull.
        x: wrap(ship.x + Math.cos(ship.angle) * 1.6, WIDTH),
        y: wrap(ship.y + Math.sin(ship.angle) * 1.6 * ASPECT, HEIGHT),
        vx: ship.vx + Math.cos(ship.angle) * BULLET_SPEED,
        vy: ship.vy + Math.sin(ship.angle) * BULLET_SPEED * ASPECT,
        life: BULLET_LIFE,
      });
      state.cooldown = COOLDOWN;
    }
    return state;
  },

  status(state) {
    return state.over
      ? `${state.over} · ${state.score} points`
      : `score ${state.score} · wave ${state.wave} · ${"▲".repeat(state.lives)}`;
  },

  render(state) {
    const grid = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => null));
    const put = (x, y, glyph) => {
      const col = wrap(Math.round(x), WIDTH);
      const row = wrap(Math.round(y), HEIGHT);
      grid[row][col] = glyph;
    };

    for (const r of state.rocks) {
      const { r: radius, glyph } = ROCKS[r.size];
      const paint = r.size === 3 ? ash : r.size === 2 ? rgb(150, 158, 150) : rgb(190, 196, 188);
      // A disc, measured in columns — hence the row doubling, which is the only
      // reason these come out round instead of squashed.
      for (let dy = -Math.ceil(radius * ASPECT); dy <= Math.ceil(radius * ASPECT); dy++) {
        for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
          if (Math.hypot(dx, dy / ASPECT) > radius) continue;
          put(r.x + dx, r.y + dy, paint(glyph));
        }
      }
    }

    for (const bullet of state.bullets) put(bullet.x, bullet.y, amber("•"));

    const heading = ((Math.round(state.ship.angle / (Math.PI / 4)) % 8) + 8) % 8;
    if (state.thrusting) {
      put(
        state.ship.x - Math.cos(state.ship.angle) * 1.4,
        state.ship.y - Math.sin(state.ship.angle) * 1.4 * ASPECT,
        danger(FLAME[heading]),
      );
    }
    if (!state.over) {
      // Blinking is the only tell that the ship cannot be hit yet.
      const shield = state.invuln && state.invuln % 6 < 3;
      put(state.ship.x, state.ship.y, (shield ? bone : acid)(HEADINGS[heading]));
    } else {
      put(state.ship.x, state.ship.y, danger("✷"));
    }

    return grid.map((row, y) => row.map((cell, x) => (
      cell ?? (star(x, y) ? dim("·") : " ")
    )).join(""));
  },
};
