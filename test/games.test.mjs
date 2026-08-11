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
import {
  INVADERS, KINDS, ROWS, COLS, BUNKER_ROW, CANNON_ROW, alienAt, aliveCount, cadence, chip, frontLine,
  WIDTH as I_WIDTH, HEIGHT as I_HEIGHT,
} from "../src/games-invaders.mjs";
import {
  BREAKOUT, BRICK_ROWS, BRICK_COLS, BRICK_TOP, BRICK_W, PADDLE_W, PADDLE_ROW, ROW_POINTS,
  brickAt, bricksLeft, buildWall, WIDTH as WIDTH_B, HEIGHT as HEIGHT_B,
} from "../src/games-breakout.mjs";
import {
  PONG, PADDLE, YOU_COL, TARGET as PONG_TARGET, WIDTH as WIDTH_P, HEIGHT as HEIGHT_P,
} from "../src/games-pong.mjs";
import {
  TANK, TARGET as TANK_TARGET, drive as driveTank, isWall as isYardWall, lineOfSight, quarterTurn, stepToward,
  WIDTH as WIDTH_T, HEIGHT as HEIGHT_T,
} from "../src/games-tank.mjs";
import {
  SPYHUNTER, CAR_ROW, CAR_W, TRAFFIC, nextRow, onRoad, openRoad, overlaps,
  WIDTH as SH_WIDTH, HEIGHT as SH_HEIGHT,
} from "../src/games-spyhunter.mjs";
import {
  CENTIPEDE, ZONE_TOP, bite, cadence as centCadence, newCentipede, spiderStep, walk,
  WIDTH as C_WIDTH, HEIGHT as C_HEIGHT,
} from "../src/games-centipede.mjs";
import {
  FROGGER, BANK, HOMES, HOME_ROW, RIVER, ROAD, homeAt, thingAt, WIDTH as F_WIDTH,
} from "../src/games-frogger.mjs";
import {
  DIGDUG, SKY, fallRocks, isDug, pump, walkMonster,
  WIDTH as DD_WIDTH, HEIGHT as DD_HEIGHT,
} from "../src/games-digdug.mjs";
import {
  KONG, GIRDERS, LADDERS, TOP as TOP_K, FLOOR as FLOOR_K, newBarrel, rollBarrel, throwEvery,
  WIDTH as WIDTH_K, HEIGHT as HEIGHT_K,
} from "../src/games-kong.mjs";
import {
  PITFALL, RUNNER as PF_RUNNER, grab, span as pfSpan, spawn as spawnPitfall,
  WIDTH as PF_WIDTH, HEIGHT as PF_HEIGHT,
} from "../src/games-pitfall.mjs";
import {
  CHOPLIFTER, BASE, SEATS, WORLD, GROUND as GROUND_CH, onPad,
  WIDTH as CH_WIDTH, HEIGHT as CH_HEIGHT,
} from "../src/games-choplifter.mjs";
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

/* --------------------------------------------------------------- invaders */

/** Run a game's own tick, calling `act(state, i)` first. Used by all five below. */
function drive(game, state, ticks, act = () => {}) {
  for (let i = 0; i < ticks && !state.over; i++) {
    act(state, i);
    state = game.tick(state);
  }
  return state;
}

test("the fleet has room to come down before it lands", () => {
  // The bug this replaces: five ranks two rows apart made the fleet nine rows
  // tall on a board with eleven above the bunkers, so it "landed" after two
  // drops and no wave was ever survivable.
  const state = INVADERS.create({ rng: seeded(1) });
  const bottom = alienAt(state.fleet, ROWS - 1, 0).y;
  assert.ok(BUNKER_ROW - bottom >= 6, `only ${BUNKER_ROW - bottom} drops before the fleet lands`);
  assert.ok(bottom < BUNKER_ROW, "the fleet starts on top of the bunkers");
});

test("a shot takes the alien it reaches, and is worth that rank", () => {
  const state = INVADERS.create({ rng: seeded(2) });
  state.bunkers = new Map(); // your own cover eats your own shots; not this test
  const target = alienAt(state.fleet, ROWS - 1, 3);
  state.cannon = target.x;
  INVADERS.onKey(state, "space");
  const after = drive(INVADERS, state, 12, (s) => { s.bombs = []; });
  assert.equal(after.fleet.alive[ROWS - 1][3], false, "the alien should be gone");
  assert.equal(after.score, KINDS[ROWS - 1].points);
  assert.equal(after.shot, null, "and the shot is spent");
});

test("a shot moving two rows a tick cannot skip the rank it passes", () => {
  const state = INVADERS.create({ rng: seeded(3) });
  const alien = alienAt(state.fleet, ROWS - 1, 2);
  // Start the shot an odd number of rows below, so a naive two-row step lands
  // above the alien without ever standing on it.
  state.shot = { x: alien.x, y: alien.y + 3 };
  state.bombs = [];
  INVADERS.tick(state);
  INVADERS.tick(state);
  assert.equal(state.fleet.alive[ROWS - 1][2], false, "the shot went straight through it");
});

test("the fewer are left, the faster they come", () => {
  const state = INVADERS.create({ rng: seeded(4) });
  const full = cadence(state.fleet);
  for (let col = 0; col < COLS; col++) for (let row = 0; row < ROWS - 1; row++) state.fleet.alive[row][col] = false;
  for (let col = 1; col < COLS; col++) state.fleet.alive[ROWS - 1][col] = false;
  assert.equal(aliveCount(state.fleet), 1);
  assert.ok(cadence(state.fleet) < full, "the last one should be the fastest");
  assert.ok(cadence(state.fleet) >= 2, "but never faster than the clock");
});

test("the fleet turns round at the wall and drops a row", () => {
  const state = INVADERS.create({ rng: seeded(5) });
  state.bombs = [];
  const startY = state.fleet.y;
  const startDir = state.fleet.dir;
  let turns = 0;
  let was = startDir;
  drive(INVADERS, state, 600, (s) => { if (s.fleet.dir !== was) { turns++; was = s.fleet.dir; } });
  assert.ok(state.fleet.y > startY, "it should have come down a row");
  assert.ok(turns > 0, "and turned round to do it");
  assert.equal(state.fleet.y - startY, turns, "one row down per turn, no more");
});

test("a bunker takes two hits from either side, then it is gone", () => {
  const state = INVADERS.create({ rng: seeded(6) });
  const [x] = [...state.bunkers.keys()];
  assert.equal(chip(state.bunkers, x, BUNKER_ROW), true);
  assert.equal(state.bunkers.get(x), 1, "chipped, not gone");
  assert.equal(chip(state.bunkers, x, BUNKER_ROW), true);
  assert.equal(state.bunkers.has(x), false, "gone");
  assert.equal(chip(state.bunkers, x, BUNKER_ROW), false, "and nothing left to chip");
  assert.equal(chip(state.bunkers, x, BUNKER_ROW - 1), false, "bunkers are only on their own row");
});

test("a bomb takes a life, and the last one ends it", () => {
  const state = INVADERS.create({ rng: seeded(7) });
  state.bunkers = new Map();
  state.lives = 2;
  state.bombs = [{ x: state.cannon, y: CANNON_ROW - 1 }];
  drive(INVADERS, state, 6, (s) => { if (!s.bombs.length && !s.over) s.bombs = [{ x: s.cannon, y: CANNON_ROW - 1 }]; });
  assert.ok(state.lives < 2, "a bomb on your head should cost you");
  const last = drive(INVADERS, state, 40, (s) => { if (!s.bombs.length && !s.over) s.bombs = [{ x: s.cannon, y: CANNON_ROW - 1 }]; });
  assert.match(last.over, /out of cannons/);
});

test("clearing the fleet brings a new one, lower down", () => {
  const state = INVADERS.create({ rng: seeded(8) });
  for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) state.fleet.alive[row][col] = false;
  state.fleet.alive[0][0] = true;
  const at = alienAt(state.fleet, 0, 0);
  const startY = state.fleet.y;
  state.shot = { x: at.x, y: at.y + 2 };
  INVADERS.tick(state);
  assert.equal(state.wave, 2);
  assert.equal(aliveCount(state.fleet), ROWS * COLS, "a whole new fleet");
  assert.ok(state.fleet.y > startY, "and it starts closer to you");
});

test("one shot in the air at a time", () => {
  const state = INVADERS.create({ rng: seeded(9) });
  INVADERS.onKey(state, "space");
  const first = state.shot;
  INVADERS.onKey(state, "space");
  assert.equal(state.shot, first, "the second press should do nothing");
});

test("the fleet cannot out-march somebody aiming at it", () => {
  // A player who picks the nearest alien on the front line and stays on it
  // until it is dead. It does not dodge a single bomb, which is exactly why the
  // interesting result below is *how* it dies.
  const aiming = (state) => {
    const front = frontLine(state.fleet);
    if (!front.length) return;
    if (!state.aim || !state.fleet.alive[state.aim.row]?.[state.aim.col]) {
      state.aim = front.slice().sort((a, b) => (
        Math.abs(alienAt(state.fleet, a.row, a.col).x - state.cannon)
        - Math.abs(alienAt(state.fleet, b.row, b.col).x - state.cannon)
      ))[0];
    }
    const want = alienAt(state.fleet, state.aim.row, state.aim.col).x;
    if (state.cannon < want) INVADERS.onKey(state, "right");
    else if (state.cannon > want) INVADERS.onKey(state, "left");
    else INVADERS.onKey(state, "space");
  };

  let cleared = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const state = drive(INVADERS, INVADERS.create({ rng: seeded(seed) }), 3000, aiming);
    // The regression that matters: every one of these runs ends with the bombs
    // getting you, never with the fleet walking over you. When the ranks were
    // spaced two rows apart the fleet landed on every seed instead, and no
    // amount of shooting could stop it.
    assert.match(state.over ?? "", /out of cannons/, `seed ${seed} ended: ${state.over}`);
    assert.ok(state.score >= 500, `seed ${seed} only managed ${state.score} of a 720-point wave`);
    if (state.wave > 1) cleared++;
  }
  assert.ok(cleared >= 4, `only ${cleared} of 8 waves fell to somebody aiming`);

  for (let seed = 1; seed <= 8; seed++) {
    const idle = drive(INVADERS, INVADERS.create({ rng: seeded(seed) }), 2500);
    assert.ok(idle.over, `seed ${seed} survived without firing a shot`);
  }
});

test("the invaders board is drawn to size", () => {
  const state = drive(INVADERS, INVADERS.create({ rng: seeded(10) }), 120);
  const rows = INVADERS.render(state);
  assert.equal(rows.length, I_HEIGHT);
  for (const row of rows) assert.equal(visible(row), I_WIDTH);
});

/* -------------------------------------------------------------- centipede */

test("a shot to the middle leaves a mushroom and two centipedes", () => {
  const state = CENTIPEDE.create({ rng: seeded(1) });
  state.field = new Map();
  state.centipede = newCentipede(6);
  const middle = state.centipede[3];
  state.shots = [{ x: middle.x, y: middle.y + 1 }];
  CENTIPEDE.tick(state);
  assert.equal(state.centipede.length, 5, "the segment is gone");
  assert.equal(state.centipede.includes(middle), false);
  assert.ok(state.field.size >= 1, "and it left a mushroom where it fell");
  assert.equal(state.score >= 10, true);
  // The pieces either side carry on independently, which is what splitting is.
  const before = state.centipede.map((s) => s.x);
  for (let i = 0; i < 20; i++) CENTIPEDE.tick(state);
  assert.notDeepEqual(state.centipede.map((s) => s.x), before, "both halves should still be walking");
});

test("a mushroom takes four hits", () => {
  const field = new Map();
  field.set("5,5", 4);
  assert.equal(bite(field, 5, 5), 1);
  assert.equal(bite(field, 5, 5), 1);
  assert.equal(bite(field, 5, 5), 1);
  assert.equal(bite(field, 5, 5), 5, "the last hit is the one worth points");
  assert.equal(field.has("5,5"), false);
  assert.equal(bite(field, 5, 5), 0, "and nothing is left to shoot");
});

test("it turns and drops at a wall, at a mushroom, and off the floor", () => {
  const state = CENTIPEDE.create({ rng: seeded(2) });
  state.field = new Map();
  const seg = { x: C_WIDTH - 1, y: 3, dir: 1, down: 1 };
  walk(state, seg);
  assert.deepEqual([seg.x, seg.y, seg.dir], [C_WIDTH - 1, 4, -1], "the wall turns it and drops it");

  state.field.set(`${seg.x - 1},${seg.y}`, 4);
  walk(state, seg);
  assert.equal(seg.y, 5, "a mushroom does the same thing a wall does");

  const floor = { x: 5, y: C_HEIGHT - 1, dir: 1, down: 1 };
  state.field = new Map([[`6,${C_HEIGHT - 1}`, 4]]);
  walk(state, floor);
  assert.equal(floor.down, -1, "off the floor it starts climbing back up");
});

test("you are confined to the bottom strip", () => {
  const state = CENTIPEDE.create({ rng: seeded(3) });
  state.field = new Map();
  for (let i = 0; i < 20; i++) CENTIPEDE.onKey(state, "up");
  assert.equal(state.player.y, ZONE_TOP, "the strip is as far up as you go");
  for (let i = 0; i < 60; i++) CENTIPEDE.onKey(state, "left");
  assert.equal(state.player.x, 0);
});

test("a segment that reaches you costs a life, and the last one ends it", () => {
  const state = CENTIPEDE.create({ rng: seeded(4) });
  state.field = new Map();
  state.lives = 1;
  state.centipede = [{ x: state.player.x - 1, y: state.player.y, dir: 1, down: 1 }];
  state.clock = 99;
  CENTIPEDE.tick(state);
  assert.match(state.over, /eaten/);
});

test("clearing it brings a faster wave", () => {
  const state = CENTIPEDE.create({ rng: seeded(5) });
  const slow = centCadence(state);
  state.centipede = [];
  CENTIPEDE.tick(state);
  assert.equal(state.wave, 2);
  assert.equal(state.centipede.length, 10, "a whole new one");
  assert.ok(centCadence(state) < slow, "and it comes down quicker");
});

test("the spider crosses your strip, eats what it walks over, and leaves", () => {
  const state = CENTIPEDE.create({ rng: seeded(7) });
  state.spider = { x: 0, y: C_HEIGHT - 2, dx: 1, dy: 1 };
  state.field.set(`1,${C_HEIGHT - 1}`, 4);
  spiderStep(state);
  assert.equal(state.field.has(`1,${C_HEIGHT - 1}`), false, "a mushroom it walks over is gone whole");
  for (let i = 0; i < C_WIDTH + 2; i++) spiderStep(state);
  assert.equal(state.spider, null, "and it walks out the far side rather than living there");

  const shot = CENTIPEDE.create({ rng: seeded(8) });
  shot.field = new Map();
  shot.spider = { x: 10, y: C_HEIGHT - 2, dx: 1, dy: 1 };
  shot.shots = [{ x: 10, y: C_HEIGHT - 1 }];
  CENTIPEDE.tick(shot);
  assert.equal(shot.spider, null);
  assert.equal(shot.score, 300, "and it is the best thing on the board to shoot");
});

test("the centipede board is drawn to size", () => {
  const state = CENTIPEDE.create({ rng: seeded(6) });
  for (let i = 0; i < 80; i++) CENTIPEDE.tick(state);
  const rows = CENTIPEDE.render(state);
  assert.equal(rows.length, C_HEIGHT);
  for (const row of rows) assert.equal(visible(row), C_WIDTH);
});

test("centipede can be cleared by shooting, and not by standing there", () => {
  // Chase the nearest segment's column and keep firing.
  const shooting = (state) => {
    const near = state.centipede.slice().sort((a, b) => (
      Math.abs(a.x - state.player.x) - Math.abs(b.x - state.player.x)))[0];
    if (!near) return;
    if (state.player.x < near.x) CENTIPEDE.onKey(state, "right");
    else if (state.player.x > near.x) CENTIPEDE.onKey(state, "left");
    CENTIPEDE.onKey(state, "space");
  };
  let cleared = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const state = drive(CENTIPEDE, CENTIPEDE.create({ rng: seeded(seed) }), 2000, shooting);
    if (state.wave > 1) cleared++;
  }
  assert.ok(cleared >= 5, `only ${cleared} of 6 waves fell to somebody shooting`);
  for (let seed = 1; seed <= 6; seed++) {
    const idle = drive(CENTIPEDE, CENTIPEDE.create({ rng: seeded(seed) }), 3000);
    assert.ok(idle.over, `seed ${seed} survived without firing`);
  }
});

/* ----------------------------------------------------------------- digdug */

test("moving is digging, and the tunnel is wherever you have been", () => {
  const state = DIGDUG.create({ rng: seeded(1) });
  const { x, y } = state.player;
  assert.equal(isDug(state.ground, x, y), true, "you start in a hole of your own");
  assert.equal(isDug(state.ground, x, y + 1), false, "and everything under you is solid");
  DIGDUG.onKey(state, "down");
  assert.equal(isDug(state.ground, x, y + 1), true, "one step down is one cell dug");
  assert.equal(state.player.dir, "down", "and you are facing the way you dug");
});

test("the harpoon only travels down a tunnel", () => {
  const state = DIGDUG.create({ rng: seeded(2) });
  state.monsters = [{ x: state.player.x + 3, y: state.player.y, dir: "left", pumped: 0, ghost: 0 }];
  state.player.dir = "right";
  pump(state);
  assert.equal(state.harpoon, null, "three cells of solid ground stops it");

  for (let i = 1; i <= 3; i++) state.ground.delete(`${state.player.x + i},${state.player.y}`);
  pump(state);
  assert.ok(state.harpoon, "dug out, it reaches");
  assert.equal(state.monsters[0].pumped, 1);
});

test("three pumps pops a monster, and moving lets it go", () => {
  const state = DIGDUG.create({ rng: seeded(3) });
  const monster = { x: state.player.x + 1, y: state.player.y, dir: "left", pumped: 0, ghost: 0 };
  state.monsters = [monster];
  state.ground.delete(`${monster.x},${monster.y}`);
  state.player.dir = "right";
  pump(state);
  assert.equal(monster.pumped, 1);
  pump(state);
  pump(state);
  assert.equal(state.monsters.length, 0, "the third pump is the last one");
  assert.ok(state.score >= 300);

  const let_go = DIGDUG.create({ rng: seeded(4) });
  const other = { x: let_go.player.x + 1, y: let_go.player.y, dir: "left", pumped: 0, ghost: 0 };
  let_go.monsters = [other];
  let_go.ground.delete(`${other.x},${other.y}`);
  let_go.player.dir = "right";
  pump(let_go);
  DIGDUG.onKey(let_go, "left");
  assert.equal(let_go.harpoon, null, "walking away drops the harpoon");
});

test("a hooked monster stops moving", () => {
  const state = DIGDUG.create({ rng: seeded(5) });
  const monster = { x: state.player.x + 1, y: state.player.y, dir: "left", pumped: 2, ghost: 0 };
  state.monsters = [monster];
  const at = { x: monster.x, y: monster.y };
  for (let i = 0; i < 30; i++) walkMonster(state, monster);
  assert.deepEqual({ x: monster.x, y: monster.y }, at, "being pumped is being pinned");
});

test("a rock with nothing under it falls, and lands on what is below", () => {
  const state = DIGDUG.create({ rng: seeded(6) });
  state.monsters = [];
  const rock = { x: 10, y: SKY + 2, falling: false };
  state.rocks = [rock];
  state.ground.delete(`10,${SKY + 3}`);
  state.monsters = [{ x: 10, y: SKY + 3, dir: "left", pumped: 0, ghost: 0 }];
  fallRocks(state);
  assert.equal(rock.y, SKY + 3, "it came down a row");
  assert.equal(state.monsters.length, 0, "onto the monster underneath");
  assert.ok(state.score >= 200);
});

test("the digdug board is drawn to size", () => {
  const state = drive(DIGDUG, DIGDUG.create({ rng: seeded(7) }), 100);
  const rows = DIGDUG.render(state);
  assert.equal(rows.length, DD_HEIGHT);
  for (const row of rows) assert.equal(visible(row), DD_WIDTH);
});

test("a level can be dug out, and standing still is not a plan", () => {
  const hunting = (state) => {
    const near = state.monsters.slice().sort((a, b) => (
      Math.abs(a.x - state.player.x) + Math.abs(a.y - state.player.y)
      - Math.abs(b.x - state.player.x) - Math.abs(b.y - state.player.y)))[0];
    if (!near) return;
    const dx = near.x - state.player.x;
    const dy = near.y - state.player.y;
    const facing = { left: dx < 0 && dy === 0, right: dx > 0 && dy === 0, up: dy < 0 && dx === 0, down: dy > 0 && dx === 0 };
    const lined = (dx === 0 || dy === 0) && Math.abs(dx) + Math.abs(dy) <= 5;
    if (state.harpoon || (lined && facing[state.player.dir])) DIGDUG.onKey(state, "space");
    else if (Math.abs(dx) > Math.abs(dy)) DIGDUG.onKey(state, dx > 0 ? "right" : "left");
    else DIGDUG.onKey(state, dy > 0 ? "down" : "up");
  };
  let cleared = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const state = drive(DIGDUG, DIGDUG.create({ rng: seeded(seed) }), 4000, hunting);
    if (state.level > 1) cleared++;
  }
  assert.ok(cleared >= 3, `only ${cleared} of 6 levels were dug out`);
  for (let seed = 1; seed <= 6; seed++) {
    const idle = drive(DIGDUG, DIGDUG.create({ rng: seeded(seed) }), 3000);
    assert.ok(idle.over, `seed ${seed} survived standing in its hole`);
  }
});

/* ------------------------------------------------------------------- kong */

test("every girder has a way off it, and the ladders line up with the girders", () => {
  for (const [i, girder] of GIRDERS.entries()) {
    if (i === GIRDERS.length - 1) {
      assert.equal(girder.ladder, null, "the floor has nowhere further down");
      continue;
    }
    const down = LADDERS.filter((l) => l.top === girder.y);
    assert.equal(down.length, 2, `girder ${girder.y} should have a barrel ladder and one of yours`);
    for (const ladder of down) assert.equal(ladder.bottom, GIRDERS[i + 1].y, "a ladder must reach the next girder");
    assert.equal(down.filter((l) => l.barrels).length, 1, "and only one of them is the barrel chute");
  }
  // The two directions alternate, which is what makes you walk into the barrels
  // rather than after them.
  for (let i = 1; i < GIRDERS.length; i++) {
    assert.notEqual(GIRDERS[i].dir, GIRDERS[i - 1].dir, "girders should alternate");
  }
});

test("a barrel crosses a girder and takes the chute down", () => {
  const state = KONG.create({ rng: () => 0 }); // always takes the ladder
  const barrel = newBarrel();
  state.barrels = [barrel];
  const top = GIRDERS[0];
  // Roll until it has both crossed the girder and finished coming down.
  for (let i = 0; i < WIDTH_K * 3 && (barrel.y === top.y || barrel.falling !== null); i++) {
    rollBarrel(state, barrel);
  }
  assert.equal(barrel.y, GIRDERS[1].y, "it should have come down to the next girder");
  assert.equal(barrel.x, top.ladder, "down the chute, not off the end");
});

test("a barrel that misses the chute rolls off the world", () => {
  const state = KONG.create({ rng: () => 0.99 }); // never takes the ladder
  const barrel = newBarrel();
  state.barrels = [barrel];
  for (let i = 0; i < WIDTH_K * 2 && !barrel.done; i++) rollBarrel(state, barrel);
  assert.equal(barrel.done, true);
});

test("ladders are the only way up, and only from on one", () => {
  const state = KONG.create({ rng: seeded(1) });
  const start = state.player.y;
  KONG.onKey(state, "up");
  assert.equal(state.player.y, start, "you cannot climb thin air");
  const ladder = LADDERS.find((l) => l.bottom === start);
  state.player.x = ladder.x;
  KONG.onKey(state, "up");
  assert.equal(state.player.y, start - 1, "on a ladder you can");
  for (let i = 0; i < 10; i++) KONG.onKey(state, "up");
  assert.equal(state.player.y, ladder.top, "and it stops at the girder above");
});

test("a barrel flattens you unless you are over it", () => {
  const flat = KONG.create({ rng: seeded(2) });
  flat.barrels = [{ x: flat.player.x, y: flat.player.y, falling: null }];
  KONG.tick(flat);
  assert.equal(flat.lives, 2);

  const jumped = KONG.create({ rng: seeded(2) });
  jumped.barrels = [{ x: jumped.player.x, y: jumped.player.y, falling: null }];
  KONG.onKey(jumped, "space");
  KONG.tick(jumped);
  assert.equal(jumped.lives, 3, "in the air it goes under you");
  assert.equal(jumped.score, 100, "and it is worth something");
});

test("reaching the top is the next level, and faster", () => {
  const state = KONG.create({ rng: seeded(3) });
  const slow = throwEvery(state);
  state.player = { x: WIDTH_K - 6, y: TOP_K, jump: 0 };
  KONG.tick(state);
  assert.equal(state.level, 2);
  assert.ok(state.score >= 1000);
  assert.equal(state.player.y, FLOOR_K, "and you start again at the bottom");
  assert.ok(throwEvery(state) < slow, "with barrels coming quicker");
});

test("the climb can be made, and cannot be made by standing at the bottom", () => {
  const climbing = (state, i) => {
    if (i % 2) return;
    const p = state.player;
    const near = state.barrels.find((b) => b.y === p.y && Math.abs(b.x - p.x) <= 2);
    if (near && !p.jump) { KONG.onKey(state, "space"); return; }
    if (p.y === TOP_K) { KONG.onKey(state, "right"); return; }
    if (!GIRDERS.some((g) => g.y === p.y)) { KONG.onKey(state, "up"); return; }
    // Climb the ladder the barrels do not come down.
    const up = LADDERS.filter((l) => l.bottom === p.y).sort((a, b) => a.barrels - b.barrels)[0];
    if (!up) return;
    if (p.x === up.x) KONG.onKey(state, "up");
    else KONG.onKey(state, up.x > p.x ? "right" : "left");
  };
  const climbed = drive(KONG, KONG.create({ rng: seeded(1) }), 4000, climbing);
  assert.ok(climbed.level > 3, `only got to level ${climbed.level}`);
  for (let seed = 1; seed <= 5; seed++) {
    // A barrel has to cross four girders to reach the floor, so this takes a
    // while — but it always arrives.
    const idle = drive(KONG, KONG.create({ rng: seeded(seed) }), 3000);
    assert.ok(idle.over, `seed ${seed} survived at the bottom of the board`);
  }
});

test("the kong board is drawn to size", () => {
  const state = drive(KONG, KONG.create({ rng: seeded(4) }), 200);
  const rows = KONG.render(state);
  assert.equal(rows.length, HEIGHT_K);
  for (const row of rows) assert.equal(visible(row), WIDTH_K);
});

/* ---------------------------------------------------------------- frogger */

test("the road kills what it touches and the river kills what it does not", () => {
  const flat = FROGGER.create();
  flat.frog = { x: 0, row: ROAD[0], drift: null };
  flat.traffic = [{ row: ROAD[0], x: 0, len: 2, kind: "car" }];
  FROGGER.tick(flat);
  assert.equal(flat.lives, 2, "a car you are standing on is a car that got you");

  const wet = FROGGER.create();
  wet.frog = { x: 0, row: RIVER[0], drift: 0 };
  wet.traffic = [];
  FROGGER.tick(wet);
  assert.equal(wet.lives, 2, "and empty water is just as fatal");

  const dry = FROGGER.create();
  dry.frog = { x: 2, row: RIVER[0], drift: 2 };
  dry.traffic = [{ row: RIVER[0], x: 0, len: 6, kind: "log" }];
  FROGGER.tick(dry);
  assert.equal(dry.lives, 3, "a log is dry land");
});

test("a log carries you, including off the end of the world", () => {
  const state = FROGGER.create();
  state.traffic = [{ row: RIVER[0], x: 10, len: 6, kind: "log" }];
  state.frog = { x: 12, row: RIVER[0], drift: 12 };
  const before = state.frog.x;
  for (let i = 0; i < 20; i++) FROGGER.tick(state);
  assert.notEqual(state.frog.x, before, "the river should have moved you");

  const edge = FROGGER.create();
  edge.traffic = [{ row: RIVER[0], x: F_WIDTH - 4, len: 6, kind: "log" }];
  edge.frog = { x: F_WIDTH - 1, row: RIVER[0], drift: F_WIDTH - 1 };
  for (let i = 0; i < 40 && edge.lives === 3; i++) FROGGER.tick(edge);
  assert.equal(edge.lives, 2, "riding it off the edge still loses the frog");
});

test("a home is a home, and the bank between them is not", () => {
  const state = FROGGER.create();
  state.frog = { x: HOMES[0], row: HOME_ROW + 1, drift: null };
  state.traffic = [];
  FROGGER.onKey(state, "up");
  assert.equal(state.homes[0], true);
  assert.ok(state.score >= 100);
  assert.equal(state.frog.row, BANK, "and you start again from the bank");

  const missed = FROGGER.create();
  missed.frog = { x: HOMES[0] + HOMES.length, row: HOME_ROW + 1, drift: null };
  missed.traffic = [];
  FROGGER.onKey(missed, "up");
  assert.equal(missed.lives, 2, "landing between the homes is a loss");

  const taken = FROGGER.create();
  taken.homes[1] = true;
  taken.frog = { x: HOMES[1], row: HOME_ROW + 1, drift: null };
  taken.traffic = [];
  FROGGER.onKey(taken, "up");
  assert.equal(taken.lives, 2, "and so is one you have already filled");
});

test("five frogs home is the next level", () => {
  const state = FROGGER.create();
  state.traffic = [];
  for (const home of HOMES) {
    state.frog = { x: home, row: HOME_ROW + 1, drift: null };
    FROGGER.onKey(state, "up");
  }
  assert.equal(state.level, 2);
  assert.deepEqual(state.homes, HOMES.map(() => false), "and five empty homes again");
});

test("the lanes run on for ever", () => {
  const state = FROGGER.create();
  state.frog = { x: 0, row: BANK, drift: null }; // out of the way on the bank
  for (let i = 0; i < 2000; i++) FROGGER.tick(state);
  for (const thing of state.traffic) {
    assert.ok(thing.x > -thing.len - 3 && thing.x < F_WIDTH + 3, `a ${thing.kind} escaped to ${thing.x}`);
  }
});

test("hopping forwards pays, hopping back and forth does not", () => {
  const state = FROGGER.create();
  state.traffic = [];
  FROGGER.onKey(state, "up");
  const forward = state.score;
  assert.ok(forward > 0);
  FROGGER.onKey(state, "down");
  FROGGER.onKey(state, "left");
  assert.equal(state.score, forward, "only forwards is progress");
});

test("a frog can be got home, and not by hopping blind", () => {
  // Wait for a gap in the lane ahead, then hop. That is the entire game.
  const patient = (state) => {
    const next = state.frog.row - 1;
    if (next === HOME_ROW) {
      if (homeAt(state.frog.x) >= 0 && !state.homes[homeAt(state.frog.x)]) FROGGER.onKey(state, "up");
      else FROGGER.onKey(state, state.frog.x < HOMES[0] ? "right" : "left");
      return;
    }
    const blocked = ROAD.includes(next) && thingAt(state.traffic, next, state.frog.x);
    const wet = RIVER.includes(next) && !thingAt(state.traffic, next, state.frog.x);
    if (!blocked && !wet) FROGGER.onKey(state, "up");
  };
  const state = drive(FROGGER, FROGGER.create(), 4000, patient);
  assert.ok(state.homes.filter(Boolean).length > 0 || state.level > 1, "nobody got home at all");
  assert.ok(state.score >= 100, `only scored ${state.score}`);

  const blind = drive(FROGGER, FROGGER.create(), 400, (s) => FROGGER.onKey(s, "up"));
  assert.ok(blind.over, "hopping without looking should not survive");
});

/* --------------------------------------------------------------- breakout */

test("a brick is hit exactly where it is drawn", () => {
  const wall = buildWall();
  assert.equal(bricksLeft(wall), BRICK_ROWS * BRICK_COLS);
  for (let i = 0; i < BRICK_W; i++) {
    assert.deepEqual(brickAt(wall, i, BRICK_TOP), { row: 0, col: 0 }, "the whole width of a brick is that brick");
  }
  assert.deepEqual(brickAt(wall, BRICK_W, BRICK_TOP), { row: 0, col: 1 });
  assert.equal(brickAt(wall, 0, BRICK_TOP - 1), null, "nothing above the wall");
  assert.equal(brickAt(wall, 0, BRICK_TOP + BRICK_ROWS), null, "nothing below it");
});

test("a brick breaks, pays its row, and turns the ball around", () => {
  const state = BREAKOUT.create({ rng: seeded(1) });
  state.stuck = false;
  state.ball = { x: 2, y: BRICK_TOP + BRICK_ROWS - 0.4, vx: 0.1, vy: -0.4 };
  BREAKOUT.tick(state);
  assert.equal(bricksLeft(state.wall), BRICK_ROWS * BRICK_COLS - 1);
  assert.equal(state.score, ROW_POINTS[BRICK_ROWS - 1], "the bottom row is the cheap one");
  assert.ok(state.ball.vy > 0, "and the ball comes back down");
});

test("the last brick starts the next level with a fresh wall", () => {
  const state = BREAKOUT.create({ rng: seeded(2) });
  state.wall = state.wall.map((row) => row.map(() => false));
  state.wall[0][0] = true;
  state.stuck = false;
  state.ball = { x: 1, y: BRICK_TOP + 0.6, vx: 0, vy: -0.5 };
  BREAKOUT.tick(state);
  assert.equal(state.level, 2);
  assert.equal(bricksLeft(state.wall), BRICK_ROWS * BRICK_COLS, "a whole new wall");
  assert.equal(state.stuck, true, "and the ball is back on the paddle");
  assert.ok(state.pace > 1, "faster than the last one");
});

test("the paddle is a steering wheel, not a wall", () => {
  const middle = (vx) => {
    const state = BREAKOUT.create({ rng: seeded(3) });
    state.stuck = false;
    state.paddle = 10;
    state.ball = { x: 10 + (PADDLE_W - 1) / 2, y: PADDLE_ROW - 1.2, vx, vy: 0.4 };
    BREAKOUT.tick(state);
    return state.ball.vx;
  };
  const edge = () => {
    const state = BREAKOUT.create({ rng: seeded(3) });
    state.stuck = false;
    state.paddle = 10;
    state.ball = { x: 10 + PADDLE_W - 1, y: PADDLE_ROW - 1.2, vx: 0.3, vy: 0.4 };
    BREAKOUT.tick(state);
    return state.ball.vx;
  };
  assert.ok(edge() > middle(0.3), "taking it off the end should send it wider");
});

test("missing the ball costs a life, and the third ends it", () => {
  const state = BREAKOUT.create({ rng: seeded(4) });
  state.stuck = false;
  state.paddle = 0;
  state.ball = { x: WIDTH_B - 1, y: PADDLE_ROW, vx: 0, vy: 0.5 };
  BREAKOUT.tick(state);
  assert.equal(state.lives, 2);
  assert.equal(state.stuck, true, "and the next ball waits on the paddle");

  state.lives = 1;
  state.stuck = false;
  state.ball = { x: WIDTH_B - 1, y: PADDLE_ROW, vx: 0, vy: 0.5 };
  BREAKOUT.tick(state);
  assert.match(state.over, /out of balls/);
});

test("the ball rides the paddle until it is launched", () => {
  const state = BREAKOUT.create({ rng: seeded(5) });
  BREAKOUT.onKey(state, "left");
  BREAKOUT.tick(state);
  assert.equal(state.ball.x, state.paddle + PADDLE_W / 2, "aiming the serve is done with the paddle");
  BREAKOUT.onKey(state, "space");
  assert.equal(state.stuck, false);
  assert.ok(state.ball.vy < 0, "and it goes up");
});

test("a wall can be cleared, and cannot be cleared by leaving the paddle alone", () => {
  const tracking = (state) => {
    if (state.stuck) BREAKOUT.onKey(state, "space");
    const want = Math.round(state.ball.x) - Math.floor(PADDLE_W / 2);
    if (want < state.paddle) BREAKOUT.onKey(state, "left");
    else if (want > state.paddle) BREAKOUT.onKey(state, "right");
  };
  for (let seed = 1; seed <= 5; seed++) {
    const state = drive(BREAKOUT, BREAKOUT.create({ rng: seeded(seed) }), 6000, tracking);
    assert.ok(state.level > 1, `seed ${seed} never cleared a wall`);
  }
  for (let seed = 1; seed <= 5; seed++) {
    const state = drive(BREAKOUT, BREAKOUT.create({ rng: seeded(seed) }), 3000, (s) => {
      if (s.stuck) BREAKOUT.onKey(s, "space");
    });
    assert.ok(state.over, `seed ${seed} survived without touching the paddle`);
  }
});

test("the breakout board is drawn to size", () => {
  const state = drive(BREAKOUT, BREAKOUT.create({ rng: seeded(6) }), 60, (s) => {
    if (s.stuck) BREAKOUT.onKey(s, "space");
  });
  const rows = BREAKOUT.render(state);
  assert.equal(rows.length, HEIGHT_B);
  for (const row of rows) assert.equal(visible(row), WIDTH_B);
});

/* ------------------------------------------------------------------- pong */

test("a serve is never dead flat", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const state = PONG.create({ rng: seeded(seed) });
    assert.ok(Math.abs(state.ball.vy) > 0.1, "a flat serve is a rally nobody can lose");
    assert.ok(Math.abs(state.ball.vx) > 0);
  }
});

test("the ball stays on the table", () => {
  const state = PONG.create({ rng: seeded(2) });
  const seen = drive(PONG, state, 4000, (s) => {
    assert.ok(s.ball.y >= -0.5 && s.ball.y <= HEIGHT_P - 0.5, `ball left the table at ${s.ball.y}`);
  });
  assert.ok(seen.yours + seen.theirs > 0, "somebody should have scored by now");
});

test("where it hits the paddle is where it goes", () => {
  const bounce = (at) => {
    const state = PONG.create({ rng: seeded(3) });
    state.you = 5;
    state.ball = { x: YOU_COL + 0.4, y: at, vx: -0.9, vy: 0 };
    PONG.tick(state);
    return state.ball.vy;
  };
  assert.ok(bounce(5) < 0, "off the top of the paddle sends it up");
  assert.ok(bounce(8) > 0, "off the bottom sends it down");
  assert.ok(Math.abs(bounce(6.5)) > 0, "and never dead flat, even off the middle");
});

test("a ball past the paddle is a point, and seven of them is the match", () => {
  const state = PONG.create({ rng: seeded(4) });
  state.you = 0;
  state.ball = { x: 0.5, y: HEIGHT_P - 1, vx: -1, vy: 0 };
  PONG.tick(state);
  assert.equal(state.theirs, 1, "missing it should cost a point");

  state.theirs = PONG_TARGET - 1;
  state.you = 0;
  state.ball = { x: 0.5, y: HEIGHT_P - 1, vx: -1, vy: 0 };
  PONG.tick(state);
  assert.match(state.over, /the machine takes it/);
});

test("the machine can be beaten, but not by doing nothing", () => {
  const tracking = (state) => {
    const want = state.ball.y - (PADDLE - 1) / 2;
    if (want < state.you - 0.5) PONG.onKey(state, "up");
    else if (want > state.you + 0.5) PONG.onKey(state, "down");
  };
  for (let seed = 1; seed <= 6; seed++) {
    const won = drive(PONG, PONG.create({ rng: seeded(seed) }), 30000, tracking);
    assert.match(won.over ?? "", /you take it/, `seed ${seed}: ${won.yours}–${won.theirs}`);
    const lost = drive(PONG, PONG.create({ rng: seeded(seed) }), 30000);
    assert.match(lost.over ?? "", /machine takes it/, "a still paddle should lose");
  }
});

test("the pong table is drawn to size", () => {
  const rows = PONG.render(drive(PONG, PONG.create({ rng: seeded(7) }), 50));
  assert.equal(rows.length, HEIGHT_P);
  for (const row of rows) assert.equal(visible(row), WIDTH_P);
});

/* ------------------------------------------------------------------- tank */

test("the yard is closed on every side", () => {
  for (let x = 0; x < WIDTH_T; x++) {
    assert.ok(isYardWall(x, 0) && isYardWall(x, HEIGHT_T - 1), `the yard leaks at column ${x}`);
  }
  for (let y = 0; y < HEIGHT_T; y++) {
    assert.ok(isYardWall(0, y) && isYardWall(WIDTH_T - 1, y), `the yard leaks at row ${y}`);
  }
  assert.equal(isYardWall(-1, 5), true, "and anything off the board is wall");
});

test("a tank cannot drive through a wall", () => {
  const tank = { x: 1, y: 1, dir: 0, cool: 0 };  // pointed at the top wall
  assert.equal(driveTank(tank, 1), false);
  assert.deepEqual([tank.x, tank.y], [1, 1], "and it does not move a bit");
  tank.dir = 1;
  assert.equal(driveTank(tank, 1), true);
  assert.equal(tank.x, 2);
});

test("a shell only carries down an open lane", () => {
  const state = TANK.create();
  // Both tanks start on the same row with the yard's furniture between them.
  assert.equal(lineOfSight({ x: 1, y: 1, dir: 1 }, { x: 20, y: 1 }), true, "the top lane is open");
  assert.equal(lineOfSight(state.you, state.them), false, "and the middle is not");
  assert.equal(lineOfSight({ x: 1, y: 1, dir: 2 }, { x: 20, y: 1 }), false, "nor is a target you are not facing");
});

test("the machine finds its way round a block rather than into it", () => {
  // The bug this replaces: "turn towards the enemy, then drive" grinds into the
  // same wall for ever, and the two tanks never met at all.
  const first = stepToward({ x: 2, y: 6 }, { x: 39, y: 6 });
  assert.ok(first, "there should be a way across the yard");
  assert.notEqual(first.dir, 1, "and it is not straight through the block in front");

  const state = drive(TANK, TANK.create(), 4000);
  assert.ok(state.theirs > 0 || state.over, "the machine should have come and found you");
});

test("a hit scores, resets both tanks, and five of them is the match", () => {
  const state = TANK.create();
  state.shells = [{ x: state.them.x - 1, y: state.them.y, dir: 1, owner: "you" }];
  TANK.tick(state);
  assert.equal(state.yours, 1);
  assert.equal(state.shells.length, 0, "the shell is spent");
  assert.deepEqual([state.you.x, state.you.y], [2, 6], "and both tanks go back to their corners");

  state.yours = TANK_TARGET - 1;
  state.shells = [{ x: state.them.x - 1, y: state.them.y, dir: 1, owner: "you" }];
  TANK.tick(state);
  assert.match(state.over, /you take it/);
});

test("one shell each in the air", () => {
  const state = TANK.create();
  state.you.dir = 0; // up the open lane, so the shell survives the first tick
  TANK.onKey(state, "space");
  assert.equal(state.shells.length, 1);
  TANK.onKey(state, "space");
  assert.equal(state.shells.length, 1, "the second press should do nothing");
});

test("the machine takes a sitting duck, and loses to somebody playing", () => {
  const hunting = (state, i) => {
    if (i % 3) return;
    if (lineOfSight(state.you, state.them)) { TANK.onKey(state, "space"); return; }
    const next = stepToward(state.you, state.them);
    if (!next) return;
    if (state.you.dir !== next.dir) {
      TANK.onKey(state, quarterTurn(state.you.dir, next.dir) === (state.you.dir + 1) % 4 ? "right" : "left");
    } else TANK.onKey(state, "up");
  };
  assert.match(drive(TANK, TANK.create(), 30000, hunting).over ?? "", /you take it/);
  assert.match(drive(TANK, TANK.create(), 30000).over ?? "", /machine takes it/);
});

test("the yard is drawn to size", () => {
  const rows = TANK.render(drive(TANK, TANK.create(), 100));
  assert.equal(rows.length, HEIGHT_T);
  for (const row of rows) assert.equal(visible(row), WIDTH_T);
});

/* -------------------------------------------------------------- spyhunter */

test("the road always has a verge on both sides, and a width you can drive", () => {
  let row = openRoad()[0];
  const rng = seeded(3);
  const centres = [];
  for (let i = 0; i < 4000; i++) {
    row = nextRow(row, rng);
    assert.ok(row.left >= 1, `the road ran off the left at ${row.left}`);
    assert.ok(row.right <= SH_WIDTH - 2, `the road ran off the right at ${row.right}`);
    const width = row.right - row.left;
    assert.ok(width >= 12 && width <= 25, `a road ${width} wide is not a road`);
    centres.push((row.left + row.right) / 2);
  }
  // Pulled back towards the middle rather than parked against an edge — a plain
  // random walk fails this every time.
  const mean = centres.reduce((a, b) => a + b, 0) / centres.length;
  assert.ok(Math.abs(mean - SH_WIDTH / 2) < 3, `the road lives at ${mean.toFixed(1)}, not the middle`);
});

test("the verge costs a life, and so does the traffic", () => {
  const off = SPYHUNTER.create({ rng: seeded(1) });
  off.car = 0;                       // hard against the left edge, off the tarmac
  off.road = off.road.map(() => ({ left: 10, right: 28 }));
  SPYHUNTER.tick(off);
  assert.equal(off.lives, 2, "the verge should have cost a life");
  assert.equal(off.grace > 0, true, "and the road ahead is cleared for a moment");

  const ram = SPYHUNTER.create({ rng: seeded(2) });
  ram.traffic = [{ kind: "civilian", x: ram.car, y: CAR_ROW, speed: 0.2 }];
  SPYHUNTER.tick(ram);
  assert.equal(ram.lives, 2);
  assert.match(SPYHUNTER.status(ram), /▲▲/);
});

test("shooting the wrong car costs more than not shooting at all", () => {
  const shoot = (kind) => {
    const state = SPYHUNTER.create({ rng: seeded(4) });
    state.score = 500;
    state.grace = 999; // this test is about the gun, not the bumper
    state.traffic = [{ kind, x: state.car, y: CAR_ROW - 4, speed: 0.2 }];
    // A tick moves the shot up 1.6 rows, so it starts below where they meet.
    state.shots = [{ x: state.car + 0.5, y: CAR_ROW - 2.5 }];
    SPYHUNTER.tick(state);
    assert.equal(state.traffic.length, 0, `the ${kind} should have been hit`);
    return state.score - 500;
  };
  assert.equal(shoot("enemy"), TRAFFIC.enemy.points);
  assert.equal(shoot("civilian"), TRAFFIC.civilian.points);
});

test("a wreck does not drop you back onto the car that got you", () => {
  const state = SPYHUNTER.create({ rng: seeded(5) });
  state.traffic = [
    { kind: "enemy", x: state.car, y: CAR_ROW, speed: 0.2 },
    { kind: "enemy", x: state.car, y: CAR_ROW - 2, speed: 0.2 },
  ];
  SPYHUNTER.tick(state);
  assert.equal(state.traffic.length, 0, "the road is cleared");
  assert.ok(onRoad(state.road[CAR_ROW], state.car), "and you are put back on the tarmac");
});

test("the road can be driven, and cannot be driven hands-off", () => {
  const steering = (state) => {
    const ahead = state.traffic.filter((c) => c.y > CAR_ROW - 7 && c.y <= CAR_ROW);
    // Hold the dodge until the car is properly past, rather than steering back
    // to the middle the moment the bumpers no longer touch — recentring early
    // just drives you back into it.
    const blocking = ahead.find((c) => Math.abs(c.x - state.car) <= 3);
    const row = state.road[CAR_ROW];
    let want = Math.round((row.left + row.right) / 2) - 1;
    if (blocking) want = blocking.x > state.car ? state.car - 4 : state.car + 4;
    want = Math.max(row.left, Math.min(row.right - CAR_W + 1, want));
    if (state.car < want) SPYHUNTER.onKey(state, "right");
    else if (state.car > want) SPYHUNTER.onKey(state, "left");
    const enemy = ahead.find((c) => c.kind === "enemy" && overlaps(c.x, state.car));
    const civil = ahead.find((c) => c.kind === "civilian" && overlaps(c.x, state.car) && c.y > (enemy?.y ?? -99));
    if (enemy && !civil) SPYHUNTER.onKey(state, "space");
  };
  for (let seed = 1; seed <= 6; seed++) {
    const driven = drive(SPYHUNTER, SPYHUNTER.create({ rng: seeded(seed) }), 700, steering);
    assert.equal(driven.over, null, `seed ${seed} could not be driven 700 ticks: ${driven.over}`);
    assert.ok(driven.miles > 10, `seed ${seed} only covered ${driven.miles} miles`);
    const drifted = drive(SPYHUNTER, SPYHUNTER.create({ rng: seeded(seed) }), 1500);
    assert.ok(drifted.over, `seed ${seed} survived with nobody steering`);
  }
});

test("the road is drawn to size", () => {
  const state = drive(SPYHUNTER, SPYHUNTER.create({ rng: seeded(8) }), 200);
  const rows = SPYHUNTER.render(state);
  assert.equal(rows.length, SH_HEIGHT);
  for (const row of rows) assert.equal(visible(row), SH_WIDTH);
});

/* ---------------------------------------------------------------- pitfall */

test("a jump clears a log and a pit needs the vine", () => {
  const jumped = PITFALL.create({ rng: seeded(1) });
  jumped.next = 1e9;
  jumped.things = [{ kind: "log", x: PF_RUNNER + 2 }];
  PITFALL.onKey(jumped, "space");
  const overLog = drive(PITFALL, jumped, 12);
  assert.equal(overLog.over, null, "a jump should cover a two-wide log");

  // A pit is five wide, which is more than a jump covers. That is on purpose.
  const short = PITFALL.create({ rng: seeded(2) });
  short.next = 1e9;
  short.things = [{ kind: "pit", x: PF_RUNNER + 2 }];
  PITFALL.onKey(short, "space");
  const fell = drive(PITFALL, short, 20);
  assert.equal(fell.lives, 2, "jumping a pit is how you find out how deep it is");
});

test("a vine is only there to be caught, and only from the ground", () => {
  const state = PITFALL.create({ rng: seeded(3) });
  state.next = 1e9;
  state.things = [{ kind: "vine", x: PF_RUNNER }];
  PITFALL.tick(state);
  assert.equal(state.lives, 3, "walking under one costs nothing");

  grab(state);
  assert.equal(state.swinging, true);
  assert.ok(state.air > 0);

  const airborne = PITFALL.create({ rng: seeded(4) });
  airborne.next = 1e9;
  airborne.things = [{ kind: "vine", x: PF_RUNNER }];
  PITFALL.onKey(airborne, "space");
  grab(airborne);
  assert.equal(airborne.swinging, false, "you cannot catch one mid-jump");
});

test("a swing carries you over a whole pit", () => {
  const state = PITFALL.create({ rng: seeded(5) });
  state.next = 1e9;
  // The spawner always hangs the vine three columns ahead of the pit it covers.
  state.things = [{ kind: "vine", x: PF_RUNNER }, { kind: "pit", x: PF_RUNNER + 3 }];
  grab(state);
  const crossed = drive(PITFALL, state, 30);
  assert.equal(crossed.lives, 3, "the swing should have carried you the whole way");
});

test("every pit the jungle throws has a vine over it", () => {
  const state = PITFALL.create({ rng: seeded(6) });
  for (let i = 0; i < 400; i++) spawnPitfall(state);
  const pits = state.things.filter((t) => t.kind === "pit");
  const vines = state.things.filter((t) => t.kind === "vine");
  assert.ok(pits.length > 0, "the spawner never made a pit");
  assert.equal(vines.length, pits.length, "a pit with no vine is a pit nobody gets past");
});

test("gold is picked up on foot, and a fall costs you daylight", () => {
  const state = PITFALL.create({ rng: seeded(7) });
  state.next = 1e9;
  // A tick scrolls the jungle first, so put it one column further out.
  state.things = [{ kind: "treasure", x: PF_RUNNER + 1 }];
  PITFALL.tick(state);
  assert.equal(state.treasure, 1);
  assert.ok(state.score >= 500);

  const fell = PITFALL.create({ rng: seeded(8) });
  fell.next = 1e9;
  fell.clock = 500;
  fell.things = [{ kind: "scorpion", x: PF_RUNNER + 1 }];
  PITFALL.tick(fell);
  assert.equal(fell.lives, 2);
  assert.ok(fell.clock < 500, "and it puts the sun down faster");
});

test("the jungle can be run, and cannot be run standing up", () => {
  const running = (state) => {
    const vine = state.things.find((t) => t.kind === "vine" && Math.abs(Math.round(t.x) - PF_RUNNER) <= 1);
    const soon = state.things.find((t) => {
      if (t.kind === "vine" || t.kind === "treasure" || t.kind === "pit") return false;
      const lead = pfSpan(t)[0] - PF_RUNNER;
      return lead >= 1 && lead <= 3;
    });
    if (vine) PITFALL.onKey(state, "up");
    else if (soon) PITFALL.onKey(state, "space");
  };
  for (let seed = 1; seed <= 6; seed++) {
    const state = drive(PITFALL, PITFALL.create({ rng: seeded(seed) }), 3000, running);
    // Somebody who jumps and swings at the right moments is only ever beaten by
    // the clock, never by the jungle.
    assert.match(state.over ?? "", /out of daylight/, `seed ${seed} ended: ${state.over}`);
    assert.ok(state.treasure > 3, `seed ${seed} only found ${state.treasure} gold`);
  }
  for (let seed = 1; seed <= 6; seed++) {
    const idle = drive(PITFALL, PITFALL.create({ rng: seeded(seed) }), 800);
    assert.ok(idle.over, `seed ${seed} walked the jungle without jumping once`);
  }
});

test("the pitfall board is drawn to size", () => {
  const state = drive(PITFALL, PITFALL.create({ rng: seeded(9) }), 150);
  const rows = PITFALL.render(state);
  assert.equal(rows.length, PF_HEIGHT);
  for (const row of rows) assert.equal(visible(row), PF_WIDTH);
});

/* ------------------------------------------------------------- choplifter */

test("the world is wider than the window, and the camera follows you", () => {
  const state = CHOPLIFTER.create({ rng: seeded(1) });
  assert.ok(WORLD > CH_WIDTH * 2, "a rescue you can see all of is not a rescue");
  const home = strip(CHOPLIFTER.render(state).join("\n"));
  state.chopper.x = WORLD - 10;
  const away = strip(CHOPLIFTER.render(state).join("\n"));
  assert.notEqual(home, away, "flying to the far end should show a different place");
});

test("landing in the desert fills the back, four at a time", () => {
  const state = CHOPLIFTER.create({ rng: seeded(2) });
  state.tanks = [];
  state.people = Array.from({ length: 6 }, (_, i) => ({ x: 60 + i * 0.4 }));
  state.chopper = { x: 60, y: GROUND_CH, vy: 0 };
  CHOPLIFTER.tick(state);
  assert.equal(state.aboard, SEATS, "it holds four and no more");
  assert.equal(state.people.length, 2, "and leaves the rest waving");
});

test("the pad is the only place they get out", () => {
  const desert = CHOPLIFTER.create({ rng: seeded(3) });
  desert.tanks = [];
  desert.people = [];
  desert.aboard = 3;
  desert.chopper = { x: 80, y: GROUND_CH, vy: 0 };
  CHOPLIFTER.tick(desert);
  assert.equal(desert.home, 0, "putting them down in the desert is not a rescue");

  const pad = CHOPLIFTER.create({ rng: seeded(3) });
  pad.tanks = [];
  pad.aboard = 3;
  pad.chopper = { x: BASE + 2, y: GROUND_CH, vy: 0 };
  CHOPLIFTER.tick(pad);
  assert.equal(pad.home, 3);
  assert.equal(pad.aboard, 0);
  assert.ok(onPad(BASE + 2) && !onPad(80));
});

test("a hit costs everybody in the back", () => {
  const state = CHOPLIFTER.create({ rng: seeded(4) });
  state.tanks = [];
  state.aboard = 4;
  state.chopper = { x: 60, y: 5, vy: 0 };
  state.shells = [{ x: 60, y: 5, vy: -0.55 }];
  CHOPLIFTER.tick(state);
  assert.equal(state.lives, 2);
  assert.equal(state.aboard, 0, "they were in the back");
  assert.equal(state.home, 0);
});

test("a tank only shoots at what is overhead", () => {
  const far = CHOPLIFTER.create({ rng: seeded(5) });
  far.people = [];
  far.tanks = [{ x: 100, dir: 1 }];
  far.chopper = { x: 10, y: 4, vy: 0 };
  drive(CHOPLIFTER, far, 200);
  assert.equal(far.shells.length, 0, "it should not shell the far end of the map");

  const over = CHOPLIFTER.create({ rng: seeded(6) });
  over.people = [{ x: 100 }];
  over.tanks = [{ x: 100, dir: 1 }];
  over.chopper = { x: 100, y: 3, vy: 0 };
  let seen = 0;
  drive(CHOPLIFTER, over, 200, (s) => { seen = Math.max(seen, s.shells.length); s.chopper.y = 3; });
  assert.ok(seen > 0, "and it should very much shell what is above it");
});

test("everyone out is the end of it", () => {
  const state = CHOPLIFTER.create({ rng: seeded(7) });
  state.tanks = [];
  state.people = [];
  state.aboard = 0;
  CHOPLIFTER.tick(state);
  assert.match(state.over, /everyone out/);
});

test("a pilot can fly the rescue, and a parked one rescues nobody", () => {
  const flying = (state) => {
    const chop = state.chopper;
    const full = state.aboard >= SEATS || (!state.people.length && state.aboard);
    const target = full ? BASE + 2 : (state.people[0]?.x ?? BASE + 2);
    const dx = target - chop.x;
    if (Math.abs(dx) > 1.5) {
      CHOPLIFTER.onKey(state, dx > 0 ? "right" : "left");
      if (chop.y > GROUND_CH - 4) CHOPLIFTER.onKey(state, "up");
    } else if (chop.y < GROUND_CH) CHOPLIFTER.onKey(state, "down");
  };
  let rescued = 0;
  for (let seed = 1; seed <= 6; seed++) {
    rescued += drive(CHOPLIFTER, CHOPLIFTER.create({ rng: seeded(seed) }), 6000, flying).home;
  }
  assert.ok(rescued >= 20, `only ${rescued} people came home across six runs`);
  for (let seed = 1; seed <= 6; seed++) {
    const parked = drive(CHOPLIFTER, CHOPLIFTER.create({ rng: seeded(seed) }), 2000);
    assert.equal(parked.home, 0, "nobody walks home on their own");
  }
});

test("the choplifter board is drawn to size", () => {
  const state = drive(CHOPLIFTER, CHOPLIFTER.create({ rng: seeded(8) }), 200);
  const rows = CHOPLIFTER.render(state);
  assert.equal(rows.length, CH_HEIGHT);
  for (const row of rows) assert.equal(visible(row), CH_WIDTH);
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
