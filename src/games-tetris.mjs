// Tetris, for the moshcode arcade. Ten wide, twenty deep, seven bricks.
//
// Everything here is pure — rotate a shape, ask whether it collides, merge it,
// clear the full rows — so the whole game can be played in a test with no
// terminal anywhere near it. See src/games.mjs for the frame it is drawn in.
import { acid, amber, ash, danger, dim, rgb } from "./ui.mjs";

export const WIDTH = 10;
export const HEIGHT = 20;

/**
 * The seven tetrominoes, drawn as square grids so one rotate() handles them
 * all. Each fills itself with its own letter, which is also its colour key —
 * merging a piece into the board is then a copy, with no bookkeeping.
 */
export const SHAPES = {
  I: ["....", "IIII", "....", "...."],
  O: ["OO", "OO"],
  T: [".T.", "TTT", "..."],
  S: [".SS", "SS.", "..."],
  Z: ["ZZ.", ".ZZ", "..."],
  J: ["J..", "JJJ", "..."],
  L: ["..L", "LLL", "..."],
};

const COLORS = {
  I: rgb(90, 220, 250),
  O: amber,
  T: rgb(190, 130, 255),
  S: acid,
  Z: danger,
  J: rgb(90, 140, 255),
  L: rgb(255, 150, 60),
};

const BAG = Object.keys(SHAPES);
const BLOCK = "██";
const EMPTY = dim("· ");
const GHOST = ash("░░");

/** Clockwise quarter turn of a square shape. */
export function rotate(shape) {
  return shape.map((_, i) => shape.map((row) => row[i]).reverse().join(""));
}

export const emptyBoard = () =>
  Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => null));

/** Would this shape overlap a wall, the floor, or something already stacked? */
export function collides(board, shape, px, py) {
  for (let y = 0; y < shape.length; y++) {
    for (let x = 0; x < shape[y].length; x++) {
      if (shape[y][x] === ".") continue;
      const bx = px + x;
      const by = py + y;
      if (bx < 0 || bx >= WIDTH || by >= HEIGHT) return true;
      // Above the ceiling is legal — that is where a piece spawns from.
      if (by >= 0 && board[by][bx]) return true;
    }
  }
  return false;
}

/** Stamp a piece into the board. Mutates, and is only ever called on a lock. */
export function merge(board, piece) {
  for (let y = 0; y < piece.shape.length; y++) {
    for (let x = 0; x < piece.shape[y].length; x++) {
      const cell = piece.shape[y][x];
      if (cell === ".") continue;
      const by = piece.y + y;
      if (by >= 0) board[by][piece.x + x] = cell;
    }
  }
  return board;
}

/** Drop out every full row, refill from the top. Returns how many went. */
export function clearLines(board) {
  const kept = board.filter((row) => row.some((cell) => !cell));
  const cleared = HEIGHT - kept.length;
  while (kept.length < HEIGHT) kept.unshift(Array.from({ length: WIDTH }, () => null));
  for (let y = 0; y < HEIGHT; y++) board[y] = kept[y];
  return cleared;
}

const pick = (rng) => BAG[Math.floor(rng() * BAG.length) % BAG.length];

function spawn(state, key) {
  const shape = SHAPES[key];
  const piece = { key, shape, x: Math.floor((WIDTH - shape[0].length) / 2), y: 0 };
  if (collides(state.board, piece.shape, piece.x, piece.y)) state.over = "stacked out";
  state.piece = piece;
  return state;
}

export const level = (state) => 1 + Math.floor(state.lines / 10);

/** Where the piece would land if you let go of it — drawn as the ghost. */
export function landing(state) {
  let y = state.piece.y;
  while (!collides(state.board, state.piece.shape, state.piece.x, y + 1)) y++;
  return y;
}

function lock(state) {
  merge(state.board, state.piece);
  const cleared = clearLines(state.board);
  if (cleared) {
    state.lines += cleared;
    state.score += [0, 100, 300, 500, 800][cleared] * level(state);
  }
  const key = state.next;
  state.next = pick(state.rng);
  return spawn(state, key);
}

export const TETRIS = {
  key: "tetris",
  aliases: ["blocks", "bricks"],
  title: "TETRIS",
  blurb: "stack the bricks, clear the lines, outrun gravity",
  keys: "← → move · ↑ rotate · ↓ drop one · space slam · q quit",
  // Gravity is the level, and the level is the lines you have cleared.
  tickMs: (state) => Math.max(90, 700 - (level(state) - 1) * 65),

  create({ rng = Math.random } = {}) {
    const state = { board: emptyBoard(), score: 0, lines: 0, over: null, rng, next: pick(rng) };
    return spawn(state, pick(rng));
  },

  tick(state) {
    if (collides(state.board, state.piece.shape, state.piece.x, state.piece.y + 1)) return lock(state);
    state.piece.y++;
    return state;
  },

  onKey(state, key) {
    const p = state.piece;
    if (key === "left" && !collides(state.board, p.shape, p.x - 1, p.y)) p.x--;
    else if (key === "right" && !collides(state.board, p.shape, p.x + 1, p.y)) p.x++;
    else if (key === "down") return TETRIS.tick(state);
    else if (key === "up" || key === "x") {
      const turned = rotate(p.shape);
      // Wall kicks, the simple kind: if the turn doesn't fit, shove it a column
      // or two off the wall before giving up. Without this an I-piece can never
      // stand up in the left gutter.
      for (const dx of [0, -1, 1, -2, 2]) {
        if (!collides(state.board, turned, p.x + dx, p.y)) {
          p.shape = turned;
          p.x += dx;
          break;
        }
      }
    } else if (key === "space") {
      const drop = landing(state);
      state.score += (drop - p.y) * 2;
      p.y = drop;
      return lock(state);
    }
    return state;
  },

  status(state) {
    return state.over
      ? `${state.over} · score ${state.score}`
      : `score ${state.score} · lines ${state.lines}`;
  },

  render(state) {
    const view = state.board.map((row) => row.slice());
    const p = state.piece;
    if (!state.over) {
      const gy = landing(state);
      for (let y = 0; y < p.shape.length; y++) {
        for (let x = 0; x < p.shape[y].length; x++) {
          if (p.shape[y][x] === ".") continue;
          if (gy + y >= 0 && gy + y < HEIGHT) view[gy + y][p.x + x] = "ghost";
        }
      }
    }
    for (let y = 0; y < p.shape.length; y++) {
      for (let x = 0; x < p.shape[y].length; x++) {
        if (p.shape[y][x] === ".") continue;
        if (p.y + y >= 0 && p.y + y < HEIGHT) view[p.y + y][p.x + x] = p.key;
      }
    }
    const gutter = sidePanel(state);
    return view.map((row, y) => {
      const well = row.map((cell) => {
        if (!cell) return EMPTY;
        if (cell === "ghost") return GHOST;
        return COLORS[cell](BLOCK);
      }).join("");
      return `${well}  ${gutter[y] ?? ""}`;
    });
  },
};

/**
 * The strip down the right: what is coming, and what level you are on.
 *
 * It is also what makes the well look like a tetris cabinet rather than a
 * column of bricks floating in a frame — the board sets the frame's width, so
 * without it the box is wider than the game.
 */
function sidePanel(state) {
  const colour = COLORS[state.next];
  const shape = SHAPES[state.next];
  const lines = [
    ash("NEXT"),
    ...shape.map((row) => row.split("").map((c) => (c === "." ? "  " : colour(BLOCK))).join("")),
    "",
    ash(`LVL ${level(state)}`),
  ];
  // Padded to a fixed width so a narrow piece cannot make the frame breathe in
  // and out as the bag turns over.
  return lines.map((line) => {
    const width = line.replace(/\x1b\[[0-9;]*m/g, "").length;
    return line + " ".repeat(Math.max(0, 8 - width));
  });
}
