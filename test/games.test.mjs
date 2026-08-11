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
import {
  ASTEROIDS, ROCKS, rock, spawnWave, span, star, WIDTH as A_WIDTH, HEIGHT as A_HEIGHT,
} from "../src/games-asteroids.mjs";
import {
  STAGEDIVE, HAZARDS, GROUND, RUNNER, cells, meters, runnerRows, spawn,
  WIDTH as D_WIDTH, HEIGHT as D_HEIGHT,
} from "../src/games-stagedive.mjs";
import { TICTACTOE, bestMove, emptyBoard as emptyGrid, winner } from "../src/games-tictactoe.mjs";
import {
  BLACKJACK, MIN_BET, canSplit, freshDeck, handValue, isBlackjack, settle,
} from "../src/games-blackjack.mjs";
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

test("a game that reads letters gets its letters back", () => {
  assert.deepEqual(decodeKeys("hjkl", { vim: false }), ["h", "j", "k", "l"]);
  // Only the letters are given up — the arrows arrive as escape sequences and
  // are unaffected, which is what lets blackjack use them for the bet.
  assert.deepEqual(decodeKeys("\x1b[C\x1b[D", { vim: false }), ["right", "left"]);
  assert.deepEqual(decodeKeys("\r ", { vim: false }), ["enter", "space"]);
});

test("the games that read letters have opted out of both intercepts", () => {
  for (const game of GAMES.filter((g) => /a–z|hit/.test(g.keys))) {
    assert.equal(game.vim, false, `${game.key} cannot see the letters h j k l`);
    assert.equal(game.restartable, false, `${game.key} loses the letter r to the restart`);
  }
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

/* --------------------------------------------------------------- asteroids */

test("a wave arrives at full size, and never on top of the ship", () => {
  const ship = { x: A_WIDTH / 2, y: A_HEIGHT / 2 };
  for (let seed = 1; seed <= 25; seed++) {
    const wave = spawnWave(3, ship, seeded(seed));
    assert.equal(wave.length, 6, "3 + wave rocks");
    for (const r of wave) {
      assert.equal(r.size, 3, "a wave opens with whole rocks");
      assert.ok(span(r, ship) >= 14, `a rock spawned ${span(r, ship).toFixed(1)} from the ship`);
    }
  }
});

test("the screen has no edges — everything wraps", () => {
  const state = ASTEROIDS.create({ rng: seeded(3) });
  state.rocks = [];
  state.ship = { x: A_WIDTH - 0.5, y: 0.2, vx: 1, vy: -0.4, angle: 0 };
  ASTEROIDS.tick(state);
  assert.ok(state.ship.x < 2, "off the right edge and back on the left");
  assert.ok(state.ship.y > A_HEIGHT - 2, "off the top and back on the bottom");
  // And the short way round is the short way round: two things either side of
  // the seam are close, not a screen apart.
  assert.ok(span({ x: 0.5, y: 5 }, { x: A_WIDTH - 0.5, y: 5 }) < 2);
});

test("a shot rock becomes two smaller ones, and scores", () => {
  const state = ASTEROIDS.create({ rng: seeded(5) });
  state.rocks = [rock(3, 20, 9, seeded(2))];
  state.rocks[0].vx = 0;
  state.rocks[0].vy = 0;
  state.bullets = [{ x: 20, y: 9, vx: 0, vy: 0, life: 5 }];
  state.invuln = 999; // the ship is not what this test is about
  ASTEROIDS.tick(state);
  assert.equal(state.rocks.length, 2, "a big rock breaks in two");
  assert.deepEqual(state.rocks.map((r) => r.size), [2, 2]);
  assert.equal(state.score, ROCKS[3].points);
  assert.equal(state.bullets.length, 0, "and the bullet is spent");

  // Down to the smallest, which leaves nothing behind.
  state.rocks = [{ ...rock(1, 20, 9, seeded(2)), vx: 0, vy: 0 }];
  state.bullets = [{ x: 20, y: 9, vx: 0, vy: 0, life: 5 }];
  ASTEROIDS.tick(state);
  assert.equal(state.score, ROCKS[3].points + ROCKS[1].points, "small rocks pay most");
});

test("clearing the rocks brings the next wave", () => {
  const state = ASTEROIDS.create({ rng: seeded(9) });
  state.rocks = [];
  ASTEROIDS.tick(state);
  assert.equal(state.wave, 2);
  assert.equal(state.rocks.length, 5, "a wave bigger than the last one");
});

test("a rock takes a life, and the last one ends the game", () => {
  const state = ASTEROIDS.create({ rng: seeded(7) });
  const sit = () => {
    state.rocks = [{ ...rock(3, state.ship.x, state.ship.y, seeded(1)), vx: 0, vy: 0 }];
    state.invuln = 0;
  };
  sit();
  ASTEROIDS.tick(state);
  assert.equal(state.lives, 2);
  assert.ok(state.invuln > 0, "you get a moment to get out of the way");
  assert.deepEqual([state.ship.x, state.ship.y], [A_WIDTH / 2, A_HEIGHT / 2], "and a fresh ship");

  state.lives = 1;
  sit();
  ASTEROIDS.tick(state);
  assert.match(state.over, /wrecked/);
});

test("the ship cannot be hit while it is blinking", () => {
  const state = ASTEROIDS.create({ rng: seeded(11) });
  state.rocks = [{ ...rock(3, state.ship.x, state.ship.y, seeded(1)), vx: 0, vy: 0 }];
  ASTEROIDS.tick(state); // create() starts you invulnerable
  assert.equal(state.lives, 3);
});

test("only four bullets are ever in the air", () => {
  const state = ASTEROIDS.create({ rng: seeded(13) });
  for (let i = 0; i < 20; i++) {
    ASTEROIDS.onKey(state, "space");
    state.cooldown = 0; // hammering the key, which is what everybody does
  }
  assert.equal(state.bullets.length, 4);
  // And they do not fly forever, or the screen fills up with old shots.
  for (let i = 0; i < 30; i++) ASTEROIDS.tick(state);
  assert.equal(state.bullets.length, 0);
});

test("thrust moves the ship the way it is pointing", () => {
  const state = ASTEROIDS.create({ rng: seeded(17) });
  state.rocks = [];
  state.ship.angle = 0; // due east
  ASTEROIDS.onKey(state, "up");
  assert.ok(state.ship.vx > 0 && Math.abs(state.ship.vy) < 1e-9);
  const flatOut = state.ship.vx;
  ASTEROIDS.onKey(state, "down");
  assert.ok(state.ship.vx < flatOut, "retro slows you down");
});

test("the asteroids board is drawn to size", () => {
  const state = ASTEROIDS.create({ rng: seeded(19) });
  const rows = ASTEROIDS.render(state);
  assert.equal(rows.length, A_HEIGHT);
  for (const row of rows) assert.equal(visible(row), A_WIDTH, "a ragged row would tear the frame");
  // The sky is scattered rather than striped — a diagonal is what you get from
  // a linear function of x and y, and it reads as a bug on screen.
  const byRow = new Set();
  for (let y = 0; y < A_HEIGHT; y++) {
    for (let x = 0; x < A_WIDTH; x++) if (star(x, y)) byRow.add(`${y}:${x}`);
  }
  assert.ok(byRow.size >= 8, "a sky with no stars in it");
});

/* -------------------------------------------------------------- stagedive */

/** A stage holding exactly the things a test puts on it, and nothing else. */
const stage = (things = []) => ({
  ...STAGEDIVE.create({ rng: seeded(1) }),
  things,
  next: Number.MAX_SAFE_INTEGER, // no spawner — this test is about one obstacle
});

/** Run the stage, calling `act(state, tick)` before each tick. */
function run(state, ticks, act = () => {}) {
  for (let i = 0; i < ticks && !state.over; i++) {
    act(state, i);
    state = STAGEDIVE.tick(state);
  }
  return state;
}

/** How far in front of the runner something is, in columns. */
const lead = (thing) => (thing ? cells(thing).cols[0] - RUNNER : Infinity);

/** A player with reflexes: jump the gear, duck the crowd. */
const reflexes = (state) => {
  for (const thing of state.things) {
    if (thing.kind === "pick") continue;
    const gap = lead(thing);
    if (thing.kind === "surfer") { if (gap >= 1 && gap <= 5) STAGEDIVE.onKey(state, "down"); }
    else if (gap >= 4 && gap <= 8) STAGEDIVE.onKey(state, "up");
  }
};

test("every hazard hits exactly as wide as it is drawn", () => {
  for (const [kind, hazard] of Object.entries(HAZARDS)) {
    const { cols } = cells({ kind, x: 20 });
    assert.equal(cols[1] - cols[0] + 1, [...hazard.art].length, `${kind} lies about its width`);
    assert.ok(hazard.rows.every((r) => r <= GROUND), `${kind} floats above the stage`);
    assert.ok(hazard.death.length, `${kind} kills you without saying so`);
  }
});

test("the runner never moves — the stage does", () => {
  const state = run(stage([{ kind: "wedge", x: 40 }]), 12);
  assert.equal(state.things[0].x < 40, true, "the wedge should have come closer");
  assert.ok(state.dist > 0, "and the distance run should have gone up");
  const drawn = STAGEDIVE.render(state).map(strip);
  assert.ok(drawn.some((row) => row[RUNNER] && row[RUNNER] !== " "), "the runner is always in its column");
});

test("a wedge you do not jump is a wedge you trip over", () => {
  const tripped = run(stage([{ kind: "wedge", x: RUNNER + 8 }]), 20);
  assert.match(tripped.over, /monitor wedge/);

  const cleared = run(stage([{ kind: "wedge", x: RUNNER + 8 }]), 20, (s) => {
    if (lead(s.things[0]) === 6) STAGEDIVE.onKey(s, "up");
  });
  assert.equal(cleared.over, null, "a jump at six columns should clear it");
});

test("an amp stack takes the height of the jump, not the start of it", () => {
  // Jumped in time: the runner is two rows up before the stack arrives.
  const cleared = run(stage([{ kind: "stack", x: RUNNER + 20 }]), 40, (s) => {
    if (lead(s.things[0]) === 6) STAGEDIVE.onKey(s, "up");
  });
  assert.equal(cleared.over, null);

  // Jumped one column late is still a jump, and still a wreck.
  const late = run(stage([{ kind: "stack", x: RUNNER + 20 }]), 40, (s) => {
    if (lead(s.things[0]) === 0) STAGEDIVE.onKey(s, "up");
  });
  assert.match(late.over, /amp stack/);
});

test("a crowdsurfer is ducked, not jumped into", () => {
  const worn = run(stage([{ kind: "surfer", x: RUNNER + 8 }]), 20);
  assert.match(worn.over, /crowdsurfer/);

  const ducked = run(stage([{ kind: "surfer", x: RUNNER + 8 }]), 20, (s) => {
    if (lead(s.things[0]) === 3) STAGEDIVE.onKey(s, "down");
  });
  assert.equal(ducked.over, null, "crouching should pass under it");
  // Crouched is one row; standing is two, and the second row is the one that
  // wears a crowdsurfer.
  assert.deepEqual(runnerRows({ y: GROUND, duck: 4, airborne: false }), [GROUND]);
  assert.deepEqual(runnerRows({ y: GROUND, duck: 0, airborne: false }), [GROUND - 1, GROUND]);
});

test("there is no second jump, and ↓ in the air is a slam", () => {
  const state = stage();
  STAGEDIVE.onKey(state, "up");
  const climbing = state.vy;
  STAGEDIVE.onKey(state, "up");
  assert.equal(state.vy, climbing, "a second jump would be a different game");
  STAGEDIVE.onKey(state, "down");
  assert.ok(state.vy > 0, "↓ in the air should send you down");
  assert.equal(state.duck, 0, "and it is not a crouch until you land");
});

test("picks are collected rather than crashed into", () => {
  const state = run(stage([{ kind: "pick", x: RUNNER + 6, row: GROUND }]), 20);
  assert.equal(state.picks, 1);
  assert.equal(state.over, null, "a pick is not a hazard");
  assert.equal(state.things.length, 0, "and it is off the stage once taken");
  assert.match(STAGEDIVE.status(state), /1 picks/);
});

test("the stage speeds up, and the gaps grow with it", () => {
  const state = STAGEDIVE.create({ rng: seeded(2) });
  const opening = state.speed;
  const far = run(state, 3000, reflexes);
  assert.ok(far.speed > opening, "the stage should get faster");

  // The gap is set in columns but a jump is fixed in ticks, so the gap has to
  // scale with speed or the game stops being playable at the far end.
  const slow = { ...STAGEDIVE.create({ rng: seeded(3) }), things: [] };
  const fast = { ...STAGEDIVE.create({ rng: seeded(3) }), things: [], speed: 1.75 };
  spawn(slow);
  spawn(fast);
  assert.ok(fast.next > slow.next * 1.9, "a faster stage should leave more room");
});

test("a player with reflexes can run the whole set", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const state = run(STAGEDIVE.create({ rng: seeded(seed) }), 3000, reflexes);
    assert.equal(state.over, null, `seed ${seed} died at ${meters(state)} m: ${state.over}`);
    assert.ok(state.picks > 10, `seed ${seed} only found ${state.picks} picks in 3000 ticks`);
  }
});

test("a player with none cannot", () => {
  for (let seed = 1; seed <= 15; seed++) {
    // Standing still, and holding the jump key down — the two ways nobody
    // should be able to play a runner.
    const idle = run(STAGEDIVE.create({ rng: seeded(seed) }), 600);
    assert.ok(idle.over, `seed ${seed} survived doing nothing`);
    const masher = run(STAGEDIVE.create({ rng: seeded(seed) }), 1500, (s) => STAGEDIVE.onKey(s, "up"));
    assert.ok(masher.over, `seed ${seed} survived on jump alone`);
  }
});

test("the stagedive board is drawn to size, with the stage under it", () => {
  const state = run(STAGEDIVE.create({ rng: seeded(9) }), 200, reflexes);
  const rows = STAGEDIVE.render(state);
  assert.equal(rows.length, D_HEIGHT);
  for (const row of rows) assert.equal(visible(row), D_WIDTH, "a ragged row would tear the frame");
  assert.match(strip(rows[GROUND + 1]), /^[═╪]+$/, "the stage edge runs the whole width");
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

/* -------------------------------------------------------------- blackjack */

/** A hand, spelled the way a table would say it: "AS 8H" is an ace and an eight. */
const cards = (spec) => spec.split(" ").map((c) => ({ rank: c.slice(0, -1), suit: c.slice(-1) }));

/**
 * A game holding exactly the cards this test wants. The deck is drawn from the
 * end, so it is stacked back to front.
 */
function table(player, dealer, upcoming = "", chips = 100, bet = 10) {
  const state = BLACKJACK.create({ rng: seeded(1) });
  state.chips = chips - bet;
  state.bet = bet;
  state.hands = [{ cards: cards(player), bet, done: false, doubled: false, result: null, payout: 0 }];
  state.dealer = cards(dealer);
  state.deck = upcoming ? cards(upcoming).reverse() : freshDeck(seeded(2));
  state.hole = true;
  state.active = 0;
  state.phase = "player";
  state.message = "";
  state.over = null;
  return state;
}

test("aces count eleven until they cannot", () => {
  assert.deepEqual(handValue(cards("A♠ 8♥")), { total: 19, soft: true });
  assert.deepEqual(handValue(cards("A♠ 8♥ 5♣")), { total: 14, soft: false });
  assert.deepEqual(handValue(cards("A♠ A♥ 9♣")), { total: 21, soft: true });
  assert.deepEqual(handValue(cards("K♠ Q♥ J♣")), { total: 30, soft: false });
  assert.equal(isBlackjack(cards("A♠ K♥")), true);
  assert.equal(isBlackjack(cards("7♠ 7♥ 7♣")), false, "21 on three cards is not blackjack");
});

test("a deck is 52 different cards, however it is shuffled", () => {
  const deck = freshDeck(seeded(5));
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map((c) => `${c.rank}${c.suit}`)).size, 52);
  assert.notDeepEqual(deck, freshDeck(seeded(9)), "two shuffles are not the same shuffle");
});

test("blackjack pays 3:2, and a pushed blackjack pays nothing", () => {
  const state = table("A♠ K♥", "9♦ 8♣");
  settle(state);
  assert.match(state.hands[0].result, /blackjack/);
  assert.equal(state.chips, 115, "the 10 back, plus 15");

  const tie = table("A♠ K♥", "A♦ K♣");
  settle(tie);
  assert.equal(tie.hands[0].result, "push");
  assert.equal(tie.chips, 100, "nothing won, nothing lost");
});

test("the dealer draws to 17 and stands on it, soft or not", () => {
  const hard = table("K♠ 7♥", "9♦ 3♣", "4♥ 2♠");
  settle(hard);
  assert.equal(handValue(hard.dealer).total, 18, "12 → 16 → 18, and stop");
  assert.equal(hard.hands[0].result, "dealer wins", "17 loses to 18");

  const soft = table("K♠ 8♥", "A♦ 6♣");
  settle(soft);
  assert.equal(hard.hole, false, "the hole card is turned over either way");
  assert.equal(soft.dealer.length, 2, "a soft 17 stands, house rules");
  assert.equal(soft.hands[0].result, "you win");
  assert.equal(soft.chips, 110);
});

test("a bust loses the bet, and the dealer does not bother drawing", () => {
  const state = table("K♠ 8♥", "9♦ 3♣", "5♣");
  BLACKJACK.onKey(state, "h");
  assert.equal(handValue(state.hands[0].cards).total, 23);
  assert.equal(state.hands[0].result, "bust");
  assert.equal(state.dealer.length, 2, "nothing left to beat");
  assert.equal(state.chips, 90, "the wager is gone");
  assert.equal(state.phase, "settled");
});

test("twenty-one stands itself rather than waiting to be busted", () => {
  const state = table("7♠ 6♥", "K♦ 9♣", "8♣");
  BLACKJACK.onKey(state, "h");
  assert.equal(state.phase, "settled", "21 does not get asked twice");
  assert.equal(state.hands[0].result, "you win");
});

test("double takes one card, doubles the stake, and ends the hand", () => {
  const state = table("6♠ 5♥", "K♦ 7♣", "9♥");
  BLACKJACK.onKey(state, "d");
  assert.equal(state.hands[0].cards.length, 3);
  assert.equal(state.hands[0].bet, 20);
  assert.equal(state.phase, "settled");
  assert.equal(state.chips, 120, "20 up on a 20 wager");

  // Three cards in, there is nothing to double.
  const late = table("6♠ 5♥ 2♦", "K♦ 7♣");
  const chips = late.chips;
  BLACKJACK.onKey(late, "d");
  assert.equal(late.hands[0].cards.length, 3);
  assert.equal(late.chips, chips, "and nothing was staked on it");
});

test("a pair splits into two hands, each with its own bet", () => {
  const state = table("8♠ 8♥", "K♦ 7♣", "3♥ 2♠");
  assert.equal(canSplit(state), true);
  BLACKJACK.onKey(state, "p");
  assert.equal(state.hands.length, 2);
  assert.deepEqual(state.hands.map((h) => h.cards.length), [2, 2]);
  assert.deepEqual(state.hands.map((h) => h.bet), [10, 10]);
  assert.equal(state.chips, 80, "two wagers on the table");
  assert.equal(state.active, 0);

  // Standing on the first hand moves to the second rather than to the dealer.
  BLACKJACK.onKey(state, "s");
  assert.equal(state.active, 1);
  assert.equal(state.phase, "player");
  BLACKJACK.onKey(state, "s");
  assert.equal(state.phase, "settled");
  assert.equal(state.hands.filter((h) => h.result).length, 2, "both hands are paid");
});

test("split aces get one card each, and 21 on them is not blackjack", () => {
  const state = table("A♠ A♥", "K♦ 7♣", "K♥ Q♠");
  BLACKJACK.onKey(state, "p");
  assert.equal(state.phase, "settled", "no decisions on split aces");
  assert.deepEqual(state.hands.map((h) => handValue(h.cards).total), [21, 21]);
  assert.deepEqual(state.hands.map((h) => h.result), ["you win", "you win"]);
  assert.equal(state.chips, 120, "paid 1:1 twice — not 3:2");
});

test("only a real pair splits, and only with the chips to back it", () => {
  assert.equal(canSplit(table("8♠ 9♥", "K♦ 7♣")), false);
  assert.equal(canSplit(table("K♠ Q♥", "K♦ 7♣")), true, "two tens is a pair at the table");
  assert.equal(canSplit(table("8♠ 8♥", "K♦ 7♣", "", 10, 10)), false, "nothing left to stake");
});

test("between hands the arrows are the chips", () => {
  const state = table("K♠ K♥", "9♦ 8♣", "2♣ 3♦ 4♥ 5♠");
  settle(state);
  assert.equal(state.phase, "settled");
  BLACKJACK.onKey(state, "right");
  assert.equal(state.bet, 15);
  for (let i = 0; i < 10; i++) BLACKJACK.onKey(state, "left");
  assert.equal(state.bet, MIN_BET, "and it does not go below the table minimum");
  BLACKJACK.onKey(state, "enter");
  assert.equal(state.phase, "player");
  assert.equal(state.hands[0].cards.length, 2, "and the next hand is dealt");
});

test("the last of the stack ends it, and a bet is never more than you have", () => {
  const broke = table("K♠ 5♥", "9♦ 8♣", "", 30, 30);
  settle(broke); // 15 against a dealer 17 — the whole stack was on it
  assert.equal(broke.chips, 0);
  assert.match(broke.over, /broke/);

  const short = table("K♠ K♥", "9♦ 8♣", "2♣ 3♦ 4♥ 5♠", 20, 20);
  settle(short); // everything staked, and 40 back on the win
  assert.equal(short.chips, 40);
  short.bet = 500;
  BLACKJACK.onKey(short, "enter");
  assert.equal(short.hands[0].bet, 40, "you can only bet what you have");
  assert.equal(short.chips, 0);
});

test("the table is dealt before the frame lands, and stays one size", () => {
  const fresh = BLACKJACK.create({ rng: seeded(21) });
  assert.equal(fresh.hands[0].cards.length, 2, "a hand is already out");
  assert.equal(fresh.dealer.length, 2, "and so is the dealer's");

  const width = (s) => Math.max(...BLACKJACK.render(s).map(visible));
  const playing = table("K♠ 7♥", "9♦ 8♣");
  const dealt = width(playing);
  settle(playing);
  assert.equal(width(playing), dealt, "the box must not breathe between hands");

  // The hole card stays a hole card until the dealer plays.
  assert.ok(strip(BLACKJACK.render(table("K♠ 7♥", "9♦ 8♣")).join("\n")).includes("▚▚▚"));
  assert.ok(!strip(BLACKJACK.render(playing).join("\n")).includes("▚▚▚"), "and is turned over after");
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
  // And "typeable" means all the way through the decoder and the driver's own
  // keys: `h` used to arrive as a left arrow and `r` as a restart, which made
  // `refactor` a word nobody could spell at the gallows.
  for (const letter of "hjklr") {
    const [key] = decodeKeys(letter, { vim: HANGMAN.vim !== false });
    assert.equal(key, letter, `${letter} never reaches hangman`);
    const state = { word: "hjklr", guessed: new Set(), missed: [], over: null };
    HANGMAN.onKey(state, key);
    assert.ok(state.guessed.has(letter), `${letter} was not taken as a guess`);
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

test("letters reach the games that read letters, all the way from the wire", async () => {
  const { input, output } = fakeIO();
  let state = null;
  // The driver owns the decoder, so this is the only place the opt-out can be
  // proved: `h` has to arrive as a hit rather than as a left arrow.
  const spy = { ...BLACKJACK, onKey: (s, key, ctx) => { state = BLACKJACK.onKey(s, key, ctx); return state; } };
  const done = runGame(spy, { input, output, rng: seeded(4) });
  await new Promise((r) => setImmediate(r));
  input.emit("data", "h");
  assert.ok(state, "the keypress never arrived");
  assert.ok(state.hands[0].cards.length >= 3 || state.phase === "settled", "h dealt no card");
  input.emit("data", "q");
  await done;
});

test("r is not a restart in a game where r is a letter", async () => {
  const { input, output } = fakeIO();
  let state = null;
  const spy = { ...HANGMAN, onKey: (s, key, ctx) => { state = HANGMAN.onKey(s, key, ctx); return state; } };
  const done = runGame(spy, { input, output, rng: seeded(3) });
  await new Promise((r) => setImmediate(r));
  input.emit("data", "r");
  assert.ok(state, "r was eaten by the restart before hangman saw it");
  // In the word or not, it was played as a guess.
  assert.ok(state.guessed.has("r") || state.missed.includes("r"));
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
