// Semantic state: what the classifier reads, what it refuses to guess, and the
// one-authority-per-session rule that keeps a hook and a screen rule from
// disagreeing in public.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  classify, clearReport, COMMON_RULES, hookReport, HOOK_TTL_MS, loadUserRules,
  reportState, rulesFor, sessionState, STATES, stripAnsi, withState,
} from "../src/herd-state.mjs";

function withHerdDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-state-test-"));
  const previous = process.env.MOSHCODE_HERD_DIR;
  process.env.MOSHCODE_HERD_DIR = dir;
  try { return fn(dir); }
  finally {
    if (previous === undefined) delete process.env.MOSHCODE_HERD_DIR;
    else process.env.MOSHCODE_HERD_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const live = (extra = {}) => ({ name: "s", engine: "claude", alive: true, exited: false, ...extra });

/* ------------------------------------------------------------------- ANSI */

test("escape sequences are stripped before anything is matched", () => {
  // tmux hands back plain text, but the pty substrate's transcript is the raw
  // stream. A rule like /do you want to/ misses when the engine coloured half
  // the sentence.
  const coloured = "\x1b[1;32mDo you want\x1b[0m to proceed?";
  assert.match(stripAnsi(coloured), /^Do you want to proceed\?$/);
});

test("an OSC title sequence does not eat the rest of the screen", () => {
  const screen = "\x1b]0;claude — api\x07Do you want to proceed?";
  assert.match(stripAnsi(screen), /Do you want to proceed\?/);
});

/* --------------------------------------------------------------- classify */

test("a trailing y/n prompt reads as blocked", () => {
  const rules = rulesFor("codex", { userRules: {} });
  assert.equal(classify("running tests…\nOverwrite config? [y/N]", rules), "blocked");
});

test("a numbered selector reads as blocked, whichever glyph the engine draws", () => {
  // Both of these are screens real engines actually put up: Claude Code's
  // first-run theme picker and Codex's directory-trust prompt. They disagree
  // about the cursor character, which is why the rule takes a set.
  const claude = "Choose the text style\n\n   1. Auto\n ❯ 2. Dark mode\n   3. Light mode";
  assert.equal(classify(claude, rulesFor("claude", { userRules: {} })), "blocked");
  const codex = "Do you trust the contents of this directory?\n\n› 1. Yes, continue\n  2. No, quit";
  assert.equal(classify(codex, rulesFor("codex", { userRules: {} })), "blocked");
});

test("blocked beats working when both markers are on screen", () => {
  // An engine that stops to ask regularly still has the "esc to interrupt"
  // hint from the work it was doing a moment ago. Reporting `working` there is
  // the one mistake that costs the user something.
  const screen = "thinking… (esc to interrupt)\nDo you want to proceed?";
  assert.equal(classify(screen, rulesFor("claude", { userRules: {} })), "blocked");
});

test("only the bottom of the screen decides", () => {
  // Scrollback is full of sentences that look like prompts. An agent that
  // answered a question thirty lines ago and moved on is not blocked.
  const screen = ["Do you want to proceed?", ...Array(40).fill("writing file…")].join("\n");
  assert.equal(classify(screen, rulesFor("claude", { userRules: {} })), "unknown");
});

test("a shell sitting at its prompt is idle", () => {
  // Without this a couple of shells in the herd read `unknown` forever, which
  // is the state you get when nobody has written a rule — useless on a roster
  // whose whole job is telling you what is going on.
  for (const prompt of ["$ ", "% ", "# ", "❯ ", "➜  ~/src/api "]) {
    const screen = `some earlier output\n[me@dev] ~/src/api\n${prompt}`;
    assert.equal(classify(screen, rulesFor("shell", { userRules: {} })), "idle", `prompt ${JSON.stringify(prompt)}`);
  }
});

test("a shell running something is not idle just because a $ appeared earlier", () => {
  // The prompt rule is anchored to the end of the capture on purpose: a dollar
  // sign in the middle of output is a dollar sign, not an invitation.
  const screen = "$ npm run build\n> building the bundle\ncompiling modules";
  assert.equal(classify(screen, rulesFor("shell", { userRules: {} })), "unknown");
});

test("a quiet screen nobody wrote a rule for is unknown, not idle", () => {
  // R8. A confident wrong answer is worse than an honest absent one, because
  // `unknown` sends you to look and `idle` tells you not to bother.
  assert.equal(classify("some ordinary build output\ndone in 3.4s", rulesFor("codex", { userRules: {} })), "unknown");
});

test("an empty screen is unknown", () => {
  assert.equal(classify("", rulesFor("claude", { userRules: {} })), "unknown");
  assert.equal(classify("   \n  \n", rulesFor("claude", { userRules: {} })), "unknown");
});

test("prose about approvals is not a blocked agent", () => {
  // The rules match terminal-shaped questions, not words. An agent writing
  // about an approvals feature must not page anyone.
  const screen = "I've added the approve button and the Approve endpoint to the router.\nNext I'll wire the tests.";
  assert.equal(classify(screen, rulesFor("codex", { userRules: {} })), "unknown");
});

test("every shared pattern is anchored to something a terminal draws", () => {
  // A rule that matches a bare English word will fire on agent output. Each
  // one has to carry punctuation, a bracket, or a line anchor.
  for (const [state, patterns] of Object.entries(COMMON_RULES)) {
    for (const re of patterns) {
      assert.match(re.source, /[[\]()\\^$?]/, `${state} rule ${re} is too loose to be safe`);
    }
  }
});

/* ---------------------------------------------------------------- authority */

test("a fresh hook report wins and the screen is not consulted", () => {
  withHerdDir(() => {
    reportState("s", "working");
    let read = 0;
    const state = sessionState(live(), { read: () => { read++; return "Do you want to proceed?"; } });
    assert.equal(state.state, "working");
    assert.equal(state.authority, "hook");
    // Two sources of truth is the failure herdr calls out: a roster flickering
    // between a hook and a rule is worse than one that commits.
    assert.equal(read, 0, "the screen must not be read when a hook has authority");
  });
});

test("an expired hook report hands authority back to the screen", () => {
  withHerdDir(() => {
    reportState("s", "working", { now: Date.now() - HOOK_TTL_MS - 1000 });
    const state = sessionState(live(), { read: () => "Do you want to proceed?" });
    assert.equal(state.state, "blocked");
    assert.equal(state.authority, "screen", "a crashed agent must not read `working` forever");
  });
});

test("a hook cannot claim authority beyond the cap", () => {
  withHerdDir(() => {
    reportState("s", "working", { ttl: 10 * 365 * 24 * 3600 * 1000 });
    const raw = JSON.parse(fs.readFileSync(path.join(process.env.MOSHCODE_HERD_DIR, "status", "s.json"), "utf8"));
    assert.ok(raw.ttl <= HOOK_TTL_MS, "an unbounded ttl would strand a dead session");
  });
});

test("a hook report is written owner-only", () => {
  withHerdDir((dir) => {
    reportState("s", "blocked");
    assert.equal(fs.statSync(path.join(dir, "status", "s.json")).mode & 0o777, 0o600);
  });
});

test("only real states can be reported", () => {
  withHerdDir(() => {
    assert.equal(reportState("s", "confused").ok, false);
    assert.equal(hookReport("s"), null);
    for (const state of STATES) assert.equal(reportState("s", state).ok, true);
  });
});

test("clearing a report gives the screen its vote back", () => {
  withHerdDir(() => {
    reportState("s", "working");
    clearReport("s");
    assert.equal(sessionState(live(), { read: () => "Do you want to proceed?" }).state, "blocked");
  });
});

/* -------------------------------------------------------------- the runtime */

test("a finished process is done, whatever is on its screen", () => {
  withHerdDir(() => {
    // The one thing the runtime knows for certain, so no rule gets a vote.
    const state = sessionState(live({ exited: true }), { read: () => "Do you want to proceed?" });
    assert.deepEqual(state, { state: "done", authority: "runtime" });
  });
});

test("a session the runtime no longer has is gone, not unknown", () => {
  withHerdDir(() => {
    // `gone` is what `restore` reads; collapsing it into `unknown` would lose
    // the difference between "I can't tell" and "the box rebooted".
    assert.deepEqual(sessionState({ name: "s", alive: false }), { state: "gone", authority: "runtime" });
  });
});

/* --------------------------------------------------------------- overrides */

test("a user rule can fix a rotted pattern without a release", () => {
  withHerdDir((dir) => {
    fs.writeFileSync(path.join(dir, "rules.json"), JSON.stringify({ codex: { blocked: ["shall i continue"] } }));
    const rules = rulesFor("codex", { userRules: loadUserRules(path.join(dir, "rules.json")) });
    assert.equal(classify("Shall I continue", rules), "blocked");
  });
});

test("one bad pattern loses that pattern, not the whole file", () => {
  withHerdDir((dir) => {
    const file = path.join(dir, "rules.json");
    fs.writeFileSync(file, JSON.stringify({ codex: { blocked: ["(unclosed", "shall i continue"] } }));
    const rules = rulesFor("codex", { userRules: loadUserRules(file) });
    assert.equal(classify("Shall I continue", rules), "blocked");
  });
});

test("a malformed rules file leaves the built-in rules working", () => {
  withHerdDir((dir) => {
    const file = path.join(dir, "rules.json");
    fs.writeFileSync(file, "not json at all");
    assert.deepEqual(loadUserRules(file), {});
    assert.equal(classify("Overwrite? [y/N]", rulesFor("codex", { userRules: loadUserRules(file) })), "blocked");
  });
});

test("withState leaves the roster rows intact and adds to them", () => {
  withHerdDir(() => {
    const rows = withState([live({ name: "a", cwd: "/x" })], { read: () => "Do you want to proceed?" });
    assert.equal(rows[0].name, "a");
    assert.equal(rows[0].cwd, "/x", "the row must survive the annotation");
    assert.equal(rows[0].state, "blocked");
  });
});
