// Typing a prompt into a member: the text, a beat, then Enter — as two
// keystroke batches, because an Enter that arrives inside the same tick as a
// long prompt is swallowed into the paste and nothing is submitted.
import test from "node:test";
import assert from "node:assert/strict";

import { PROMPT_SETTLE_MS, sendPrompt } from "../src/herd.mjs";

function fakeTmux() {
  const calls = [];
  const runner = (bin, args) => {
    calls.push({ bin, args, at: process.hrtime.bigint() });
    if (args.includes("list-panes")) return { status: 0, stdout: "api\t%3\tapi\t@1\t0\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, runner };
}

test("the prompt is typed literally, then Enter is sent on its own", () => {
  const { calls, runner } = fakeTmux();
  const result = sendPrompt("api", "port the auth routes", { substrate: "tmux", runner, settleMs: 0 });
  assert.equal(result.ok, true);
  const sends = calls.filter((c) => c.args.includes("send-keys")).map((c) => c.args);
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0].slice(-3), ["%3", "-l", "port the auth routes"], "the text goes to the pane id, literally");
  assert.deepEqual(sends[1].slice(-2), ["%3", "Enter"]);
});

test("there is a beat between the text and the Enter", () => {
  // Seen live: without it Claude Code showed "[Pasted text #1 +1 lines]" and
  // sat there. The default is a quarter second; the test uses a shorter one so
  // it is measurable without being slow.
  assert.ok(PROMPT_SETTLE_MS >= 100, "the default settle must be longer than a paste window");
  const { calls, runner } = fakeTmux();
  sendPrompt("api", "x".repeat(400), { substrate: "tmux", runner, settleMs: 40 });
  const sends = calls.filter((c) => c.args.includes("send-keys"));
  const gapMs = Number(sends[1].at - sends[0].at) / 1e6;
  assert.ok(gapMs >= 35, `Enter followed the text after ${gapMs.toFixed(1)}ms — no settle`);
});

test("a failed send reports the error and never presses Enter", () => {
  const calls = [];
  const runner = (bin, args) => {
    calls.push(args);
    if (args.includes("list-panes")) return { status: 0, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: "can't find pane" };
  };
  const result = sendPrompt("api", "hi", { substrate: "tmux", runner, settleMs: 0 });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /can't find pane/);
  assert.equal(calls.filter((a) => a.includes("Enter")).length, 0);
});
