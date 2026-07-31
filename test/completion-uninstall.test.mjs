import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { completionModel, completionScript } from "../src/completion.mjs";
import { ENGINE_ALIASES, ENGINES } from "../src/engines.mjs";
import { TOOLS } from "../src/tools.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

function names(entries) {
  return entries.map(({ name }) => name);
}

function bashQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// Source the real generated script in a real bash and call the real completion
// function, rather than asserting against the script text. A script can mention
// a word and still never offer it.
function bashCompletions(tokens) {
  const script = `${completionScript("bash")}
COMP_WORDS=(${tokens.map(bashQuote).join(" ")})
COMP_CWORD=${tokens.length - 1}
_moshcode_completion
printf '%s\\n' "\${COMPREPLY[@]}"
`;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").filter(Boolean);
}

// The roster `uninstall` actually resolves its target against: bin/moshcode.mjs
// checks `Object.hasOwn(ENGINES, target) || Object.hasOwn(TOOLS, target)`.
const REMOVABLE = [...new Set([...Object.keys(ENGINES), ...Object.keys(TOOLS)])];

// --- the bug: `uninstall` shipped with no completion at all -----------------

test("uninstall and its remove alias are offered as top-level commands", () => {
  const top = new Set(names(completionModel().top));
  assert.ok(top.has("uninstall"), "uninstall missing from top-level completion");
  assert.ok(top.has("remove"), "remove missing from top-level completion");
});

test("typing `moshcode un` completes to uninstall in bash", () => {
  assert.deepEqual(bashCompletions(["moshcode", "un"]), ["uninstall"]);
});

test("`moshcode uninstall <TAB>` offers every engine and tool it can remove", () => {
  const offered = new Set(bashCompletions(["moshcode", "uninstall", ""]));
  for (const name of REMOVABLE) {
    assert.ok(offered.has(name), `${name} can be uninstalled but is not offered`);
  }
});

test("the remove alias completes its targets too", () => {
  assert.deepEqual(
    new Set(bashCompletions(["moshcode", "remove", ""])),
    new Set(bashCompletions(["moshcode", "uninstall", ""])),
  );
});

test("uninstall flags complete after a target", () => {
  const offered = new Set(bashCompletions(["moshcode", "uninstall", "claude", "--"]));
  assert.ok(offered.has("--yes"), "--yes is required to delete a binary but is not offered");
  assert.ok(offered.has("--dry-run"));
});

test("zsh and fish completions cover uninstall as well as bash", () => {
  for (const shell of ["zsh", "fish"]) {
    const script = completionScript(shell);
    assert.match(script, /\buninstall\b/, `${shell} completion never mentions uninstall`);
    assert.match(script, /\bremove\b/, `${shell} completion never mentions remove`);
  }
});

test("every command bin/moshcode.mjs dispatches on is completable", () => {
  // The same guarantee completion.test.mjs asserts, kept here so a new command
  // added without a completion entry fails next to the uninstall regression.
  const source = readFileSync(BIN, "utf8");
  const dispatched = [...source.matchAll(/cmd === "([^"]+)"/g)].map((m) => m[1]);
  const top = new Set(names(completionModel().top));
  assert.ok(dispatched.includes("uninstall"), "guard is stale: uninstall is no longer dispatched");
  for (const command of dispatched) {
    assert.ok(top.has(command), `${command} is dispatched but missing from completion`);
  }
});

// --- controls: these pass before and after, in the opposite direction -------
// They stop the fix buying a passing suite by over-offering or by disturbing
// the completions that already worked.

test("uninstall offers exactly the removable roster and nothing more", () => {
  assert.deepEqual(new Set(names(completionModel().uninstall)), new Set(REMOVABLE));
});

test("uninstall does not offer engine aliases, which its dispatch cannot resolve", () => {
  // `uninstall` looks the target up with Object.hasOwn(ENGINES, target), so an
  // alias would be offered and then rejected. install behaves the same way.
  const offered = new Set(names(completionModel().uninstall));
  for (const alias of Object.keys(ENGINE_ALIASES)) {
    assert.ok(!offered.has(alias), `${alias} is an alias and would not resolve`);
  }
});

test("install completion is unchanged by the uninstall wiring", () => {
  assert.deepEqual(new Set(names(completionModel().install)), new Set(REMOVABLE));
  assert.deepEqual(new Set(bashCompletions(["moshcode", "install", ""])), new Set(REMOVABLE));
});

test("an unrelated command still completes nothing", () => {
  assert.deepEqual(bashCompletions(["moshcode", "whoami", ""]), []);
});

test("uninstall completes targets only in the target position", () => {
  // COMP_CWORD 3 without a flag prefix must not re-offer the roster.
  const offered = bashCompletions(["moshcode", "uninstall", "claude", ""]);
  assert.deepEqual(offered, []);
});

test("the generated scripts still parse in their own shell where available", () => {
  const bash = spawnSync("bash", ["-n", "-c", completionScript("bash")], { encoding: "utf8" });
  assert.equal(bash.status, 0, bash.stderr);
});
