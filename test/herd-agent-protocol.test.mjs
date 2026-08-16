// The rest of PRD 0011: sessions that know their own name, blocked sub-kinds,
// the rules file that finally gets to complain, and fan-in.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sessionCommand, sessionEnv } from "../src/herd.mjs";
import {
  BLOCKED_KINDS, blockedKind, hookReport, inspectUserRules, parseState, reportState, rulesFor, sessionState,
} from "../src/herd-state.mjs";
import { EXIT, waitForMany } from "../src/herd-cli.mjs";
import { TOOLS } from "../src/tools.mjs";

function withHerdDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-0011-test-"));
  const previous = process.env.MOSHCODE_HERD_DIR;
  process.env.MOSHCODE_HERD_DIR = dir;
  try { return fn(dir); }
  finally {
    if (previous === undefined) delete process.env.MOSHCODE_HERD_DIR;
    else process.env.MOSHCODE_HERD_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------- R2: knowing your own name */

test("a session is told its own name and where the herd lives", () => {
  // A hook fires inside the engine's process tree and has to name the session
  // it is reporting for. Nothing else in that tree knows it.
  withHerdDir((dir) => {
    const env = sessionEnv("api");
    assert.equal(env.MOSHCODE_HERD_NAME, "api");
    assert.equal(env.MOSHCODE_HERD_DIR, dir, "a non-default herd dir would have its reports written elsewhere");
  });
});

test("the name is injected through the same env prefix both substrates share", () => {
  const command = sessionCommand({ bin: "claude", args: [], setEnv: sessionEnv("api") });
  // shQuote wraps every word, which is why these look for the quoted forms.
  assert.match(command, /env .*'MOSHCODE_HERD_NAME=api'/);
  assert.match(command, /'claude'$/);
});

test("setting a variable and unsetting one compose in one prefix", () => {
  // `env -e` is a tmux 3.2+ flag the pty substrate has no equivalent for, and
  // an inherited ANTHROPIC_API_KEY still has to be *removed* rather than blanked.
  const command = sessionCommand({ bin: "claude", stripEnv: ["ANTHROPIC_API_KEY"], setEnv: sessionEnv("api") });
  assert.match(command, /'-u' 'ANTHROPIC_API_KEY'/);
  assert.match(command, /'MOSHCODE_HERD_NAME=api'/);
});

test("a session with nothing to set or unset gets no env wrapper at all", () => {
  assert.equal(sessionCommand({ bin: "sh", args: [], exec: false }), "'sh'");
});

/* --------------------------------------------------- R4: what it is blocked on */

test("a state token can carry the kind of blocked it means", () => {
  assert.deepEqual(parseState("blocked:menu"), { state: "blocked", kind: "menu" });
  assert.deepEqual(parseState("working"), { state: "working" });
  assert.equal(parseState("done:menu"), null, "only blocked has sub-kinds");
  assert.equal(parseState("blocked:whatever"), null);
  assert.equal(parseState("nonsense"), null);
});

test("a reported sub-kind survives the round trip", () => {
  withHerdDir(() => {
    assert.equal(reportState("api", "blocked:permission").ok, true);
    assert.equal(hookReport("api").kind, "permission");
    const state = sessionState({ name: "api", engine: "claude", alive: true, exited: false });
    assert.deepEqual(state, { state: "blocked", authority: "hook", blockedOn: "permission" });
  });
});

test("a numbered menu is a menu, and a y/n is a permission", () => {
  // The distinction the notification uses: a menu wants a digit and a
  // permission wants a letter, and answering one with the other types prose
  // into a selector.
  assert.equal(blockedKind("Do you want to proceed?\n❯ 1. Yes\n  2. No"), "menu");
  assert.equal(blockedKind("Overwrite the file? [y/N]"), "permission");
  assert.equal(blockedKind("Which environment should I deploy to?"), "question");
  assert.equal(blockedKind("nothing prompt-shaped here"), null);
  for (const kind of BLOCKED_KINDS) assert.ok(typeof kind === "string");
});

test("the sub-kind is absent rather than undefined when there is not one", () => {
  // This object is spread over every roster row. An always-present key for the
  // benefit of none is a new key on every row.
  withHerdDir(() => {
    const state = sessionState({ name: "api", engine: "claude", alive: true, exited: false }, { read: () => "esc to interrupt" });
    assert.deepEqual(state, { state: "working", authority: "screen" });
    assert.equal("blockedOn" in state, false);
  });
});

test("the sub-kind never overwrites the row's own kind", () => {
  // `kind` on a roster row says local-or-remote. Naming the sub-kind `kind` too
  // would have a blocked local session claiming to be a URL.
  withHerdDir(() => {
    const state = sessionState({ name: "api", engine: "claude", alive: true, exited: false, kind: "local" },
      { read: () => "Do you want to proceed?\n❯ 1. Yes" });
    assert.equal(state.blockedOn, "menu");
    assert.equal(state.kind, undefined, "sessionState must not return a `kind` key at all");
  });
});

/* ---------------------------------------------------- R3: the rules file talks */

test("a rules file that is not JSON is named, not silently ignored", () => {
  // loadUserRules() swallows this by design and must keep doing so. The cost
  // is a file quietly ignored since someone typo'd a bracket, and doctor is
  // where that gets to be loud.
  withHerdDir((dir) => {
    const file = path.join(dir, "rules.json");
    fs.writeFileSync(file, "{ nope");
    const report = inspectUserRules(file);
    assert.equal(report.ok, false);
    assert.match(report.problems[0].error, /not valid JSON/);
  });
});

test("a pattern that will not compile is named with its engine and state", () => {
  withHerdDir((dir) => {
    const file = path.join(dir, "rules.json");
    fs.writeFileSync(file, JSON.stringify({ codex: { blocked: ["fine", "a(b"] } }));
    const report = inspectUserRules(file);
    assert.equal(report.ok, false);
    assert.equal(report.patterns, 1);
    assert.equal(report.problems[0].where, "codex.blocked");
    assert.equal(report.problems[0].pattern, "a(b");
  });
});

test("a state the classifier does not read is a problem worth saying", () => {
  withHerdDir((dir) => {
    const file = path.join(dir, "rules.json");
    fs.writeFileSync(file, JSON.stringify({ codex: { blocekd: ["typo"] } }));
    assert.match(inspectUserRules(file).problems[0].error, /not a state the classifier reads/);
  });
});

test("no rules file at all is not a problem", () => {
  withHerdDir((dir) => {
    const report = inspectUserRules(path.join(dir, "rules.json"));
    assert.equal(report.present, false);
    assert.equal(report.ok, true);
  });
});

/* ------------------------------------------------- R15: a tool in the herd */

test("a workflow tool's screen rules are found the same way an engine's are", () => {
  // `herd run -- gradient agent run --dev` names its session after the binary,
  // and the workflow CLIs are exactly what people put in the herd next to an
  // agent.
  const rules = rulesFor("gradient", { userRules: {} });
  assert.ok(rules.idle.some((re) => re.test("INFO:     Uvicorn running on http://127.0.0.1:8000")));
  assert.ok(TOOLS.gradient.state, "the rules live beside the install spec");
});

test("a served request leaves the ADK dev server idle, not stuck working", () => {
  // uvicorn writes its access line when a request has FINISHED. A rule that
  // read it as `working` would pin the tile there until it scrolled away —
  // exactly the rot this PRD is trying to get away from.
  const rules = rulesFor("gradient", { userRules: {} });
  const served = 'INFO:     127.0.0.1:51234 - "POST /run HTTP/1.1" 200 OK';
  assert.ok(rules.idle.some((re) => re.test(served)));
  assert.equal(rules.working.some((re) => re.test(served)), false);
});

test("gradient owns its own runtime rather than moshcode growing a Python", () => {
  assert.match(TOOLS.gradient.install.args.join(" "), /python3/);
  assert.match(TOOLS.gradient.install.args.join(" "), /3, 10/, "the version requirement is checked, not assumed");
  assert.ok(TOOLS.gradient.installHelp, "a missing Python has to name the fix");
});

/* ------------------------------------------------------------ R8: fan-in */

test("--any returns on the first member to arrive", async () => {
  const states = { api: "working", web: "working" };
  const observe = async (name) => ({ name, present: true, alive: true, state: states[name] });
  setTimeout(() => { states.web = "blocked"; }, 5);
  const result = await waitForMany(["api", "web"], ["blocked"], {
    mode: "any", intervalMs: 1, nap: (ms) => new Promise((r) => setTimeout(r, ms)), observe,
  });
  assert.equal(result.outcome, "matched");
  assert.equal(result.winner, "web");
});

test("--all returns only when every one of them has", async () => {
  const states = { api: "working", web: "blocked" };
  const observe = async (name) => ({ name, present: true, alive: true, state: states[name] });
  setTimeout(() => { states.api = "blocked"; }, 5);
  const result = await waitForMany(["api", "web"], ["blocked"], {
    mode: "all", intervalMs: 1, nap: (ms) => new Promise((r) => setTimeout(r, ms)), observe,
  });
  assert.equal(result.outcome, "matched");
  assert.equal(result.results.length, 2);
});

test("a member that ends without getting there ends the --all wait honestly", async () => {
  const observe = async (name) => ({ name, present: true, alive: name !== "web", state: name === "web" ? "done" : "working" });
  const result = await waitForMany(["api", "web"], ["blocked"], {
    mode: "all", timeoutMs: 5, intervalMs: 1, nap: (ms) => new Promise((r) => setTimeout(r, ms)), observe,
  });
  assert.notEqual(result.outcome, "matched");
  assert.ok(result.results.some((r) => r.name === "web" && r.outcome === "ended"));
});

test("a fan-in that times out says which members it was still waiting on", async () => {
  const observe = async (name) => ({ name, present: true, alive: true, state: "working" });
  const result = await waitForMany(["api", "web"], ["blocked"], {
    mode: "any", timeoutMs: 3, intervalMs: 1, nap: (ms) => new Promise((r) => setTimeout(r, ms)), observe,
  });
  assert.equal(result.outcome, "timeout");
  assert.deepEqual(result.pending, ["api", "web"]);
});

test("a member that does not exist is gone, not waited on forever", async () => {
  const observe = async (name) => ({ name, present: false });
  const result = await waitForMany(["nobody"], ["blocked"], { mode: "any", intervalMs: 1, observe });
  assert.equal(result.results[0].outcome, "gone");
});

/* ------------------------------------------------------------- exit codes */

test("eval's outcomes have codes of their own", () => {
  // 0 pass, 4 below the threshold, 5 the harness could not run.
  assert.equal(EXIT.matched, 0);
  assert.equal(EXIT.below, 4);
  assert.equal(EXIT.infra, 5);
  assert.equal(new Set(Object.values(EXIT)).size, Object.values(EXIT).length, "two outcomes share a code");
});
