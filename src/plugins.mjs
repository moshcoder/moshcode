// `moshcode plugin` — install moshcode's own slash commands into an engine.
//
// The same shape as src/skills.mjs, for the same reason: one source, a plan of
// per-engine actions, and a summary that names the engines it *skipped* as well
// as the ones it touched. An engine silently missing from the summary reads as
// "installed everywhere", which is exactly the confusion prd/0003 R8 exists to
// prevent.
//
// Claude Code is currently the only engine with a plugin primitive. That is a
// fact about the engines, not an assumption baked into the fan-out — adding a
// second one means adding a case to pluginInstallActions, nothing else.
import { ENGINES, isInstalled, ranOk, runCmd } from "./engines.mjs";

/** Engines with a plugin primitive. */
export const PLUGIN_ENGINES = ["claude"];

/** The marketplace this repo publishes (see .claude-plugin/marketplace.json). */
export const MARKETPLACE_NAME = "moshcode";

/**
 * Where the marketplace is fetched from. A GitHub `owner/repo` by default;
 * point it at a checkout to test an unreleased plugin:
 *   MOSHCODE_PLUGIN_SOURCE=. moshcode plugin install
 */
export function marketplaceSource(env = process.env) {
  return String(env.MOSHCODE_PLUGIN_SOURCE || "moshcoder/moshcode").trim() || "moshcoder/moshcode";
}

/** The plugins this marketplace ships. Mirrors .claude-plugin/marketplace.json. */
export const PLUGINS = [
  {
    name: "ticker",
    description: "equity research slash commands backed by advis0r.com",
    commands: ["/stocks", "/signals", "/research", "/lookup", "/reports", "/discover"],
  },
  {
    name: "crypto",
    description: "crypto market data slash commands backed by advis0r.com",
    commands: ["/crypto", "/quote", "/book", "/bars", "/spark", "/pairs", "/coin"],
  },
];

export const DEFAULT_PLUGIN = PLUGINS[0].name;

export function resolvePlugin(name) {
  if (!name) return PLUGINS.find((p) => p.name === DEFAULT_PLUGIN) ?? null;
  const key = String(name).toLowerCase().replace(/@.*$/, "");
  return PLUGINS.find((p) => p.name === key) ?? null;
}

/** Fully-qualified plugin id, the form `claude plugin install` disambiguates with. */
export function pluginId(name) {
  return `${name}@${MARKETPLACE_NAME}`;
}

/**
 * The commands one engine needs to install a plugin.
 *
 * Adding the marketplace is idempotent and separate from installing, so it runs
 * every time: a machine that added the marketplace before this plugin existed
 * would otherwise fail the install with "not found in any marketplace".
 */
export function pluginInstallActions(key, { plugin, source, scope }) {
  switch (key) {
    case "claude":
      return [
        { cmd: "claude", args: ["plugin", "marketplace", "add", source, ...(scope ? ["--scope", scope] : [])] },
        { cmd: "claude", args: ["plugin", "install", pluginId(plugin.name), ...(scope ? ["--scope", scope] : [])] },
      ];
    default:
      return { skip: "no plugin primitive" };
  }
}

export function pluginRemoveActions(key, { plugin }) {
  switch (key) {
    case "claude":
      return [{ cmd: "claude", args: ["plugin", "uninstall", pluginId(plugin.name)] }];
    default:
      return { skip: "no plugin primitive" };
  }
}

/**
 * Plan the fan-out: one entry per engine, with its actions or its skip reason.
 * Derived from ENGINES so an engine added later cannot fall out of the summary.
 */
export function planPluginCommand(spec, { installedSet, verb = "install" } = {}) {
  const build = verb === "remove" ? pluginRemoveActions : pluginInstallActions;
  const rest = Object.keys(ENGINES).filter((key) => !PLUGIN_ENGINES.includes(key));
  return [...PLUGIN_ENGINES, ...rest].map((key) => {
    const bin = ENGINES[key].bin;
    const installed = installedSet ? installedSet.has(key) : isInstalled(bin, ENGINES[key].binDirs);
    const actions = build(key, spec);
    return Array.isArray(actions)
      ? { key, bin, installed, actions }
      : { key, bin, installed, ...actions };
  });
}

/**
 * Execute a plan. Returns [{ key, status, reason?, code? }] with
 * status one of installed | removed | skipped | failed | not-installed.
 * `run` is injectable for tests.
 */
export async function runPluginCommand(plan, { run = runCmd, verb = "install" } = {}) {
  const done = verb === "remove" ? "removed" : "installed";
  const results = [];
  for (const item of plan) {
    if (item.skip) { results.push({ key: item.key, status: "skipped", reason: item.skip }); continue; }
    if (!item.installed) { results.push({ key: item.key, status: "not-installed" }); continue; }
    let last = null;
    let failed = false;
    for (const action of item.actions) {
      last = await run(action.cmd, action.args);
      if (!ranOk(last)) { failed = true; break; }
    }
    results.push({
      key: item.key,
      status: failed ? "failed" : done,
      code: last?.code ?? null,
      signal: last?.signal ?? null,
    });
  }
  return results;
}
