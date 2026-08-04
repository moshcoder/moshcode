// Install Agent Skills across every engine that has a skills primitive, from one
// source (a git URL or local path). Gemini installs natively; Claude clones the
// source into its personal skills dir. See prd/0003.
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
 * The install action for one engine: a spawnable { cmd, args } or a { skip }
 * reason. `spec: { source, name }`.
 */
export function skillInstallAction(key, spec) {
  const { source, name } = spec;
  switch (key) {
    case "gemini":
      return { cmd: "gemini", args: ["skills", "install", source, "--scope", "user"] };
    case "claude":
      // Claude has no `skill install`; clone the source into its skills dir.
      return { cmd: "git", args: ["clone", "--depth", "1", source, path.join(claudeSkillsDir(), name)] };
    case "kimi":
      // Kimi Code discovers skills by scanning directories, with no install
      // command of its own — so clone into the one it scans, as Claude does.
      return { cmd: "git", args: ["clone", "--depth", "1", source, path.join(kimiSkillsDir(), name)] };
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
export async function runSkillInstall(plan, { run = runCmd } = {}) {
  const results = [];
  for (const item of plan) {
    if (item.skip) { results.push({ key: item.key, status: "skipped", reason: item.skip }); continue; }
    if (!item.installed) { results.push({ key: item.key, status: "not-installed" }); continue; }
    const r = await run(item.cmd, item.args);
    results.push({ key: item.key, status: ranOk(r) ? "installed" : "failed", code: r.code, signal: r.signal ?? null });
  }
  return results;
}
