// Shared paddle motion, for the games where the thing you hold is a paddle.
//
// Everything else on a pong or breakout board already moves on the tick. The
// ball is stepped sixty times a second and then drawn on its own even clock
// (games-draw.mjs) precisely so that it reads as travelling rather than
// hopping. The paddle did not: it was moved by the keypress itself, one jump
// per key, which left the one object you are actually steering as the only
// thing on the board not moving at a rate.
//
// Two things fall out of that, and both of them read as a slow game rather than
// as a coarse control.
//
// A terminal has no key-up. What it has is auto-repeat: one press, then a gap
// of about half a second, then twenty-five or thirty a second for as long as
// you hold the key. A paddle moved by the key therefore sits still for that
// half second however hard you lean on the arrow — long enough for a pong ball
// to cross a third of the table — and then crosses the board in a blur. None of
// that is the paddle being slow. It is the paddle being on the keyboard's clock
// instead of the game's.
//
// And a step big enough to be worth those half-second gaps is a step you can
// watch land. Breakout moved three columns per key, which at thirty repeats a
// second is ninety columns a second delivered in visible three-column jumps:
// the paddle teleports, most of its own width, several times a second.
//
// So a key does not move the paddle here. It buys movement, and the tick spends
// it. A press adds `step` cells of debt; each tick pays out at most `rate` of
// it. Held, the debt is refilled faster than it can ever be paid, so the paddle
// runs at exactly `rate` — a constant speed, on the game's clock, for as long
// as the key is down, and identical whether the terminal repeats at fifteen a
// second or a hundred. Tapped, the debt is one `step` and the paddle glides
// that far and stops.
//
// The debt is capped at a single press, which is what makes letting go stop the
// paddle. Without the cap a held key would bank seconds of travel it had no
// time to spend, and the paddle would sail on long after the ball had gone by —
// the one thing worse than a paddle that will not start.
//
// The position stays a plain number on the game's state. Only the debt lives
// here, so a game keeps `state.you` or `state.paddle` as the coordinate it
// always was and a test can still put the paddle somewhere by assigning to it.

// All of that is what a terminal that will not say when a key comes back up
// leaves you with, and it is as good as that gets: the half-second before
// auto-repeat starts is a half second in which the terminal has told us
// nothing, and no paddle can be tuned out of a gap in its own input.
//
// A terminal that answers `HELD_KEYS.ask` (games.mjs) does say. There the
// paddle is not paced by presses at all — `holdPaddle` puts it in gear and it
// stays there, at exactly `rate`, until `releasePaddle` takes it out. No
// repeat delay to sit through, no overrun to bound, and the same `rate` and the
// same glide either way, so a game plays the same in both and simply answers
// sooner in one.

/** A paddle owing no movement. Games keep the position; this is the rest. */
export const paddleMotion = () => ({ owed: 0, held: 0 });

/**
 * A key held down, where the terminal will tell us when it is let go.
 *
 * The debt is refilled every tick for as long as this is in gear, so it can
 * never run out and the paddle simply runs at `rate`.
 */
export function holdPaddle(motion, dir) {
  motion.held = dir;
  return motion;
}

/**
 * That key let go. `dir` is checked so that releasing the arrow you are no
 * longer pressing cannot stop the one you are — rolling from one direction
 * straight into the other sends the release for the first *after* the press for
 * the second, and stopping on it would drop every reversal.
 */
export function releasePaddle(motion, dir) {
  if (motion.held !== dir) return motion;
  motion.held = 0;
  motion.owed = 0;
  return motion;
}

/**
 * A press: `dir` is -1 or 1, `step` is how far one press is worth.
 *
 * Pressing the other way drops whatever is left of the old direction first, so
 * a reversal starts the moment you ask for it rather than after the paddle has
 * finished paying out the way it was already going. Getting that wrong costs a
 * press, and a lost press on a paddle is a lost ball.
 */
export function pressPaddle(motion, dir, step) {
  if (motion.owed * dir < 0) motion.owed = 0;
  motion.owed = dir * Math.min(step, Math.abs(motion.owed) + step);
  return motion;
}

/**
 * Pay out this tick's share of the debt and return where the paddle now is.
 *
 * Called once per tick — and once more by a press that finds the paddle
 * standing still, so that the frame drawn for that press already shows it
 * moving. A tick away is only sixteen milliseconds, but starting on the frame
 * you pressed is the difference between a control that answers and one that
 * agrees to answer shortly. A press that finds the paddle already moving does
 * not, because the tick is paying it out evenly and a second helping on top is
 * exactly the jolt this is here to remove.
 */
export function glidePaddle(motion, at, { rate, step, lo, hi }) {
  // A key that is being held owes a fresh press every tick, so the debt below
  // never runs dry and the paddle just runs.
  if (motion.held) motion.owed = motion.held * step;
  if (!motion.owed) return at;
  const move = Math.sign(motion.owed) * Math.min(rate, Math.abs(motion.owed));
  motion.owed -= move;
  const next = Math.min(hi, Math.max(lo, at + move));
  // A paddle against the end of the board owes nothing. Left standing, the debt
  // would sit there and then fire the instant you pressed the other way.
  if (next === at) motion.owed = 0;
  return next;
}

/**
 * Cells per tick, from a speed written in cells per second.
 *
 * Paddle speeds are a feel, and a feel is in seconds. Writing them per tick
 * would silently re-tune every one of them the next time a game changed how
 * often it steps.
 */
export const perSecond = (cells, tickMs) => (cells * tickMs) / 1000;
