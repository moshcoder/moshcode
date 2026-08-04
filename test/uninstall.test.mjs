// Taking a tool back off the machine.
//
// The dangerous branch is the one that deletes a file, so most of this is about
// when it refuses to.
import assert from "node:assert/strict";
import test from "node:test";

import { describeUninstall, npmPackageOf, safePrefixes, uninstallPlan } from "../src/uninstall.mjs";

const HOME = "/home/someone";
const npmEntry = { bin: "claude", desc: "…", install: { cmd: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"] } };
const scriptEntry = { bin: "opencode", desc: "…", install: { cmd: "bash", args: ["-c", "curl -fsSL https://opencode.ai/install | bash"] } };

test("an npm install is undone by npm", () => {
  const plan = uninstallPlan(npmEntry, { binPath: "/usr/bin/claude", home: HOME });

  // npm knows what it put where, so the binary's location does not matter —
  // note this passes a path that the binary branch would refuse.
  assert.equal(plan.kind, "npm");
  assert.deepEqual(plan.steps, [{ kind: "run", command: "npm", args: ["uninstall", "-g", "@anthropic-ai/claude-code"] }]);
});

test("the package name is read out of the install spec", () => {
  assert.equal(npmPackageOf({ cmd: "npm", args: ["install", "-g", "@openai/codex"] }), "@openai/codex");
  assert.equal(npmPackageOf({ cmd: "pnpm", args: ["add", "-g", "thing"] }), "thing");
  assert.equal(npmPackageOf({ cmd: "npm", args: ["install", "--global", "thing"] }), "thing");

  // Not npm, or not global — neither has an npm inverse.
  assert.equal(npmPackageOf({ cmd: "bash", args: ["-c", "curl … | bash"] }), null);
  assert.equal(npmPackageOf({ cmd: "npm", args: ["install", "thing"] }), null, "a local install is not ours");
  assert.equal(npmPackageOf(null), null);
});

test("a script install removes the binary it dropped", () => {
  const plan = uninstallPlan(scriptEntry, { binPath: `${HOME}/.local/bin/opencode`, home: HOME });

  assert.equal(plan.kind, "binary");
  assert.deepEqual(plan.steps, [{ kind: "remove", path: `${HOME}/.local/bin/opencode` }]);
  // Said out loud, because "uninstalled" reads as "gone" and it is not.
  assert.match(plan.warnings.join(" "), /config, caches, credentials — stays/);
});

test("it refuses to delete a binary it could not have installed", () => {
  // The whole point of the allow-list. A binary here came from a package
  // manager or from someone's own hands, and deleting it because a prompt was
  // clicked through is worse than not offering.
  for (const path of ["/usr/bin/opencode", "/bin/opencode", "/snap/bin/opencode", "/etc/opencode"]) {
    const plan = uninstallPlan(scriptEntry, { binPath: path, home: HOME });
    assert.equal(plan.kind, "refused", path);
    assert.equal(plan.steps.length, 0, `${path} must produce no steps`);
    assert.match(plan.warnings.join(" "), /not in a directory moshcode installs into/);
  }
});

test("the places a per-user installer legitimately writes are allowed", () => {
  for (const dir of safePrefixes(HOME)) {
    const plan = uninstallPlan(scriptEntry, { binPath: `${dir}/opencode`, home: HOME });
    assert.equal(plan.kind, "binary", dir);
  }
});

test("a Go-installed Alpaca binary can be removed from the default GOPATH", () => {
  const entry = { bin: "alpaca", install: { cmd: "go", args: ["install", "github.com/alpacahq/cli/cmd/alpaca@latest"] } };
  const plan = uninstallPlan(entry, { binPath: `${HOME}/go/bin/alpaca`, home: HOME });
  assert.equal(plan.kind, "binary");
  assert.deepEqual(plan.steps, [{ kind: "remove", path: `${HOME}/go/bin/alpaca` }]);
});

test("a tool that is not there says so rather than failing", () => {
  const plan = uninstallPlan(scriptEntry, { binPath: null, home: HOME });
  assert.equal(plan.kind, "absent");
  assert.equal(plan.steps.length, 0);
  assert.match(plan.warnings.join(" "), /not on your PATH/);
});

test("a plan reads as something you can agree to first", () => {
  assert.match(describeUninstall(uninstallPlan(npmEntry, { home: HOME })), /run\s+npm uninstall -g/);
  assert.match(
    describeUninstall(uninstallPlan(scriptEntry, { binPath: `${HOME}/bin/opencode`, home: HOME })),
    /remove\s+\/home\/someone\/bin\/opencode/,
  );
});
