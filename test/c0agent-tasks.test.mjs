import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskBoard, liveSummary, readTasks, renderTasks } from "../src/c0agent-tasks.mjs";
import { manageAgents, parseArgs } from "../src/c0agent-repl.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c0tasks-")), "tasks.json");

test("a task moves through the states and notifies on state changes only", () => {
  const seen = [];
  const board = createTaskBoard({ persist: false, onChange: (t, before) => seen.push(`${before}->${t.state}`) });
  const t = board.add({ title: "fix the build\nsecond line", background: true });
  assert.equal(t.title, "fix the build");
  assert.equal(t.state, "working");
  board.update(t, { activity: "Read(a.js)" });
  board.update(t, { state: "needs_input", pending: { req: { title: "Bash(rm -rf x)" } } });
  board.update(t, { state: "working", pending: null });
  board.update(t, { state: "completed", result: "done" });
  assert.deepEqual(seen, ["null->working", "working->needs_input", "needs_input->working", "working->completed"]);
  assert.ok(t.endedAt);
  assert.deepEqual(board.counts(), { needs_input: 0, working: 0, completed: 1, failed: 0, stopped: 0 });
});

test("renderTasks groups by state with Needs input first", () => {
  const board = createTaskBoard({ persist: false });
  const a = board.add({ title: "done one", background: true });
  board.update(a, { state: "completed" });
  const b = board.add({ title: "asks", background: true });
  board.update(b, { state: "needs_input", pending: { req: { title: "Edit(x.js)" } } });
  const c = board.add({ title: "broke", background: false });
  board.update(c, { state: "failed", error: "no node took the job" });
  board.add({ title: "busy", background: true, agent: "explore" });
  const lines = [];
  renderTasks(board.tasks, (l) => lines.push(strip(l)));
  const heads = lines.filter((l) => !l.startsWith(" "));
  assert.deepEqual(heads, ["Needs input (1)", "Working (1)", "Completed (1)", "Failed (1)"]);
  assert.ok(lines.some((l) => l.includes("waiting on: Edit(x.js)")));
  assert.ok(lines.some((l) => l.includes("busy @explore")));
  assert.ok(lines.some((l) => l.includes("broke (fg)")));
  assert.ok(lines.some((l) => l.includes("no node took the job")));
  assert.equal(strip(liveSummary(board.tasks)), "1 needs input · 1 working");
});

test("the saved board merges sessions and a dead session's live task reads as Stopped", () => {
  const file = tmpFile();
  const mine = createTaskBoard({ file, pid: process.pid });
  const t = mine.add({ title: "mine", background: true });
  const ghost = createTaskBoard({ file, pid: 2 ** 30 }); // no such process
  ghost.add({ title: "orphan", background: true });
  mine.update(t, { state: "completed", result: "ok" });
  const all = readTasks({ file });
  assert.equal(all.length, 2);
  assert.equal(all.find((x) => x.title === "mine").state, "completed");
  const orphan = all.find((x) => x.title === "orphan");
  assert.equal(orphan.state, "stopped");
  assert.equal(orphan.activity, "session ended");
  assert.ok(!("pending" in orphan) && !("controller" in orphan));
});

test("`moshcode agents c0mpute tasks` prints and clears the saved board", () => {
  assert.deepEqual(parseArgs(["tasks"]).manage, ["tasks"]);
  assert.deepEqual(parseArgs(["tasks", "clear"]).manage, ["tasks", "clear"]);
  assert.deepEqual(parseArgs(["tasks for today"]).words, ["tasks for today"]);
  const file = tmpFile();
  const board = createTaskBoard({ file });
  const done = board.add({ title: "old", background: true });
  board.update(done, { state: "completed" });
  board.add({ title: "still going", background: true });
  const out = [];
  assert.equal(manageAgents(["tasks"], { write: (l) => out.push(strip(l)), file }), 0);
  assert.ok(out.includes("Working (1)") && out.includes("Completed (1)"));
  out.length = 0;
  manageAgents(["tasks", "clear"], { write: (l) => out.push(strip(l)), file });
  assert.match(out.join("\n"), /cleared 1 finished task$/);
  assert.deepEqual(readTasks({ file }).map((x) => x.title), ["still going"]);
});
