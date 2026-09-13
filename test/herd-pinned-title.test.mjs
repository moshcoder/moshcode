// A member's pane title is its handle on the roster, and an engine that sets
// its own terminal title would take it away. Seen live: Claude Code writes
// "1 awaiting input · claude agents" the moment it is up, and the member read
// as `gone` while it sat there waiting for a prompt.
import test from "node:test";
import assert from "node:assert/strict";

import { tmuxCanPinTitle, tmuxStartPlan } from "../src/herd.mjs";

test("the start plan pins the pane title so an engine cannot rename itself off the roster", () => {
  const plan = tmuxStartPlan({ name: "api", cwd: "/x", command: "exec claude" });
  const at = plan.indexOf("allow-set-title");
  assert.ok(at > 0, "allow-set-title is not in the plan");
  assert.equal(plan[at + 1], "off");
  assert.ok(plan.slice(0, at).includes("-T"), "the title must be set before it is pinned");
  assert.equal(plan[at - 2], "-t");
  assert.equal(plan[at - 1], "api");
  assert.equal(plan[at - 3], "-w", "allow-set-title is a window option");
});

test("an old tmux gets the plan without the option it does not know", () => {
  const plan = tmuxStartPlan({ name: "api", cwd: "/x", command: "exec claude", pinTitle: false });
  assert.ok(!plan.includes("allow-set-title"));
  assert.ok(plan.includes("-T"), "the title is still set — it is the handle for the pane on every tmux");
});

test("tmuxCanPinTitle reads the version: 3.4 or newer", () => {
  const at = (v) => tmuxCanPinTitle({ force: true, runner: () => ({ stdout: `tmux ${v}\n` }) });
  assert.equal(at("3.6"), true);
  assert.equal(at("3.4"), true);
  assert.equal(at("3.3a"), false);
  assert.equal(at("2.9"), false);
  assert.equal(at("next-3.5"), true);
  assert.equal(tmuxCanPinTitle({ force: true, runner: () => { throw new Error("no tmux"); } }), false);
});
