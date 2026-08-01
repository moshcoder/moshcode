// prd/0003 R8: `/skill install` MUST report the engines that have no skills
// primitive as skipped. The plan is what the summary prints, so an engine the
// plan omits is an engine the user never hears about.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ENGINES } from "../src/engines.mjs";
import {
  SKILL_ENGINES, claudeSkillsDir, planSkillInstall, runSkillInstall,
} from "../src/skills.mjs";

const SPEC = { source: "https://github.com/acme/some-skill", name: "some-skill" };
const NO_PRIMITIVE = Object.keys(ENGINES).filter((key) => !SKILL_ENGINES.includes(key));
const byKey = (results) => Object.fromEntries(results.map((r) => [r.key, r]));

// --- the bug -----------------------------------------------------------------

test("the plan covers every engine, not just the ones with a primitive", () => {
  const keys = planSkillInstall(SPEC, { installedSet: new Set() }).map((p) => p.key);
  assert.deepEqual([...keys].sort(), Object.keys(ENGINES).sort());
});

test("every engine without a primitive carries the skip reason", () => {
  const plan = byKey(planSkillInstall(SPEC, { installedSet: new Set() }));
  for (const key of NO_PRIMITIVE) {
    assert.equal(plan[key]?.skip, "no skills primitive", `${key} has no skip reason`);
  }
});

test("the fan-out reports them as skipped, so the summary can print a line", async () => {
  const plan = planSkillInstall(SPEC, { installedSet: new Set(["claude", "gemini"]) });
  const results = byKey(await runSkillInstall(plan, { run: async () => ({ ok: true, code: 0 }) }));
  for (const key of NO_PRIMITIVE) {
    assert.equal(results[key]?.status, "skipped", `${key} missing from the summary`);
    assert.equal(results[key]?.reason, "no skills primitive");
  }
});

test("skipped beats not-installed: an absent engine still gets its reason", async () => {
  // Nothing installed at all — the user must still learn *why* codex got
  // nothing, rather than being told to go and install it.
  const plan = planSkillInstall(SPEC, { installedSet: new Set() });
  const results = byKey(await runSkillInstall(plan, { run: async () => ({ ok: true, code: 0 }) }));
  for (const key of NO_PRIMITIVE) {
    assert.equal(results[key]?.status, "skipped", `${key} reported as ${results[key]?.status}`);
  }
});

test("an installed engine without a primitive is skipped, never spawned", async () => {
  const spawned = [];
  const plan = planSkillInstall(SPEC, { installedSet: new Set(Object.keys(ENGINES)) });
  const results = byKey(await runSkillInstall(plan, {
    run: async (cmd, args) => { spawned.push([cmd, ...args]); return { ok: true, code: 0 }; },
  }));

  for (const key of NO_PRIMITIVE) assert.equal(results[key]?.status, "skipped");
  assert.equal(spawned.length, SKILL_ENGINES.length);
  for (const [cmd] of spawned) assert.ok(["git", "gemini"].includes(cmd), `spawned ${cmd}`);
});

test("privacycode — an engine added after SKILL_ENGINES was written — is reported", () => {
  // The exact failure the /skill list matrix comment warns about: a hardcoded
  // list silently drops any engine added later.
  const plan = byKey(planSkillInstall(SPEC, { installedSet: new Set() }));
  assert.equal(plan.privacycode?.skip, "no skills primitive");
});

test("the fan-out and the /skill list matrix name the same engines", async () => {
  const results = await runSkillInstall(
    planSkillInstall(SPEC, { installedSet: new Set() }),
    { run: async () => ({ ok: true, code: 0 }) },
  );
  assert.deepEqual(results.map((r) => r.key).sort(), Object.keys(ENGINES).sort());
});

test("every planned engine carries a real bin, so the summary can name it", () => {
  for (const item of planSkillInstall(SPEC, { installedSet: new Set() })) {
    assert.equal(item.bin, ENGINES[item.key].bin);
  }
});

// --- controls: the fix must not buy green by over-reporting -------------------

test("the engines with a primitive still come first, in SKILL_ENGINES order", () => {
  const keys = planSkillInstall(SPEC, { installedSet: new Set() }).map((p) => p.key);
  assert.deepEqual(keys.slice(0, SKILL_ENGINES.length), SKILL_ENGINES);
});

test("SKILL_ENGINES is unchanged: no engine gained a primitive", () => {
  assert.deepEqual(SKILL_ENGINES, ["claude", "gemini"]);
});

test("claude still clones the source into its skills dir, byte for byte", () => {
  const claude = byKey(planSkillInstall(SPEC, { installedSet: new Set(["claude"]) })).claude;
  assert.equal(claude.skip, undefined);
  assert.equal(claude.cmd, "git");
  assert.deepEqual(claude.args, [
    "clone", "--depth", "1", SPEC.source, path.join(claudeSkillsDir(), "some-skill"),
  ]);
});

test("gemini still installs natively, byte for byte", () => {
  const gemini = byKey(planSkillInstall(SPEC, { installedSet: new Set(["gemini"]) })).gemini;
  assert.equal(gemini.skip, undefined);
  assert.equal(gemini.cmd, "gemini");
  assert.deepEqual(gemini.args, ["skills", "install", SPEC.source, "--scope", "user"]);
});

test("installed / not-installed still decides the outcome for a real target", async () => {
  const plan = planSkillInstall(SPEC, { installedSet: new Set(["gemini"]) });
  const results = byKey(await runSkillInstall(plan, { run: async () => ({ ok: true, code: 0 }) }));
  assert.equal(results.gemini.status, "installed");
  assert.equal(results.claude.status, "not-installed");
});

test("a real install killed by a signal still reports failed", async () => {
  const plan = planSkillInstall(SPEC, { installedSet: new Set(["gemini"]) });
  const results = byKey(await runSkillInstall(plan, {
    run: async () => ({ ok: true, code: null, signal: "SIGKILL" }),
  }));
  assert.equal(results.gemini.status, "failed");
  assert.equal(results.gemini.signal, "SIGKILL");
});

test("a failing exit code is still a failure, not a skip", async () => {
  const plan = planSkillInstall(SPEC, { installedSet: new Set(["gemini"]) });
  const results = byKey(await runSkillInstall(plan, {
    run: async () => ({ ok: true, code: 128, signal: null }),
  }));
  assert.equal(results.gemini.status, "failed");
  assert.equal(results.gemini.code, 128);
});

test("no engine is planned twice", () => {
  const keys = planSkillInstall(SPEC, { installedSet: new Set() }).map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length);
});
