import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SKILL_ENGINES, claudeSkillsDir, planSkillInstall, runSkillInstall, skillInstallAction, skillName,
} from "../src/skills.mjs";

test("skillName derives from a git url or path, or takes an override", () => {
  assert.equal(skillName("https://github.com/acme/cool-skill.git"), "cool-skill");
  assert.equal(skillName("https://github.com/acme/cool-skill"), "cool-skill");
  assert.equal(skillName("/local/path/my-skill/"), "my-skill");
  assert.equal(skillName("whatever", "Custom Name"), "custom-name");
});

test("skillInstallAction: gemini installs natively, claude clones into its skills dir", () => {
  const gemini = skillInstallAction("gemini", { source: "https://x/y", name: "y" });
  assert.deepEqual(gemini, { cmd: "gemini", args: ["skills", "install", "https://x/y", "--scope", "user"] });

  const claude = skillInstallAction("claude", { source: "https://x/y", name: "y" });
  assert.deepEqual(claude, { cmd: "git", args: ["clone", "--depth", "1", "https://x/y", path.join(claudeSkillsDir(), "y")] });
});

test("skillInstallAction: engines without a skills primitive are skipped", () => {
  for (const key of ["codex", "opencode", "aider"]) {
    assert.ok(skillInstallAction(key, { source: "x", name: "x" }).skip);
  }
});

test("claudeSkillsDir points at the personal skills directory", () => {
  assert.equal(claudeSkillsDir(), path.join(os.homedir(), ".claude", "skills"));
});

test("SKILL_ENGINES is exactly the engines with a skills primitive", () => {
  assert.deepEqual(SKILL_ENGINES, ["claude", "gemini"]);
});

test("runSkillInstall summarizes installed / not-installed", async () => {
  const plan = planSkillInstall({ source: "https://x/y", name: "y" }, { installedSet: new Set(["gemini"]) });
  const results = await runSkillInstall(plan, { run: async () => ({ ok: true, code: 0 }) });
  const byKey = Object.fromEntries(results.map((r) => [r.key, r.status]));
  assert.equal(byKey.gemini, "installed");
  assert.equal(byKey.claude, "not-installed");
});
