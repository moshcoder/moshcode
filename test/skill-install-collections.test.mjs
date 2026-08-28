// A skills repository is not always one skill. Engines that discover skills by
// scanning look exactly one level deep, so cloning a *collection* whole lands
// every skill one level too deep — where nothing finds them — while `git clone`
// exits 0 and the install reports success. These tests pin the shape detection
// that makes that silent failure impossible.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  planSkillInstall, runSkillInstall, settleSkillClone, skillCollection,
} from "../src/skills.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-skills-"));
const skill = (dir, name) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
};

// --- shape detection ---------------------------------------------------------

test("a SKILL.md at the root is one skill", () => {
  const root = tmp();
  const dir = path.join(root, "some-skill");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: some-skill\n---\n");
  assert.deepEqual(skillCollection(dir), { kind: "single", names: [] });
});

test("subdirectories holding SKILL.md are a collection", () => {
  const root = tmp();
  const dir = path.join(root, "a-collection");
  fs.mkdirSync(dir);
  skill(dir, "beta");
  skill(dir, "alpha");
  // A collection's own tooling must not be mistaken for a skill.
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "README.md"), "# not a skill\n");
  assert.deepEqual(skillCollection(dir), { kind: "collection", names: ["alpha", "beta"] });
});

test("a repository with no SKILL.md anywhere is empty, not a collection", () => {
  const root = tmp();
  const dir = path.join(root, "not-skills");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# nope\n");
  assert.deepEqual(skillCollection(dir), { kind: "empty", names: [] });
});

test("dot-directories are not skills", () => {
  const root = tmp();
  const dir = path.join(root, "c");
  fs.mkdirSync(dir);
  skill(dir, ".hidden");
  assert.equal(skillCollection(dir).kind, "empty");
});

// --- settling ----------------------------------------------------------------

test("settling a collection lifts each skill one level and drops the wrapper", () => {
  const root = tmp();
  const dir = path.join(root, "a-collection");
  fs.mkdirSync(dir);
  skill(dir, "alpha");
  skill(dir, "beta");

  const res = settleSkillClone(dir);

  assert.deepEqual(res.installed, ["alpha", "beta"]);
  assert.equal(fs.existsSync(dir), false, "the wrapper must not survive");
  for (const name of ["alpha", "beta"]) {
    assert.ok(fs.existsSync(path.join(root, name, "SKILL.md")), `${name} must sit one level deep`);
  }
});

test("settling leaves a single skill exactly where it was cloned", () => {
  const root = tmp();
  const dir = path.join(root, "some-skill");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: some-skill\n---\n");

  const res = settleSkillClone(dir);

  assert.equal(res.kind, "single");
  assert.deepEqual(res.installed, ["some-skill"]);
  assert.ok(fs.existsSync(path.join(dir, "SKILL.md")));
});

test("settling never replaces a skill the user already had", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "alpha"));
  fs.writeFileSync(path.join(root, "alpha", "SKILL.md"), "MINE");

  const dir = path.join(root, "a-collection");
  fs.mkdirSync(dir);
  skill(dir, "alpha");
  skill(dir, "beta");

  const res = settleSkillClone(dir);

  assert.deepEqual(res.kept, ["alpha"]);
  assert.deepEqual(res.installed, ["beta"]);
  assert.equal(fs.readFileSync(path.join(root, "alpha", "SKILL.md"), "utf8"), "MINE");
});

test("settling an empty clone removes it rather than leaving a dead directory", () => {
  const root = tmp();
  const dir = path.join(root, "not-skills");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# nope\n");

  assert.equal(settleSkillClone(dir).kind, "empty");
  assert.equal(fs.existsSync(dir), false);
});

// --- the fan-out reports what actually happened ------------------------------

const SPEC = { source: "https://github.com/acme/a-collection", name: "a-collection" };
const claudeOnly = () => planSkillInstall(SPEC, { installedSet: new Set(["claude"]) });
const ok = async () => ({ ok: true, code: 0 });
const byKey = (r) => Object.fromEntries(r.map((x) => [x.key, x]));

test("a collection install reports the skills it actually installed", async () => {
  const results = await runSkillInstall(claudeOnly(), {
    run: ok,
    settle: () => ({ kind: "collection", installed: ["alpha", "beta"], kept: [] }),
  });
  const claude = byKey(results).claude;
  assert.equal(claude.status, "installed");
  assert.equal(claude.kind, "collection");
  assert.deepEqual(claude.skills, ["alpha", "beta"]);
});

test("a clone that contains no skill is a failure, not a silent success", async () => {
  const results = await runSkillInstall(claudeOnly(), {
    run: ok,
    settle: () => ({ kind: "empty", installed: [], kept: [] }),
  });
  const claude = byKey(results).claude;
  assert.equal(claude.status, "failed", "git exiting 0 must not read as installed");
  assert.match(claude.reason, /no SKILL\.md/);
});

test("a failed clone is not settled at all", async () => {
  let settled = false;
  const results = await runSkillInstall(claudeOnly(), {
    run: async () => ({ ok: false, code: 128 }),
    settle: () => { settled = true; return { kind: "empty", installed: [], kept: [] }; },
  });
  assert.equal(byKey(results).claude.status, "failed");
  assert.equal(settled, false, "nothing to settle when the clone never landed");
});

test("gemini installs natively and is never settled", () => {
  const gemini = planSkillInstall(SPEC, { installedSet: new Set(["gemini"]) }).find((p) => p.key === "gemini");
  assert.equal(gemini.settle, undefined);
});
