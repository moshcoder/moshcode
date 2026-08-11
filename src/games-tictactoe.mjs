// Tic-tac-toe against an opponent that cannot be beaten, only held.
//
// The AI is a full minimax — the search space is 9! at its very worst, which is
// nothing — so a draw is a win. It breaks ties at random, which is the only
// reason two games in a row are not the same game.
import { acid, ash, bone, danger, dim } from "./ui.mjs";

export const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export const emptyBoard = () => Array.from({ length: 9 }, () => null);

/** "X", "O", "draw", or null while there is still a game on. */
export function winner(board) {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[b] === board[c]) return board[a];
  }
  return board.every(Boolean) ? "draw" : null;
}

const other = (player) => (player === "X" ? "O" : "X");

/**
 * Minimax with no pruning and no depth limit — 3×3 does not need either.
 * Depth is in the score so it prefers winning sooner and losing later, which is
 * what stops it from wandering into a fork it could have blocked.
 */
export function score(board, player, me, depth = 0) {
  const done = winner(board);
  if (done === me) return 10 - depth;
  if (done === other(me)) return depth - 10;
  if (done === "draw") return 0;

  const scores = [];
  for (let i = 0; i < 9; i++) {
    if (board[i]) continue;
    board[i] = player;
    scores.push(score(board, other(player), me, depth + 1));
    board[i] = null;
  }
  return player === me ? Math.max(...scores) : Math.min(...scores);
}

/** The best square for `player`, chosen at random among equally good ones. */
export function bestMove(board, player, rng = Math.random) {
  let best = -Infinity;
  let moves = [];
  for (let i = 0; i < 9; i++) {
    if (board[i]) continue;
    board[i] = player;
    const value = score(board, other(player), player, 1);
    board[i] = null;
    if (value > best) { best = value; moves = [i]; }
    else if (value === best) moves.push(i);
  }
  if (!moves.length) return null;
  return moves[Math.floor(rng() * moves.length) % moves.length];
}

function finish(state) {
  const result = winner(state.board);
  if (!result) return state;
  state.over = result === "draw" ? "a draw — the only honest result"
    : result === "X" ? "you win 🤘" : "the machine takes it";
  return state;
}

export const TICTACTOE = {
  key: "tictactoe",
  // `tic-tac-toe` needs no alias — resolveGame drops dashes before it looks.
  aliases: ["ttt", "tiktaktoe", "noughts", "xo"],
  title: "TIC-TAC-TOE",
  blurb: "three in a row against a perfect opponent",
  keys: "← ↑ ↓ → move · enter mark · r new game · q quit",

  create() {
    return { board: emptyBoard(), cursor: 4, over: null, turn: "X" };
  },

  onKey(state, pressed, { rng = Math.random } = {}) {
    const x = state.cursor % 3;
    const y = Math.floor(state.cursor / 3);
    if (pressed === "left") state.cursor = y * 3 + (x + 2) % 3;
    else if (pressed === "right") state.cursor = y * 3 + (x + 1) % 3;
    else if (pressed === "up") state.cursor = ((y + 2) % 3) * 3 + x;
    else if (pressed === "down") state.cursor = ((y + 1) % 3) * 3 + x;
    else if (pressed === "enter" || pressed === "space") {
      if (state.board[state.cursor]) return state;
      state.board[state.cursor] = "X";
      if (finish(state).over) return state;
      const reply = bestMove(state.board, "O", rng);
      if (reply != null) state.board[reply] = "O";
      finish(state);
    }
    return state;
  },

  status(state) {
    return state.over ? state.over : `you ${acid("X")} ${ash("· machine")} ${bone("O")}`;
  },

  render(state) {
    const mark = (i) => {
      const value = state.board[i];
      const glyph = value === "X" ? acid("X") : value === "O" ? danger("O") : " ";
      // The cursor is drawn as brackets rather than a highlight so it survives
      // NO_COLOR, a pipe, and every terminal that lies about its capabilities.
      return i === state.cursor && !state.over ? ` ${acid("[")}${glyph}${acid("]")} ` : `  ${glyph}  `;
    };
    const line = (l, m, r) => ash(`${l}─────${m}─────${m}─────${r}`);
    const rows = [];
    rows.push(line("┌", "┬", "┐"));
    for (let y = 0; y < 3; y++) {
      rows.push(`${ash("│")}${mark(y * 3)}${ash("│")}${mark(y * 3 + 1)}${ash("│")}${mark(y * 3 + 2)}${ash("│")}`);
      rows.push(y < 2 ? line("├", "┼", "┤") : line("└", "┴", "┘"));
    }
    rows.push("");
    rows.push(dim(state.over ? "r for another" : "enter to mark the square"));
    return rows;
  },
};
