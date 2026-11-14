import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickList, viewLines, wrapAnsi } from "../src/c0agent-picker.mjs";
import { contextDir, createTaskBoard, readTaskContext, renderTaskContext, taskItems } from "../src/c0agent-tasks.mjs";
import { strip } from "../src/ui.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "c0picker-"));

/** A fake terminal: input emits keypress events, output records what was drawn. */
function fakeTerm({ rows = 12, columns = 60 } = {}) {
  const input = new EventEmitter();
  input.isTTY = false;
  input.resume = () => {};
  const readlineKey = () => {};
  input.on("keypress", readlineKey);
  const output = new EventEmitter();
  output.rows = rows;
  output.columns = columns;
  output.frames = [];
  output.write = (s) => { output.frames.push(s); return true; };
  const last = () => strip(output.frames.filter((f) => f.includes("\x1b[2J")).at(-1) ?? "");
  const press = (name, extra = {}) => input.emit("keypress", extra.s ?? (name.length === 1 ? name : undefined), { name, ...extra });
  return { input, output, last, press, readlineKey };
}

test("wrapAnsi wraps at the width and carries an open colour onto the next row", () => {
  assert.deepEqual(wrapAnsi("abcdefgh", 3), ["abc", "def", "gh"]);
  const rows = wrapAnsi("\x1b[2mabcdef\x1b[22m", 4);
  assert.equal(rows.length, 2);
  assert.equal(strip(rows[0]), "abcd");
  assert.ok(rows[1].startsWith("\x1b[2m"), "second row reopens the dim colour");
  assert.equal(strip(rows[1]), "ef");
});

test("pickList: arrows move over headers, enter opens, extra keys act, esc backs out, keys go back to readline", async () => {
  const term = fakeTerm();
  const items = [{ header: "Working (1)" }, { id: "a", label: "first" }, { header: "Completed (2)" }, { id: "b", label: "second" }, { id: "c", label: "third" }];
  let p = pickList({ title: "Tasks", getItems: () => items, keys: { x: "stop" }, input: term.input, output: term.output, refreshMs: 10_000 });
  assert.match(term.last(), /❯ first/);
  assert.equal(term.input.listeners("keypress").includes(term.readlineKey), false, "readline does not see keys while the list is open");
  term.press("down");
  assert.match(term.last(), /❯ second/);
  term.press("down");
  term.press("down"); // stops at the end
  assert.match(term.last(), /❯ third/);
  term.press("return");
  assert.deepEqual((await p).item.id, "c");
  assert.ok(term.input.listeners("keypress").includes(term.readlineKey), "readline gets its keys back");

  p = pickList({ title: "Tasks", getItems: () => items, keys: { x: "stop" }, input: term.input, output: term.output, refreshMs: 10_000, startId: "b" });
  term.press("x");
  assert.deepEqual(await p, { action: "stop", item: items[3] });
  p = pickList({ title: "Tasks", getItems: () => items, input: term.input, output: term.output, refreshMs: 10_000 });
  term.press("escape");
  assert.equal(await p, null);
});

test("viewLines follows the end of a live page and stops following when you scroll up", async () => {
  const term = fakeTerm({ rows: 6 });
  const lines = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"];
  let liveNow = true;
  const p = viewLines({ title: "Task #ab12", getLines: () => lines, live: () => liveNow, input: term.input, output: term.output, refreshMs: 20 });
  assert.match(term.last(), /l7/);
  assert.match(term.last(), /live, following/);
  lines.push("l8 new");
  await new Promise((r) => setTimeout(r, 60));
  assert.match(term.last(), /l8 new/, "a live page redraws with what arrived");
  term.press("up");
  assert.match(term.last(), /G to follow/);
  term.press("g", { s: "G", shift: true });
  assert.match(term.last(), /following/);
  liveNow = false;
  term.press("escape");
  assert.equal(await p, "back");
});

test("the board keeps the full prompt and the conversation, saves it beside the board, and prunes it", () => {
  const dir = tmp();
  const file = path.join(dir, "tasks.json");
  const board = createTaskBoard({ file, pid: 4242 });
  const convo = [{ role: "user", content: "old turn" }];
  const long = `line one\n${"x".repeat(300)}`;
  const t = board.add({ title: long, prompt: long, background: true });
  board.attach(t, convo, convo.length);
  convo.push({ role: "user", content: long }, { role: "assistant", content: "<tool>read</tool>" }, { role: "user", content: '<tool_result name="read" ok="true">\nfile body\n</tool_result>' });
  board.stream(t, "Here is wha");
  board.note(t, "● Read(src/app.js)");
  board.update(t, { state: "completed", result: "done: fixed it" });
  const saved = readTaskContext({ pid: 4242, id: t.id }, { file });
  assert.equal(saved.prompt, long, "the whole prompt, not just its first line");
  assert.equal(saved.messages.length, 3, "only this task's messages, from where it started");
  assert.equal(saved.result, "done: fixed it");
  const text = strip(renderTaskContext(saved).join("\n"));
  assert.match(text, /── prompt/);
  assert.match(text, /⎿ tool results/);
  assert.match(text, /file body/);
  assert.match(text, /── result/);
  assert.doesNotMatch(text, /old turn/);
  assert.equal(text.split("line one").length, 3, "title header + prompt section, not again as the first message");

  board.clearFinished();
  assert.deepEqual(fs.readdirSync(contextDir(file)), [], "a cleared task's context file goes with it");
});

test("renderTaskContext shows a reply still arriving, and taskItems groups by state", () => {
  const text = strip(renderTaskContext({ id: "ab12", title: "t", prompt: "t", state: "working", agent: "c0mpute", cwd: "/x", startedAt: 1, messages: [], log: [], streaming: "partial answ", activity: "writing on node …abc" }, { now: 61_000 }).join("\n"));
  assert.match(text, /c0mpute \(writing…\)\npartial answ/);
  assert.match(text, /◐ writing on node/);
  const items = taskItems([
    { id: "a1", pid: process.pid, title: "one", state: "completed", startedAt: 0, endedAt: 1, updatedAt: 1, background: true },
    { id: "b2", pid: process.pid, title: "two", state: "working", startedAt: 0, updatedAt: 2, activity: "queued", background: true },
  ]);
  assert.deepEqual(items.map((i) => i.header ?? i.id), ["Working (1)", `${process.pid}-b2`, "Completed (1)", `${process.pid}-a1`]);
  assert.match(strip(items[1].sub), /queued/);
});
