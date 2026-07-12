// `moshcode upgrade` — update everything that has a newer version: moshcode
// itself and every installed coding engine. Conductor pattern: we just re-run
// each tool's own updater/installer (they fetch latest), never vendor them.
import { ENGINES, engineStatus, resolveEngine, upgradeSpec, runCmd } from "./engines.mjs";

// Self-upgrade re-runs the moshcode installer's `update` path. Defaults to the
// GitHub-hosted install.sh (always live); override with MOSHCODE_INSTALL_URL.
const SELF_URL = process.env.MOSHCODE_INSTALL_URL
  || "https://raw.githubusercontent.com/moshcoder/moshcode/main/install.sh";

function selfSpec() {
  return { cmd: "sh", args: ["-c", `curl -fsSL ${SELF_URL} | sh -s -- update`] };
}

/**
 * Work out an upgrade plan from optional targets:
 *   []/["all"]            → moshcode + every *installed* engine
 *   ["self"|"moshcode"]   → moshcode only
 *   ["engines"]           → all installed engines (no self)
 *   ["claude", …]         → those engines (installs the ones not present yet)
 * Returns { self, items:[{key,label,spec,installed}], unknown:[] }.
 */
export function planUpgrade(targets = []) {
  const t = targets.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const status = engineStatus();
  const byKey = Object.fromEntries(status.map((e) => [e.key, e]));

  const wantsAll = t.length === 0 || t.includes("all");
  const wantsSelf = wantsAll || t.includes("self") || t.includes("moshcode");
  const wantsEngines = wantsAll || t.includes("engines");

  const items = [];
  const unknown = [];
  const seen = new Set();

  const add = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const st = byKey[key];
    items.push({ key, label: key, spec: upgradeSpec(ENGINES[key]), installed: st.installed });
  };

  if (wantsEngines) {
    for (const e of status) if (e.installed) add(e.key);
  }
  // Explicitly-named engines/aliases (upgrade even if not among "installed").
  for (const tok of t) {
    if (["all", "self", "moshcode", "engines"].includes(tok)) continue;
    const resolved = resolveEngine(tok);
    if (resolved) add(resolved[0]);
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

  for (const u of unknown) log(`? skipping unknown engine "${u}"`);

  if (!self && items.length === 0) {
    if (!unknown.length) log("nothing to upgrade — no engines installed. install one: moshcode install claude");
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

  if (self) await run("moshcode", selfSpec(), "(self)");
  for (const it of items) await run(it.label, it.spec, it.installed ? "" : "(installing — not present)");

  const failed = results.filter((r) => !r.ok);
  log(`\n${failed.length ? "✗" : "✓"} upgraded ${results.length - failed.length}/${results.length}${failed.length ? ` — failed: ${failed.map((r) => r.name).join(", ")}` : "."} 🤘`);
  if (self) log("· restart moshcode to pick up its own new version.");
  return results;
}
