// Install Agent Skills across every engine that has a skills primitive, from one
// source (a git URL or local path). Gemini installs natively; Claude clones the
// source into its personal skills dir. See prd/0003.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENGINES, isInstalled, ranOk, runCmd } from "./engines.mjs";

// Coding engines with a skills primitive. Codex/OpenCode/Aider have none.
export const SKILL_ENGINES = ["claude", "gemini", "kimi"];

/** Claude's global personal skills directory (~/.claude/skills). */
export function claudeSkillsDir() {
  return path.join(os.homedir(), ".claude", "skills");
}

/**
 * Kimi Code's global skills directory ($KIMI_CODE_HOME/skills, default
 * ~/.kimi-code/skills). Kimi's own user-level skill dir moves with that
 * variable, so read it rather than hardcoding the default away.
 */
export function kimiSkillsDir(env = process.env) {
  return path.join(env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code"), "skills");
}

/** Derive a skill name from a git URL or path (basename minus `.git`), or use the override. */
export function skillName(source, override) {
  const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  // `.` and `..` are directory references, not names: path.join would collapse
  // them and land the clone on the skills dir itself (or its parent).
  const named = (s) => (s === "." || s === ".." ? "" : s);
  if (override) return named(sanitize(override)) || "skill";
  const raw = String(source).replace(/[/\\]+$/, "");
  const base = raw.split(/[/\\]/).pop() || "skill";
  const derived = named(sanitize(base.replace(/\.git$/i, "")));
  if (derived) return derived;
  // A `.` / `..` source means "this directory", so name the skill after the
  // directory it resolves to: `skill install .` installs the repo you are in.
  return named(sanitize(path.basename(path.resolve(raw)))) || "skill";
}

/**
 * What a freshly cloned skill source actually contains.
 *
 * A repository is not always one skill. `SKILL.md` at the root is the common
 * shape and the one this module assumed. But a repository can equally be a
 * *collection* — subdirectories that each hold a `SKILL.md` — and every engine
 * that discovers skills by scanning looks exactly one level deep. Cloning a
 * collection whole therefore lands every skill one level too deep, where
 * nothing will ever find them, while `git clone` still exits 0 and the install
 * reports success. Detecting the shape is what makes that failure impossible.
 */
export function skillCollection(dir) {
  if (!fs.existsSync(dir)) return { kind: "empty", names: [] };
  if (fs.existsSync(path.join(dir, "SKILL.md"))) return { kind: "single", names: [] };
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .filter((d) => fs.existsSync(path.join(dir, d.name, "SKILL.md")))
    .map((d) => d.name)
    .sort();
  return names.length ? { kind: "collection", names } : { kind: "empty", names: [] };
}

/**
 * Settle a fresh clone into the shape the engine scans, and report what it was.
 *
 * `single` is left exactly as cloned. `collection` has each skill moved up
 * beside its siblings and the wrapper removed — the wrapper holds the
 * repository's own README, tooling and CI, none of which is a skill. `empty`
 * removes the clone rather than leaving a directory that can never resolve.
 *
 * A skill whose name is already taken is left alone and reported in `kept`:
 * this runs inside the user's real skills directory, so a name collision must
 * never silently replace a skill they already had.
 */
export function settleSkillClone(dir) {
  const { kind, names } = skillCollection(dir);
  if (kind === "single") return { kind, installed: [path.basename(dir)], kept: [] };
  if (kind === "empty") {
    fs.rmSync(dir, { recursive: true, force: true });
    return { kind, installed: [], kept: [] };
  }
  const parent = path.dirname(dir);
  const installed = [];
  const kept = [];
  for (const name of names) {
    const dest = path.join(parent, name);
    if (fs.existsSync(dest)) { kept.push(name); continue; }
    fs.renameSync(path.join(dir, name), dest);
    installed.push(name);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { kind, installed, kept };
}

/**
 * The install action for one engine: a spawnable { cmd, args } or a { skip }
 * reason. `spec: { source, name }`.
 */
export function skillInstallAction(key, spec) {
  const { source, name } = spec;
  switch (key) {
    case "gemini":
      return { cmd: "gemini", args: ["skills", "install", source, "--scope", "user"] };
    case "claude": {
      // Claude has no `skill install`; clone the source into its skills dir.
      // `settle` is the cloned path: a scanning engine needs the clone resolved
      // into one-level-deep skills afterwards (see settleSkillClone).
      const dir = path.join(claudeSkillsDir(), name);
      return { cmd: "git", args: ["clone", "--depth", "1", source, dir], settle: dir };
    }
    case "kimi": {
      // Kimi Code discovers skills by scanning directories, with no install
      // command of its own — so clone into the one it scans, as Claude does.
      const dir = path.join(kimiSkillsDir(), name);
      return { cmd: "git", args: ["clone", "--depth", "1", source, dir], settle: dir };
    }
    default:
      return { skip: "no skills primitive" };
  }
}

/**
 * Plan the fan-out: one entry per engine with its action or skip reason.
 * Every engine, not just SKILL_ENGINES — prd/0003 R8 requires the engines with
 * no skills primitive to be *reported* as skipped, and an engine missing from
 * the plan is missing from the summary. Derived from ENGINES the same way the
 * /skill list matrix derives it, so an engine added later cannot quietly fall
 * out of the fan-out while still showing up in the matrix.
 */
export function planSkillInstall(spec, { installedSet } = {}) {
  const rest = Object.keys(ENGINES).filter((key) => !SKILL_ENGINES.includes(key));
  return [...SKILL_ENGINES, ...rest].map((key) => {
    const bin = ENGINES[key].bin;
    const installed = installedSet ? installedSet.has(key) : isInstalled(bin, ENGINES[key].binDirs);
    return { key, bin, installed, ...skillInstallAction(key, spec) };
  });
}

/**
 * Execute a skill-install plan. Returns results
 * [{ key, status: "installed"|"skipped"|"failed"|"not-installed", reason? }].
 * `run` is injectable for tests.
 */
export async function runSkillInstall(plan, { run = runCmd, settle = settleSkillClone } = {}) {
  const results = [];
  for (const item of plan) {
    if (item.skip) { results.push({ key: item.key, status: "skipped", reason: item.skip }); continue; }
    if (!item.installed) { results.push({ key: item.key, status: "not-installed" }); continue; }
    const r = await run(item.cmd, item.args);
    const base = { key: item.key, code: r.code, signal: r.signal ?? null };
    if (!ranOk(r)) { results.push({ ...base, status: "failed" }); continue; }
    if (!item.settle) { results.push({ ...base, status: "installed" }); continue; }

    // The clone succeeded, which is not the same as a skill being installed.
    const { kind, installed, kept } = settle(item.settle);
    if (kind === "empty") {
      results.push({ ...base, status: "failed", reason: "no SKILL.md at the root or in any subdirectory" });
      continue;
    }
    results.push({ ...base, status: "installed", kind, skills: installed, ...(kept.length ? { kept } : {}) });
  }
  return results;
}
