// Breakout. A wall, a paddle, and one ball that is always your fault.
//
// The bounce off the paddle is not a mirror: where the ball lands on the paddle
// decides the angle it leaves at, so the paddle is a steering wheel rather than
// a wall. Without that you cannot dig a channel up the side of the wall, and
// digging a channel is the entire reason anybody still plays this.
import { advanceBall, drawnBall, drawnCell, snapBall } from "./games-draw.mjs";
import { glidePaddle, holdPaddle, paddleMotion, perSecond, pressPaddle, releasePaddle } from "./games-paddle.mjs";
import { acid, amber, bone, danger, rgb } from "./ui.mjs";

export const WIDTH = 40;
export const HEIGHT = 17;

export const BRICK_W = 4;
export const BRICK_COLS = WIDTH / BRICK_W;  // 10
export const BRICK_ROWS = 5;
export const BRICK_TOP = 1;

export const PADDLE_W = 7;
export const PADDLE_ROW = HEIGHT - 1;
// Three columns a press was enough to keep up with the ball and much too much
// to watch: at a terminal's repeat rate the paddle covered ninety columns a
// second in jumps you could count. It is now a press's worth of *travel* rather
// than a jump, paid out over the ticks that follow — see games-paddle.mjs.
const PADDLE_STEP = 3;            // columns one press is worth

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

/**
 * How hard the wall is played, against the pace it was first tuned at.
 *
 * Launched, the old ball took three seconds to cross the board and two and a
 * half to fall the height of it, which is a slow enough ball that you can put
 * the paddle under it and go and make a cup of tea. It also meant the drawn
 * ball moved twenty times a second, and twenty steps a second does not read as
 * travel however even they are. Everything below scales together, so a ball off
 * the end of the paddle leaves at the angle it always did.
 */
const PACE = 1.9;

/** The speeds below are still written per 50ms, the rate this was tuned at. */
const SCALE = (TICK_MS / 50) * PACE;

const LIVES = 3;
const BASE_VX = 0.62 * SCALE;
const BASE_VY = 0.34 * SCALE;   // half of vx, because a row is two columns
const SPIN = 0.5 * SCALE;
const MAX_VX = 1.4 * SCALE;
const MIN_VX = 0.15 * SCALE;    // never let it go vertical and unsteerable
const LEVEL_UP = 1.12;          // a multiplier on pace, so it does not scale

/**
 * How fast the paddle runs while you hold an arrow, in columns per second.
 *
 * The fastest the ball ever travels sideways is `MAX_VX`, which is fifty-three
 * columns a second. A paddle slower than that is one that a ball taken off the
 * end can simply outrun, so this sits just above it: you can always still get
 * there, and only just, which is the game. It crosses the board in a little
 * over half a second.
 */
const PADDLE_RATE = perSecond(58, TICK_MS);

/** The board's edges, as far as the paddle is concerned. */
const PADDLE_GLIDE = { rate: PADDLE_RATE, step: PADDLE_STEP, lo: 0, hi: WIDTH - PADDLE_W };

/** Which way an arrow moves the paddle, and 0 for a key that is not one. */
const towards = (key) => (key === "left" ? -1 : key === "right" ? 1 : 0);

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
  state.drawn = drawnBall(state.ball.x, state.ball.y);
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
  // The paddle moves here, with the ball, rather than back in `onKey` — so it
  // travels at a speed instead of jumping at the keyboard's repeat rate. It
  // goes first so that a ball resting on it is put where it has just got to.
  state.paddle = glidePaddle(state.motion, state.paddle, PADDLE_GLIDE);

  if (state.stuck) {
    // A ball that has not been launched rides the paddle, so moving before you
    // serve aims the serve. It is carried rather than travelling, so it is put
    // where the paddle is rather than paced there — a stationary ball earns no
    // steps, and would otherwise sit still while the paddle slid out from under
    // it.
    state.ball.x = state.paddle + PADDLE_W / 2;
    snapBall(state.drawn, state.ball.x, state.ball.y);
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

  advanceBall(state.drawn, ball);

  if (ball.y > PADDLE_ROW) {
    state.lives--;
    if (state.lives <= 0) {
      state.lives = 0;
      state.over = `out of balls · ${state.score} points`;
      // The last ball is left where it went, below the board and so off it,
      // rather than resting on the row it fell past.
      snapBall(state.drawn, ball.x, ball.y);
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
  heldKeys: true,   // worth asking the terminal for key releases — see games.mjs

  create({ rng = Math.random } = {}) {
    const state = {
      wall: buildWall(),
      paddle: Math.floor((WIDTH - PADDLE_W) / 2),
      motion: paddleMotion(),
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

  onKey(state, key, ctx) {
    const dir = towards(key);
    if (dir) {
      // Told when the key comes back up, the paddle is simply put in gear and
      // the tick does the rest — including for the auto-repeats that keep
      // arriving while it is held, which must not be allowed to add a second
      // helping of speed on top of the one the tick is already paying.
      if (ctx?.heldKeys) { holdPaddle(state.motion, dir); return state; }
      // Not told, it is paid for a press at a time. A press that finds it
      // standing still is also spent immediately, so the frame this keypress
      // draws already has it moving; a press that finds it already moving is
      // not, because the tick is paying it out evenly and a second helping on
      // top would be the very jolt this is here to remove.
      const resting = state.motion.owed === 0;
      pressPaddle(state.motion, dir, PADDLE_STEP);
      if (resting) state.paddle = glidePaddle(state.motion, state.paddle, PADDLE_GLIDE);
      // A ball waiting on the paddle is carried by it, and aiming the serve is
      // the only thing you can do before you launch: it would look broken if it
      // stayed behind until the next tick.
      if (state.stuck) {
        state.ball.x = state.paddle + PADDLE_W / 2;
        snapBall(state.drawn, state.ball.x, state.ball.y);
      }
    } else if (key === "space" || key === "up" || key === "enter") launch(state);
    return state;
  },

  onRelease(state, key) {
    const dir = towards(key);
    if (dir) releasePaddle(state.motion, dir);
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

    // The paddle travels on fractions of a column and is drawn on whole ones,
    // the same as the ball is.
    const paddle = Math.round(state.paddle);
    for (let i = 0; i < PADDLE_W; i++) put(paddle + i, PADDLE_ROW, bone("▀"));
    // Drawn on half-rows and on its own even clock, so the ball steps the same
    // distance down the wall as across it, and at a rate. See games-draw.mjs.
    const ball = drawnCell(state.drawn);
    put(ball.col, ball.row, (state.stuck ? amber : bone)(ball.glyph));

    return grid.map((row) => row.map((cell) => cell ?? " ").join(""));
  },
};
