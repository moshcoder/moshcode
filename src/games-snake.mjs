// Snake. The cheapest game in the arcade and the hardest to stop playing.
import { acid, amber, dim, rgb } from "./ui.mjs";

export const WIDTH = 28;
export const HEIGHT = 14;

const HEAD = acid("█");
const BODY = rgb(120, 190, 40)("▓");
const FOOD = amber("✳");
const EMPTY = dim("·");

const DIRS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

const same = (a, b) => a[0] === b[0] && a[1] === b[1];

/** A cell nothing is standing on, so the food never lands under the snake. */
export function placeFood(snake, rng) {
  const free = [];
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (!snake.some((s) => same(s, [x, y]))) free.push([x, y]);
    }
  }
  if (!free.length) return null; // the board is snake — that is a win
  return free[Math.floor(rng() * free.length) % free.length];
}

/**
 * One step. Returns the state; sets `over` when the head meets a wall or
 * itself. Kept separate from the game object so a test can walk a snake into
 * its own tail on purpose.
 */
export function step(state) {
  const [dx, dy] = DIRS[state.dir];
  const head = [state.snake[0][0] + dx, state.snake[0][1] + dy];
  if (head[0] < 0 || head[0] >= WIDTH || head[1] < 0 || head[1] >= HEIGHT) {
    state.over = "into the wall";
    return state;
  }
  // The tail cell is about to move out from under the head, so it is only a
  // collision when the snake is about to grow into it.
  const eating = state.food && same(head, state.food);
  const body = eating ? state.snake : state.snake.slice(0, -1);
  if (body.some((s) => same(s, head))) {
    state.over = "ate itself";
    return state;
  }
  state.snake = [head, ...body];
  if (eating) {
    state.score += 10;
    state.food = placeFood(state.snake, state.rng);
    if (!state.food) state.over = "the whole board — no notes";
  }
  state.turned = false;
  return state;
}

export const SNAKE = {
  key: "snake",
  aliases: ["worm", "nibbles"],
  title: "SNAKE",
  blurb: "eat, grow, and try not to eat yourself",
  keys: "← ↑ ↓ → turn · q quit",
  tickMs: (state) => Math.max(60, 130 - state.snake.length * 2),

  create({ rng = Math.random } = {}) {
    const mid = Math.floor(HEIGHT / 2);
    const snake = [[6, mid], [5, mid], [4, mid]];
    return { snake, dir: "right", turned: false, score: 0, over: null, rng, food: placeFood(snake, rng) };
  },

  tick: step,

  onKey(state, key) {
    if (!DIRS[key]) return state;
    // One turn per tick, and never a full reverse: without either, a fast
    // left-then-up folds the snake back through its own neck.
    const opposite = { up: "down", down: "up", left: "right", right: "left" };
    if (state.turned || opposite[key] === state.dir || key === state.dir) return state;
    state.dir = key;
    state.turned = true;
    return state;
  },

  status(state) {
    return state.over
      ? `${state.over} · ${state.score} points`
      : `score ${state.score} · length ${state.snake.length}`;
  },

  render(state) {
    const rows = [];
    for (let y = 0; y < HEIGHT; y++) {
      let row = "";
      for (let x = 0; x < WIDTH; x++) {
        const cell = [x, y];
        if (same(state.snake[0], cell)) row += HEAD;
        else if (state.snake.some((s) => same(s, cell))) row += BODY;
        else if (state.food && same(state.food, cell)) row += FOOD;
        else row += EMPTY;
      }
      rows.push(row);
    }
    return rows;
  },
};
