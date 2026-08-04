import assert from "node:assert/strict";
import test from "node:test";

import { tabCommand, tabPlan, tabShellQuote } from "../src/tabs.mjs";

test("tab shell quoting keeps paths as one shell word", () => {
  assert.equal(tabShellQuote("/tmp/it's here"), "'/tmp/it'\\''s here'");
});

test("a tab command opens a fresh pit with the current entrypoint", () => {
  assert.equal(
    tabCommand({ execPath: "/opt/node bin/node", entry: "/tmp/mosh coder/bin/moshcode.mjs" }),
    "exec '/opt/node bin/node' '/tmp/mosh coder/bin/moshcode.mjs'",
  );
});

test("/new inside tmux creates one window in the current session", () => {
  const plan = tabPlan({
    cwd: "/work/space here",
    command: "moshcode-command",
    tmux: "/tmp/tmux,1,0",
  });

  assert.equal(plan.dedicated, false);
  assert.deepEqual(plan.required, [[
    "new-window", "-c", "/work/space here", "-n", "mosh", "moshcode-command",
  ]]);
  assert.equal(plan.attach, null);
});

test("/new outside tmux builds a private two-tab workspace", () => {
  const plan = tabPlan({ cwd: "/repo", command: "moshcode-command", tmux: "", pid: 42, stamp: 99 });

  assert.equal(plan.dedicated, true);
  assert.equal(plan.socket, "moshcode-42-99");
  assert.deepEqual(plan.required[0], [
    "-L", "moshcode-42-99", "new-session", "-d", "-s", "moshcode-42-99",
    "-c", "/repo", "-n", "mosh 1", "moshcode-command",
  ]);
  assert.deepEqual(plan.required[1], [
    "-L", "moshcode-42-99", "new-window", "-t", "moshcode-42-99",
    "-c", "/repo", "-n", "mosh 2", "moshcode-command",
  ]);
  assert.deepEqual(plan.attach, [
    "-L", "moshcode-42-99", "attach-session", "-t", "moshcode-42-99",
  ]);
  assert.ok(plan.optional.some((args) => args.includes("bottom")));
});
