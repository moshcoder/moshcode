// Pong. The oldest one in the cabinet, and still the one that explains itself
// fastest: you are the left paddle, the ball is going that way, do something.
//
// The machine on the right is deliberately not perfect. It waits until the ball
// crosses the halfway line before it starts tracking, and then it moves slowly
// enough that it cannot reach a corner from the middle in the time it has left.
// A flat return it will always get; one taken off the end of your paddle it will
// not. That is the whole game, and it is why the angle off the paddle depends on
// where the ball hit it.
import { advanceBall, drawnBall, drawnCell, snapBall } from "./games-draw.mjs";
import { glidePaddle, holdPaddle, paddleMotion, perSecond, pressPaddle, releasePaddle } from "./games-paddle.mjs";
import { acid, bone, danger, dim } from "./ui.mjs";

export const WIDTH = 44;
export const HEIGHT = 16;

/** A row is worth two columns, so the ball travels at the angle it looks like. */
const ASPECT = 0.5;

export const PADDLE = 4;          // rows tall
export const YOU_COL = 2;
export const THEM_COL = WIDTH - 3;
export const TARGET = 7;          // first to this many

/**
 * How often the table is stepped.
 *
 * The board is a grid of characters, so wherever the ball really is it can only
 * ever be drawn on a whole cell — and what reads as smooth is not the size of
 * that step but the evenness of it. At 55ms a ball crossing fifteen columns a
 * second advances a cell on six ticks out of seven and stands still on the
 * seventh, and that one stalled frame, arriving three times a second, is the
 * jiggle. Ticking at 16ms does not move the ball anywhere different at any
 * given moment; it shrinks the stall from 55ms to 16ms, which is under what the
 * eye reads as a stop. It is close to free, too: a tick that leaves the ball in
 * the same cell renders an identical frame, and `runGame` never writes one of
 * those to the terminal.
 */
export const TICK_MS = 16;

/**
 * How hard the table is played, against the pace it was first tuned at.
 *
 * The old pace put the ball across the table in just under three seconds. That
 * is not a ball being hit, it is a ball being carried, and it was also why the
 * drawn ball only moved twenty times a second — too few steps for any of them
 * to be smooth. Everything below is scaled by this, the machine along with the
 * ball, so the balance is exactly the one that was tuned; only the clock it is
 * played against changes.
 */
const PACE = 1.9;

/**
 * The speeds below are still written per 55ms — the rate this game was tuned
 * at — and scaled to the tick. Keeping the tuned numbers legible matters more
 * than saving a multiply: they are what makes the machine beatable off the end
 * of the paddle and not from the middle, and that balance is the game.
 */
const SCALE = (TICK_MS / 55) * PACE;

const SERVE_SPEED = 0.85 * SCALE;
const MAX_SPEED = 1.7 * SCALE;
const SPIN = 0.55 * SCALE;        // how much the edge of the paddle bends the ball
const THEM_SPEED = 0.3 * SCALE;   // slow enough that a ball into the corner beats it
const FLAT = 0.08 * SCALE;        // below this a rally has gone flat
const NUDGE = 0.12 * SCALE;       // and this is the angle it is put back at
const MAX_VY = 0.5 * SCALE;

/**
 * Your paddle, which moves on this game's clock and not on the keyboard's.
 *
 * `YOU_RATE` is the speed the paddle actually travels at while you hold an
 * arrow, in rows per second, so it says something about the game rather than
 * about the rate the game happens to tick at. Twenty-one rows a second crosses
 * the table's twelve in a little over half a second — comfortably faster than
 * the ball falls, which is what makes a ball put into the corner a shot you
 * lost rather than one you were never allowed to reach. The machine is left at
 * ten rows a second and so is still beatable exactly where it always was.
 *
 * `YOU_STEP` is what one press is worth, and therefore also how far the paddle
 * will still glide after you let go: nudging without holding moves a shade over
 * a row, and a released paddle is done within a tenth of a second. See
 * games-paddle.mjs for why a press buys movement instead of performing it.
 */
const YOU_RATE = perSecond(21, TICK_MS);
const YOU_STEP = 1.2;             // rows one press is worth

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The table's ends, as far as your paddle is concerned. */
const YOU_GLIDE = { rate: YOU_RATE, step: YOU_STEP, lo: 0, hi: HEIGHT - PADDLE };

/** Which way an arrow moves your paddle, and 0 for a key that is not one. */
const towards = (key) => (key === "up" ? -1 : key === "down" ? 1 : 0);

/** A ball in the middle, heading at whoever just lost the point. */
export function serve(state, toward) {
  state.ball = {
    x: WIDTH / 2,
    y: HEIGHT / 2,
    vx: toward * SERVE_SPEED,
    // Never dead flat: a ball with no angle is a rally nobody can lose.
    vy: (state.rng() < 0.5 ? -1 : 1) * (0.15 + state.rng() * 0.2) * SCALE,
  };
  // A serve is a ball put on the table, not a ball that travelled there.
  state.drawn = drawnBall(state.ball.x, state.ball.y);
  return state;
}

/** Where a paddle's rows are, given its top row. */
export const paddleRows = (top) => Array.from({ length: PADDLE }, (_, i) => Math.round(top) + i);

const catches = (top, y) => y >= top - 0.5 && y <= top + PADDLE - 0.5;

/**
 * Bounce off a paddle, steeper the further from its middle you take it. This is
 * the only way a player gets to aim, so it does more work than the physics.
 */
function returned(ball, top, dir) {
  const offset = (ball.y - (top + (PADDLE - 1) / 2)) / (PADDLE / 2);
  ball.vx = dir * Math.min(MAX_SPEED, Math.abs(ball.vx) * 1.06);
  ball.vy = clamp(offset * SPIN * ASPECT + ball.vy * 0.3, -MAX_VY, MAX_VY);
  // Never let a rally go flat. A ball with no angle is one the machine can park
  // in front of forever, and a rally that cannot end is not a game.
  if (Math.abs(ball.vy) < FLAT) ball.vy = (ball.vy < 0 ? -1 : 1) * NUDGE;
  return ball;
}

/** One tick of rally. Exported so a test can play a whole match with no clock. */
export function step(state) {
  // Your paddle moves here, with everything else, rather than back in `onKey`.
  state.you = glidePaddle(state.motion, state.you, YOU_GLIDE);

  const ball = state.ball;
  ball.x += ball.vx;
  ball.y += ball.vy;

  // The top and bottom are walls, and the ball is put back inside rather than
  // just reflected — at speed, a reflection alone can leave it outside.
  if (ball.y < 0) { ball.y = -ball.y; ball.vy = Math.abs(ball.vy); }
  if (ball.y > HEIGHT - 1) { ball.y = 2 * (HEIGHT - 1) - ball.y; ball.vy = -Math.abs(ball.vy); }

  if (ball.vx < 0 && ball.x <= YOU_COL) {
    if (catches(state.you, ball.y)) { ball.x = YOU_COL; returned(ball, state.you, 1); }
  } else if (ball.vx > 0 && ball.x >= THEM_COL) {
    if (catches(state.them, ball.y)) { ball.x = THEM_COL; returned(ball, state.them, -1); }
  }

  if (ball.x < 0) { state.theirs++; point(state, 1); }
  else if (ball.x > WIDTH - 1) { state.yours++; point(state, -1); }
  // Anything else is the ball travelling, which is the only thing the drawn
  // ball is asked to follow — a serve puts it back itself.
  else advanceBall(state.drawn, ball);
  // A match ends with the ball where it went out, off the table and so off the
  // board, rather than parked on the edge it left by.
  if (state.over) snapBall(state.drawn, ball.x, ball.y);

  // The machine: idle in the middle until the ball is on its half, then chase
  // the ball's row. Perfect tracking here would make the game unloseable for it,
  // which is the same thing as unplayable.
  const chasing = state.ball.vx > 0 && state.ball.x > WIDTH * 0.4;
  const want = chasing ? state.ball.y - (PADDLE - 1) / 2 : (HEIGHT - PADDLE) / 2;
  const move = clamp(want - state.them, -THEM_SPEED, chasing ? THEM_SPEED : THEM_SPEED / 2);
  state.them = clamp(state.them + move, 0, HEIGHT - PADDLE);

  return state;
}

function point(state, toward) {
  if (state.yours >= TARGET) state.over = `you take it ${state.yours}–${state.theirs} 🤘`;
  else if (state.theirs >= TARGET) state.over = `the machine takes it ${state.theirs}–${state.yours}`;
  else serve(state, toward);
}

export const PONG = {
  key: "pong",
  aliases: ["tennis", "paddle"],
  title: "PONG",
  blurb: "first to seven, and the angle is all in where you hit it",
  keys: "↑ ↓ move · q quit",
  tickMs: TICK_MS,
  heldKeys: true,   // worth asking the terminal for key releases — see games.mjs

  create({ rng = Math.random } = {}) {
    const state = {
      you: (HEIGHT - PADDLE) / 2,
      motion: paddleMotion(),
      them: (HEIGHT - PADDLE) / 2,
      yours: 0,
      theirs: 0,
      over: null,
      rng,
    };
    return serve(state, rng() < 0.5 ? -1 : 1);
  },

  tick: step,

  onKey(state, key, ctx) {
    const dir = towards(key);
    if (!dir) return state;
    // Told when the key comes back up, the paddle is simply put in gear and the
    // tick does the rest — including for the auto-repeats that keep arriving
    // while it is held, which must not be allowed to add a second helping of
    // speed on top of the one the tick is already paying. See games-paddle.mjs.
    if (ctx?.heldKeys) { holdPaddle(state.motion, dir); return state; }
    // Not told, the paddle is paid for a press at a time. A press that finds it
    // standing still is also spent immediately, so the frame this keypress
    // draws is already one it has moved in; a press that finds it already
    // moving is not, because the tick is paying it out evenly and a second
    // helping on top would be the very jolt this is here to remove.
    const resting = state.motion.owed === 0;
    pressPaddle(state.motion, dir, YOU_STEP);
    if (resting) state.you = glidePaddle(state.motion, state.you, YOU_GLIDE);
    return state;
  },

  onRelease(state, key) {
    const dir = towards(key);
    if (dir) releasePaddle(state.motion, dir);
    return state;
  },

  status(state) {
    return state.over ? state.over : `you ${state.yours} · machine ${state.theirs}`;
  },

  render(state) {
    const grid = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => null));
    const put = (x, y, glyph) => {
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      grid[y][x] = glyph;
    };

    for (const row of paddleRows(state.you)) put(YOU_COL, row, acid("█"));
    for (const row of paddleRows(state.them)) put(THEM_COL, row, danger("█"));
    // Drawn on half-rows and on its own even clock, so the ball steps the same
    // distance up the table as across it, and at a rate. See games-draw.mjs.
    const ball = drawnCell(state.drawn);
    put(ball.col, ball.row, bone(ball.glyph));

    return grid.map((row, y) => row.map((cell, x) => (
      // The net, which is only there so the middle of the table has a middle.
      cell ?? (x === Math.floor(WIDTH / 2) && y % 2 === 0 ? dim("┊") : " ")
    )).join(""));
  },
};
