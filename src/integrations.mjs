// `/mcp` and `/skill` command flows, shared by the TUI and the CLI. Each parses
// a canonical spec, plans the per-engine fan-out, runs it, and prints a
// per-engine summary. See prd/0003.
import { ENGINES, isInstalled } from "./engines.mjs";
import {
  MCP_ENGINES, deriveName, isRemoteTarget, planMcpAdd, runMcpAdd,
} from "./mcp.mjs";
import {
  SKILL_ENGINES, planSkillInstall, runSkillInstall, skillName,
} from "./skills.mjs";
import {
  MARKETPLACE_NAME, PLUGINS, PLUGIN_ENGINES, marketplaceSource, planPluginCommand,
  pluginId, resolvePlugin, resolveRetiredPlugin, runPluginCommand,
} from "./plugins.mjs";
import { catalogList, resolveCatalog } from "./mcp-catalog.mjs";
import { MCP_VERBS, PLUGIN_VERBS, SKILL_VERBS } from "./cli-schema.mjs";
import { acid, ash, bone, ok, err, info } from "./ui.mjs";

function splitKV(pair) {
  const i = String(pair).indexOf("=");
  return i === -1 ? [String(pair), ""] : [pair.slice(0, i), pair.slice(i + 1)];
}

function headerName(header) {
  const i = String(header).indexOf(":");
  return i === -1 ? null : String(header).slice(0, i).trim();
}

function flagValue(rest, index, flag) {
  const value = rest[index + 1];
  if (value === undefined || value === "--" || String(value).startsWith("-")) {
    return { error: `${flag} requires a value` };
  }
  return { value };
}

/** Parse `/mcp` tokens (after the `mcp` word) into { list } | { spec } | { error }. */
export function parseMcp(tokens) {
  const verb = tokens[0];
  if (!verb || verb === "list") return { list: true, json: tokens.slice(1).includes("--json") };
  if (verb === "catalog") return { showCatalog: true };
  const verbSchema = MCP_VERBS.find(({ name }) => name === verb);
  if (!verbSchema?.acceptsServerSpec) {
    const choices = MCP_VERBS.map(({ name }) => name);
    return { error: `unknown mcp verb "${verb}" — try ${choices.slice(0, -1).join(", ")}, or ${choices.at(-1)}` };
  }

  const rest = tokens.slice(1);
  let name, transport, cmdParts = null;
  const env = [], headers = [], positional = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--") { cmdParts = rest.slice(i + 1); break; }
    else if (t === "--name") {
      const next = flagValue(rest, i, t);
      if (next.error) return next;
      name = next.value; i++;
    }
    else if (t === "-t" || t === "--transport") {
      const next = flagValue(rest, i, t);
      if (next.error) return next;
      transport = next.value; i++;
    }
    else if (t === "-e" || t === "--env") {
      const next = flagValue(rest, i, t);
      if (next.error) return next;
      env.push(splitKV(next.value)); i++;
    }
    else if (t === "-H" || t === "--header") {
      const next = flagValue(rest, i, t);
      if (next.error) return next;
      headers.push(next.value); i++;
    }
    else positional.push(t);
  }

  if (verb === "add") name = name || positional.shift();
  let target, args = [];
  if (cmdParts) { target = cmdParts[0]; args = cmdParts.slice(1); }
  else { target = positional[0]; args = positional.slice(1); }

  // A bare known name is enough: `mcp add porkbun` fills the command in from
  // the catalog. Only when nothing else was given — an explicit target always
  // wins, so the catalog can never override what was actually typed.
  let catalog = null;
  if (!target) {
    catalog = resolveCatalog(name) || resolveCatalog(positional[0]);
    if (catalog) {
      name = name || catalog.key;
      target = catalog.target;
      args = catalog.args;
    }
  }

  // A token still starting with `-` at this point was never consumed as a flag,
  // so it is a typo or an engine-native flag moshcode does not take (`-s user`).
  // Left alone it becomes the server NAME or its command and gets spliced
  // straight into every engine's own `mcp add` argv. Everything after `--` is
  // the user's command line and is deliberately not second-guessed.
  const stray = [name, cmdParts ? null : target]
    .find((t) => typeof t === "string" && t.startsWith("-"));
  if (stray) {
    return {
      error: `unknown mcp flag "${stray}" — mcp takes --name, -t/--transport, -e/--env, and -H/--header; put a command's own flags after --`,
    };
  }

  if (verb === "install" && !name) {
    if (target && isRemoteTarget(target)) name = deriveName(target);
    else return { error: "a stdio command server needs an explicit --name" };
  }
  if (!name) return { error: "missing server name" };
  if (!target) return { error: "missing server URL or command" };
  if (env.some(([key]) => String(key).trim() === "")) {
    return { error: "mcp --env requires a non-empty key" };
  }
  if (headers.some((header) => headerName(header) === null)) {
    return { error: "mcp --header requires a Name: Value header" };
  }
  if (headers.some((header) => headerName(header) === "")) {
    return { error: "mcp --header requires a non-empty header name" };
  }
  return {
    spec: { name, target, args, transport, env, headers },
    ...(catalog ? { catalog } : {}),
  };
}

const DOT = { installed: acid("●"), missing: ash("○") };
function line(key, statusText) { return `   ${bone(key.padEnd(9))} ${statusText}`; }

function integrationTargetStatus(supportedKeys, { installedSet } = {}) {
  const supported = new Set(supportedKeys);
  const keys = [...supportedKeys, ...Object.keys(ENGINES).filter((key) => !supported.has(key))];
  return keys.map((key) => ({
    name: key,
    binary: ENGINES[key].bin,
    installed: installedSet ? installedSet.has(key) : isInstalled(ENGINES[key].bin, ENGINES[key].binDirs),
    supported: supported.has(key),
  }));
}

/** MCP capability and install status for every engine. */
export function mcpTargetStatus(options) {
  return integrationTargetStatus(MCP_ENGINES, options);
}

/** Skills capability and install status for every engine. */
export function skillTargetStatus(options) {
  return integrationTargetStatus(SKILL_ENGINES, options);
}

/** Print the known-server catalog. */
export function printMcpCatalog() {
  console.log(bone("  known mcp servers") + ash("  — register one with ") + acid("/mcp add <name>"));
  console.log(catalogList());
}

/** Print the MCP support matrix + install status. */
export function printMcpTargets(json = false) {
  const targets = mcpTargetStatus();
  if (json) { console.log(JSON.stringify(targets, null, 2)); return; }
  console.log(bone("  mcp") + ash("  — register a server everywhere with ") + acid("/mcp install <url>"));
  for (const target of targets) {
    const dot = target.supported && target.installed ? DOT.installed : DOT.missing;
    // "no MCP support" would be a claim about the engine; what this column
    // actually knows is whether moshcode can register a server there. Kimi runs
    // MCP servers perfectly well and simply has no command to add one from a
    // script — the fan-out states each engine's own reason when you run it.
    console.log(`   ${dot} ${bone(target.name.padEnd(9))} ${ash(target.supported ? "mcp add supported" : "no mcp add command")}`);
  }
}

/** Print the skills support matrix + install status. */
export function printSkillTargets(json = false) {
  const targets = skillTargetStatus();
  if (json) { console.log(JSON.stringify(targets, null, 2)); return; }
  console.log(bone("  skills") + ash("  — install a skill everywhere with ") + acid("/skill install <git-url>"));
  for (const target of targets) {
    const dot = target.supported && target.installed ? DOT.installed : DOT.missing;
    console.log(`   ${dot} ${bone(target.name.padEnd(9))} ${ash(target.supported ? "skills supported" : "no skills primitive")}`);
  }
}

function summarize(results) {
  for (const r of results) {
    if (r.status === "added" || r.status === "installed" || r.status === "removed") console.log(line(r.key, ok(r.status)));
    else if (r.status === "failed") console.log(line(r.key, err(`failed${r.code != null ? ` (code ${r.code})` : r.signal ? ` (${r.signal})` : ""}`)));
    else if (r.status === "not-installed") console.log(line(r.key, ash("not installed — /install " + r.key)));
    else console.log(line(r.key, ash(`skipped — ${r.reason}`)));
  }
}

/**
 * Did any engine we actually ran come back failed?
 *
 * Only "failed" counts. An engine that is skipped ("no MCP support") or absent
 * ("not installed") was never attempted, and the summary already prints both in
 * grey rather than red — treating them as failures would make `mcp add` exit
 * non-zero on a perfectly good box that simply does not have all six engines.
 * This is the rule `upgrade` already applies to its own fan-out, which counts
 * `!r.ok` over the engines it ran and exits 1 if any of them failed.
 */
const anyFailed = (results) => results.some((r) => r.status === "failed");

/** Run `/mcp …`. `tokens` are the words after `mcp`. `run`/`installedSet` are injectable for tests. */
export async function mcpCommand(tokens, { run, installedSet } = {}) {
  const parsed = parseMcp(tokens);
  if (parsed.list) { printMcpTargets(parsed.json); return 0; }
  if (parsed.showCatalog) { printMcpCatalog(); return 0; }
  if (parsed.error) { console.log(err(parsed.error)); return 1; }

  const { spec } = parsed;
  console.log(info(`registering ${bone(spec.name)} → ${ash(spec.target)} across MCP engines…`));
  const results = await runMcpAdd(planMcpAdd(spec, { installedSet }), run ? { run } : {});
  summarize(results);
  // Credentials are named, never registered: an API key copied into five
  // engines' config files is five places to leak it from and five to rotate.
  const missing = (parsed.catalog?.env || []).filter((k) => !process.env[k]);
  if (missing.length) {
    console.log(ash(`  note: ${spec.name} needs ${missing.join(" and ")} in the environment.`));
    if (parsed.catalog?.note) console.log(ash(`        ${parsed.catalog.note}`));
    if (parsed.catalog?.docs) console.log(ash(`        ${parsed.catalog.docs}`));
  }
  if (spec.headers.length || /^https?:/i.test(spec.target)) {
    console.log(ash("  note: OAuth/HTTP servers may still need per-engine auth (e.g. `opencode mcp auth`, `codex mcp login`)."));
  }
  return anyFailed(results) ? 1 : 0;
}

/** Run `/skill …`. `tokens` are the words after `skill`. `run`/`installedSet` are injectable for tests. */
export async function skillCommand(tokens, { run, installedSet } = {}) {
  const verb = tokens[0];
  if (!verb || verb === "list") { printSkillTargets(tokens.slice(1).includes("--json")); return 0; }
  if (verb !== "install") {
    console.log(err(`unknown skill verb "${verb}" — try ${SKILL_VERBS.map(({ name }) => name).join(" or ")}`));
    return 1;
  }

  const rest = tokens.slice(1);
  let name, source;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--name") {
      const next = flagValue(rest, i, rest[i]);
      if (next.error) { console.log(err(next.error)); return 1; }
      name = next.value;
      i++;
    }
    else if (!source) source = rest[i];
  }
  // A source still starting with `-` was never consumed as a flag, so it is a
  // typo or an engine-native flag moshcode does not take (`-s user`). Left
  // alone it becomes the skill SOURCE and is spliced straight into every
  // engine's own argv — `gemini skills install -s --scope user`, and a
  // `git clone --depth 1 -s <dest>` where `-s` (`--shared`) makes git read the
  // destination as the repository — while the URL the user actually typed is
  // dropped on the floor. Same guard `mcp` already applies to its own spec.
  if (source?.startsWith("-")) {
    console.log(err(`unknown skill flag "${source}" — skill install takes --name; a source that really starts with "-" must be written as ./${source}`));
    return 1;
  }
  if (!source) { console.log(err("usage: /skill install <git-url|path> [--name <name>]")); return 1; }

  const spec = { source, name: skillName(source, name) };
  console.log(info(`installing skill ${bone(spec.name)} → ${ash(source)} across skills engines…`));
  const results = await runSkillInstall(planSkillInstall(spec, { installedSet }), run ? { run } : {});
  summarize(results);
  return anyFailed(results) ? 1 : 0;
}

/**
 * `/plugin list` — what this marketplace ships, and which engines can take it.
 *
 * Two tables rather than one: the plugin list is a property of moshcode, the
 * engine support is a property of this machine, and merging them into a single
 * list is how "installed" and "installable" get confused.
 */
export function printPluginTargets(json = false, { installedSet } = {}) {
  const targets = integrationTargetStatus(PLUGIN_ENGINES, { installedSet }).map((t) => ({
    ...t, supported: PLUGIN_ENGINES.includes(t.name),
  }));
  if (json) {
    console.log(JSON.stringify({
      marketplace: { name: MARKETPLACE_NAME, source: marketplaceSource() },
      plugins: PLUGINS,
      engines: targets,
    }, null, 2));
    return;
  }
  console.log(bone("  plugins") + ash("  — install moshcode's slash commands with ") + acid("/plugin install"));
  for (const plugin of PLUGINS) {
    console.log(`   ${acid(pluginId(plugin.name).padEnd(18))}${ash(plugin.description)}`);
    console.log(`   ${" ".repeat(18)}${ash(plugin.commands.join("  "))}`);
  }
  console.log("");
  for (const target of targets) {
    const dot = target.supported && target.installed ? DOT.installed : DOT.missing;
    console.log(`   ${dot} ${bone(target.name.padEnd(9))} ${ash(target.supported ? "plugins supported" : "no plugin primitive")}`);
  }
}

/** Run `/plugin …`. `tokens` are the words after `plugin`. */
export async function pluginCommand(tokens, { run, installedSet } = {}) {
  const verb = tokens[0];
  if (!verb || verb === "list") {
    printPluginTargets(tokens.slice(1).includes("--json"), { installedSet });
    return 0;
  }
  if (verb !== "install" && verb !== "remove") {
    console.log(err(`unknown plugin verb "${verb}" — try ${PLUGIN_VERBS.map(({ name }) => name).join(", ")}`));
    return 1;
  }

  const rest = tokens.slice(1).filter((t) => t !== "--json");
  const stray = rest.find((t) => String(t).startsWith("-"));
  if (stray) { console.log(err(`unknown plugin flag "${stray}"`)); return 1; }

  let plugin = resolvePlugin(rest[0]);
  if (!plugin) {
    // A retired name still has to be removable: the old plugin is installed in
    // someone's engine right now, and installing its replacement puts a second
    // copy of the same slash commands beside it rather than replacing it.
    const retired = resolveRetiredPlugin(rest[0]);
    if (retired && verb === "remove") {
      plugin = { name: retired.name, description: `retired — renamed to ${retired.renamedTo}`, commands: [] };
    } else if (retired) {
      console.log(err(`"${retired.name}" is now "${retired.renamedTo}" — install ${bone(pluginId(retired.renamedTo))}`));
      console.log(info(`already have the old one? ${bone(`moshcode plugin remove ${retired.name}`)} first`));
      return 1;
    } else {
      console.log(err(`unknown plugin "${rest[0]}" — this marketplace ships ${PLUGINS.map((p) => p.name).join(", ")}`));
      return 1;
    }
  }

  const source = marketplaceSource();
  console.log(verb === "install"
    ? info(`installing ${bone(pluginId(plugin.name))} ${ash(`from ${source}`)} across plugin engines…`)
    : info(`removing ${bone(pluginId(plugin.name))} from plugin engines…`));

  const plan = planPluginCommand({ plugin, source }, { installedSet, verb });
  const results = await runPluginCommand(plan, { verb, ...(run ? { run } : {}) });
  summarize(results);

  // A newly installed plugin is not live in an already-running engine, and the
  // first thing anyone does is type the slash command and conclude it failed.
  if (!anyFailed(results) && verb === "install" && results.some((r) => r.status === "installed")) {
    console.log(info(`restart the engine, then try ${acid(plugin.example ?? plugin.commands[0])}`));
  }
  return anyFailed(results) ? 1 : 0;
}
