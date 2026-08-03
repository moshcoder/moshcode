// Privileged steps should raise themselves, not ask the operator to raise the
// whole CLI. The old advice — `sudo moshcode dns enable` — is correct on its
// own, but it teaches a habit that breaks `moshcode update`, which re-runs the
// installer with $HOME set to /root.
//
// The cases worth pinning are the ones that cannot happen in a test process:
// no tty, no sudo on the box, the operator cancelling at the password prompt.
// So every input is injected.
import assert from "node:assert/strict";
import test from "node:test";

import { ESCALATION_MARKER, escalateSelf, findEscalator } from "../src/escalate.mjs";

const has = (...names) => (tool) => names.includes(tool);
const collect = () => {
  const lines = [];
  return { lines, out: (s) => lines.push(String(s)) };
};

test("prefers sudo, falls back to doas, and reports neither", () => {
  assert.equal(findEscalator({ env: {}, probe: has("sudo", "doas") }), "sudo");
  assert.equal(findEscalator({ env: {}, probe: has("doas") }), "doas");
  assert.equal(findEscalator({ env: {}, probe: has() }), null);
});

test("an explicit MOSHCODE_ESCALATOR wins, but only if it exists", () => {
  assert.equal(findEscalator({ env: { MOSHCODE_ESCALATOR: "doas" }, probe: has("sudo", "doas") }), "doas");
  // Naming a helper that is not installed must not silently fall back to sudo:
  // the operator asked for something specific.
  assert.equal(findEscalator({ env: { MOSHCODE_ESCALATOR: "please" }, probe: has("sudo") }), null);
});

test("re-runs this CLI's own argv under the escalator", () => {
  const calls = [];
  const { lines, out } = collect();
  const result = escalateSelf({
    args: ["dns", "enable"],
    env: {},
    argv: ["/usr/bin/node", "/opt/moshcode/bin/moshcode.mjs", "dns", "enable"],
    isTTY: true,
    probe: has("sudo"),
    spawn: (cmd, argv, opts) => {
      calls.push({ cmd, argv, opts });
      return { status: 0 };
    },
    out,
  });

  assert.deepEqual(result, { ran: true, code: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "sudo");
  assert.deepEqual(calls[0].argv, ["/usr/bin/node", "/opt/moshcode/bin/moshcode.mjs", "dns", "enable"]);
  // The password prompt has to reach the terminal.
  assert.equal(calls[0].opts.stdio, "inherit");
  assert.equal(calls[0].opts.env[ESCALATION_MARKER], "1");
  assert.match(lines.join("\n"), /needs root/);
});

test("the child's exit code is the command's exit code", () => {
  // 1 here is the operator cancelling at the password prompt. That is a
  // refusal, and it must surface as a failure rather than a silent success.
  const result = escalateSelf({
    args: ["dns", "enable"],
    env: {},
    argv: ["node", "moshcode.mjs"],
    isTTY: true,
    probe: has("sudo"),
    spawn: () => ({ status: 1 }),
    out: () => {},
  });

  assert.deepEqual(result, { ran: true, code: 1 });
});

test("does not escalate without a terminal", () => {
  // In CI there is nowhere to type a password: sudo would fail, or hang until
  // the job times out. Fall back to advice instead.
  const result = escalateSelf({
    args: ["dns", "enable"],
    env: {},
    argv: ["node", "moshcode.mjs"],
    isTTY: false,
    probe: has("sudo"),
    spawn: () => assert.fail("must not spawn without a tty"),
    out: () => {},
  });

  assert.deepEqual(result, { ran: false, reason: "no-tty" });
});

test("does not escalate when the box has no escalator", () => {
  const result = escalateSelf({
    args: ["dns", "enable"],
    env: {},
    argv: ["node", "moshcode.mjs"],
    isTTY: true,
    probe: has(),
    spawn: () => assert.fail("must not spawn without an escalator"),
    out: () => {},
  });

  assert.deepEqual(result, { ran: false, reason: "no-escalator" });
});

test("refuses to escalate twice", () => {
  // If the child is somehow still unprivileged, it must print advice rather
  // than spawn another escalation and stack password prompts forever.
  const result = escalateSelf({
    args: ["dns", "enable"],
    env: { [ESCALATION_MARKER]: "1" },
    argv: ["node", "moshcode.mjs"],
    isTTY: true,
    probe: has("sudo"),
    spawn: () => assert.fail("must not escalate a second time"),
    out: () => {},
  });

  assert.deepEqual(result, { ran: false, reason: "already-escalated" });
});

test("a failed spawn degrades to advice rather than throwing", () => {
  const result = escalateSelf({
    args: ["dns", "enable"],
    env: {},
    argv: ["node", "moshcode.mjs"],
    isTTY: true,
    probe: has("sudo"),
    spawn: () => ({ error: new Error("ENOENT") }),
    out: () => {},
  });

  assert.deepEqual(result, { ran: false, reason: "spawn-failed" });
});
