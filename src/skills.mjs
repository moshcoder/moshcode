// Install Agent Skills across every engine that has a skills primitive, from one
// source (a git URL or local path). Gemini installs natively; Claude clones the
// source into its personal skills dir. See prd/0003.
import os from "node:os";
import path from "node:path";
import { ENGINES, isInstalled, runCmd } from "./engines.mjs";

// Coding engines with a skills primitive. Codex/OpenCode/Aider have none.
export const SKILL_ENGINES = ["claude", "gemini"];

/** Claude's global personal skills directory (~/.claude/skills). */
export function claudeSkillsDir() {
  return path.join(os.homedir(), ".claude", "skills");
}

/** Derive a skill name from a git URL or path (basename minus `.git`), or use the override. */
export function skillName(source, override) {
  const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  if (override) return sanitize(override) || "skill";
  const base = String(source).replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "skill";
  return sanitize(base.replace(/\.git$/i, "")) || "skill";
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
    default:
      return { skip: "no skills primitive" };
  }
}

/** Plan the fan-out: one entry per skills engine with its action or skip reason. */
export function planSkillInstall(spec, { installedSet } = {}) {
  return SKILL_ENGINES.map((key) => {
    const bin = ENGINES[key].bin;
    const installed = installedSet ? installedSet.has(key) : isInstalled(bin);
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
    results.push({ key: item.key, status: r.ok && (r.code === 0 || r.code == null) ? "installed" : "failed", code: r.code });
  }
  return results;
}
