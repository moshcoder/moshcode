// Pac-Man, arcade-sized. One maze, 240-odd dots, four power pellets and three
// ghosts that are not quite as clever as the ones in 1980 — on purpose. This is
// a game you can win on a coffee break.
import { acid, amber, ash, dim, rgb } from "./ui.mjs";

/**
 * `#` wall · `.` dot · `o` power pellet · `P` where pac starts · `G` the pen.
 *
 * Symmetric, fully connected, and small enough that the whole board fits above
 * the pit's prompt without scrolling.
 */
export const MAZE = [
  "###################",
  "#........#........#",
  "#o##.###.#.###.##o#",
  "#.................#",
  "#.##.#.#####.#.##.#",
  "#....#...G...#....#",
  "####.##.###.##.####",
  "#........P........#",
  "#.##.####.####.##.#",
  "#o...............o#",
  "###################",
];

export const WIDTH = MAZE[0].length;
export const HEIGHT = MAZE.length;

const WALL = ash("██");
const DOT = dim("· ");
const POWER = amber("✳ ");
const PAC = acid("● ");
const BLANK = "  ";
const GHOST_COLORS = [rgb(255, 77, 61), rgb(255, 120, 180), rgb(90, 220, 250)];
const SCARED = rgb(90, 140, 255);

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" };
const FRIGHT_TICKS = 40;

export const isWall = (x, y) => MAZE[y]?.[x] === "#" || MAZE[y]?.[x] === undefined;
const cellKey = (x, y) => `${x},${y}`;
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Every dot and pellet in the maze, as a fresh map. */
export function pellets() {
  const map = new Map();
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const cell = MAZE[y][x];
      if (cell === "." || cell === "o") map.set(cellKey(x, y), cell);
    }
  }
  return map;
}

function find(char) {
  for (let y = 0; y < HEIGHT; y++) {
    const x = MAZE[y].indexOf(char);
    if (x >= 0) return { x, y };
  }
  return { x: 1, y: 1 };
}

/** Where everything stands at the start of a life. */
function positions() {
  const pen = find("G");
  const pac = find("P");
  return {
    pac: { ...pac, dir: "left", want: "left" },
    // Three ghosts abreast in the pen — the two beside it are open corridor in
    // this maze, which is what keeps them from stepping on each other at spawn.
    ghosts: [
      { x: pen.x, y: pen.y },
      { x: pen.x - 1, y: pen.y },
      { x: pen.x + 1, y: pen.y },
    ].map((g, i) => ({ ...g, home: { x: g.x, y: g.y }, dir: "up", color: i })),
  };
}

/** Directions a ghost may take from where it stands. */
export function options(ghost, { allowReverse = false } = {}) {
  const open = Object.entries(DIRS)
    .filter(([name, [dx, dy]]) => !isWall(ghost.x + dx, ghost.y + dy)
      && (allowReverse || name !== OPPOSITE[ghost.dir]));
  // A dead end is the one place reversing is the only move there is.
  return open.length ? open : Object.entries(DIRS).filter(([, [dx, dy]]) => !isWall(ghost.x + dx, ghost.y + dy));
}

/**
 * One ghost step. Chases by Manhattan distance, flees while you are lit up,
 * and takes a random legal turn one time in five so the three of them do not
 * arrive in a single-file line.
 */
export function moveGhost(ghost, pac, { frightened = false, rng = Math.random } = {}) {
  const open = options(ghost);
  if (!open.length) return ghost;
  const scored = open.map(([name, [dx, dy]]) => ({
    name,
    dx,
    dy,
    d: distance({ x: ghost.x + dx, y: ghost.y + dy }, pac),
  }));
  let choice;
  if (rng() < 0.2) choice = scored[Math.floor(rng() * scored.length) % scored.length];
  else {
    const sorted = scored.slice().sort((a, b) => (frightened ? b.d - a.d : a.d - b.d));
    choice = sorted[0];
  }
  ghost.dir = choice.name;
  ghost.x += choice.dx;
  ghost.y += choice.dy;
  return ghost;
}

function caught(state) {
  const hits = state.ghosts.filter((g) => g.x === state.pac.x && g.y === state.pac.y);
  if (!hits.length) return false;
  if (state.fright > 0) {
    for (const g of hits) {
      state.score += 200;
      Object.assign(g, { x: g.home.x, y: g.home.y, dir: "up" });
    }
    return false;
  }
  state.lives--;
  if (state.lives <= 0) { state.over = "game over"; return true; }
  Object.assign(state, positions(), { fright: 0 });
  return true;
}

export const PACMAN = {
  key: "pacman",
  aliases: ["pac", "pacmam", "puckman"],
  title: "PAC-MAN",
  blurb: "eat the dots, dodge the ghosts, ✳ makes them edible",
  keys: "← ↑ ↓ → steer · q quit",
  tickMs: 150,

  create({ rng = Math.random } = {}) {
    return { ...positions(), dots: pellets(), score: 0, lives: 3, fright: 0, frame: 0, over: null, rng };
  },

  tick(state) {
    state.frame++;
    const pac = state.pac;
    // A turn is remembered until it becomes legal, which is what makes a corner
    // feel like a corner rather than a keypress you have to time.
    const wanted = DIRS[pac.want];
    if (wanted && !isWall(pac.x + wanted[0], pac.y + wanted[1])) pac.dir = pac.want;
    const [dx, dy] = DIRS[pac.dir];
    if (!isWall(pac.x + dx, pac.y + dy)) { pac.x += dx; pac.y += dy; }

    const here = state.dots.get(cellKey(pac.x, pac.y));
    if (here) {
      state.dots.delete(cellKey(pac.x, pac.y));
      state.score += here === "o" ? 50 : 10;
      if (here === "o") state.fright = FRIGHT_TICKS;
    }
    if (!state.dots.size) { state.over = "maze cleared 🤘"; return state; }
    if (caught(state)) return state;

    // Ghosts move at half speed, and slower still while they are running away.
    const beat = state.fright > 0 ? 3 : 2;
    if (state.frame % beat === 0) {
      for (const ghost of state.ghosts) {
        moveGhost(ghost, pac, { frightened: state.fright > 0, rng: state.rng });
      }
      caught(state);
    }
    if (state.fright > 0) state.fright--;
    return state;
  },

  onKey(state, pressed) {
    if (DIRS[pressed]) state.pac.want = pressed;
    return state;
  },

  status(state) {
    const left = state.dots.size;
    if (state.over) return `${state.over} · ${state.score} points`;
    return `score ${state.score} · lives ${"●".repeat(Math.max(0, state.lives))} · dots ${left}`
      + (state.fright > 0 ? " · RUN" : "");
  },

  render(state) {
    const rows = [];
    for (let y = 0; y < HEIGHT; y++) {
      let row = "";
      for (let x = 0; x < WIDTH; x++) {
        const ghost = state.ghosts.find((g) => g.x === x && g.y === y);
        if (state.pac.x === x && state.pac.y === y) row += PAC;
        else if (ghost) row += (state.fright > 0 ? SCARED : GHOST_COLORS[ghost.color])("▲ ");
        else if (MAZE[y][x] === "#") row += WALL;
        else {
          const pellet = state.dots.get(cellKey(x, y));
          row += pellet === "o" ? POWER : pellet === "." ? DOT : BLANK;
        }
      }
      rows.push(row);
    }
    return rows;
  },
};
