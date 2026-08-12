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

/**
 * Where to draw a ball whose true position is (x, y) in board coordinates.
 *
 * `y` is a row centre, so row r covers y from r - 0.5 up to r + 0.5: below the
 * centre the ball is in the top half of the cell, at or above it the bottom.
 * Returns the cell to write into and the half block to write there.
 */
export function ballCell(x, y) {
  const col = Math.round(x);
  const row = Math.round(y);
  return { col, row, glyph: y < row ? "▀" : "▄" };
}

/**
 * The ball's position in half-rows — the unit it is actually drawn in.
 *
 * Only the tests use this, to assert that a step down the board is the same
 * size as a step across it.
 */
export const halfRow = (y) => {
  const row = Math.round(y);
  return y < row ? row * 2 : row * 2 + 1;
};
