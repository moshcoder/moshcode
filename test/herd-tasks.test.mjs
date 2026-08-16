// The task ledger: what it records, what it refuses to invent, and the caps
// that keep an append-only file from being a disk-eater with a delay on it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_ARTIFACT_CHARS, compact, endTask, findTask, ledgerSessions, mintTaskId, openTask,
  readLog, readTasks, recordTransition, screenDelta, startTask, stats,
} from "../src/herd-tasks.mjs";

function withHerdDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-tasks-test-"));
  const previous = process.env.MOSHCODE_HERD_DIR;
  process.env.MOSHCODE_HERD_DIR = dir;
  try { return fn(dir); }
  finally {
    if (previous === undefined) delete process.env.MOSHCODE_HERD_DIR;
    else process.env.MOSHCODE_HERD_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------------- ids */

test("task ids are herd-wide, so an id names one task", () => {
  // Per-session ordinals would make `herd task t-01` mean one task per member,
  // and an ambiguous handle is not a handle.
  withHerdDir(() => {
    const a = startTask("api", "one");
    const b = startTask("web", "two");
    assert.notEqual(a, b);
    assert.equal(findTask(a).session, "api");
    assert.equal(findTask(b).session, "web");
  });
});

test("minting an id never blocks", () => {
  withHerdDir((dir) => {
    // A stale lock is what a crashed fan-out leaves behind. It must cost an id,
    // not a hang.
    fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tasks", "seq.lock"), "");
    const started = Date.now();
    const id = mintTaskId({ now: Date.now() + 10_000 });
    assert.ok(id.startsWith("t-"));
    assert.ok(Date.now() - started < 2000, "minting an id waited on a lock");
  });
});

/* ---------------------------------------------------------------- recording */

test("a prompt is recorded before it is known to have worked", () => {
  // A ledger that only records successful work cannot answer the question
  // anybody actually asks it.
  withHerdDir(() => {
    const id = startTask("api", "port the auth routes", { now: 1000 });
    const [task] = readTasks("api");
    assert.equal(task.id, id);
    assert.equal(task.text, "port the auth routes");
    assert.equal(task.submitted, 1000);
    assert.equal(task.status, "open");
  });
});

test("an open task is reported open rather than given an invented outcome", () => {
  withHerdDir(() => {
    startTask("api", "run the migration");
    const [task] = readTasks("api");
    assert.equal(task.status, "open");
    assert.equal(task.artifact, null);
    assert.equal(task.durationMs, null);
  });
});

test("transitions are attributed to the open task and survive without one", () => {
  withHerdDir(() => {
    recordTransition("api", "idle");                 // nobody prompted; still history
    const id = startTask("api", "go");
    recordTransition("api", "working", { id });
    recordTransition("api", "blocked", { id, kind: "menu" });
    const [task] = readTasks("api");
    assert.deepEqual(task.transitions.map((t) => t.state), ["working", "blocked"]);
    assert.equal(task.transitions.at(-1).kind, "menu");
    assert.equal(readLog("api").length, 4, "the unbound transition was lost");
  });
});

test("repeating the current state is not a transition", () => {
  // A `--wait` prompt runs two waits back to back and the watcher is looking at
  // the same session anyway. Without this, one prompt writes `idle` three
  // times and the task detail shows two rows that lasted zero seconds.
  withHerdDir(() => {
    const id = startTask("api", "go");
    assert.equal(recordTransition("api", "working", { id }), true);
    assert.equal(recordTransition("api", "working", { id }), false);
    assert.equal(recordTransition("api", "idle", { id }), true);
    const [task] = readTasks("api");
    assert.deepEqual(task.transitions.map((t) => t.state), ["working", "idle"]);
  });
});

test("closing a task records its outcome, its output and how long it took", () => {
  withHerdDir(() => {
    const id = startTask("api", "go", { now: 1000 });
    endTask("api", id, { state: "done", artifact: "the answer", ts: 5000 });
    const [task] = readTasks("api");
    assert.equal(task.status, "closed");
    assert.equal(task.state, "done");
    assert.equal(task.artifact, "the answer");
    assert.equal(task.durationMs, 4000);
    assert.equal(openTask("api"), null);
  });
});

test("an oversized artifact keeps its tail and admits it was cut", () => {
  // The answer is the last thing an agent printed; the first 8KB of a long run
  // is the part you already watched.
  withHerdDir(() => {
    const id = startTask("api", "go");
    const huge = `${"x".repeat(MAX_ARTIFACT_CHARS + 500)}THE ANSWER`;
    endTask("api", id, { artifact: huge });
    const [task] = readTasks("api");
    assert.equal(task.truncated, true);
    assert.equal(task.artifactChars, huge.length);
    assert.ok(task.artifact.endsWith("THE ANSWER"), "the tail was not the part that was kept");
    assert.equal(task.artifact.length, MAX_ARTIFACT_CHARS);
  });
});

/* ------------------------------------------------------------------ deltas */

test("the artifact is what appeared after the prompt, not the whole screen", () => {
  const before = "$ ls\nfile.txt\n$";
  const after = "$ ls\nfile.txt\n$ echo hi\nhi\n$";
  assert.equal(screenDelta(before, after), "echo hi\nhi\n$");
});

test("a repaint that scrolled the baseline away returns the screen, not nothing", () => {
  // An empty artifact would read as "the agent said nothing", which is a lie
  // about a full-screen engine that redrew.
  assert.equal(screenDelta("$ ls\nfile.txt", "a totally different screen"), "a totally different screen");
});

test("no baseline means everything is new", () => {
  assert.equal(screenDelta("", "hello"), "hello");
});

/* ------------------------------------------------------------------- stats */

test("blocked time is counted, because it is the number with a name", () => {
  withHerdDir(() => {
    const id = startTask("api", "go", { now: 0 });
    recordTransition("api", "working", { id, ts: 1000 });
    recordTransition("api", "blocked", { id, ts: 3000 });
    endTask("api", id, { state: "done", ts: 9000 });
    const totals = stats("api", { now: 10_000 }).totals;
    assert.equal(totals.working, 2000);
    assert.equal(totals.blocked, 6000, "human latency is the whole point of this figure");
    assert.equal(stats("api", { now: 10_000 }).tasks, 1);
  });
});

test("a session with no history reports nothing rather than throwing", () => {
  withHerdDir(() => {
    assert.deepEqual(readTasks("nobody"), []);
    assert.deepEqual(readLog("nobody"), []);
    assert.equal(stats("nobody").tasks, 0);
    assert.equal(findTask("t-99"), null);
    assert.deepEqual(ledgerSessions(), []);
  });
});

/* -------------------------------------------------------------- resilience */

test("one unparseable line loses that line, not the history above it", () => {
  withHerdDir((dir) => {
    const id = startTask("api", "go");
    endTask("api", id, { state: "done", artifact: "fine" });
    const file = path.join(dir, "tasks", "api.jsonl");
    fs.appendFileSync(file, '{"e":"state","id":"t-9",\n'); // a torn last write
    const tasks = readTasks("api");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].artifact, "fine");
  });
});

test("the ledger is owner-only, because it holds what the engine said", () => {
  // The manifest's reason, one step harder: this records output, and output
  // regularly carries secrets the user never typed.
  withHerdDir((dir) => {
    startTask("api", "go");
    const mode = fs.statSync(path.join(dir, "tasks", "api.jsonl")).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test("retention keeps whole tasks, newest first", () => {
  // A ledger cut mid-task shows a submission with no outcome, which reads as an
  // agent that never answered rather than as a file that was trimmed.
  withHerdDir(() => {
    for (let i = 0; i < 12; i++) {
      const id = startTask("api", `task ${i}`);
      endTask("api", id, { state: "done", artifact: `answer ${i}` });
    }
    compact("api", { maxTasks: 5, maxBytes: 10 * 1024 * 1024 });
    const tasks = readTasks("api");
    assert.equal(tasks.length, 5);
    assert.equal(tasks.at(-1).text, "task 11");
    for (const task of tasks) assert.equal(task.status, "closed", "a task was cut in half");
  });
});
