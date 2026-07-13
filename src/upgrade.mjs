// `moshcode upgrade` — update everything that has a newer version: moshcode,
// installed coding engines, and installed workflow tools. Conductor pattern:
// re-run each target's own updater/installer (they fetch latest), never vendor.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { ENGINES, engineStatus, resolveEngine, upgradeSpec, runCmd } from "./engines.mjs";
import { TOOLS, resolveTool, toolStatus, toolUpgradeSpec } from "./tools.mjs";

// Self-upgrade re-runs the moshcode installer's `update` path. Defaults to the
// GitHub-hosted install.sh (always live); override with MOSHCODE_INSTALL_URL.
const SELF_URL = process.env.MOSHCODE_INSTALL_URL
  || "https://raw.githubusercontent.com/moshcoder/moshcode/main/install.sh";

// Where the *running* moshcode actually lives (…/<home>/src/upgrade.mjs → <home>).
// We point the installer at this so it updates THIS copy in place, not a default
// path that might not be the one on your PATH.
export const MOSHCODE_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Running from a git checkout? Then a reinstall would blow away the working tree
// — update it with `git pull`, not the installer.
function isGitCheckout(dir) {
  return fs.existsSync(path.join(dir, ".git"));
}

function selfVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(MOSHCODE_HOME, "package.json"), "utf8")).version || null; }
  catch { return null; }
}

function selfSpec() {
  // Export MOSHCODE_HOME so install.sh updates the exact dir we run from.
  return { cmd: "sh", args: ["-c", `export MOSHCODE_HOME='${MOSHCODE_HOME}'; curl -fsSL ${SELF_URL} | sh -s -- update`] };
}

/**
 * Work out an upgrade plan from optional targets:
 *   []/["all"]            → moshcode + every installed engine and tool
 *   ["self"|"moshcode"]   → moshcode only
 *   ["engines"]           → all installed engines (no self)
 *   ["tools"]             → all installed tools (no self)
 *   ["claude"|"ugig", …] → named targets (install if not present yet)
 * Returns { self, items:[{key,label,kind,spec,installed}], unknown:[] }.
 */
export function planUpgrade(targets = []) {
  const t = targets.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const engines = engineStatus();
  const tools = toolStatus();
  const engineByKey = Object.fromEntries(engines.map((entry) => [entry.key, entry]));
  const toolByKey = Object.fromEntries(tools.map((entry) => [entry.key, entry]));

  const wantsAll = t.length === 0 || t.includes("all");
  const wantsSelf = wantsAll || t.includes("self") || t.includes("moshcode");
  const wantsEngines = wantsAll || t.includes("engines");
  const wantsTools = wantsAll || t.includes("tools");

  const items = [];
  const unknown = [];
  const seen = new Set();

  const addEngine = (key) => {
    const id = `engine:${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    items.push({
      key,
      label: key,
      kind: "engine",
      spec: upgradeSpec(ENGINES[key]),
      installed: engineByKey[key].installed,
    });
  };
  const addTool = (key) => {
    const id = `tool:${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    items.push({
      key,
      label: key,
      kind: "tool",
      spec: toolUpgradeSpec(TOOLS[key]),
      installed: toolByKey[key].installed,
    });
  };

  if (wantsEngines) {
    for (const engine of engines) if (engine.installed) addEngine(engine.key);
  }
  if (wantsTools) {
    for (const tool of tools) if (tool.installed) addTool(tool.key);
  }
  // Explicit names/engine aliases upgrade even when not currently installed.
  for (const tok of t) {
    if (["all", "self", "moshcode", "engines", "tools"].includes(tok)) continue;
    const engine = resolveEngine(tok);
    const tool = resolveTool(tok);
    if (engine) addEngine(engine[0]);
    else if (tool) addTool(tool[0]);
    else unknown.push(tok);
  }

  return { self: wantsSelf, items, unknown };
}

/**
 * Run an upgrade plan sequentially, streaming each tool's own output. `io.log`
 * prints a status line, `io.rule` draws a divider around each hand-off (both
 * optional — default to plain console output). Returns a summary array.
 */
export async function runUpgrade(targets = [], io = {}) {
  const log = io.log || ((s) => console.log(s));
  const rule = io.rule || (() => console.log("─".repeat(48)));
  const { self, items, unknown } = planUpgrade(targets);

  for (const u of unknown) log(`? skipping unknown upgrade target "${u}"`);

  if (!self && items.length === 0) {
    if (!unknown.length) log("nothing to upgrade — no matching engines or tools are installed.");
    return [];
  }

  const results = [];
  const run = async (name, spec, note) => {
    log(`\n⬆ upgrading ${name}${note ? ` ${note}` : ""} — ${spec.cmd} ${spec.args.join(" ")}`);
    rule();
    const r = await runCmd(spec.cmd, spec.args);
    rule();
    const ok = r.ok && (r.code == null || r.code === 0);
    log(ok ? `✓ ${name} up to date` : `✗ ${name} upgrade failed${r.code != null ? ` (code ${r.code})` : r.error ? `: ${r.error.message || r.error}` : ""}`);
    results.push({ name, ok, code: r.code });
    return ok;
  };

  if (self) {
    if (isGitCheckout(MOSHCODE_HOME)) {
      // Don't reinstall over a working tree — just tell the user how to update it.
      log(`\n· moshcode runs from a git checkout (${MOSHCODE_HOME}) — \`git pull\` there to update it (skipping self-reinstall).`);
    } else {
      const before = selfVersion();
      const ok = await run("moshcode", selfSpec(), "(self)");
      const after = selfVersion();
      if (ok && before && after) {
        log(before === after ? `· moshcode already at ${after}` : `· moshcode ${before} → ${after} — restart moshcode to load it.`);
      }
    }
  }
  for (const it of items) await run(it.label, it.spec, it.installed ? "" : "(installing — not present)");

  const failed = results.filter((r) => !r.ok);
  log(`\n${failed.length ? "✗" : "✓"} upgraded ${results.length - failed.length}/${results.length}${failed.length ? ` — failed: ${failed.map((r) => r.name).join(", ")}` : "."} 🤘`);
  return results;
}
