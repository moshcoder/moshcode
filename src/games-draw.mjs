// Shared drawing for the things in the arcade that move on a diagonal.
//
// A terminal cell is about twice as tall as it is wide, so a board drawn one
// object per cell has half the resolution going down that it has going across.
// For a ball that is not a rounding detail, it is the whole reason the motion
// looks wrong. Two things fall out of it, and both of them read as bad physics
// rather than as a coarse grid:
//
// A step sideways moves the ball one pixel and a step down moves it two, so the
// same ball appears to travel faster down the board than across it, and a
// trajectory the maths has at forty-five degrees is drawn at sixty.
//
// Worse, the two steps keep their own schedules. Crossing into the next column
// and crossing into the next row almost never land on the same tick, so a ball
// going diagonally does not move diagonally — it hops sideways, then a tick or
// two later hops down. Measured on pong, the ball holds a cell for four ticks,
// four ticks, then two and two as a row change splits one of those spans. That
// 4-4-2-2 stutter, three or four times a second, is what is left of the jiggle
// after the clock was fixed.
//
// Half blocks fix both. `▀` and `▄` each fill half a cell, which is close to
// square, so the ball is drawn on a grid with the same pitch both ways: it
// steps the same distance whichever way it goes, a row is two steps rather than
// one, and the corner it turns is half as wide. It is also a better ball than
// `●` was — a square pixel moving on a square grid, rather than a round dot
// snapping between cells twice its own height apart.
//
// Half blocks fix the size of the steps. They do not fix when the steps happen,
// which turned out to be the other half of it — see `drawnBall` below.

/**
 * The ball's position in half-rows — the unit it is actually drawn in.
 *
 * `y` is a row centre, so row r covers y from r - 0.5 up to r + 0.5: below the
 * centre the ball is in the top half of that cell, at or above it the bottom.
 * Half-rows and columns are the same size on screen, so this and the column
 * together are a square lattice, and a step is a step whichever way it goes.
 */
export const halfRow = (y) => {
  const row = Math.round(y);
  return y < row ? row * 2 : row * 2 + 1;
};

/**
 * A drawn ball, released on its own even clock.
 *
 * Equal pitch fixed the size of the ball's steps but not their timing, and the
 * timing is the rest of the jiggle. Rounding the true position to the lattice
 * moves the ball whenever it happens to cross a column edge or a half-row edge,
 * and those two are on unrelated schedules: a ball with the two periods close
 * but not equal — which is what a near-diagonal is, and what breakout launches
 * at — beats between them. Measured, breakout held a cell for 16ms, then 80ms,
 * then 48ms, five times a second. The steps were the right size and still the
 * ball looked like it was struggling, because nothing was moving at a rate.
 *
 * So the true position is not what is drawn. It decides only which way the
 * drawn ball owes a step; when that step is paid is decided by a clock that
 * ticks at the ball's own speed. `owed` accrues at |vx| + 2|vy| lattice units
 * per tick — the distance the true ball covers, measured the way the drawn one
 * has to travel it — and a whole unit buys one step. The drawn ball therefore
 * moves every 1/speed ticks whatever angle it is on, trailing the true one by
 * under a unit, which is under half a character.
 *
 * It cannot fall behind: the same accrual that paces the ball also lets it pay
 * two steps in a tick when the ball is genuinely moving that fast.
 */
export function drawnBall(x, y) {
  return snapBall({ col: 0, half: 0, owed: 0 }, x, y);
}

/**
 * Put the drawn ball exactly where the real one is, with no debt either way.
 *
 * For the moves that are not travel and so have nothing to smooth: a serve, a
 * fresh ball on the paddle, the ball riding a paddle that is being aimed.
 */
export function snapBall(drawn, x, y) {
  drawn.col = Math.round(x);
  drawn.half = halfRow(y);
  drawn.owed = 0;
  return drawn;
}

/** Far enough apart that the ball was put there rather than travelled there. */
const TELEPORT = 4;

/** Pay out whatever steps the ball has earned this tick. */
export function advanceBall(drawn, ball) {
  const col = Math.round(ball.x);
  const half = halfRow(ball.y);
  if (Math.abs(col - drawn.col) + Math.abs(half - drawn.half) >= TELEPORT) return snapBall(drawn, ball.x, ball.y);

  drawn.owed += Math.abs(ball.vx) + Math.abs(ball.vy) * 2;
  while (drawn.owed >= 1) {
    const dcol = col - drawn.col;
    const dhalf = half - drawn.half;
    if (dcol === 0 && dhalf === 0) break;
    // Whichever axis is further behind goes first, which is what keeps a
    // diagonal a staircase instead of a sideways run and then a drop.
    if (Math.abs(dcol) >= Math.abs(dhalf)) drawn.col += Math.sign(dcol);
    else drawn.half += Math.sign(dhalf);
    drawn.owed -= 1;
  }
  // A ball that has caught up banks at most one step, so that standing still
  // for a moment cannot be turned into a lurch later.
  if (drawn.owed > 1) drawn.owed = 1;
  return drawn;
}

/** The cell and half block to write for a drawn ball. */
export const drawnCell = (drawn) => ({
  col: drawn.col,
  row: drawn.half >> 1,
  glyph: drawn.half % 2 === 0 ? "▀" : "▄",
});
