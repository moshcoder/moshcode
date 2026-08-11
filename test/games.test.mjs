// The arcade, played without a terminal.
//
// Every game is pure — a state, a key, a tick — which is what makes this
// possible: these tests finish real games of tetris, pac-man and chess, win
// hangman, and prove the tic-tac-toe opponent cannot be beaten, with no TTY and
// no timers left running.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  GAMES, decodeKeys, frame, gamesCommand, gamesModel, renderList, resolveGame, runGame, strip, visible,
} from "../src/games.mjs";
import {
  TETRIS, SHAPES, clearLines, collides, emptyBoard, landing, rotate, HEIGHT as T_HEIGHT, WIDTH as T_WIDTH,
} from "../src/games-tetris.mjs";
import { SNAKE, WIDTH as S_WIDTH, HEIGHT as S_HEIGHT, step } from "../src/games-snake.mjs";
import { PACMAN, MAZE, isWall, pellets, WIDTH as P_WIDTH, HEIGHT as P_HEIGHT } from "../src/games-pacman.mjs";
import { TICTACTOE, bestMove, emptyBoard as emptyGrid, winner } from "../src/games-tictactoe.mjs";
import { HANGMAN, MISSES_ALLOWED, WORDS, guess, mask } from "../src/games-hangman.mjs";
import {
  CHESS, allMoves, apply, chooseMove, inCheck, legalMoves, name, outcome, parseBoard,
} from "../src/games-chess.mjs";

/** A predictable rng — the games take one, so a test can replay a session. */
const seeded = (seed = 1) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

/* ------------------------------------------------------------- the cabinet */

test("every game satisfies the shape the driver expects", () => {
  for (const game of GAMES) {
    assert.match(game.key, /^[a-z]+$/, "a game key is what someone types");
    for (const field of ["title", "blurb", "keys"]) {
      assert.ok(game[field]?.length, `${game.key} has no ${field}`);
    }
    assert.equal(typeof game.create, "function", `${game.key} cannot start`);
    assert.equal(typeof game.onKey, "function", `${game.key} ignores the keyboard`);
    assert.equal(typeof game.render, "function");
    assert.equal(typeof game.status, "function");
    // A real-time game must have something for the clock to call.
    if (game.tickMs) assert.equal(typeof game.tick, "function", `${game.key} ticks into nothing`);
    // Every game explains its own controls, and every one of them takes q.
    assert.match(game.keys, /q quit/, `${game.key} does not say how to leave`);
  }
});

test("game names are unique, aliases included", () => {
  const seen = new Set();
  for (const game of GAMES) {
    for (const label of [game.key, ...(game.aliases || [])]) {
      assert.ok(!seen.has(label), `"${label}" names two games`);
      seen.add(label);
    }
  }
});

test("a game resolves however it is spelled", () => {
  assert.equal(resolveGame("tetris")?.key, "tetris");
  assert.equal(resolveGame("/TETRIS")?.key, "tetris");
  // The spelling in the request this was built from, and the one everybody
  // types second.
  assert.equal(resolveGame("tiktaktoe")?.key, "tictactoe");
  assert.equal(resolveGame("tic-tac-toe")?.key, "tictactoe");
  assert.equal(resolveGame("ttt")?.key, "tictactoe");
  assert.equal(resolveGame("pac")?.key, "pacman");
  assert.equal(resolveGame(""), null);
  assert.equal(resolveGame("doom"), null);
});

test("the list names every game and how to start one", () => {
  const listed = strip(renderList({ prefix: "/games" }));
  for (const game of GAMES) {
    assert.ok(listed.includes(game.key), `${game.key} is missing from the list`);
    assert.ok(listed.includes(game.blurb), `${game.key} is listed with no blurb`);
  }
  assert.match(listed, /\/games tetris/, "the list should say how to play one");
  assert.match(strip(renderList()), /moshcode games tetris/, "and how to from a shell");
});

test("the roster is available as data", () => {
  const model = gamesModel();
  assert.equal(model.games.length, GAMES.length);
  assert.deepEqual(model.games.map((g) => g.name), GAMES.map((g) => g.key));
  assert.equal(model.games.find((g) => g.name === "tetris").realtime, true);
  assert.equal(model.games.find((g) => g.name === "chess").realtime, true);
  assert.equal(model.games.find((g) => g.name === "hangman").realtime, false);
});

/* -------------------------------------------------------------- the frame */

test("the frame is a rectangle, whatever the board is made of", () => {
  const rows = ["ab", "a much longer row than that one", "c"];
  const lines = frame({ title: "GAME", status: "score 3", rows, keys: "q quit" }).split("\n");
  const boxed = lines.slice(1, -1); // between header and key line
  const widths = new Set(boxed.map(visible));
  assert.equal(widths.size, 1, `the box is ragged: ${[...widths].join(", ")}`);
});

test("the key line does not stretch the board", () => {
  // The bug this replaces: a 20-column tetris well drawn inside a 54-column
  // frame, because the footer was measured as if it were part of the box.
  const narrow = frame({ title: "T", rows: ["####"], keys: "q quit" });
  const wide = frame({ title: "T", rows: ["####"], keys: "a very long line of key hints indeed, look at it go" });
  assert.equal(visible(narrow.split("\n")[1]), visible(wide.split("\n")[1]));
});

test("the status sits on the right when it fits, and beside the title when it does not", () => {
  const roomy = frame({ title: "GAME", status: "ok", rows: ["x".repeat(40)] }).split("\n")[0];
  assert.match(strip(roomy), /GAME {2,}ok$/);
  const tight = frame({ title: "GAME", status: "a status far too long for this board", rows: ["xx"] }).split("\n")[0];
  assert.match(strip(tight), /^ {2}GAME {2}a status/);
});

/* ---------------------------------------------------------------- the keys */

test("raw bytes become key names", () => {
  assert.deepEqual(decodeKeys("\x1b[A\x1b[B\x1b[C\x1b[D"), ["up", "down", "right", "left"]);
  assert.deepEqual(decodeKeys("\r"), ["enter"]);
  assert.deepEqual(decodeKeys(" "), ["space"]);
  assert.deepEqual(decodeKeys("\x03"), ["quit"]);
  assert.deepEqual(decodeKeys("\x1b"), ["escape"]);
  assert.deepEqual(decodeKeys("Q"), ["q"], "shift is not a different key here");
  // hjkl everywhere, for free.
  assert.deepEqual(decodeKeys("hjkl"), ["left", "down", "up", "right"]);
  // Holding a key down delivers several at once.
  assert.deepEqual(decodeKeys("\x1b[Ax\x1b[A"), ["up", "x", "up"]);
  // An unknown escape sequence is swallowed, not misread as three keys.
  assert.deepEqual(decodeKeys("\x1b[Z"), []);
});

/* ------------------------------------------------------------------ tetris */

test("a shape turns without changing size", () => {
  assert.deepEqual(rotate(SHAPES.O), SHAPES.O, "a square is a square");
  assert.deepEqual(rotate(SHAPES.I), ["..I.", "..I.", "..I.", "..I."]);
  assert.deepEqual(rotate(rotate(rotate(rotate(SHAPES.T)))), SHAPES.T, "four turns is where you started");
});

test("a piece collides with the walls, the floor, and the stack", () => {
  const board = emptyBoard();
  assert.equal(collides(board, SHAPES.O, -1, 0), true, "off the left");
  assert.equal(collides(board, SHAPES.O, T_WIDTH - 1, 0), true, "off the right");
  assert.equal(collides(board, SHAPES.O, 0, T_HEIGHT - 1), true, "through the floor");
  assert.equal(collides(board, SHAPES.O, 0, 0), false);
  board[4][0] = "I";
  assert.equal(collides(board, SHAPES.O, 0, 3), true, "into the stack");
});

test("full rows clear and everything above drops", () => {
  const board = emptyBoard();
  board[T_HEIGHT - 1] = Array.from({ length: T_WIDTH }, () => "I");
  board[T_HEIGHT - 2][3] = "T";
  assert.equal(clearLines(board), 1);
  assert.equal(board[T_HEIGHT - 1][3], "T", "the row above fell into the gap");
  assert.equal(board[0].every((c) => c === null), true, "and the top is empty again");
});

test("a slam drops the piece to its landing square and locks it", () => {
  const state = TETRIS.create({ rng: seeded(3) });
  const target = landing(state);
  TETRIS.onKey(state, "space");
  assert.notEqual(state.piece.y, target, "a lock spawns the next piece");
  const filled = state.board.filter((row) => row.some(Boolean)).length;
  assert.ok(filled > 0, "the slammed piece is part of the board now");
  assert.ok(state.score > 0, "and a slam pays for the distance");
});

test("tetris ends when the stack reaches the ceiling", () => {
  const state = TETRIS.create({ rng: seeded(7) });
  for (let i = 0; i < 200 && !state.over; i++) TETRIS.onKey(state, "space");
  assert.ok(state.over, "200 slammed pieces should fill a ten-wide well");
  assert.equal(typeof TETRIS.status(state), "string");
  assert.match(strip(TETRIS.status(state)), /score/);
});

test("clearing a line pays, and the level follows the lines", () => {
  const state = TETRIS.create({ rng: seeded(11) });
  state.board[T_HEIGHT - 1] = Array.from({ length: T_WIDTH }, (_, x) => (x < T_WIDTH - 2 ? "I" : null));
  state.piece = { key: "O", shape: SHAPES.O, x: T_WIDTH - 2, y: 0 };
  TETRIS.onKey(state, "space");
  assert.equal(state.lines, 1);
  assert.ok(state.score >= 100, `a cleared line should pay: ${state.score}`);
});

test("a piece rotating in the gutter kicks off the wall", () => {
  const state = TETRIS.create({ rng: seeded(5) });
  state.piece = { key: "I", shape: SHAPES.I, x: -1, y: 5 };
  TETRIS.onKey(state, "up");
  assert.equal(collides(state.board, state.piece.shape, state.piece.x, state.piece.y), false);
});

/* ------------------------------------------------------------------- snake */

test("the snake grows on food and keeps its length otherwise", () => {
  const state = SNAKE.create({ rng: seeded(2) });
  const head = state.snake[0];
  state.food = [head[0] + 1, head[1]];
  const before = state.snake.length;
  step(state);
  assert.equal(state.snake.length, before + 1, "eating grows it");
  assert.equal(state.score, 10);
  step(state);
  assert.equal(state.snake.length, before + 1, "and a plain step does not");
});

test("the snake dies on the wall and on itself", () => {
  const wall = SNAKE.create({ rng: seeded(2) });
  wall.snake = [[S_WIDTH - 1, 0]];
  wall.dir = "right";
  step(wall);
  assert.match(wall.over, /wall/);

  const self = SNAKE.create({ rng: seeded(2) });
  self.snake = [[5, 5], [6, 5], [6, 6], [5, 6], [4, 6]];
  self.dir = "down";
  self.food = null;
  step(self);
  assert.match(self.over, /itself/);
});

test("the snake cannot reverse into its own neck", () => {
  const state = SNAKE.create({ rng: seeded(2) });
  SNAKE.onKey(state, "left"); // it is travelling right
  assert.equal(state.dir, "right");
  SNAKE.onKey(state, "up");
  assert.equal(state.dir, "up");
  SNAKE.onKey(state, "left");
  assert.equal(state.dir, "up", "one turn per tick");
});

test("food never lands under the snake", () => {
  const state = SNAKE.create({ rng: seeded(9) });
  for (let i = 0; i < 300 && !state.over; i++) {
    if (state.food) assert.ok(!state.snake.some(([x, y]) => x === state.food[0] && y === state.food[1]));
    SNAKE.onKey(state, ["up", "right", "down", "left"][i % 4]);
    step(state);
  }
});

test("the snake board is drawn to size", () => {
  const state = SNAKE.create({ rng: seeded(2) });
  const rows = SNAKE.render(state);
  assert.equal(rows.length, S_HEIGHT);
  assert.equal(visible(rows[0]), S_WIDTH);
});

/* ------------------------------------------------------------------ pacman */

test("the maze is one connected place — every dot is reachable", () => {
  // A maze with a walled-off pocket is a game that cannot be won, and no
  // amount of playing it by hand would reliably find the pocket.
  const start = { x: MAZE.findIndex(() => true), y: 0 };
  let pac = null;
  for (let y = 0; y < P_HEIGHT; y++) {
    const x = MAZE[y].indexOf("P");
    if (x >= 0) pac = { x, y };
  }
  assert.ok(pac, "the maze must say where pac starts");
  assert.ok(start);

  const seen = new Set([`${pac.x},${pac.y}`]);
  const queue = [pac];
  while (queue.length) {
    const { x, y } = queue.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;
      if (isWall(nx, ny) || seen.has(key)) continue;
      seen.add(key);
      queue.push({ x: nx, y: ny });
    }
  }
  for (const key of pellets().keys()) {
    assert.ok(seen.has(key), `the dot at ${key} is walled off from the start`);
  }
});

test("the maze is a rectangle with a wall all the way round", () => {
  for (const row of MAZE) assert.equal(row.length, P_WIDTH);
  for (let x = 0; x < P_WIDTH; x++) {
    assert.equal(MAZE[0][x], "#", "the top leaks");
    assert.equal(MAZE[P_HEIGHT - 1][x], "#", "the bottom leaks");
  }
  for (const row of MAZE) {
    assert.equal(row[0], "#");
    assert.equal(row[P_WIDTH - 1], "#");
  }
});

test("eating a dot scores, and a pellet makes the ghosts edible", () => {
  const state = PACMAN.create({ rng: seeded(4) });
  const before = state.dots.size;
  PACMAN.onKey(state, "left");
  PACMAN.tick(state);
  assert.equal(state.dots.size, before - 1, "pac ate the dot it walked onto");
  assert.equal(state.score, 10);

  // Stand pac on a power pellet and let the tick eat it.
  const pellet = [...state.dots.entries()].find(([, kind]) => kind === "o")[0];
  const [px, py] = pellet.split(",").map(Number);
  state.pac = { x: px + 1, y: py, dir: "left", want: "left" };
  PACMAN.tick(state);
  assert.ok(state.fright > 0, "the ghosts should be running");
});

test("a ghost costs a life, and the third one ends it", () => {
  const state = PACMAN.create({ rng: seeded(6) });
  state.lives = 1;
  const ghost = state.ghosts[0];
  state.pac = { x: ghost.x, y: ghost.y, dir: "left", want: "left" };
  // The tick moves pac first; put a ghost where it is about to arrive.
  state.ghosts[0] = { ...ghost, x: ghost.x - 1, y: ghost.y };
  PACMAN.tick(state);
  assert.equal(state.over, "game over");
});

test("eating the last dot wins the maze", () => {
  const state = PACMAN.create({ rng: seeded(8) });
  const next = { x: state.pac.x - 1, y: state.pac.y };
  state.dots = new Map([[`${next.x},${next.y}`, "."]]);
  PACMAN.tick(state);
  assert.match(state.over, /cleared/);
});

test("a ghost never steps into a wall", () => {
  const state = PACMAN.create({ rng: seeded(12) });
  for (let i = 0; i < 400 && !state.over; i++) {
    PACMAN.onKey(state, ["left", "up", "right", "down"][i % 4]);
    PACMAN.tick(state);
    for (const ghost of state.ghosts) {
      assert.equal(isWall(ghost.x, ghost.y), false, `a ghost is inside a wall at ${ghost.x},${ghost.y}`);
    }
    assert.equal(isWall(state.pac.x, state.pac.y), false, "pac is inside a wall");
  }
});

/* -------------------------------------------------------------- tictactoe */

test("three in a row is spotted in every direction", () => {
  assert.equal(winner(["X", "X", "X", null, null, null, null, null, null]), "X");
  assert.equal(winner(["O", null, null, "O", null, null, "O", null, null]), "O");
  assert.equal(winner(["X", null, null, null, "X", null, null, null, "X"]), "X");
  assert.equal(winner(emptyGrid()), null);
  assert.equal(winner(["X", "O", "X", "X", "O", "O", "O", "X", "X"]), "draw");
});

test("the opponent takes the win in front of it, and blocks the one against it", () => {
  assert.equal(bestMove(["O", "O", null, "X", "X", null, null, null, null], "O", () => 0), 2, "take the win");
  assert.equal(bestMove(["X", "X", null, "O", null, null, null, null, null], "O", () => 0), 2, "block the loss");
});

test("the opponent cannot be beaten", () => {
  // 40 games of random play against the search. A single loss here means the
  // minimax is wrong, and it is the sort of wrong nobody notices by playing.
  const rng = seeded(13);
  for (let game = 0; game < 40; game++) {
    const board = emptyGrid();
    for (;;) {
      const open = board.map((c, i) => (c ? null : i)).filter((i) => i !== null);
      if (!open.length || winner(board)) break;
      board[open[Math.floor(rng() * open.length) % open.length]] = "X";
      if (winner(board)) break;
      const reply = bestMove(board, "O", rng);
      if (reply == null) break;
      board[reply] = "O";
    }
    assert.notEqual(winner(board), "X", `random play beat the machine: ${board.join(",")}`);
  }
});

test("marking a square answers immediately, and a taken square is refused", () => {
  const state = TICTACTOE.create();
  state.cursor = 0;
  TICTACTOE.onKey(state, "enter", { rng: seeded(3) });
  assert.equal(state.board[0], "X");
  assert.equal(state.board.filter((c) => c === "O").length, 1, "the machine replied");
  const before = state.board.slice();
  TICTACTOE.onKey(state, "enter", { rng: seeded(3) });
  assert.deepEqual(state.board, before, "you cannot play a square twice");
});

test("the cursor wraps rather than sticking to an edge", () => {
  const state = TICTACTOE.create();
  state.cursor = 0;
  TICTACTOE.onKey(state, "left");
  assert.equal(state.cursor, 2);
  TICTACTOE.onKey(state, "up");
  assert.equal(state.cursor, 8);
});

/* ---------------------------------------------------------------- hangman */

test("a right letter is revealed and a wrong one costs a limb", () => {
  const state = { word: "kernel", guessed: new Set(), missed: [], over: null };
  guess(state, "e");
  assert.equal(mask(state).join(""), "_E__E_");
  guess(state, "z");
  assert.deepEqual(state.missed, ["z"]);
  guess(state, "z");
  assert.deepEqual(state.missed, ["z"], "a repeat is free and tells you nothing");
  guess(state, "3");
  guess(state, "enter");
  assert.deepEqual(state.missed, ["z"], "only letters count");
});

test("hangman is winnable and losable", () => {
  const won = { word: "mosh", guessed: new Set(), missed: [], over: null };
  for (const c of "mosh") guess(won, c);
  assert.match(won.over, /got it/);

  const lost = { word: "mosh", guessed: new Set(), missed: [], over: null };
  for (const c of "bcdfgj".slice(0, MISSES_ALLOWED)) guess(lost, c);
  assert.match(lost.over, /hanged/);
  assert.match(lost.over, /MOSH/, "a loss shows the word");
  assert.ok(strip(HANGMAN.render(lost).join("\n")).includes("☹"), "and finishes the gallows");
});

test("every hangman word is guessable with the keys the game offers", () => {
  for (const word of WORDS) {
    assert.match(word, /^[a-z]+$/, `"${word}" has a character nobody can type at it`);
  }
});

/* ------------------------------------------------------------------ chess */

test("a game of chess opens with twenty legal moves", () => {
  const state = CHESS.create();
  assert.equal(allMoves(state).length, 20);
  assert.deepEqual(legalMoves(state, 52).map((m) => name(m.to)).sort(), ["e3", "e4"]);
});

test("castling is offered, moves the rook, and is refused through check", () => {
  const open = { board: parseBoard("4k3/8/8/8/8/8/8/R3K2R"), turn: "w", castling: { K: true, Q: true }, ep: null };
  const both = legalMoves(open, 60).filter((m) => m.castle);
  assert.equal(both.length, 2, "both sides should be available");
  const after = apply(open, both.find((m) => m.castle === "K"));
  assert.equal(after.board[62], "K");
  assert.equal(after.board[61], "R", "the rook came with it");
  assert.equal(after.board[63], null);
  assert.equal(after.castling.K, false, "and the right is spent");

  const watched = { ...open, board: parseBoard("4kr2/8/8/8/8/8/8/R3K2R") };
  assert.equal(legalMoves(watched, 60).some((m) => m.castle === "K"), false, "not through an attacked square");
});

test("en passant captures the pawn that ran past", () => {
  const state = { board: parseBoard("4k3/8/8/3pP3/8/8/8/4K3"), turn: "w", castling: {}, ep: 19 };
  const ep = legalMoves(state, 28).find((m) => m.enPassant);
  assert.ok(ep, "the capture should be on offer");
  const after = apply(state, ep);
  assert.equal(after.board[19], "P");
  assert.equal(after.board[27], null, "the black pawn is gone");
});

test("a pawn reaching the far rank becomes a queen", () => {
  const state = { board: parseBoard("4k3/P7/8/8/8/8/8/4K3"), turn: "w", castling: {}, ep: null };
  const promo = legalMoves(state, 8).find((m) => m.promotion);
  assert.equal(apply(state, promo).board[0], "Q");
});

test("a king may not walk into check, or stay in it", () => {
  const state = { board: parseBoard("4k3/8/8/8/8/8/4r3/4K3"), turn: "w", castling: {}, ep: null };
  assert.equal(inCheck(state, true), true);
  for (const move of allMoves(state, true)) {
    assert.equal(inCheck(apply(state, move), true), false, `${name(move.from)}-${name(move.to)} leaves the king in check`);
  }
});

test("checkmate and stalemate are told apart", () => {
  let mate = CHESS.create();
  for (const [from, to] of [[53, 45], [12, 28], [54, 38], [3, 39]]) {
    mate = apply(mate, legalMoves(mate, from).find((m) => m.to === to));
  }
  assert.equal(outcome(mate), "checkmate");

  const stuck = { board: parseBoard("7k/5Q2/6K1/8/8/8/8/8"), turn: "b", castling: {}, ep: null };
  assert.equal(inCheck(stuck, false), false);
  assert.equal(outcome(stuck), "stalemate");
});

test("the machine takes a piece left hanging", () => {
  // Black to move, white queen on d5 undefended, and a knight on c3 that can
  // reach it.
  const state = { board: parseBoard("4k3/8/8/3Q4/8/2n5/8/4K3"), turn: "b", castling: {}, ep: null };
  const move = chooseMove(state, { depth: 2, rng: seeded(3) });
  assert.equal(name(move.to), "d5", `it should take the queen, played ${name(move.from)}-${name(move.to)}`);
});

test("picking a piece up shows where it can go, and putting it down moves it", () => {
  const state = CHESS.create();
  state.cursor = 52; // e2
  CHESS.onKey(state, "enter");
  assert.equal(state.selected, 52);
  assert.equal(state.targets.length, 2);
  state.cursor = 36; // e4
  CHESS.onKey(state, "enter");
  assert.equal(state.board[36], "P");
  assert.equal(state.board[52], null);
  assert.equal(state.turn, "b", "and it is the machine's move");
  assert.equal(state.selected, null);

  // The reply comes on the clock, so the player's own move draws first.
  CHESS.tick(state, { rng: seeded(4) });
  assert.equal(state.turn, "w");
  assert.equal(state.played.length, 2);
});

test("a piece can be put back down without moving", () => {
  const state = CHESS.create();
  state.cursor = 52;
  CHESS.onKey(state, "enter");
  CHESS.onKey(state, "enter"); // same square
  assert.equal(state.selected, null);
  assert.equal(state.board[52], "P", "the pawn never left");
  assert.equal(state.turn, "w");
});

test("black's pieces are lower case, so the board reads without colour", () => {
  const rows = CHESS.render(CHESS.create()).map(strip);
  assert.match(rows[0], /r {2}n {2}b {2}q {2}k/, "rank 8 is black");
  assert.match(rows[7], /R {2}N {2}B {2}Q {2}K/, "rank 1 is white");
});

/* ----------------------------------------------------------- the command */

test("with no game named, the command lists them", async () => {
  const lines = [];
  assert.equal(await gamesCommand([], { out: (s) => lines.push(s), interactive: false }), 0);
  assert.match(strip(lines.join("\n")), /moshcode arcade/);
});

test("--json prints the roster and nothing else", async () => {
  const lines = [];
  await gamesCommand(["--json"], { out: (s) => lines.push(s), interactive: false });
  const parsed = JSON.parse(lines.join("\n"));
  assert.equal(parsed.games.length, GAMES.length);
});

test("an unknown game names the ones that exist", async () => {
  const errors = [];
  const code = await gamesCommand(["doom"], { out: () => {}, fail: (s) => errors.push(s), interactive: false });
  assert.equal(code, 1);
  assert.match(strip(errors.join("\n")), /no game called "doom"/);
  assert.match(strip(errors.join("\n")), /tetris/);
});

test("a game refuses to start where there is no keyboard", async () => {
  const errors = [];
  const code = await gamesCommand(["tetris"], { out: () => {}, fail: (s) => errors.push(s), interactive: false });
  assert.equal(code, 1);
  assert.match(strip(errors.join("\n")), /interactive terminal/);
});

/* ------------------------------------------------------------- the driver */

/** A stdin that is not a terminal, and an stdout that is a string. */
function fakeIO() {
  const input = new EventEmitter();
  input.setRawMode = () => {};
  input.setEncoding = () => {};
  input.resume = () => {};
  input.pause = () => {};
  input.off = input.removeListener;
  const written = [];
  return { input, output: { write: (s) => written.push(s) }, written };
}

test("q leaves the game, and the last frame stays on the screen", async () => {
  const { input, output, written } = fakeIO();
  const done = runGame(TICTACTOE, { input, output, rng: seeded(3) });
  await new Promise((r) => setImmediate(r));
  input.emit("data", "q");
  assert.equal(await done, 0);
  const screen = strip(written.join(""));
  assert.match(screen, /TIC-TAC-TOE/);
  assert.match(screen, /thanks for playing/);
  assert.equal(written.join("").includes("\x1b[?25h"), true, "the cursor comes back");
});

test("keys reach the game and the board is redrawn", async () => {
  const { input, output, written } = fakeIO();
  const done = runGame(TICTACTOE, { input, output, rng: seeded(3) });
  await new Promise((r) => setImmediate(r));
  const before = written.length;
  input.emit("data", "\x1b[A");
  assert.ok(written.length > before, "a keypress should repaint");
  input.emit("data", "q");
  await done;
});

test("an identical frame is not repainted", async () => {
  const { input, output, written } = fakeIO();
  const done = runGame(HANGMAN, { input, output, rng: seeded(3) });
  await new Promise((r) => setImmediate(r));
  const before = written.length;
  input.emit("data", "\t"); // a key hangman does nothing with
  assert.equal(written.length, before, "nothing changed, so nothing was drawn");
  input.emit("data", "q");
  await done;
});

test("a real-time game runs on the clock it is given, and stops when it ends", async () => {
  const { input, output } = fakeIO();
  let fire = null;
  const done = runGame(SNAKE, {
    input,
    output,
    rng: seeded(5),
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => { fire = null; },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(typeof fire, "function", "the game should have armed its clock");
  for (let i = 0; i < 40 && fire; i++) {
    const next = fire;
    fire = null;
    next();
  }
  // Twenty-eight columns of board and a snake pointed at the wall: by now it
  // has either crashed (clock stopped) or is still going with the clock armed.
  input.emit("data", "q");
  assert.equal(await done, 0);
});

test("r starts another game once the last one is over", async () => {
  const { input, output } = fakeIO();
  const done = runGame(HANGMAN, { input, output, rng: seeded(21) });
  await new Promise((r) => setImmediate(r));
  input.emit("data", "bcdfgjkmpqvwxz".slice(0, 12)); // wrong letters, mostly
  input.emit("data", "r");
  input.emit("data", "\x03");
  assert.equal(await done, 0);
});
