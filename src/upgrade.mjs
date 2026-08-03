// `moshcode upgrade` — update everything that has a newer version: moshcode,
// installed coding engines, and installed workflow tools. Conductor pattern:
// re-run each target's own updater/installer (they fetch latest), never vendor.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { ENGINES, engineStatus, exitReason, ranOk, resolveEngine, upgradeSpec, runCmd } from "./engines.mjs";
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

// POSIX-safe single-quoting for values embedded in the `sh -c` command line:
// wrap in '…' and escape every ' as '\'' . Without this an apostrophe in the
// install path (e.g. /Users/o'brien/moshcode) broke self-upgrade with a shell
// syntax error — and a hostile path could break out of the quotes and inject
// extra shell into the update command.
const shQ = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

export function selfSpec(home = MOSHCODE_HOME, url = SELF_URL) {
  // Export MOSHCODE_HOME so install.sh updates the exact dir we run from.
  return { cmd: "sh", args: ["-c", `export MOSHCODE_HOME=${shQ(home)}; curl -fsSL ${shQ(url)} | sh -s -- update`] };
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

  // A native updater (`doppler update`, `aider --upgrade`) is the missing
  // binary itself, so it cannot be what installs it. When the target is not
  // present yet, run its installer — that is the command the "(installing —
  // not present)" note below promises. Installed targets keep the native
  // updater, which is the whole point of having one.
  const addEngine = (key) => {
    const id = `engine:${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    const installed = engineByKey[key].installed;
    items.push({
      key,
      label: key,
      kind: "engine",
      spec: installed ? upgradeSpec(ENGINES[key]) : ENGINES[key].install,
      // Where to turn when a native updater refuses. Only set when the updater
      // is something other than the installer, so a fallback can never repeat
      // the command that just failed.
      fallback: installed && upgradeSpec(ENGINES[key]) !== ENGINES[key].install ? ENGINES[key].install : null,
      installed,
    });
  };
  const addTool = (key) => {
    const id = `tool:${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    const installed = toolByKey[key].installed;
    items.push({
      key,
      label: key,
      kind: "tool",
      spec: installed ? toolUpgradeSpec(TOOLS[key]) : TOOLS[key].install,
      fallback: installed && toolUpgradeSpec(TOOLS[key]) !== TOOLS[key].install ? TOOLS[key].install : null,
      installed,
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

  // `sudo moshcode update` is the one escalation this CLI must never accept.
  // selfSpec re-runs the installer, and every path the installer uses comes
  // from $HOME — which sudo has set to /root. The update "succeeds", moshcode
  // is reinstalled into root's home, and the operator is left with a binary on
  // PATH they cannot execute. Engine and tool installers have the same shape:
  // they write into $HOME too.
  //
  // A bare root shell has no SUDO_USER and is a legitimate place to run this,
  // so only the escalated-from-a-real-user case is refused.
  const uid = io.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const env = io.env || process.env;
  if (uid === 0 && env.SUDO_USER && !env.MOSHCODE_ALLOW_ROOT) {
    log(`✗ don't run moshcode update with sudo.`);
    log("");
    log(`  It reinstalls moshcode, and the installer puts everything under $HOME —`);
    log(`  which sudo has set to ${env.HOME || "/root"}. That would install moshcode for`);
    log(`  root and leave ${env.SUDO_USER} with a moshcode on PATH it cannot execute.`);
    log("");
    log("  Run it as yourself instead:");
    log("      moshcode update");
    log("");
    log("  Commands that genuinely need root, like `dns enable`, now ask for it");
    log("  themselves — you do not need to escalate the whole CLI for those.");
    return [{ name: "moshcode", ok: false, code: 1, signal: null }];
  }

  const { self, items, unknown } = planUpgrade(targets);

  for (const u of unknown) log(`? skipping unknown upgrade target "${u}"`);

  if (!self && items.length === 0) {
    if (!unknown.length) log("nothing to upgrade — no matching engines or tools are installed.");
    return [];
  }

  const exec = io.runCmd || runCmd;

  const results = [];
  const attempt = async (name, spec, note) => {
    log(`\n⬆ upgrading ${name}${note ? ` ${note}` : ""} — ${spec.cmd} ${spec.args.join(" ")}`);
    rule();
    const r = await exec(spec.cmd, spec.args);
    rule();
    const ok = ranOk(r);
    log(ok ? `✓ ${name} up to date` : `✗ ${name} upgrade failed (${exitReason(r)})`);
    return { name, ok, code: r.code, signal: r.signal ?? null };
  };
  const run = async (name, spec, note) => {
    const result = await attempt(name, spec, note);
    results.push(result);
    return result.ok;
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
  for (const it of items) {
    const result = await attempt(it.label, it.spec, it.installed ? "" : "(installing — not present)");
    // A native updater that can't tell how the binary got there fails the same
    // way on every run — an opencode fork living under its own directory, a
    // binary someone moved, a machine where the installer left no marker. The
    // installer is idempotent and fetches the latest, so reach for it rather
    // than leaving the target stranded on an old version.
    if (!result.ok && it.fallback) {
      log(`· ${it.label}'s own updater could not do it — falling back to its installer`);
      results.push(await attempt(it.label, it.fallback, "(installer)"));
      continue;
    }
    results.push(result);
  }

  const failed = results.filter((r) => !r.ok);
  log(`\n${failed.length ? "✗" : "✓"} upgraded ${results.length - failed.length}/${results.length}${failed.length ? ` — failed: ${failed.map((r) => r.name).join(", ")}` : "."} 🤘`);
  return results;
}
