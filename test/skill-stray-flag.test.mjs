// `skill install` took the first unconsumed token as the source, so a flag it
// does not know became the source itself and the real URL was dropped: for
// `skill install -s user https://github.com/o/r.git` the source is `-s`, and
// `user` and the URL are never looked at again. The source is spliced verbatim
// into each engine's native argv, so gemini got `skills install -s --scope user`
// and Claude got `git clone --depth 1 -s <skills-dir>/s` — where `-s` is git's
// own `--shared`, which makes git read the *destination* as the repository
// ("fatal: repository '…/skills/s' does not exist"). `mcp` already rejects a
// stray flag for exactly this reason (test/mcp-stray-flag.test.mjs); this is
// the same guard on the same kind of splice.
import assert from "node:assert/strict";
import test from "node:test";

import { ENGINES } from "../src/engines.mjs";
import { skillCommand } from "../src/integrations.mjs";

const ALL = new Set(Object.keys(ENGINES));
const URL = "https://github.com/example/real-skill.git";

/** Run `fn` with console.log captured; returns { code, out }. */
async function capture(fn) {
  const log = console.log;
  const out = [];
  console.log = (...args) => out.push(args.join(" "));
  try { return { code: await fn(), out: out.join("\n") }; }
  finally { console.log = log; }
}

/** A `run` that records every argv it is handed and always succeeds. */
function spy() {
  const calls = [];
  const run = async (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { ok: true, code: 0 }; };
  return { calls, run };
}

// --- the bug -----------------------------------------------------------------

test("an engine-native scope flag is rejected instead of becoming the source", async () => {
  const { run, calls } = spy();
  const { code, out } = await capture(() => skillCommand(["install", "-s", "user", URL], { run, installedSet: ALL }));
  assert.equal(code, 1, "a stray flag was accepted as the skill source");
  assert.match(out, /unknown skill flag "-s"/);
  assert.deepEqual(calls, [], "no engine should be run at all");
});

test("a misspelled --name is rejected, not installed as a skill called nmae", async () => {
  const { run, calls } = spy();
  const { code, out } = await capture(() => skillCommand(["install", "--nmae", "my-skill", URL], { run, installedSet: ALL }));
  assert.equal(code, 1);
  assert.match(out, /unknown skill flag "--nmae"/);
  assert.deepEqual(calls, [], "no engine should be run at all");
});

test("the stray flag never reaches git's or gemini's argv", async () => {
  // The end-to-end consequence: `-s` is git's --shared, so the clone would have
  // read its own destination as the repository.
  const { run, calls } = spy();
  await capture(() => skillCommand(["install", "-s", "user", URL], { run, installedSet: ALL }));
  assert.ok(!calls.some((c) => c.includes(" -s")), `a stray flag was spliced into ${calls.join(" | ")}`);
});

test("the user's real source is never silently dropped in favour of a flag", async () => {
  const { run, calls } = spy();
  const { code } = await capture(() => skillCommand(["install", "--scope", "user", URL], { run, installedSet: ALL }));
  assert.equal(code, 1);
  assert.ok(!calls.some((c) => c.includes(URL)), "nothing should have been installed");
});

test("the error names the flag skill install does take, and how to escape a real one", async () => {
  const { run } = spy();
  const { out } = await capture(() => skillCommand(["install", "-s", "user", URL], { run, installedSet: ALL }));
  assert.match(out, /--name/);
  assert.match(out, /\.\/-s/);
});

// --- controls: the opposite direction ---------------------------------------

test("a normal git URL still installs across the skills engines", async () => {
  const { run, calls } = spy();
  const { code } = await capture(() => skillCommand(["install", URL], { run, installedSet: ALL }));
  assert.equal(code, 0);
  assert.ok(calls.some((c) => c.startsWith("git clone") && c.includes(URL)), `expected a clone of the source, got ${calls.join(" | ")}`);
  assert.ok(calls.some((c) => c.startsWith(`${ENGINES.gemini.bin} skills install ${URL}`)), `expected gemini to be handed the source, got ${calls.join(" | ")}`);
});

test("--name still parses and still names the skill", async () => {
  const { run, calls } = spy();
  const { code } = await capture(() => skillCommand(["install", URL, "--name", "renamed"], { run, installedSet: ALL }));
  assert.equal(code, 0);
  assert.ok(calls.some((c) => c.includes("/renamed")), `expected the clone to land in .../renamed, got ${calls.join(" | ")}`);
});

test("a local path source is untouched by the guard", async () => {
  const { run, calls } = spy();
  const { code } = await capture(() => skillCommand(["install", "./my-skill"], { run, installedSet: ALL }));
  assert.equal(code, 0);
  assert.ok(calls.some((c) => c.includes("./my-skill")), `expected the path to survive, got ${calls.join(" | ")}`);
});

test("the pre-existing --name missing-value guard still fires first", async () => {
  const { run } = spy();
  const { code, out } = await capture(() => skillCommand(["install", URL, "--name"], { run, installedSet: ALL }));
  assert.equal(code, 1);
  assert.match(out, /--name requires a value/);
  assert.doesNotMatch(out, /unknown skill flag/);
});

test("no source at all still reports usage, not an unknown flag", async () => {
  const { run } = spy();
  const { code, out } = await capture(() => skillCommand(["install"], { run, installedSet: ALL }));
  assert.equal(code, 1);
  assert.match(out, /usage: \/skill install/);
  assert.doesNotMatch(out, /unknown skill flag/);
});

test("an unknown verb still reports an unknown verb", async () => {
  const { run } = spy();
  const { code, out } = await capture(() => skillCommand(["bogus"], { run, installedSet: ALL }));
  assert.equal(code, 1);
  assert.match(out, /unknown skill verb/);
});
