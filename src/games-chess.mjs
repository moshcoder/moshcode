// Chess. Real rules — castling, en passant, promotion, check, checkmate,
// stalemate — against an alpha-beta search that is about as strong as a friend
// who plays sometimes. You are white; the machine answers immediately.
//
// The board is 64 squares of FEN letters: uppercase white, lowercase black,
// null empty, index 0 = a8 and index 63 = h1. Everything below is pure, so a
// position can be set up in a test and asked what it thinks.
import { acid, amber, ash, bone, danger, dim, rgb } from "./ui.mjs";

export const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";

const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
const KNIGHT_STEPS = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const DIAGONALS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const STRAIGHTS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const ROYAL = [...DIAGONALS, ...STRAIGHTS];

export const isWhite = (piece) => Boolean(piece) && piece === piece.toUpperCase();
const friendly = (a, b) => Boolean(a) && Boolean(b) && isWhite(a) === isWhite(b);
const fileOf = (i) => i % 8;
const rankOf = (i) => Math.floor(i / 8);
const square = (x, y) => y * 8 + x;
const inside = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;
/** The piece on a square, `null` if empty and `undefined` if off the board. */
const at = (board, x, y) => (inside(x, y) ? board[square(x, y)] : undefined);

/** Board rows of a FEN position (the placement field only). */
export function parseBoard(fen = START) {
  const board = Array.from({ length: 64 }, () => null);
  let i = 0;
  for (const char of fen.split(" ")[0]) {
    if (char === "/") continue;
    if (/\d/.test(char)) { i += Number(char); continue; }
    board[i++] = char;
  }
  return board;
}

/** Algebraic name of a square — for the move list down the side. */
export const name = (i) => "abcdefgh"[fileOf(i)] + (8 - rankOf(i));

/**
 * Every move the piece on `from` could make if the king's safety were somebody
 * else's problem. `attacksOnly` drops pawn pushes and castling, because a pawn
 * does not attack the square in front of it and a rook cannot be taken by a
 * castle — that distinction is what makes check detection correct.
 */
export function pseudoMoves(state, from, { attacksOnly = false } = {}) {
  const { board } = state;
  const piece = board[from];
  if (!piece) return [];
  const white = isWhite(piece);
  const type = piece.toLowerCase();
  const x = fileOf(from);
  const y = rankOf(from);
  const moves = [];
  const add = (to, extra = {}) => moves.push({ from, to, ...extra });

  const slide = (dirs) => {
    for (const [dx, dy] of dirs) {
      for (let step = 1; step < 8; step++) {
        const nx = x + dx * step;
        const ny = y + dy * step;
        const target = at(board, nx, ny);
        if (target === undefined) break;
        if (target === null) { add(square(nx, ny)); continue; }
        if (!friendly(piece, target)) add(square(nx, ny), { capture: true });
        break;
      }
    }
  };
  const hop = (steps) => {
    for (const [dx, dy] of steps) {
      const nx = x + dx;
      const ny = y + dy;
      const target = at(board, nx, ny);
      if (target === undefined) continue;
      if (target === null) add(square(nx, ny));
      else if (!friendly(piece, target)) add(square(nx, ny), { capture: true });
    }
  };

  if (type === "p") {
    const dir = white ? -1 : 1;
    const start = white ? 6 : 1;
    const last = white ? 0 : 7;
    if (!attacksOnly) {
      if (at(board, x, y + dir) === null) {
        add(square(x, y + dir), y + dir === last ? { promotion: true } : {});
        if (y === start && at(board, x, y + 2 * dir) === null) {
          add(square(x, y + 2 * dir), { double: true });
        }
      }
    }
    for (const dx of [-1, 1]) {
      const nx = x + dx;
      const ny = y + dir;
      const target = at(board, nx, ny);
      if (target === undefined) continue;
      if (attacksOnly) { add(square(nx, ny)); continue; }
      if (target && !friendly(piece, target)) {
        add(square(nx, ny), ny === last ? { capture: true, promotion: true } : { capture: true });
      } else if (target === null && state.ep === square(nx, ny)) {
        add(square(nx, ny), { capture: true, enPassant: true });
      }
    }
    return moves;
  }
  if (type === "n") hop(KNIGHT_STEPS);
  else if (type === "b") slide(DIAGONALS);
  else if (type === "r") slide(STRAIGHTS);
  else if (type === "q") slide(ROYAL);
  else if (type === "k") {
    hop(ROYAL);
    if (!attacksOnly) {
      const home = white ? 60 : 4;
      const rights = state.castling || {};
      const empty = (...squares) => squares.every((s) => board[s] === null);
      const safe = (...squares) => squares.every((s) => !attacked(state, s, !white));
      if (from === home && !attacked(state, home, !white)) {
        if (rights[white ? "K" : "k"] && empty(home + 1, home + 2) && safe(home + 1, home + 2)) {
          add(home + 2, { castle: "K" });
        }
        if (rights[white ? "Q" : "q"] && empty(home - 1, home - 2, home - 3) && safe(home - 1, home - 2)) {
          add(home - 2, { castle: "Q" });
        }
      }
    }
  }
  return moves;
}

/** Is `target` attacked by the side `byWhite`? */
export function attacked(state, target, byWhite) {
  for (let i = 0; i < 64; i++) {
    const piece = state.board[i];
    if (!piece || isWhite(piece) !== byWhite) continue;
    for (const move of pseudoMoves(state, i, { attacksOnly: true })) {
      if (move.to === target) return true;
    }
  }
  return false;
}

export const findKing = (board, white) => board.indexOf(white ? "K" : "k");

export function inCheck(state, white) {
  const king = findKing(state.board, white);
  return king >= 0 && attacked(state, king, !white);
}

/** A new position with the move played. Never mutates what it was given. */
export function apply(state, move) {
  const board = state.board.slice();
  const piece = board[move.from];
  const white = isWhite(piece);
  const castling = { ...state.castling };

  board[move.from] = null;
  board[move.to] = move.promotion ? (white ? "Q" : "q") : piece;
  if (move.enPassant) board[square(fileOf(move.to), rankOf(move.from))] = null;
  if (move.castle) {
    const home = white ? 60 : 4;
    const [rookFrom, rookTo] = move.castle === "K" ? [home + 3, home + 1] : [home - 4, home - 1];
    board[rookTo] = board[rookFrom];
    board[rookFrom] = null;
  }

  // Rights are lost by moving the king or a rook, and by capturing a rook on
  // the square it started on — the last one is the case everybody forgets.
  if (piece === "K") { castling.K = false; castling.Q = false; }
  if (piece === "k") { castling.k = false; castling.q = false; }
  for (const [corner, right] of [[63, "K"], [56, "Q"], [7, "k"], [0, "q"]]) {
    if (move.from === corner || move.to === corner) castling[right] = false;
  }

  return {
    ...state,
    board,
    castling,
    ep: move.double ? square(fileOf(move.from), (rankOf(move.from) + rankOf(move.to)) / 2) : null,
    turn: white ? "b" : "w",
  };
}

/** Pseudo-legal minus everything that walks into check. */
export function legalMoves(state, from) {
  const piece = state.board[from];
  if (!piece) return [];
  const white = isWhite(piece);
  return pseudoMoves(state, from).filter((move) => !inCheck(apply(state, move), white));
}

export function allMoves(state, white = state.turn === "w") {
  const moves = [];
  for (let i = 0; i < 64; i++) {
    if (state.board[i] && isWhite(state.board[i]) === white) moves.push(...legalMoves(state, i));
  }
  return moves;
}

/** "checkmate", "stalemate", or null. */
export function outcome(state) {
  if (allMoves(state).length) return null;
  return inCheck(state, state.turn === "w") ? "checkmate" : "stalemate";
}

/* --------------------------------------------------------------------- ai */

// Material, plus a nudge toward the middle. Enough to make it take free pieces
// and develop rather than shuffle a rook, which is all this needs to be.
const CENTER = [0, 1, 2, 3, 3, 2, 1, 0];

export function evaluate(state) {
  let total = 0;
  for (let i = 0; i < 64; i++) {
    const piece = state.board[i];
    if (!piece) continue;
    const worth = VALUE[piece.toLowerCase()] + CENTER[fileOf(i)] + CENTER[rankOf(i)];
    total += isWhite(piece) ? worth : -worth;
  }
  return state.turn === "w" ? total : -total;
}

function negamax(state, depth, alpha, beta) {
  if (depth === 0) return evaluate(state);
  const moves = allMoves(state);
  if (!moves.length) return inCheck(state, state.turn === "w") ? -90000 - depth : 0;
  // Captures first: cheap ordering, and it is most of what alpha-beta needs to
  // prune a depth-3 search down to something that answers instantly.
  moves.sort((a, b) => Number(Boolean(b.capture)) - Number(Boolean(a.capture)));
  let best = -Infinity;
  for (const move of moves) {
    const value = -negamax(apply(state, move), depth - 1, -beta, -alpha);
    if (value > best) best = value;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

/** The machine's reply. Ties broken at random so it is not the same game twice. */
export function chooseMove(state, { depth = 3, rng = Math.random } = {}) {
  const moves = allMoves(state);
  if (!moves.length) return null;
  let best = -Infinity;
  let picks = [];
  for (const move of moves) {
    const value = -negamax(apply(state, move), depth - 1, -Infinity, Infinity);
    if (value > best) { best = value; picks = [move]; }
    else if (value === best) picks.push(move);
  }
  return picks[Math.floor(rng() * picks.length) % picks.length];
}

/* ------------------------------------------------------------------- game */

// White is upper case and black is lower, the way a FEN reads — so the board is
// still playable with NO_COLOR set, where the two colours are the same colour.
const GLYPH = (piece) => (isWhite(piece) ? piece.toUpperCase() : piece.toLowerCase());
const WHITE_PIECE = bone;
const BLACK_PIECE = rgb(255, 120, 180);

function settle(state) {
  const done = outcome(state);
  if (!done) {
    state.note = inCheck(state, state.turn === "w") ? "check" : "";
    return state;
  }
  state.over = done === "stalemate"
    ? "stalemate — nobody wins"
    : state.turn === "w" ? "checkmate — the machine takes it" : "checkmate — you win 🤘";
  return state;
}

export const CHESS = {
  key: "chess",
  aliases: ["ches", "kasparov"],
  title: "CHESS",
  blurb: "full rules, real opponent, pawns auto-queen",
  keys: "← ↑ ↓ → move · enter pick then place · r new game · q quit",
  // The search blocks for a few hundred milliseconds in an open position, so it
  // runs on the clock rather than inside the keypress: your own move is on the
  // board and drawn before the machine starts thinking about it. The idle beat
  // is slow because nothing happens on it — the driver skips a redraw that
  // would change nothing.
  tickMs: (state) => (state.turn === "b" ? 80 : 400),

  create() {
    return {
      board: parseBoard(START),
      turn: "w",
      castling: { K: true, Q: true, k: true, q: true },
      ep: null,
      cursor: 52, // e2, where most games start
      selected: null,
      targets: [],
      played: [],
      note: "",
      over: null,
    };
  },

  onKey(state, pressed, { rng = Math.random } = {}) {
    const x = fileOf(state.cursor);
    const y = rankOf(state.cursor);
    if (pressed === "left") state.cursor = square((x + 7) % 8, y);
    else if (pressed === "right") state.cursor = square((x + 1) % 8, y);
    else if (pressed === "up") state.cursor = square(x, (y + 7) % 8);
    else if (pressed === "down") state.cursor = square(x, (y + 1) % 8);
    else if (pressed === "enter" || pressed === "space") {
      if (state.selected === null) {
        const piece = state.board[state.cursor];
        if (!piece || !isWhite(piece)) return state;
        state.selected = state.cursor;
        state.targets = legalMoves(state, state.cursor);
        return state;
      }
      // Enter on the piece again (or on a square it cannot reach) puts it back
      // down. No cancel key to learn, and no way to get stuck holding a rook.
      const move = state.targets.find((m) => m.to === state.cursor);
      state.selected = null;
      state.targets = [];
      if (!move) return state;

      Object.assign(state, apply(state, move));
      state.played.push(`${name(move.from)}${move.capture ? "x" : "-"}${name(move.to)}`);
      settle(state);
    }
    return state;
  },

  /** The machine's turn, one move per beat. Idle while white is thinking. */
  tick(state, { rng = Math.random } = {}) {
    if (state.turn !== "b" || state.over) return state;
    const reply = chooseMove(state, { rng });
    if (!reply) return settle(state);
    Object.assign(state, apply(state, reply));
    state.played.push(`${name(reply.from)}${reply.capture ? "x" : "-"}${name(reply.to)}`);
    return settle(state);
  },

  status(state) {
    if (state.over) return state.over;
    if (state.turn === "b") return `${ash("black is thinking…")}`;
    const last = state.played.slice(-1)[0];
    return `you ${bone("white")}${last ? ash(` · last ${last}`) : ""}${state.note ? ` · ${danger(state.note.toUpperCase())}` : ""}`;
  },

  render(state) {
    const targets = new Set(state.targets.map((m) => m.to));
    const rows = [];
    for (let y = 0; y < 8; y++) {
      let row = `${ash(String(8 - y))} `;
      for (let x = 0; x < 8; x++) {
        const i = square(x, y);
        const piece = state.board[i];
        const dark = (x + y) % 2 === 1;
        let glyph = piece
          ? (isWhite(piece) ? WHITE_PIECE : BLACK_PIECE)(GLYPH(piece))
          : targets.has(i) ? acid("◦") : dark ? dim("·") : " ";
        // A piece you could take is lit up rather than dotted — the dot would
        // be hidden underneath it.
        if (targets.has(i) && piece) glyph = amber(GLYPH(piece));
        if (i === state.cursor) row += `${acid("[")}${glyph}${acid("]")}`;
        else if (i === state.selected) row += `${amber("‹")}${glyph}${amber("›")}`;
        else row += ` ${glyph} `;
      }
      rows.push(row);
    }
    rows.push(`  ${ash(" a  b  c  d  e  f  g  h ")}`);
    rows.push("");
    rows.push(`  ${dim(state.selected === null ? "enter picks a piece up" : "enter puts it down")}`);
    return rows;
  },
};
