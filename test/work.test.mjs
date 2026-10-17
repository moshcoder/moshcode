// moshcode work (PRD 0021): the queue, the claim, the verifier, the inbox.
//
// A real git repository with a real failing test, the live shell and git, and
// a fake engine that edits files the way a coding engine would. Nothing here
// needs a model on the box.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as openfleet from "../src/openfleet.mjs";
import * as work from "../src/work.mjs";
import { workCommand } from "../src/work-cli.mjs";

const BROKEN = "export const add = (a, b) => a - b;\n";
const FIXED = "export const add = (a, b) => a + b;\n";
const TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { add } from "../src/add.mjs";
test("add", () => { assert.equal(add(2, 3), 5); });
`;
const PASSING = `import { test } from "node:test";
test("fine", () => {});
`;

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-work-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "test"));
  fs.writeFileSync(path.join(repo, "src/add.mjs"), BROKEN);
  fs.writeFileSync(path.join(repo, "test/add.test.mjs"), TEST);
  fs.writeFileSync(path.join(repo, "test/fine.test.mjs"), PASSING);
  fs.writeFileSync(path.join(repo, "package.json"), '{ "type": "module" }\n');
  const g = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  g("init", "-q");
  g("add", "-A");
  g("commit", "-qm", "init");
  const env = { ...process.env, MOSHCODE_WORK_DIR: path.join(root, "work"), OPENFLEET_HOME: path.join(root, "fleet") };
  // NODE_TEST_CONTEXT is set by the runner running this file: a nested
  // `node --test` that inherits it reports to us and exits 0 whatever happens.
  for (const k of ["OPENFLEET_RECORD", "OPENFLEET_FLEET", "OPENFLEET_MEMBER", "OPENFLEET_SWARM", "NODE_TEST_CONTEXT"]) delete env[k];
  return { root, repo, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** The live shell and git, with an engine that does `edit(cwd, prompt)`. */
function depsWith(env, edit, calls = []) {
  return {
    ...work.liveWorkDeps({ env }),
    engine: async (engine, prompt, { cwd, env: extra }) => {
      calls.push({ engine, prompt, cwd, env: extra });
      edit(cwd, prompt);
      return { code: 0, signal: null, stdout: "worked on it\nSUMMARY: changed add", stderr: "", error: null, timedOut: false };
    },
  };
}

const fixAdd = (cwd) => fs.writeFileSync(path.join(cwd, "src/add.mjs"), FIXED);
const doNothing = () => {};
const claude = () => "claude";
const VERIFY = "node --test test/add.test.mjs";

test("a task needs a verify command, and the same ask is one task", () => {
  const s = sandbox();
  try {
    const none = work.addTask("q", { prompt: "fix it", cwd: s.repo }, { env: s.env });
    assert.equal(none.ok, false);
    assert.match(none.error, /verify/);
    const a = work.addTask("q", { prompt: "fix it", verify: VERIFY, cwd: s.repo }, { env: s.env });
    const b = work.addTask("q", { prompt: "fix it", verify: VERIFY, cwd: s.repo }, { env: s.env });
    assert.equal(a.added, true);
    assert.equal(b.added, false);
    assert.equal(a.id, b.id);
    assert.equal(work.listTasks("q", "pending", s.env).length, 1);
  } finally { s.cleanup(); }
});

test("a queue name is a name, not a path", () => {
  assert.equal(work.validQueueName("fix-tests"), true);
  assert.equal(work.validQueueName("../etc"), false);
  assert.equal(work.validQueueName(""), false);
  assert.throws(() => work.queueDir("a/b"));
});

test("a claim is a rename: two workers never hold the same task", () => {
  const s = sandbox();
  try {
    for (const p of ["one", "two", "three"]) work.addTask("q", { prompt: p, verify: "true", cwd: s.repo }, { env: s.env });
    const got = [];
    for (let i = 0; i < 5; i++) {
      const t = work.claimTask("q", `w${i}`, { env: s.env });
      if (t) got.push(t.id);
    }
    assert.equal(got.length, 3);
    assert.equal(new Set(got).size, 3);
    assert.equal(work.listTasks("q", "claimed", s.env).length, 3);
    assert.equal(work.claimTask("q", "late", { env: s.env }), null);
  } finally { s.cleanup(); }
});

test("a claim whose worker died on this host goes back to the queue", () => {
  const s = sandbox();
  try {
    work.addTask("q", { prompt: "p", verify: "true", cwd: s.repo }, { env: s.env });
    work.claimTask("q", "w", { env: s.env, pid: 999999 });
    const back = work.recoverClaims("q", { env: s.env, alive: () => false });
    assert.equal(back.length, 1);
    assert.equal(work.listTasks("q", "pending", s.env).length, 1);
    assert.equal(work.listTasks("q", "pending", s.env)[0].claim, undefined);
  } finally { s.cleanup(); }
});

test("from-tests queues only the failing file, with its failure as the hint", async () => {
  const s = sandbox();
  try {
    const r = await work.queueFailingTests("q", { cwd: s.repo, env: s.env, deps: work.liveWorkDeps({ env: s.env }) });
    assert.equal(r.scanned, 2);
    assert.equal(r.failing, 1);
    const [task] = work.listTasks("q", "pending", s.env);
    assert.equal(task.verify, VERIFY);
    assert.match(task.title, /add\.test\.mjs/);
    assert.match(task.hint, /fail|Expected|5/i);
    assert.match(work.workerPrompt(task), /failed like this before anyone started/);
  } finally { s.cleanup(); }
});

test("a passing attempt keeps its patch, leaves the checkout alone, and removes its worktree", async () => {
  const s = sandbox();
  try {
    const { id } = work.addTask("q", { prompt: "make add add", verify: VERIFY, cwd: s.repo }, { env: s.env });
    const calls = [];
    const r = await work.runWork({ queue: "q", workers: 1 }, { env: s.env, deps: depsWith(s.env, fixAdd, calls), engineOf: claude });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.done, 1);
    assert.equal(calls.length, 1);
    // The engine worked in a worktree, not the checkout, and was told what done means.
    assert.notEqual(calls[0].cwd, s.repo);
    assert.match(calls[0].prompt, /node --test test\/add\.test\.mjs/);
    assert.equal(calls[0].env.MOSHCODE_WORK_TASK, id);
    assert.ok(calls[0].env.OPENFLEET_MEMBER.startsWith(r.swarm));
    assert.equal(fs.readFileSync(path.join(s.repo, "src/add.mjs"), "utf8"), BROKEN);
    assert.equal(fs.existsSync(calls[0].cwd), false, "the worktree is removed after a pass");

    const { state, task } = work.findTask("q", id, s.env);
    assert.equal(state, "done");
    assert.deepEqual(task.result.files, ["src/add.mjs"]);
    assert.match(fs.readFileSync(task.result.patch, "utf8"), /a \+ b/);
    assert.equal(task.attempts[0].summary, "changed add");
    assert.equal(task.attempts[0].verifyExit, 0);
  } finally { s.cleanup(); }
});

test("the run is an OpenFleet swarm: spawn, a start and an end with the verdict per attempt, one end", async () => {
  const s = sandbox();
  try {
    work.addTask("q", { prompt: "make add add", verify: VERIFY, cwd: s.repo }, { env: s.env });
    const r = await work.runWork({ queue: "q", workers: 2 }, { env: s.env, deps: depsWith(s.env, fixAdd), engineOf: claude });
    const lines = openfleet.readLedger(r.fleet, s.env).filter((l) => l.swarm === r.swarm || l.member?.startsWith(r.swarm));
    assert.deepEqual(lines.map((l) => l.event), ["swarm.spawn", "member.start", "member.end", "swarm.end"]);
    const end = lines.find((l) => l.event === "member.end");
    assert.equal(end.state, "done");
    assert.equal(end.verdict.passed, true);
    assert.equal(end.verdict.verify, VERIFY);
    assert.ok(openfleet.listRecords(r.fleet, s.env).some((rec) => rec.member === end.member));
  } finally { s.cleanup(); }
});

test("a failing attempt goes back with the verify output, then to the inbox with its worktree kept", async () => {
  const s = sandbox();
  try {
    const { id } = work.addTask("q", { prompt: "make add add", verify: VERIFY, cwd: s.repo, maxAttempts: 2 }, { env: s.env });
    const calls = [];
    const r = await work.runWork({ queue: "q", workers: 1 }, { env: s.env, deps: depsWith(s.env, doNothing, calls), engineOf: claude });
    assert.equal(r.ok, false);
    assert.equal(r.inbox, 1);
    assert.equal(r.retried, 1);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[0].prompt, /did not pass/);
    assert.match(calls[1].prompt, /Attempt 1 of 2 did not pass/);
    const { state, task } = work.findTask("q", id, s.env);
    assert.equal(state, "inbox");
    assert.match(task.inbox.reason, /failed verify 2 times/);
    assert.ok(fs.existsSync(task.inbox.tree), "the last worktree is kept for a person to look at");

    // retry: a fresh budget, history kept, the kept tree gone
    assert.deepEqual(work.retryTasks("q", [id], { env: s.env }), [id]);
    const again = work.findTask("q", id, s.env);
    assert.equal(again.state, "pending");
    assert.equal(again.task.attempts.length, 0);
    assert.equal(again.task.history.length, 2);
    assert.equal(fs.existsSync(task.inbox.tree), false);
  } finally { s.cleanup(); }
});

test("a task that already passes costs one verify and no engine", async () => {
  const s = sandbox();
  try {
    const { id } = work.addTask("q", { prompt: "keep it green", verify: "node --test test/fine.test.mjs", cwd: s.repo }, { env: s.env });
    const calls = [];
    const r = await work.runWork({ queue: "q" }, { env: s.env, deps: depsWith(s.env, fixAdd, calls), engineOf: claude });
    assert.equal(r.done, 1);
    assert.equal(r.attempts, 0);
    assert.equal(calls.length, 0);
    assert.equal(work.findTask("q", id, s.env).task.result.already, true);
  } finally { s.cleanup(); }
});

test("a setup that fails sends the task to the inbox without calling the engine", async () => {
  const s = sandbox();
  try {
    work.addTask("q", { prompt: "p", verify: VERIFY, cwd: s.repo }, { env: s.env });
    const calls = [];
    const r = await work.runWork({ queue: "q", setup: "exit 3" }, { env: s.env, deps: depsWith(s.env, fixAdd, calls), engineOf: claude });
    assert.equal(r.inbox, 1);
    assert.equal(calls.length, 0);
    assert.match(work.listTasks("q", "inbox", s.env)[0].inbox.reason, /setup failed \(exit 3\)/);
  } finally { s.cleanup(); }
});

test("many workers drain many tasks, each exactly once", async () => {
  const s = sandbox();
  try {
    for (let i = 0; i < 6; i++) work.addTask("q", { prompt: `fix add, take ${i}`, verify: VERIFY, cwd: s.repo }, { env: s.env });
    const calls = [];
    const r = await work.runWork({ queue: "q", workers: 4 }, { env: s.env, deps: depsWith(s.env, fixAdd, calls), engineOf: claude });
    assert.equal(r.done, 6, JSON.stringify(r.status));
    assert.equal(calls.length, 6);
    assert.equal(new Set(calls.map((c) => c.prompt)).size, 6);
    assert.equal(new Set(calls.map((c) => c.cwd)).size, 6, "a worktree per attempt");
    const status = work.queueStatus("q", { env: s.env });
    assert.deepEqual(status.counts, { pending: 0, claimed: 0, done: 6, inbox: 0 });
    assert.equal(status.passRate, 1);
  } finally { s.cleanup(); }
});

test("apply lands a patch once, and one that no longer applies goes to the inbox", async () => {
  const s = sandbox();
  try {
    const a = work.addTask("q", { prompt: "make add add", verify: VERIFY, cwd: s.repo }, { env: s.env });
    const b = work.addTask("q", { prompt: "make add add, differently", verify: VERIFY, cwd: s.repo }, { env: s.env });
    const writeOther = (cwd, prompt) => fs.writeFileSync(path.join(cwd, "src/add.mjs"), /differently/.test(prompt) ? "export const add = (a, b) => b + a;\n" : FIXED);
    await work.runWork({ queue: "q", workers: 2 }, { env: s.env, deps: depsWith(s.env, writeOther), engineOf: claude });
    const deps = work.liveWorkDeps({ env: s.env });
    const r = await work.applyPatches("q", { env: s.env, deps });
    assert.equal(r.applied.length, 1);
    assert.equal(r.conflicted.length, 1);
    assert.match(fs.readFileSync(path.join(s.repo, "src/add.mjs"), "utf8"), /\+/);
    const loser = [a.id, b.id].find((id) => r.conflicted.includes(id));
    assert.equal(work.findTask("q", loser, s.env).state, "inbox");
    const again = await work.applyPatches("q", { env: s.env, deps });
    assert.deepEqual(again.applied, []);
  } finally { s.cleanup(); }
});

test("the fleet's fan_out ceiling refuses a run wider than it allows", async () => {
  const s = sandbox();
  try {
    work.addTask("q", { prompt: "p", verify: VERIFY, cwd: s.repo }, { env: s.env });
    const fleet = { ...openfleet, context: (env) => ({ ...openfleet.context(env), ceiling: { depth: 1, hosts: [openfleet.host()], fan_out: 2 } }) };
    const calls = [];
    const r = await work.runWork({ queue: "q", workers: 8 }, { env: s.env, deps: { ...depsWith(s.env, fixAdd, calls), fleet }, engineOf: claude });
    assert.equal(r.ok, false);
    assert.equal(r.refused.key, "fan_out");
    assert.equal(calls.length, 0);
    assert.equal(work.listTasks("q", "pending", s.env).length, 1);
  } finally { s.cleanup(); }
});

test("a worker runs its engine with the engine's autonomous flags", () => {
  assert.deepEqual(work.workerArgs("claude", "x"), ["-p", "x", "--dangerously-skip-permissions"]);
  assert.ok(work.workerArgs("codex", "x").includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("not a git repository: the inbox says so, unless --no-isolate", async () => {
  const s = sandbox();
  try {
    const plain = path.join(s.root, "plain");
    fs.mkdirSync(plain);
    work.addTask("q", { prompt: "write ok", verify: "test -f ok", cwd: plain }, { env: s.env });
    const write = (cwd) => fs.writeFileSync(path.join(cwd, "ok"), "");
    const isolated = await work.runWork({ queue: "q" }, { env: s.env, deps: depsWith(s.env, write), engineOf: claude });
    assert.equal(isolated.inbox, 1);
    assert.match(work.listTasks("q", "inbox", s.env)[0].inbox.reason, /not inside a git repository/);
    work.retryTasks("q", [], { env: s.env, all: true });
    const inPlace = await work.runWork({ queue: "q", isolate: false }, { env: s.env, deps: depsWith(s.env, write), engineOf: claude });
    assert.equal(inPlace.done, 1);
    assert.ok(fs.existsSync(path.join(plain, "ok")));
  } finally { s.cleanup(); }
});

test("the CLI: add refuses a task with no verify, status prints the counts", async () => {
  const s = sandbox();
  try {
    const out = [];
    const write = (line) => out.push(String(line));
    assert.equal(await workCommand(["add", "q", "fix it", "--cwd", s.repo], { write, env: s.env }), 1);
    assert.match(out.join("\n"), /verify/);
    assert.equal(await workCommand(["add", "q", "fix it", "--verify", VERIFY, "--cwd", s.repo], { write, env: s.env }), 0);
    out.length = 0;
    assert.equal(await workCommand(["status", "q"], { write, env: s.env }), 0);
    assert.match(out.join("\n"), /1 pending/);
    out.length = 0;
    assert.equal(await workCommand(["run", "q", "-n", "0"], { write, env: s.env }), 2);
    assert.equal(await workCommand(["status", "nope"], { write, env: s.env }), 2);
    assert.equal(await workCommand(["frobnicate"], { write, env: s.env }), 2);
  } finally { s.cleanup(); }
});
