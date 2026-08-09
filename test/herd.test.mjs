// The herd runtime: naming, the argv that reaches tmux, the manifest, and the
// capability detection that decides whether any of it runs at all.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  defaultName, detectSubstrate, forgetSession, NAME_RE, readManifest, rememberSession,
  resetSubstrate, sessionCommand, slugifyName, substrateNote, tmuxStartPlan, validName,
  writeManifest,
} from "../src/herd.mjs";

/** Each test gets its own herd dir; the module reads the env var every call. */
function withHerdDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-herd-test-"));
  const previous = process.env.MOSHCODE_HERD_DIR;
  process.env.MOSHCODE_HERD_DIR = dir;
  try { return fn(dir); }
  finally {
    if (previous === undefined) delete process.env.MOSHCODE_HERD_DIR;
    else process.env.MOSHCODE_HERD_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ naming */

test("a session name is safe as a tmux target and as a filename", () => {
  assert.ok(validName("api"));
  assert.ok(validName("api-refactor_2"));
  // tmux reads `:` and `.` as target separators, so a name carrying either
  // would address a different window than the one it names.
  assert.ok(!validName("api:2"), "a colon is a tmux target separator");
  assert.ok(!validName("api.2"), "a dot is a tmux target separator");
  assert.ok(!validName("../escape"), "a name is also a filename");
  assert.ok(!validName("2fast"), "must start with a letter");
  assert.ok(!validName(""));
  assert.ok(!validName("a".repeat(33)), "32 characters is the cap");
});

test("slugifyName always produces something NAME_RE accepts", () => {
  for (const input of ["My Repo!", "2024-report", "---", "", "ünïcödé", "a".repeat(80)]) {
    assert.match(slugifyName(input), NAME_RE, `slugify(${JSON.stringify(input)}) must be usable`);
  }
});

test("default names distinguish the same engine in two repos", () => {
  assert.equal(defaultName("claude", "/home/x/src/coinpay"), "claude-coinpay");
  assert.equal(defaultName("claude", "/home/x/src/ugig.net"), "claude-ugig-net");
});

test("a default name that is taken gets a suffix rather than colliding", () => {
  // Starting a second agent in the same repo is the common case, not the edge
  // case, and silently reusing the name would address the first session.
  assert.equal(defaultName("claude", "/x/api", ["claude-api"]), "claude-api-2");
  assert.equal(defaultName("claude", "/x/api", ["claude-api", "claude-api-2"]), "claude-api-3");
});

/* -------------------------------------------------------------- the launch */

test("the session command quotes arguments that would otherwise split", () => {
  const command = sessionCommand({ bin: "claude", args: ["--prompt", "fix the build; now"] });
  assert.match(command, /'fix the build; now'/, "a bare semicolon would end the command");
  assert.ok(command.startsWith("exec "), "the engine should replace the shell, not sit under it");
});

test("stripEnv unsets variables rather than blanking them", () => {
  // tmux's own `-e KEY=` sets an empty value, and an empty ANTHROPIC_API_KEY is
  // not the same as an absent one — claude reads the empty string as a key and
  // abandons the subscription login it should have used.
  const command = sessionCommand({ bin: "claude", args: [], stripEnv: ["ANTHROPIC_API_KEY"] });
  assert.match(command, /exec env '-u' 'ANTHROPIC_API_KEY'/);
  assert.ok(!/ANTHROPIC_API_KEY=/.test(command), "must unset, never assign empty");
});

test("a shell metacharacter in a binary path cannot escape the command", () => {
  const command = sessionCommand({ bin: "/opt/my agent/bin/claude", args: ["$(id)"] });
  assert.match(command, /'\/opt\/my agent\/bin\/claude'/);
  assert.match(command, /'\$\(id\)'/, "command substitution must stay literal");
});

test("the start plan keeps finished sessions readable", () => {
  const plan = tmuxStartPlan({ name: "api", cwd: "/x", command: "exec claude" });
  assert.deepEqual(plan.slice(0, 2), ["-f", "/dev/null"], "moshcode's server, not the user's config");
  assert.ok(plan.includes("-d"), "the session must start detached — that is the whole point");
  // Without remain-on-exit the pane vanishes when the agent finishes, and the
  // roster can only ever say "gone" where it should say "done".
  assert.ok(plan.includes("remain-on-exit") && plan.includes("on"));
});

test("the session and its remain-on-exit are set in one tmux call", () => {
  // Two calls is a race: a command that finishes fast is gone before the second
  // process starts, and the option lands on a session that no longer exists —
  // which is exactly how a finished agent came to report `gone` instead of
  // `done`.
  const plan = tmuxStartPlan({ name: "api", cwd: "/x", command: "exec true" });
  const separator = plan.indexOf(";");
  assert.ok(separator > 0, "tmux takes `;` as its own argument to mean `and then`");
  assert.ok(plan.slice(0, separator).includes("new-session"));
  assert.ok(plan.slice(separator).includes("remain-on-exit"));
});

/* ----------------------------------------------------------- the manifest */

test("the manifest is written owner-only", () => {
  withHerdDir(() => {
    rememberSession("api", { engine: "claude", cwd: "/x", args: ["--token", "sk-secret"] });
    const file = path.join(process.env.MOSHCODE_HERD_DIR, "sessions.json");
    // It records the argv an engine was launched with, and engine argv
    // regularly carries a token. Same reasoning as .moshcode_history.
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

test("an existing manifest is tightened on write, not just on create", () => {
  withHerdDir((dir) => {
    const file = path.join(dir, "sessions.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: {} }), { mode: 0o644 });
    rememberSession("api", { engine: "claude" });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "installs predating this must get fixed too");
  });
});

test("a corrupt manifest reads as an empty herd instead of throwing", () => {
  withHerdDir((dir) => {
    fs.writeFileSync(path.join(dir, "sessions.json"), "{not json");
    // The live substrate is the authority on what is running; losing the
    // metadata must never take down the roster that reads it.
    assert.deepEqual(readManifest(), { version: 1, sessions: {} });
  });
});

test("remembering merges rather than replacing", () => {
  withHerdDir(() => {
    rememberSession("api", { engine: "claude", cwd: "/x" });
    rememberSession("api", { agent: true });
    assert.deepEqual(readManifest().sessions.api, { engine: "claude", cwd: "/x", agent: true });
  });
});

test("forgetting is idempotent and scoped to one session", () => {
  withHerdDir(() => {
    writeManifest({ sessions: { a: { engine: "claude" }, b: { engine: "codex" } } });
    assert.equal(forgetSession("a"), true);
    assert.equal(forgetSession("a"), false, "a second forget is not an error");
    assert.deepEqual(Object.keys(readManifest().sessions), ["b"]);
  });
});

/* ------------------------------------------------------ capability detection */

test("MOSHCODE_HERD=off degrades instead of failing", () => {
  // R2: moshcode must not harden a soft dependency into a hard one. This is
  // also how the no-tmux path gets exercised on a box that has tmux.
  const previous = process.env.MOSHCODE_HERD;
  process.env.MOSHCODE_HERD = "off";
  try {
    assert.equal(detectSubstrate({ force: true }), null);
    assert.match(substrateNote(null), /foreground/, "the note has to say what is lost");
  } finally {
    if (previous === undefined) delete process.env.MOSHCODE_HERD;
    else process.env.MOSHCODE_HERD = previous;
    resetSubstrate();
  }
});

test("tmux is preferred, and its absence falls through rather than erroring", () => {
  const runner = (cmd) => (cmd === "tmux"
    ? { error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) }
    : { status: 0, stdout: "util-linux" });
  const substrate = detectSubstrate({ force: true, runner, env: {} });
  assert.ok(substrate === "pty" || substrate === null, "no tmux must not throw");
});

test("a tmux that answers -V wins", () => {
  const runner = (cmd) => (cmd === "tmux" ? { status: 0, stdout: "tmux 3.4" } : { status: 1 });
  assert.equal(detectSubstrate({ force: true, runner, env: {} }), "tmux");
});

test("the substrate note names a fix rather than only a problem", () => {
  assert.equal(substrateNote("tmux"), null, "nothing to say when everything works");
  assert.match(substrateNote("pty"), /tmux/, "say what would make it better");
  assert.match(substrateNote(null), /install tmux|apt|brew/, "and how to get it");
});
