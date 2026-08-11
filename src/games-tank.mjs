// Tank. Two of them in a walled yard, one shell each in the air at a time, five
// hits and it is over.
//
// Everything is on the grid and turned in quarter turns, because a tank you
// cannot line up is a tank you cannot aim, and lining up *is* the shot. Your
// keys are one action each — a press turns you or moves you one cell — so
// holding an arrow drives, and tapping it nudges.
import { acid, ash, bone, danger, dim } from "./ui.mjs";

export const TARGET = 5;

/**
 * The yard. `#` is wall, and the outer ring is closed — a shell that leaves the
 * board is a shell nobody saw stop.
 */
export const YARD = [
  "##########################################",
  "#                                        #",
  "#    ####        ######        ####      #",
  "#       #             #           #      #",
  "#       #    ####     #    ####   #      #",
  "#            #  #          #  #          #",
  "#    #####   #  #   ####   #  #   ####   #",
  "#            #  #          #  #          #",
  "#       #    ####     #    ####   #      #",
  "#       #             #           #      #",
  "#    ####        ######        ####      #",
  "#                                        #",
  "##########################################",
];

export const isWall = (x, y) => (YARD[y]?.[x] ?? "#") === "#";

// Derived from the yard rather than declared beside it, so the two can never
// disagree about how big the board is.
export const WIDTH = YARD[0].length;
export const HEIGHT = YARD.length;

/** Quarter turns, and the glyph a tank wears pointing that way. */
export const HEADINGS = [
  { dx: 0, dy: -1, glyph: "▲" },
  { dx: 1, dy: 0, glyph: "▶" },
  { dx: 0, dy: 1, glyph: "▼" },
  { dx: -1, dy: 0, glyph: "◀" },
];

const SHELL_SPEED = 1;   // cells per tick
const THEM_EVERY = 4;    // the machine gets a move every this many ticks

const spawnYou = () => ({ x: 2, y: 6, dir: 1, cool: 0 });
const spawnThem = () => ({ x: WIDTH - 3, y: 6, dir: 3, cool: 0 });

/** Move a tank one cell if there is floor there. Walls simply refuse. */
export function drive(tank, sign) {
  const { dx, dy } = HEADINGS[tank.dir];
  const x = tank.x + dx * sign;
  const y = tank.y + dy * sign;
  if (isWall(x, y)) return false;
  tank.x = x;
  tank.y = y;
  return true;
}

export const fire = (tank, owner) => ({
  x: tank.x + HEADINGS[tank.dir].dx,
  y: tank.y + HEADINGS[tank.dir].dy,
  dir: tank.dir,
  owner,
});

/**
 * Whether a tank can see another down the barrel: same row or column, nothing
 * but floor in between. This is both how the machine decides to shoot and the
 * only thing it is good at.
 */
export function lineOfSight(from, to) {
  const { dx, dy } = HEADINGS[from.dir];
  let x = from.x + dx;
  let y = from.y + dy;
  for (let i = 0; i < Math.max(WIDTH, HEIGHT); i++) {
    if (isWall(x, y)) return false;
    if (x === to.x && y === to.y) return true;
    x += dx;
    y += dy;
  }
  return false;
}

/**
 * The next cell on the shortest way from one point to another, and the heading
 * that gets there.
 *
 * This is a breadth-first search of the whole yard on every decision, which
 * sounds extravagant for 546 cells and is not: it is the difference between a
 * tank that comes around the block after you and one that drives into the same
 * wall forever, which is what "just turn towards the enemy" does the moment
 * there is anything between the two of you.
 */
export function stepToward(from, to) {
  if (from.x === to.x && from.y === to.y) return null;
  const seen = new Set([`${from.x},${from.y}`]);
  const queue = [{ x: from.x, y: from.y, first: null }];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (let dir = 0; dir < HEADINGS.length; dir++) {
      const x = cur.x + HEADINGS[dir].dx;
      const y = cur.y + HEADINGS[dir].dy;
      const key = `${x},${y}`;
      if (isWall(x, y) || seen.has(key)) continue;
      seen.add(key);
      const first = cur.first ?? { x, y, dir };
      if (x === to.x && y === to.y) return first;
      queue.push({ x, y, first });
    }
  }
  return null;
}

/** One quarter turn from `dir` towards `want`, the short way round. */
export const quarterTurn = (dir, want) => (dir + ((want - dir + 4) % 4 === 3 ? 3 : 1)) % 4;

function hit(state, who) {
  if (who === "you") state.yours++; else state.theirs++;
  state.shells = [];
  state.you = spawnYou();
  state.them = spawnThem();
  if (state.yours >= TARGET) state.over = `you take it ${state.yours}–${state.theirs} 🤘`;
  else if (state.theirs >= TARGET) state.over = `the machine takes it ${state.theirs}–${state.yours}`;
  return state;
}

/** One tick: shells first, then the machine takes its turn. */
export function step(state) {
  for (const shell of [...state.shells]) {
    for (let i = 0; i < SHELL_SPEED; i++) {
      const { dx, dy } = HEADINGS[shell.dir];
      shell.x += dx;
      shell.y += dy;
      if (isWall(shell.x, shell.y)) { state.shells = state.shells.filter((s) => s !== shell); break; }
      const target = shell.owner === "you" ? state.them : state.you;
      if (shell.x === target.x && shell.y === target.y) {
        state.shells = state.shells.filter((s) => s !== shell);
        hit(state, shell.owner);
        return state;
      }
    }
  }
  if (state.over) return state;

  if (state.you.cool > 0) state.you.cool--;
  if (state.them.cool > 0) state.them.cool--;

  state.clock++;
  if (state.clock % THEM_EVERY) return state;

  // The machine: shoot if it is looking at you, otherwise turn towards you, and
  // drive when it is already pointed the right way. It is not clever, but it is
  // relentless, and in a yard this size that is enough.
  const them = state.them;
  if (lineOfSight(them, state.you)) {
    if (!them.cool && !state.shells.some((s) => s.owner === "them")) {
      state.shells.push(fire(them, "them"));
      them.cool = 6;
    }
    return state;
  }
  const next = stepToward(them, state.you);
  if (!next) return state;
  if (them.dir !== next.dir) them.dir = quarterTurn(them.dir, next.dir);
  else drive(them, 1);
  return state;
}

export const TANK = {
  key: "tank",
  aliases: ["tanks", "combat"],
  title: "TANK",
  blurb: "two tanks, one yard, five hits — line it up and let go",
  keys: "← → turn · ↑ drive · ↓ reverse · space fire · q quit",
  tickMs: 60,

  create() {
    return {
      you: spawnYou(),
      them: spawnThem(),
      shells: [],
      yours: 0,
      theirs: 0,
      clock: 0,
      over: null,
    };
  },

  tick: step,

  onKey(state, key) {
    const you = state.you;
    if (key === "left") you.dir = (you.dir + 3) % 4;
    else if (key === "right") you.dir = (you.dir + 1) % 4;
    else if (key === "up") drive(you, 1);
    else if (key === "down") drive(you, -1);
    else if (key === "space" || key === "enter") {
      // One shell of yours in the air at a time, same as the machine. Two would
      // turn a duel into a hosepipe.
      if (you.cool || state.shells.some((s) => s.owner === "you")) return state;
      const shell = fire(you, "you");
      if (!isWall(shell.x, shell.y)) state.shells.push(shell);
      you.cool = 4;
    }
    return state;
  },

  status(state) {
    return state.over ? state.over : `you ${state.yours} · machine ${state.theirs}`;
  },

  render(state) {
    const grid = YARD.map((row) => [...row].map((c) => (c === "#" ? ash("█") : null)));
    const put = (x, y, glyph) => {
      if (!grid[y] || x < 0 || x >= grid[y].length) return;
      grid[y][x] = glyph;
    };

    for (const shell of state.shells) put(shell.x, shell.y, (shell.owner === "you" ? bone : danger)("•"));
    put(state.you.x, state.you.y, acid(HEADINGS[state.you.dir].glyph));
    put(state.them.x, state.them.y, danger(HEADINGS[state.them.dir].glyph));

    return grid.map((row) => row.map((cell) => cell ?? dim("·")).join(""));
  },
};
