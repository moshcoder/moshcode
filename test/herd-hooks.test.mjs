// Engine hooks: the merge that must not clobber, the guard that must not break
// an engine, and the removal that must only take back what we put in.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  hookCommand, hookDiff, hookableEngines, hooksStatus, installHooks, isOurs, removeHooks,
} from "../src/herd-hooks.mjs";
import { ENGINES } from "../src/engines.mjs";

function withSettings(initial, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-hooks-test-"));
  const file = path.join(dir, "settings.json");
  if (initial !== undefined) fs.writeFileSync(file, typeof initial === "string" ? initial : JSON.stringify(initial, null, 2));
  try { return fn(file); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/* ------------------------------------------------------------- the command */

test("a hook fired outside a herd session does nothing and exits 0", () => {
  // The single most important property here. An engine is used by hand far
  // more often than it is used in a herd, and a hook that fails on every turn
  // of a working engine gets the whole feature uninstalled by lunchtime.
  const command = hookCommand("done");
  assert.match(command, /\[ -n "\$MOSHCODE_HERD_NAME" \]/, "no guard on the session name");
  assert.match(command, /command -v moshcode/, "a box without moshcode would get a failing hook");
  assert.match(command, /exit 0\s*$/, "the engine must carry on whatever happened");
});

test("the hook says nothing to the operator", () => {
  // Its whole output belongs in the roster, not in the middle of a session.
  assert.match(hookCommand("working"), />\/dev\/null 2>&1/);
});

test("the command carries the state it reports", () => {
  assert.match(hookCommand("blocked"), /herd report "\$MOSHCODE_HERD_NAME" blocked\b/);
});

test("our entries are recognised by their command, not by a marker we invented", () => {
  // The file's schema belongs to the engine. An unknown key is something it is
  // entitled to reject, and a config it rejects is worse than no hook at all.
  assert.equal(isOurs({ type: "command", command: hookCommand("done") }), true);
  assert.equal(isOurs({ type: "command", command: "echo hello" }), false);
  assert.equal(isOurs({}), false);
  assert.equal(isOurs(null), false);
});

/* ------------------------------------------------------------ install/merge */

test("installing extends a settings file rather than replacing it", () => {
  withSettings({
    model: "opus",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo theirs" }] }] },
  }, (file) => {
    const result = installHooks("claude", { file });
    assert.equal(result.ok, true);
    const after = read(file);
    assert.equal(after.model, "opus", "an unrelated setting was lost");
    const stop = after.hooks.Stop.flatMap((g) => g.hooks);
    assert.ok(stop.some((h) => h.command === "echo theirs"), "the user's own hook was clobbered");
    assert.ok(stop.some(isOurs), "ours was not added");
  });
});

test("installing twice does not fire the hook twice", () => {
  withSettings({}, (file) => {
    installHooks("claude", { file });
    const second = installHooks("claude", { file });
    assert.equal(second.changes.every((c) => c.change === "unchanged"), true);
    const stop = read(file).hooks.Stop.flatMap((g) => g.hooks).filter(isOurs);
    assert.equal(stop.length, 1);
  });
});

test("a command from an older release is replaced, not duplicated", () => {
  withSettings({
    hooks: { Stop: [{ hooks: [{ type: "command", command: 'moshcode herd report "$MOSHCODE_HERD_NAME" done' }] }] },
  }, (file) => {
    const result = installHooks("claude", { file });
    assert.equal(result.changes.find((c) => c.event === "Stop").change, "updated");
    const stop = read(file).hooks.Stop.flatMap((g) => g.hooks).filter(isOurs);
    assert.equal(stop.length, 1, "an upgrade must not leave two copies firing");
    assert.equal(stop[0].command, hookCommand("done"));
  });
});

test("a settings file that cannot be parsed is refused, not overwritten", () => {
  // Overwriting it would take every other hook, MCP server and preference in
  // it along with the mistake.
  withSettings("{ not json", (file) => {
    const result = installHooks("claude", { file });
    assert.equal(result.ok, false);
    assert.match(String(result.error.message), /not valid JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "the file was modified anyway");
  });
});

test("--dry-run writes nothing and can still show the change", () => {
  withSettings({ model: "opus" }, (file) => {
    const result = installHooks("claude", { file, dryRun: true });
    assert.equal(result.ok, true);
    assert.deepEqual(read(file), { model: "opus" }, "a dry run touched the file");
    const diff = hookDiff(result.before, result.after);
    assert.match(diff, /^\+.*MOSHCODE_HERD_NAME/m, "the diff does not show what would be added");
  });
});

test("installing creates the file when the engine has never been configured", () => {
  withSettings(undefined, (file) => {
    assert.equal(installHooks("claude", { file }).ok, true);
    assert.equal(Object.keys(read(file).hooks).length, ENGINES.claude.hooks.events.length);
  });
});

/* ------------------------------------------------------------------ remove */

test("remove takes out only what moshcode put in", () => {
  withSettings({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "echo theirs" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo audit" }] }],
    },
  }, (file) => {
    installHooks("claude", { file });
    const removed = removeHooks("claude", { file });
    assert.equal(removed.removed, 3);
    const after = read(file);
    assert.deepEqual(after.hooks.Stop, [{ hooks: [{ type: "command", command: "echo theirs" }] }]);
    assert.deepEqual(after.hooks.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: "echo audit" }] }]);
    assert.equal(after.hooks.Notification, undefined, "an event group we created should go with us");
  });
});

test("remove sweeps an event an older spec used, not only the current ones", () => {
  // Otherwise `remove` after an upgrade leaves the previous version's hook
  // firing forever, with nothing left that knows how to take it out.
  withSettings({
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: hookCommand("working") }] }] },
  }, (file) => {
    const removed = removeHooks("claude", { file });
    assert.equal(removed.removed, 1);
    assert.equal(read(file).hooks, undefined);
  });
});

test("removing from a file that was never written is not an error", () => {
  withSettings(undefined, (file) => {
    const result = removeHooks("claude", { file });
    assert.equal(result.ok, true);
    assert.equal(result.removed, 0);
  });
});

/* ------------------------------------------------------------------ status */

test("status distinguishes absent, current, and out of date", () => {
  withSettings({}, (file) => {
    assert.equal(hooksStatus("claude", { file }).installed, false);
    installHooks("claude", { file });
    assert.equal(hooksStatus("claude", { file }).installed, true);

    const settings = read(file);
    settings.hooks.Stop[0].hooks[0].command = 'moshcode herd report "$MOSHCODE_HERD_NAME" done';
    fs.writeFileSync(file, JSON.stringify(settings));
    const stale = hooksStatus("claude", { file });
    assert.equal(stale.installed, false, "an out-of-date command is not the current install");
    assert.equal(stale.partial, true, "…but it is not 'never installed' either");
  });
});

test("an engine with no hook spec says so instead of pretending", () => {
  // A guessed hook schema is a rule that rots with no screen to fall back to.
  assert.equal(hooksStatus("codex").supported, false);
  assert.equal(installHooks("codex").ok, false);
  assert.ok(hookableEngines().includes("claude"));
});

test("every engine with a hook spec keeps its screen rules", () => {
  // A hook that a schema change quietly breaks must degrade to what the herd
  // did before it, never below it.
  for (const key of hookableEngines()) {
    assert.ok(ENGINES[key].state, `${key} dropped its screen rules when it gained hooks`);
  }
});

test("every hook event reports a state the herd actually has", () => {
  for (const key of hookableEngines()) {
    for (const { event, state, label } of ENGINES[key].hooks.events) {
      assert.ok(["working", "blocked", "done", "idle"].includes(state), `${key}/${event} reports ${state}`);
      assert.ok(label, `${key}/${event} has no human-readable label`);
    }
  }
});
