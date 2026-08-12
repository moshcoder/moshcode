// Breakout. A wall, a paddle, and one ball that is always your fault.
//
// The bounce off the paddle is not a mirror: where the ball lands on the paddle
// decides the angle it leaves at, so the paddle is a steering wheel rather than
// a wall. Without that you cannot dig a channel up the side of the wall, and
// digging a channel is the entire reason anybody still plays this.
import { acid, amber, bone, danger, rgb } from "./ui.mjs";

export const WIDTH = 40;
export const HEIGHT = 17;

export const BRICK_W = 4;
export const BRICK_COLS = WIDTH / BRICK_W;  // 10
export const BRICK_ROWS = 5;
export const BRICK_TOP = 1;

export const PADDLE_W = 7;
export const PADDLE_ROW = HEIGHT - 1;
const PADDLE_STEP = 2;  // a keypress, not a tick — unchanged by the tick rate

/**
 * How often the wall is stepped. See the note in games-pong.mjs: the ball can
 * only be drawn on whole cells, so smoothness comes from ticking often enough
 * that the frames where it has not crossed into the next one go by too fast to
 * read as a stall. Those frames are identical, and `runGame` does not write
 * identical frames, so the extra ticks cost nothing on the wire.
 *
 * Ticking finer buys this game a second thing: at 0.34 rows a tick the ball
 * used to cross a whole brick row between two samples, so which side it bounced
 * off was a guess. It now samples inside every row it enters.
 */
export const TICK_MS = 16;

/** The speeds below are still written per 50ms, the rate this was tuned at. */
const SCALE = TICK_MS / 50;

const LIVES = 3;
const BASE_VX = 0.62 * SCALE;
const BASE_VY = 0.34 * SCALE;   // half of vx, because a row is two columns
const SPIN = 0.5 * SCALE;
const MAX_VX = 1.4 * SCALE;
const MIN_VX = 0.15 * SCALE;    // never let it go vertical and unsteerable
const LEVEL_UP = 1.12;          // a multiplier on pace, so it does not scale

/** Top rows are worth more, which is what makes the ball worth risking. */
export const ROW_POINTS = [50, 40, 30, 20, 10];
const ROW_COLOR = [danger, amber, acid, rgb(90, 200, 250), rgb(190, 130, 255)];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A full wall: every brick standing. */
export const buildWall = () => Array.from({ length: BRICK_ROWS }, () => Array.from({ length: BRICK_COLS }, () => true));

export const bricksLeft = (wall) => wall.reduce((n, row) => n + row.filter(Boolean).length, 0);

/** The brick under a cell, or null. */
export function brickAt(wall, x, y) {
  const row = y - BRICK_TOP;
  if (row < 0 || row >= BRICK_ROWS) return null;
  const col = Math.floor(x / BRICK_W);
  if (col < 0 || col >= BRICK_COLS || !wall[row]?.[col]) return null;
  return { row, col };
}

/** The ball sitting on the paddle, waiting for space. */
function rest(state) {
  state.ball = { x: state.paddle + PADDLE_W / 2, y: PADDLE_ROW - 1, vx: 0, vy: 0 };
  state.stuck = true;
  return state;
}

export function launch(state) {
  if (!state.stuck) return state;
  state.stuck = false;
  state.ball.vx = (state.rng() < 0.5 ? -1 : 1) * BASE_VX * state.pace;
  state.ball.vy = -BASE_VY * state.pace;
  return state;
}

/** One tick. Exported so a test can clear a whole wall with no clock. */
export function step(state) {
  if (state.stuck) {
    // A ball that has not been launched rides the paddle, so moving before you
    // serve aims the serve.
    state.ball.x = state.paddle + PADDLE_W / 2;
    return state;
  }

  const ball = state.ball;
  const wasCol = Math.round(ball.x);
  const wasRow = Math.round(ball.y);
  ball.x += ball.vx;
  ball.y += ball.vy;

  if (ball.x < 0) { ball.x = -ball.x; ball.vx = Math.abs(ball.vx); }
  if (ball.x > WIDTH - 1) { ball.x = 2 * (WIDTH - 1) - ball.x; ball.vx = -Math.abs(ball.vx); }
  if (ball.y < 0) { ball.y = -ball.y; ball.vy = Math.abs(ball.vy); }

  const col = Math.round(ball.x);
  const row = Math.round(ball.y);
  const brick = brickAt(state.wall, col, row);
  if (brick) {
    state.wall[brick.row][brick.col] = false;
    state.score += ROW_POINTS[brick.row];
    // Which way it bounces depends on which way it came in: through a row means
    // the ball flips vertically, along a row means it flips sideways.
    if (row !== wasRow) ball.vy = -ball.vy;
    else if (col !== wasCol) ball.vx = -ball.vx;
    else ball.vy = -ball.vy;
    if (!bricksLeft(state.wall)) return cleared(state);
  }

  if (ball.vy > 0 && ball.y >= PADDLE_ROW - 1) {
    const off = ball.x - (state.paddle + (PADDLE_W - 1) / 2);
    if (Math.abs(off) <= PADDLE_W / 2 + 0.5) {
      ball.y = PADDLE_ROW - 1;
      ball.vy = -Math.abs(ball.vy);
      // The steering wheel: the further out you take it, the flatter it leaves.
      ball.vx = clamp(ball.vx + (off / (PADDLE_W / 2)) * SPIN * 0.5, -MAX_VX, MAX_VX);
      if (Math.abs(ball.vx) < MIN_VX) ball.vx = ball.vx < 0 ? -MIN_VX : MIN_VX;
    }
  }

  if (ball.y > PADDLE_ROW) {
    state.lives--;
    if (state.lives <= 0) {
      state.lives = 0;
      state.over = `out of balls · ${state.score} points`;
      return state;
    }
    rest(state);
  }
  return state;
}

function cleared(state) {
  state.level++;
  state.pace *= LEVEL_UP;
  state.wall = buildWall();
  state.score += 100;
  return rest(state);
}

export const BREAKOUT = {
  key: "breakout",
  aliases: ["arkanoid", "wall"],
  title: "BREAKOUT",
  blurb: "dig a channel up the side and let the ball do the rest",
  keys: "← → paddle · space launch · q quit",
  tickMs: TICK_MS,

  create({ rng = Math.random } = {}) {
    const state = {
      wall: buildWall(),
      paddle: Math.floor((WIDTH - PADDLE_W) / 2),
      score: 0,
      lives: LIVES,
      level: 1,
      pace: 1,
      over: null,
      rng,
    };
    return rest(state);
  },

  tick: step,

  onKey(state, key) {
    if (key === "left") state.paddle = clamp(state.paddle - PADDLE_STEP, 0, WIDTH - PADDLE_W);
    else if (key === "right") state.paddle = clamp(state.paddle + PADDLE_STEP, 0, WIDTH - PADDLE_W);
    else if (key === "space" || key === "up" || key === "enter") launch(state);
    return state;
  },

  status(state) {
    return state.over
      ? state.over
      : `${state.score} · level ${state.level} · ${"●".repeat(state.lives)}`;
  },

  render(state) {
    const grid = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => null));
    const put = (x, y, glyph) => {
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      grid[y][x] = glyph;
    };

    for (let row = 0; row < BRICK_ROWS; row++) {
      for (let col = 0; col < BRICK_COLS; col++) {
        if (!state.wall[row][col]) continue;
        // A brick is drawn exactly as wide as it is hit, with a seam so the wall
        // reads as bricks rather than as one solid slab.
        for (let i = 0; i < BRICK_W; i++) {
          put(col * BRICK_W + i, BRICK_TOP + row, ROW_COLOR[row](i === BRICK_W - 1 ? "▓" : "█"));
        }
      }
    }

    for (let i = 0; i < PADDLE_W; i++) put(state.paddle + i, PADDLE_ROW, bone("▀"));
    put(Math.round(state.ball.x), Math.round(state.ball.y), state.stuck ? amber("●") : bone("●"));

    return grid.map((row) => row.map((cell) => cell ?? " ").join(""));
  },
};
