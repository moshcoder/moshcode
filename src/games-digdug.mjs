// Dig Dug. You are underground, everything down here wants you, and the only
// wall between you and it is the ground you have not dug yet.
//
// The board is the enemy AI. There is no pathfinding: a monster walks the tunnel
// it is in and turns towards you at a junction, so the shape you dig is the
// shape of the fight. Dig a straight line and they queue up behind you; dig a
// loop and they come round both ends of it.
import { acid, amber, ash, bone, danger, dim, rgb } from "./ui.mjs";

export const WIDTH = 40;
export const HEIGHT = 16;
export const SKY = 1;          // rows above this are open air

const LIVES = 3;
const HARPOON = 5;             // how far the pump reaches
const POPS_AT = 3;             // pumps to burst a monster
const MONSTER_EVERY = 9;       // ticks between monster steps
const ROCK_EVERY = 3;

const soil = rgb(150, 100, 60);
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

const key = (x, y) => `${x},${y}`;

/** Solid ground everywhere below the sky, minus the shafts the level starts with. */
export function buildGround() {
  const ground = new Set();
  for (let y = SKY + 1; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) ground.add(key(x, y));
  return ground;
}

export const isDug = (ground, x, y) => (
  x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT && !ground.has(key(x, y))
);

/** Where the monsters and rocks start — spread out, and never on top of you. */
export function populate(state, level) {
  state.monsters = [];
  for (let i = 0; i < 3 + Math.min(3, level - 1); i++) {
    state.monsters.push({
      x: 6 + Math.floor(state.rng() * (WIDTH - 12)),
      y: SKY + 2 + Math.floor(state.rng() * (HEIGHT - SKY - 3)),
      dir: state.rng() < 0.5 ? "left" : "right",
      pumped: 0,
      ghost: 0,
    });
  }
  state.rocks = [];
  for (let i = 0; i < 4; i++) {
    state.rocks.push({
      x: 4 + Math.floor(state.rng() * (WIDTH - 8)),
      y: SKY + 2 + Math.floor(state.rng() * 5),
      falling: false,
    });
  }
  // Every monster and rock starts buried, so the board opens up only where you
  // dig it.
  for (const thing of [...state.monsters, ...state.rocks]) state.ground.delete(key(thing.x, thing.y));
  return state;
}

function lose(state, why) {
  state.lives--;
  if (state.lives <= 0) {
    state.lives = 0;
    state.over = `${why} · ${state.score} points`;
    return state;
  }
  state.player = { x: Math.floor(WIDTH / 2), y: SKY + 1, dir: "down" };
  state.harpoon = null;
  state.ground.delete(key(state.player.x, state.player.y));
  return state;
}

/** A rock with nothing under it falls, and takes anything under it with it. */
export function fallRocks(state) {
  for (const rock of state.rocks) {
    const below = { x: rock.x, y: rock.y + 1 };
    if (!rock.falling && !isDug(state.ground, below.x, below.y)) continue;
    if (below.y >= HEIGHT) { rock.falling = false; continue; }
    rock.falling = true;
    rock.y += 1;
    state.ground.delete(key(rock.x, rock.y));
    const squashed = state.monsters.filter((m) => m.x === rock.x && m.y === rock.y);
    if (squashed.length) {
      state.monsters = state.monsters.filter((m) => !squashed.includes(m));
      state.score += squashed.length * 200;
    }
    if (state.player.x === rock.x && state.player.y === rock.y) return lose(state, "under a rock");
  }
  return state;
}

/** One monster step: down its own tunnel, turning towards you at a junction. */
export function walkMonster(state, monster) {
  if (monster.pumped) return monster;   // a hooked monster is going nowhere
  const player = state.player;

  // Once in a while one gives up on the tunnels and comes straight through the
  // ground at you. Without it, a player who digs one deep hole is untouchable.
  if (monster.ghost > 0) {
    monster.ghost--;
    monster.x += Math.sign(player.x - monster.x);
    if (monster.x === player.x) monster.y += Math.sign(player.y - monster.y);
    return monster;
  }
  if (state.rng() < 0.02) { monster.ghost = 6; return monster; }

  const options = Object.entries(DIRS)
    .filter(([, [dx, dy]]) => isDug(state.ground, monster.x + dx, monster.y + dy))
    .sort(([, a], [, b]) => {
      const da = Math.abs(monster.x + a[0] - player.x) + Math.abs(monster.y + a[1] - player.y);
      const db = Math.abs(monster.x + b[0] - player.x) + Math.abs(monster.y + b[1] - player.y);
      return da - db;
    });
  if (!options.length) return monster;
  // It prefers the way it is already going when that is no worse, so it does not
  // jitter on the spot at a crossroads.
  const [name, [dx, dy]] = options[0];
  monster.dir = name;
  monster.x += dx;
  monster.y += dy;
  return monster;
}

/** One tick. Exported so a test can clear a level with no clock. */
export function step(state) {
  state.clock++;

  if (state.clock % ROCK_EVERY === 0) {
    fallRocks(state);
    if (state.over) return state;
  }

  if (state.harpoon) {
    // The harpoon holds whatever it caught; it is the pump that does the work.
    const hooked = state.monsters.find((m) => m === state.harpoon.on);
    if (!hooked) state.harpoon = null;
  }

  if (state.clock % MONSTER_EVERY === 0) {
    for (const monster of state.monsters) walkMonster(state, monster);
    const caught = state.monsters.find((m) => m.x === state.player.x && m.y === state.player.y);
    if (caught) return lose(state, "caught underground");
  }

  if (!state.monsters.length) {
    state.level++;
    state.ground = buildGround();
    state.player = { x: Math.floor(WIDTH / 2), y: SKY + 1, dir: "down" };
    state.ground.delete(key(state.player.x, state.player.y));
    state.score += 500;
    populate(state, state.level);
  }
  return state;
}

/** Fire the harpoon down the tunnel you are facing, or pump what is on it. */
export function pump(state) {
  if (state.harpoon) {
    const monster = state.harpoon.on;
    monster.pumped++;
    if (monster.pumped >= POPS_AT) {
      state.monsters = state.monsters.filter((m) => m !== monster);
      state.score += 100 * POPS_AT;
      state.harpoon = null;
    }
    return state;
  }
  const [dx, dy] = DIRS[state.player.dir];
  for (let i = 1; i <= HARPOON; i++) {
    const x = state.player.x + dx * i;
    const y = state.player.y + dy * i;
    if (!isDug(state.ground, x, y)) break;   // it does not go through dirt
    const monster = state.monsters.find((m) => m.x === x && m.y === y);
    if (monster) {
      state.harpoon = { on: monster, x, y };
      monster.pumped = 1;
      return state;
    }
  }
  return state;
}

export const DIGDUG = {
  key: "digdug",
  aliases: ["dig", "pooka"],
  title: "DIG DUG",
  blurb: "dig the tunnels, pump the monsters, drop rocks on the rest",
  keys: "← ↑ ↓ → dig · space pump · q quit",
  tickMs: 60,

  create({ rng = Math.random } = {}) {
    const state = {
      ground: buildGround(),
      player: { x: Math.floor(WIDTH / 2), y: SKY + 1, dir: "down" },
      monsters: [],
      rocks: [],
      harpoon: null,
      score: 0,
      lives: LIVES,
      level: 1,
      clock: 0,
      over: null,
      rng,
    };
    state.ground.delete(key(state.player.x, state.player.y));
    return populate(state, 1);
  },

  tick: step,

  onKey(state, pressed) {
    if (pressed === "space" || pressed === "enter") return pump(state);
    const move = DIRS[pressed];
    if (!move) return state;
    // Moving is digging: the tunnel is wherever you have been.
    state.harpoon = null;
    state.player.dir = pressed;
    const x = state.player.x + move[0];
    const y = state.player.y + move[1];
    if (x < 0 || x >= WIDTH || y <= SKY || y >= HEIGHT) return state;
    if (state.rocks.some((r) => r.x === x && r.y === y && !r.falling)) return state;
    if (state.ground.delete(key(x, y))) state.score += 1;
    state.player.x = x;
    state.player.y = y;
    return state;
  },

  status(state) {
    return state.over
      ? state.over
      : `${state.score} · level ${state.level} · ${state.monsters.length} left · ${"▲".repeat(state.lives)}`;
  },

  render(state) {
    const grid = Array.from({ length: HEIGHT }, (_, y) => Array.from({ length: WIDTH }, (_, x) => (
      state.ground.has(key(x, y)) ? soil("▒") : null
    )));
    const put = (x, y, glyph) => {
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      grid[y][x] = glyph;
    };

    for (const rock of state.rocks) put(rock.x, rock.y, ash("▣"));
    for (const monster of state.monsters) {
      // A monster part-way through being pumped is visibly bigger, which is the
      // only feedback the pump gives you.
      const art = monster.pumped >= 2 ? "◯" : monster.pumped ? "◎" : "◉";
      put(monster.x, monster.y, (monster.ghost ? amber : danger)(art));
    }
    if (state.harpoon) {
      const [dx, dy] = DIRS[state.player.dir];
      for (let i = 1; i < HARPOON; i++) {
        const x = state.player.x + dx * i;
        const y = state.player.y + dy * i;
        if (x === state.harpoon.x && y === state.harpoon.y) break;
        put(x, y, bone(dx ? "─" : "│"));
      }
    }
    put(state.player.x, state.player.y, state.over ? danger("✷") : acid("◈"));

    return grid.map((row, y) => row.map((cell) => (
      cell ?? (y <= SKY ? dim("·") : " ")
    )).join(""));
  },
};
