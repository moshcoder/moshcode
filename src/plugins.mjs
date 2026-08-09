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

/**
 * The plugins this marketplace ships. Mirrors .claude-plugin/marketplace.json.
 *
 * `commands` carry their namespace because that is how they are actually
 * invoked. Claude Code namespaces every plugin command as
 * `/<plugin>:<command>` — always, not only when two plugins collide — so a bare
 * `/crypto` is simply not a command, and advertising one sends people to
 * "Unknown command: /crypto" on their first try.
 * https://code.claude.com/docs/en/plugins
 *
 * `example` exists because the invitation printed after an install has to be
 * runnable. It used to append a hardcoded "NVDA" to whatever came first in
 * `commands`, which told anyone installing the crypto plugin to try a stock.
 *
 * `version` mirrors each plugin's own plugin.json, and it is not decoration:
 * "If set, users only receive updates when you bump this field."
 * https://code.claude.com/docs/en/plugins-reference#version-management
 *
 * So editing a plugin's commands and shipping a moshcode release is *not*
 * enough — an existing install keeps serving the old copy until this number
 * moves. Both plugins sat at 0.1.0 through v0.29.2, which rewrote every command
 * file. Change a plugin's contents, bump its version, in the same commit.
 * A test fails when this list and the manifests disagree.
 */
export const PLUGINS = [
  {
    name: "stocks",
    version: "0.4.0",
    description: "equity research slash commands backed by advis0r.com",
    // `list` rather than `reports`: one letter from `report` is a coin-flip at
    // the prompt, and `index` would read as a market index in a stocks plugin.
    // The CLI already accepts `moshcode stocks list` as an alias, so the two
    // surfaces still agree.
    commands: [
      "/stocks:help", "/stocks:report", "/stocks:quote", "/stocks:lookup",
      "/stocks:signals", "/stocks:research", "/stocks:list", "/stocks:discover",
    ],
    example: "/stocks:report NVDA",
  },
  {
    name: "crypto",
    version: "0.4.0",
    description: "crypto market data slash commands backed by advis0r.com",
    commands: [
      "/crypto:help", "/crypto:report", "/crypto:quote", "/crypto:lookup",
      "/crypto:book", "/crypto:bars", "/crypto:spark", "/crypto:pairs",
    ],
    example: "/crypto:report BTC",
  },
];

/**
 * Command names both plugins are expected to share.
 *
 * The two cover different markets, so they can never ship the same *set* — a
 * crypto pair has no earnings transcript and an equity has no order book. What
 * they can share is vocabulary: the same question is spelled the same way on
 * both sides, so knowing one plugin means knowing half the other. A test holds
 * this, because the natural drift is for one side to grow a synonym.
 */
export const SHARED_COMMANDS = ["help", "report", "quote", "lookup"];

/** How Claude Code namespaces a plugin's command. */
export function pluginCommandName(plugin, file) {
  return `/${plugin}:${String(file).replace(/\.md$/, "")}`;
}

export const DEFAULT_PLUGIN = PLUGINS[0].name;

/**
 * Plugins this marketplace no longer ships, and what replaced them.
 *
 * A renamed plugin is not the same problem as a renamed command. The old
 * command simply stops existing; an old *plugin* is still sitting installed in
 * someone's engine, still serving its slash commands, and the new one installs
 * alongside it rather than over it — so `/stocks` would resolve to two plugins
 * at once. Removal therefore has to keep reaching a name that install refuses.
 */
export const RETIRED_PLUGINS = [
  { name: "ticker", renamedTo: "stocks" },
];

export function resolvePlugin(name) {
  if (!name) return PLUGINS.find((p) => p.name === DEFAULT_PLUGIN) ?? null;
  const key = String(name).toLowerCase().replace(/@.*$/, "");
  return PLUGINS.find((p) => p.name === key) ?? null;
}

/**
 * A retired plugin by its old name, or null.
 *
 * Deliberately separate from resolvePlugin: `remove ticker` must work so the
 * stale install can be cleaned up, and `install ticker` must not, or the rename
 * never actually happens.
 */
export function resolveRetiredPlugin(name) {
  if (!name) return null;
  const key = String(name).toLowerCase().replace(/@.*$/, "");
  return RETIRED_PLUGINS.find((p) => p.name === key) ?? null;
}

/** Fully-qualified plugin id, the form `claude plugin install` disambiguates with. */
export function pluginId(name) {
  return `${name}@${MARKETPLACE_NAME}`;
}

/**
 * The commands one engine needs to install a plugin.
 *
 * Both marketplace steps run every time, and they do different jobs:
 *
 *   add    — makes the marketplace exist. A no-op when it is already on disk,
 *            which is exactly why it is not sufficient on its own.
 *   update — re-fetches it. Without this, a machine that added the marketplace
 *            before a plugin existed installs from its stale local copy and
 *            fails with "not found in any marketplace" — the failure `add` was
 *            supposed to prevent and cannot, because it declines to do anything
 *            for a marketplace it already has.
 *
 * That gap is not theoretical: it broke `plugin install crypto` in v0.27.0 and
 * `plugin install stocks` in v0.29.0, on every machine that had installed a
 * plugin from this marketplace beforehand — which is all of them.
 *
 * `marketplace update` takes the marketplace *name*, not the source, and
 * accepts no --scope.
 */
export function pluginInstallActions(key, { plugin, source, scope }) {
  switch (key) {
    case "claude":
      return [
        { cmd: "claude", args: ["plugin", "marketplace", "add", source, ...(scope ? ["--scope", scope] : [])] },
        { cmd: "claude", args: ["plugin", "marketplace", "update", MARKETPLACE_NAME] },
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
