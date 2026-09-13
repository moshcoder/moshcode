// A member's pane title is its handle on the roster, and an engine that sets
// its own terminal title would take it away. Seen live: Claude Code writes
// "1 awaiting input · claude agents" the moment it is up, and the member read
// as `gone` while it sat there waiting for a prompt.
//
// And the other half, seen on CI: `allow-set-title` is a tmux 3.5 option.
// Ubuntu 24.04 ships 3.4, answers "invalid option", and starts nothing — so a
// wrong guess about the version must cost a retry, never a member.
import test from "node:test";
import assert from "node:assert/strict";

import { startSession, tmuxCanPinTitle, tmuxStartPlan } from "../src/herd.mjs";

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

test("tmuxCanPinTitle reads the version: 3.5 or newer, because 3.4 rejects the option", () => {
  const at = (v) => tmuxCanPinTitle({ force: true, runner: () => ({ stdout: `tmux ${v}\n` }) });
  assert.equal(at("3.6"), true);
  assert.equal(at("3.5"), true);
  assert.equal(at("3.5a"), true);
  assert.equal(at("3.4"), false, "ubuntu 24.04's tmux — the one every ubuntu-latest runner has");
  assert.equal(at("3.3a"), false);
  assert.equal(at("2.9"), false);
  assert.equal(at("next-3.6"), true);
  assert.equal(tmuxCanPinTitle({ force: true, runner: () => { throw new Error("no tmux"); } }), false);
});

/**
 * A tmux that claims a version the guard trusts but does not know the option:
 * `-V` says 3.5, `new-session … allow-set-title` fails the way tmux 3.4 does.
 */
function tmuxThatRejectsThePin() {
  const calls = [];
  const runner = (bin, args) => {
    calls.push(args);
    if (args[0] === "-V") return { status: 0, stdout: "tmux 3.5\n", stderr: "" };
    if (args.includes("new-session") && args.includes("allow-set-title")) {
      return { status: 1, stdout: "", stderr: "invalid option: allow-set-title\n" };
    }
    // list-panes (liveNames), kill-session, the retried new-session: fine.
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, runner };
}

test("a tmux that rejects allow-set-title gets one retry without it, and the member starts", () => {
  tmuxCanPinTitle({ force: true, runner: () => ({ stdout: "tmux 3.5\n" }) });
  const { calls, runner } = tmuxThatRejectsThePin();
  const result = startSession({ name: "api", engine: "claude", bin: "/bin/true", cwd: "/tmp", substrate: "tmux", runner });
  assert.equal(result.ok, true, "the member must start on a tmux that does not know the option");
  const starts = calls.filter((a) => a.includes("new-session"));
  assert.equal(starts.length, 2, "one attempt with the pin, one without");
  assert.ok(starts[0].includes("allow-set-title"));
  assert.ok(!starts[1].includes("allow-set-title"));
  // tmux stops at the command it rejects, after the session exists.
  const killed = calls.find((a) => a[0] !== "-V" && a.includes("kill-session"));
  assert.ok(killed, "the half-made session is removed before the retry");
  assert.equal(tmuxCanPinTitle({ runner }), false, "the answer is remembered for the rest of the process");
});
