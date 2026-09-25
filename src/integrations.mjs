// `/mcp` and `/skill` command flows, shared by the TUI and the CLI. Each parses
// a canonical spec, plans the per-engine fan-out, runs it, and prints a
// per-engine summary. See prd/0003.
import { ENGINES, isInstalled, runCmd } from "./engines.mjs";
import {
  MCP_ENGINES, MCP_SCOPES, deriveName, isRemoteTarget, planMcpAdd, planMcpVerb,
  resolveMcpEngines, runMcpAdd, runMcpVerb,
} from "./mcp.mjs";
import {
  PROBE_VERBS, catalogSearchArgs, MCPJAM, mcpjamArgs, mcpjamInstalled, missingProbeTool,
} from "./mcp-probe.mjs";
import {
  forgetServer, getServer, listServers, recordServer, setServerEnabled,
} from "./mcp-registry.mjs";
import {
  SKILL_ENGINES, planSkillInstall, runSkillInstall, skillName,
} from "./skills.mjs";
import {
  MARKETPLACE_NAME, PLUGINS, PLUGIN_ENGINES, marketplaceSource, planPluginCommand,
  pluginId, resolvePlugin, resolveRetiredPlugin, runPluginCommand,
} from "./plugins.mjs";
import { catalogList, resolveCatalog } from "./mcp-catalog.mjs";
import { MCP_VERBS, PLUGIN_VERBS, SKILL_VERBS } from "./cli-schema.mjs";
import { findCommand, renderCommand } from "./help.mjs";
import { connectMcp, createMcpShare, ensureMcpCredentials, listMcpShares, revokeMcpShare } from "./mcp-share.mjs";
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

/**
 * `--scope` means OAuth permissions on `/mcp answer` and nothing else.
 *
 * Someone reading a parity list elsewhere will type `--scope project` at these
 * verbs, and the two axes of moshcode's scope model are `--engine-scope` and
 * `--engines` (see MCP_SCOPES). Failing with the name of the flag they wanted
 * costs one line and saves the reader a trip through help.
 */
const SCOPE_COLLISION = "`--scope` is the OAuth permissions of a /mcp answer share, not a config scope."
  + " For the config file each engine writes, use --engine-scope user|project."
  + " For which engines get the server, use --engines claude,codex";

/** Verbs that act on one already-registered server by name, through the engines. */
const MANAGE_VERBS = ["remove", "enable", "disable", "reauth", "unauth", "reconnect"];

/**
 * The flags every name-addressed verb shares: which engines, which config file
 * inside them, and whether the caller wants JSON back.
 */
function parseManageFlags(rest) {
  const parsed = { json: false, engineScope: undefined, engines: null, name: undefined, extra: [] };
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--json") { parsed.json = true; continue; }
    if (t === "--all" || t === "-a") { parsed.all = true; continue; }
    if (t === "--scope") return { error: SCOPE_COLLISION };
    if (t === "--engine-scope" || t === "--engines") {
      const next = flagValue(rest, i, t);
      if (next.error) return next;
      if (t === "--engine-scope") {
        if (!MCP_SCOPES.includes(next.value)) {
          return { error: `--engine-scope must be ${MCP_SCOPES.join(" or ")}` };
        }
        parsed.engineScope = next.value;
      } else {
        const resolved = resolveMcpEngines(next.value);
        if (resolved.error) return resolved;
        parsed.engines = resolved.engines;
      }
      i++;
      continue;
    }
    if (String(t).startsWith("-")) return { error: `unknown mcp flag "${t}"` };
    if (parsed.name === undefined) parsed.name = t;
    else parsed.extra.push(t);
  }
  return parsed;
}

/** Parse `/mcp` tokens (after the `mcp` word) into { list } | { spec } | { error }. */
export function parseMcp(tokens) {
  const verb = tokens[0];
  if (!verb || verb === "list") {
    const flags = tokens.slice(1);
    // `--servers` narrows the listing to the servers moshcode registered.
    // Deliberately a narrowing flag rather than a new shape for `--json`: that
    // already returns an ARRAY of engine capability rows, `skill list --json`
    // returns the same array, and wrapping it in an object to make room would
    // break every reader of both for a listing that has its own flag anyway.
    return {
      list: true,
      json: flags.includes("--json"),
      ...(flags.includes("--servers") ? { servers: true } : {}),
    };
  }
  if (verb === "help") return { help: true };
  if (verb === "catalog") {
    // `catalog` with no argument is still the local list. `catalog search …` is
    // the generalized form of the Smithery verbs; see catalogSearchArgs.
    if (tokens[1] !== "search") {
      if (tokens.length > 1) return { error: `unknown mcp catalog verb "${tokens[1]}". try search` };
      return { showCatalog: true };
    }
    const search = { query: "", limit: null, source: null, json: false };
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--json") { search.json = true; continue; }
      if (t === "--limit" || t === "--source") {
        const next = flagValue(tokens, i, t);
        if (next.error) return next;
        if (t === "--limit") {
          const n = Number(next.value);
          if (!Number.isInteger(n) || n < 1 || n > 100) return { error: "--limit must be a whole number from 1 to 100" };
          search.limit = n;
        } else search.source = next.value;
        i++;
        continue;
      }
      if (String(t).startsWith("-")) return { error: `unknown mcp catalog search flag "${t}"` };
      search.query = search.query ? `${search.query} ${t}` : t;
    }
    if (!search.query) return { error: "mcp catalog search needs a keyword" };
    return { catalogSearch: search };
  }
  // The house rule from PRD 0018 R12: a CLI ships an MCP bridge. It takes no
  // arguments because it is a transport, not a verb with options. Note which
  // direction it points: `bridge` makes MOSHCODE an MCP server, where every
  // verb below acts on somebody else's.
  if (verb === "bridge") {
    if (tokens.length > 1) return { error: "mcp bridge takes no arguments" };
    return { bridge: true };
  }
  if (verb === "connect") {
    if (tokens.length > 1) return { error: "mcp connect takes no arguments" };
    return { remote: { action: "connect" } };
  }
  if (verb === "answer" || verb === "share") {
    const remote = { action: "share", json: false };
    for (let i = 1; i < tokens.length; i++) {
      const flag = tokens[i];
      if (flag === "--json") remote.json = true;
      else if (["--session", "--name", "--ttl", "--scope"].includes(flag)) {
        const next = flagValue(tokens, i, flag);
        if (next.error) return next;
        remote[{ "--session": "sessionId", "--name": "name", "--ttl": "ttl", "--scope": "scope" }[flag]] = next.value;
        i++;
      } else return { error: `unknown mcp ${verb} flag "${flag}"` };
    }
    return { remote };
  }
  if (verb === "status") {
    if (tokens.length > 2 || (tokens[1] && tokens[1] !== "--json")) return { error: "mcp status only takes --json" };
    return { remote: { action: "status", json: tokens[1] === "--json" } };
  }
  if (verb === "revoke") {
    if (!tokens[1] || tokens.length > 2) return { error: "mcp revoke requires exactly one share id" };
    return { remote: { action: "revoke", shareId: tokens[1] } };
  }

  // The verbs that talk TO a server rather than about it. They take a
  // registered name, a catalog name, or a bare URL. A URL because the most
  // common moment to ask "does this thing work" is before deciding to register
  // it, which is the whole point of having the probe.
  if (PROBE_VERBS.includes(verb)) {
    const probe = { verb, json: false, listen: false, durationMs: null };
    const rest = tokens.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === "--json") { probe.json = true; continue; }
      if (t === "--listen") { probe.listen = true; continue; }
      if (t === "--scope") return { error: SCOPE_COLLISION };
      if (t === "--for") {
        const next = flagValue(rest, i, t);
        if (next.error) return next;
        const ms = Number(next.value);
        if (!Number.isInteger(ms) || ms < 1) return { error: "--for must be a whole number of milliseconds" };
        probe.durationMs = ms;
        i++;
        continue;
      }
      if (String(t).startsWith("-")) return { error: `unknown mcp ${verb} flag "${t}"` };
      if (!probe.name) probe.name = t;
      else return { error: `mcp ${verb} takes one server, not "${t}"` };
    }
    if (!probe.name) return { error: `mcp ${verb} needs a server name or URL` };
    // --for only means anything while something is streaming, and silently
    // ignoring it is how someone waits ten minutes for a capability dump.
    if (probe.durationMs && !probe.listen) return { error: "--for only applies with --listen" };
    return { probe };
  }

  if (MANAGE_VERBS.includes(verb)) {
    const flags = parseManageFlags(tokens.slice(1));
    if (flags.error) return flags;
    if (flags.extra.length) return { error: `mcp ${verb} takes one server, not "${flags.extra[0]}"` };
    // `reconnect --all` is the one name-less case: the Gemini family's own
    // reconnect takes `--all`, and "redial everything" is what people actually
    // want after a laptop wakes up.
    // The wrong-flag error comes first on purpose: `mcp remove --all` with the
    // name check leading answers "needs a server name", which reads as though
    // --all were fine and only the name were missing.
    if (flags.all && verb !== "reconnect") return { error: "--all only applies to mcp reconnect" };
    const wantsAll = verb === "reconnect" && flags.all;
    if (!flags.name && !wantsAll) return { error: `mcp ${verb} needs a server name` };
    return {
      manage: {
        verb,
        name: flags.name,
        all: Boolean(wantsAll),
        engineScope: flags.engineScope,
        engines: flags.engines,
      },
    };
  }

  const verbSchema = MCP_VERBS.find(({ name }) => name === verb);
  if (!verbSchema?.acceptsServerSpec) {
    const choices = MCP_VERBS.map(({ name }) => name);
    return { error: `unknown mcp verb "${verb}" — try ${choices.slice(0, -1).join(", ")}, or ${choices.at(-1)}` };
  }

  const rest = tokens.slice(1);
  // `mcp add` with nothing after it is the wizard, not an error. The parity
  // surface asks for an interactive wizard and this is where it announces
  // itself; mcpCommand decides whether a terminal is actually there to answer.
  if (verb === "add" && !rest.length) return { wizard: true };

  let name, transport, url, engineScope, engines = null, auth = null, cmdParts = null;
  const env = [], headers = [], positional = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--") { cmdParts = rest.slice(i + 1); break; }
    else if (t === "--scope") return { error: SCOPE_COLLISION };
    else if (t === "--name" || t === "--url" || t === "--engine-scope" || t === "--engines") {
      const next = flagValue(rest, i, t);
      if (next.error) return next;
      if (t === "--name") name = next.value;
      else if (t === "--url") url = next.value;
      else if (t === "--engine-scope") {
        if (!MCP_SCOPES.includes(next.value)) {
          return { error: `--engine-scope must be ${MCP_SCOPES.join(" or ")}` };
        }
        engineScope = next.value;
      } else {
        const resolved = resolveMcpEngines(next.value);
        if (resolved.error) return resolved;
        engines = resolved.engines;
      }
      i++;
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
    // `--token` is sugar for the Authorization header every hosted MCP server
    // wants, and `env:NAME` is the form worth using. A literal token typed here
    // is in the shell history before moshcode sees it and in six engine configs
    // afterwards; `--token env:SENTRY_TOKEN` is neither, and it is the form the
    // record in ~/.moshcode/mcp.json can keep without keeping a secret.
    else if (t === "--token") {
      const next = flagValue(rest, i, t);
      if (next.error) return next;
      const fromEnv = /^env:(.+)$/.exec(next.value);
      if (fromEnv) {
        const variable = fromEnv[1];
        const value = process.env[variable];
        if (!value) return { error: `--token env:${variable}: ${variable} is not set in this environment` };
        headers.push(`Authorization: Bearer ${value}`);
        auth = { header: "Authorization", from: `env:${variable}` };
      } else {
        headers.push(`Authorization: Bearer ${next.value}`);
        auth = { header: "Authorization", from: "inline" };
      }
      i++;
    }
    else positional.push(t);
  }

  if (transport !== undefined && !["http", "sse", "stdio"].includes(transport)) {
    return { error: "-t/--transport must be http, sse, or stdio" };
  }

  if (verb === "add") name = name || positional.shift();
  let target, args = [];
  // `--url` is the explicit spelling of the remote target, and it wins over a
  // positional so `mcp add sentry --url https://…` reads the way it looks. A
  // URL and a `-- <command…>` together is a contradiction rather than a
  // precedence question, so it is refused instead of silently resolved.
  if (url && cmdParts) {
    return { error: "--url and `-- <command…>` describe two different servers. pick one" };
  }
  if (url) { target = url; args = []; }
  else if (cmdParts) { target = cmdParts[0]; args = cmdParts.slice(1); }
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

  // A remote server is a URL and nothing else — every engine's builder pushes
  // the target alone and discards `args`. So a leftover token here is not a
  // command line, it is something the user typed that this command will silently
  // throw away. `mcp install <url> --dry-run` is the case that matters: the flag
  // does not exist, it lands here, and the install goes ahead and writes to
  // every engine's config — the exact opposite of what the person typing it
  // expected. Say so instead of dropping it on the floor.
  if (!cmdParts && target && isRemoteTarget(target) && args.length) {
    const extra = args[0];
    return {
      error: extra.startsWith("-")
        ? `unknown mcp flag "${extra}" — mcp takes --name, -t/--transport, -e/--env, and -H/--header, and has no --dry-run`
        : `unexpected argument "${extra}" after a remote server URL — a URL server takes no command arguments`,
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
  // The spec stays exactly the canonical five fields every engine builder
  // reads. The new axes ride beside it rather than inside it: `engineScope` and
  // `engines` are about the fan-out, not about the server, and folding them in
  // would put fan-out policy into the thing that gets recorded and re-used.
  return {
    spec: { name, target, args, transport, env, headers },
    ...(engineScope ? { engineScope } : {}),
    ...(engines ? { engines } : {}),
    ...(auth ? { auth } : {}),
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

/**
 * Print the servers moshcode registered, above the engine matrix.
 *
 * Its own printer rather than a section inside `printMcpTargets`, because that
 * one answers "which engines can take a server" and this one answers "which
 * servers did I register". Two questions, two blocks, and the matrix's own
 * tests keep asserting exactly what they always asserted.
 */
export function printMcpServers() {
  const servers = listServers();
  if (!servers.length) {
    console.log(ash("  no servers registered through moshcode yet. /mcp install <url>"));
    console.log("");
    return;
  }
  console.log(bone("  servers") + ash("  registered by moshcode; each engine's own config is the truth"));
  const width = Math.max(10, ...servers.map((s) => s.name.length));
  for (const server of servers) {
    const dot = server.enabled === false ? DOT.missing : DOT.installed;
    const where = server.engines ? server.engines.join(",") : "all engines";
    const scope = server.engineScope || "user";
    const target = [server.target, ...(server.args || [])].join(" ");
    console.log(`   ${dot} ${bone(server.name.padEnd(width))} ${ash(target)}`);
    console.log(`     ${" ".repeat(width)} ${ash(`${scope} scope · ${where}${server.enabled === false ? " · disabled" : ""}`)}`);
  }
  console.log("");
}

/**
 * Turn a name into something a probe can dial.
 *
 * Three sources, most specific first: what moshcode registered, what the
 * catalog knows, and a bare URL typed on the spot. The last one matters most.
 * "Does this server work" is a question people ask BEFORE registering it, and a
 * probe that only accepted registered names would be useless at exactly the
 * moment it is wanted.
 */
export function resolveServerSpec(token) {
  if (!token) return null;
  const recorded = getServer(token);
  if (recorded) {
    // The record keeps header NAMES, never values (see mcp-registry.mjs), so a
    // header-authenticated server is rebuilt here only when the value came from
    // somewhere nameable. `unauthenticated` tells the caller to say so rather
    // than letting a 401 read as a broken server.
    const headers = [];
    let unauthenticated = false;
    if (recorded.auth) {
      const variable = /^env:(.+)$/.exec(recorded.auth.from || "")?.[1];
      const value = variable ? process.env[variable] : null;
      if (value) headers.push(`${recorded.auth.header}: Bearer ${value}`);
      else unauthenticated = true;
    } else if (recorded.headers?.length) unauthenticated = true;
    return {
      source: "registry",
      unauthenticated,
      spec: {
        name: recorded.name,
        target: recorded.target,
        args: recorded.args || [],
        transport: recorded.transport || undefined,
        env: [],
        headers,
      },
    };
  }
  const catalog = resolveCatalog(token);
  if (catalog) {
    return {
      source: "catalog",
      unauthenticated: false,
      spec: { name: catalog.key, target: catalog.target, args: catalog.args, transport: undefined, env: [], headers: [] },
    };
  }
  if (isRemoteTarget(token)) {
    return {
      source: "url",
      unauthenticated: false,
      spec: { name: deriveName(token), target: token, args: [], transport: undefined, env: [], headers: [] },
    };
  }
  return null;
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

// The past tenses that mean "this engine did the thing". Listed rather than
// inferred so a new verb has to choose its word here and cannot land in the
// `skipped` branch by spelling its status something nobody expected.
const DID_IT = new Set([
  "added", "installed", "removed", "authorized", "cleared", "reconnected", "enabled", "disabled",
]);

function summarize(results) {
  for (const r of results) {
    if (DID_IT.has(r.status)) console.log(line(r.key, ok(r.status)));
    // Nothing to do and nothing wrong: grey, like the other "we didn't act"
    // rows, rather than the green of a change we actually made.
    else if (r.status === "already") console.log(line(r.key, ash("already registered")));
    else if (r.status === "missing") console.log(line(r.key, ash("not registered here")));
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

/**
 * Register one canonical spec across the chosen engines and say what happened.
 *
 * Its own function because three callers reach it now: `mcp install`, `mcp add`
 * (flags or wizard) and `mcp enable`, and the notes it prints afterwards are
 * the ones people actually read. `engineScope` and `engines` are the two axes
 * of moshcode's scope model; both default to the widest useful answer.
 */
export async function fanOutAdd(spec, {
  run, installedSet, engineScope = "user", engines = null, auth = null, catalog = null,
} = {}) {
  const where = engines ? engines.join(", ") : "MCP engines";
  console.log(info(`registering ${bone(spec.name)} → ${ash(spec.target)} across ${where}…`));
  const plan = planMcpVerb("add", { ...spec, scope: engineScope }, { installedSet, engines });
  const results = await runMcpAdd(plan, run ? { run } : {});
  summarize(results);
  // Credentials are named, never registered: an API key copied into five
  // engines' config files is five places to leak it from and five to rotate.
  const missing = (catalog?.env || []).filter((k) => !process.env[k]);
  if (missing.length) {
    console.log(ash(`  note: ${spec.name} needs ${missing.join(" and ")} in the environment.`));
  }
  // The catalog's own note and docs are printed whenever the catalog was used,
  // not only when a variable is missing. A server whose credential is a header
  // rather than an environment variable — or one that needs none at all to be
  // useful — has nothing in `env`, and hanging its note off that check is what
  // made the note invisible for exactly the servers it was written for.
  if (catalog?.note) console.log(ash(`  note: ${catalog.note}`));
  if (catalog?.docs) console.log(ash(`        ${catalog.docs}`));
  if (spec.headers.length || /^https?:/i.test(spec.target)) {
    console.log(ash("  note: OAuth/HTTP servers may still need per-engine auth. `/mcp reauth " + spec.name + "` drives it."));
  }
  // A token typed on the command line is in the shell history before moshcode
  // ever sees it and in every engine's config afterwards. moshcode has no vault
  // to put it in (its own credentials are a 0600 dotfile), so the honest move is
  // to say what just happened and name the form that avoids it.
  if (auth?.from === "inline") {
    console.log(ash("  note: that token is now in each engine's config, and in this shell's history."));
    console.log(ash("        `--token env:VAR` reads it from the environment instead, and is what gets recorded."));
  }
  // Record only what actually landed somewhere. A spec that every engine
  // skipped is not registered, and putting it in the list would make `/mcp
  // list` claim a server this box does not have.
  if (results.some((r) => r.status === "added" || r.status === "already")) {
    recordServer(spec.name, { ...spec, auth }, { engineScope, engines });
  }
  return anyFailed(results) ? 1 : 0;
}

/* ------------------------------------------------------ the probe verbs */

/**
 * `mcp test|resources|prompts|notifications <server>`: hand it to mcpjam.
 *
 * The house rule is reuse before building, and TOOLS.mcpjam already states the
 * split this function implements: moshcode registers a server across engines,
 * mcpjam tells you whether the server is worth registering. What is left here
 * is the part mcpjam cannot know: which server "sentry" means on this box.
 */
export async function runProbe(probe, { run = runCmd, probeInstalled = mcpjamInstalled } = {}) {
  const resolved = resolveServerSpec(probe.name);
  if (!resolved) {
    console.log(err(`unknown server "${probe.name}". /mcp list shows the registered ones, or pass a URL`));
    return 1;
  }
  if (!probeInstalled()) {
    const [headline, ...rest] = missingProbeTool(probe.verb);
    console.log(err(headline));
    for (const extra of rest) console.log(ash(`  ${extra}`));
    return 1;
  }
  if (resolved.unauthenticated) {
    // The record keeps header names, never values. Saying so up front is the
    // difference between "this server is broken" and "this probe is anonymous".
    console.log(ash(`  note: ${resolved.spec.name} authenticates with a header moshcode does not store`));
    console.log(ash("        this probe runs unauthenticated; register it with --token env:VAR to reuse the credential"));
  }
  const argv = mcpjamArgs(probe.verb, resolved.spec, probe);
  console.log(info(`${probe.verb} ${bone(resolved.spec.name)} ${ash(`via ${MCPJAM.bin} (${resolved.source})`)}`));
  const result = await run(MCPJAM.bin, argv, { capture: false });
  return result?.ok && result.code === 0 ? 0 : 1;
}

/** `mcp catalog search <keyword>`: the local catalog, widened to the directories. */
export async function runCatalogSearch(search, { run = runCmd, probeInstalled = mcpjamInstalled } = {}) {
  // The local catalog is two curated entries and it is the better answer when
  // it has one, so it is checked first and for free.
  const local = resolveCatalog(search.query);
  if (local) {
    console.log(ok(`${bone(local.key)} ${ash("is in moshcode's own catalog")}`));
    console.log(`   ${ash(local.desc)}`);
    console.log(`   ${acid(`/mcp install ${local.key}`)}`);
    console.log("");
  }
  if (!probeInstalled()) {
    const [headline, ...rest] = missingProbeTool("catalog search");
    console.log(local ? info(headline) : err(headline));
    for (const extra of rest) console.log(ash(`  ${extra}`));
    return local ? 0 : 1;
  }
  console.log(info(`searching the MCP directories for ${bone(search.query)} ${ash(`via ${MCPJAM.bin}`)}`));
  const result = await run(MCPJAM.bin, catalogSearchArgs(search.query, search), { capture: false });
  return result?.ok && result.code === 0 ? 0 : 1;
}

/* ---------------------------------------------------- the name-addressed verbs */

// What each fan-out verb is called when it worked, and whether a non-zero exit
// that says "no such server" is a failure or just nothing to do.
const MANAGE_PLANS = {
  remove: { verb: "remove", done: "removed", missing: true, capture: true },
  // reauth opens a browser and asks questions. Captured stdio swallows the
  // prompt, so this one inherits the terminal and gives up the "already"
  // detection that capturing buys. That is the right trade for a flow whose
  // whole job is to talk to the person sitting there.
  reauth: { verb: "reauth", done: "authorized", missing: false, capture: false },
  unauth: { verb: "unauth", done: "cleared", missing: true, capture: true },
  reconnect: { verb: "reconnect", done: "reconnected", missing: true, capture: true },
};

/**
 * `mcp remove|enable|disable|reauth|unauth|reconnect <server>`.
 *
 * enable/disable are the two that needed a decision. No engine moshcode drives
 * has an enable or disable verb. Not Claude Code, not Codex, not the Gemini
 * family, not OpenCode. And moshcode will not edit their config files to fake
 * one (prd/0003 rules that out, and it is the rule that keeps this whole
 * command honest). So disable means what a wrapper can actually deliver: take
 * the server out of every engine, and keep its spec here so `enable` can put
 * exactly the same one back. It is a real round trip, not a flag nobody reads,
 * and the help text says exactly that so nobody expects a live toggle.
 */
export async function runManage(manage, { run, installedSet } = {}) {
  const { verb, name } = manage;
  const recorded = name ? getServer(name) : null;
  // What the server was registered WITH is the right default for acting on it
  // again. Without this, `mcp add x --engines claude` followed by `mcp remove x`
  // sends a removal to all six engines. Five never had it, and two belong to
  // somebody who never asked moshcode to touch them. An
  // explicit flag still wins, because the record is moshcode's memory and not
  // an authority over what the user just typed.
  const engineScope = manage.engineScope || recorded?.engineScope;
  const engines = manage.engines || recorded?.engines || null;
  const where = engines ? engines.join(", ") : "MCP engines";

  if (verb === "disable" || verb === "enable") {
    if (verb === "enable") {
      if (!recorded) {
        console.log(err(`nothing recorded for "${name}". moshcode can only re-enable a server it registered`));
        console.log(ash("  /mcp list shows them; /mcp install <url> registers a new one"));
        return 1;
      }
      const spec = {
        name, target: recorded.target, args: recorded.args || [], transport: recorded.transport || undefined,
        env: [], headers: [],
      };
      console.log(info(`re-registering ${bone(name)} → ${ash(spec.target)} across ${where}…`));
      const results = await runMcpVerb(
        planMcpVerb("add", { ...spec, scope: engineScope || "user" }, { installedSet, engines }),
        { ...(run ? { run } : {}), done: "enabled", already: true },
      );
      summarize(results);
      if (recorded.headers?.length || recorded.auth) {
        console.log(ash("  note: the credential was never stored here. re-run /mcp install with --token to restore it"));
      }
      setServerEnabled(name, true);
      return anyFailed(results) ? 1 : 0;
    }
    console.log(info(`deregistering ${bone(name)} from ${where}; moshcode keeps the spec…`));
    const results = await runMcpVerb(
      planMcpVerb("remove", { name, scope: engineScope }, { installedSet, engines }),
      { ...(run ? { run } : {}), done: "disabled", missing: true },
    );
    summarize(results);
    if (recorded) setServerEnabled(name, false);
    else console.log(ash(`  note: ${name} was not in moshcode's record, so /mcp enable ${name} has nothing to restore`));
    return anyFailed(results) ? 1 : 0;
  }

  const plan = MANAGE_PLANS[verb];
  const spec = { name, scope: engineScope, all: manage.all };
  const what = manage.all ? "every server" : bone(name);
  console.log(info(`${verb} ${what} across ${where}…`));
  const results = await runMcpVerb(
    planMcpVerb(plan.verb, spec, { installedSet, engines }),
    { ...(run ? { run } : {}), done: plan.done, missing: plan.missing, capture: plan.capture },
  );
  summarize(results);
  // Removing it from the engines and leaving it in moshcode's own list would
  // make `/mcp list` lie about the box it is printed on.
  if (verb === "remove") forgetServer(name);
  if (verb === "reauth") {
    console.log(ash("  each engine ran its own OAuth 2.1 flow (auth code + PKCE) and keeps its own refresh token"));
    console.log(ash("  moshcode stored nothing. /mcp unauth " + name + " clears them again"));
  }
  return anyFailed(results) ? 1 : 0;
}

/* ------------------------------------------------------------- the wizard */

/** One prompt, defaulting when the answer is empty. Injectable so tests never block. */
async function promptLine(question, fallback = "") {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer || fallback;
  } finally { rl.close(); }
}

/**
 * `mcp add` with no arguments.
 *
 * The flag form is the one worth learning and the wizard prints it at the end
 * rather than hiding it, so the second time somebody registers a server they do
 * not need this. Refusing outright without a terminal matters more than it
 * looks: `mcp add` in a script would otherwise hang forever on a read that
 * nothing is going to answer.
 */
export async function runAddWizard({ run, installedSet, ask = promptLine, isTty = () => process.stdin.isTTY } = {}) {
  if (!isTty()) {
    console.log(err("`mcp add` with no arguments opens a wizard, and there is no terminal here"));
    console.log(ash("  non-interactively: mcp add <name> --url <url> [--transport http|sse] [--token env:VAR]"));
    console.log(ash("               or:  mcp add <name> -- <command…>"));
    return 1;
  }
  console.log(bone("  add an MCP server") + ash("  blank answers take the default in brackets"));
  const name = await ask("  name: ");
  if (!name) { console.log(err("a server needs a name")); return 1; }
  const target = await ask("  url, or a command to run: ");
  if (!target) { console.log(err("a server needs a URL or a command")); return 1; }
  const remote = isRemoteTarget(target);
  const transport = remote ? (await ask("  transport [http]: ", "http")) : undefined;
  if (transport && !["http", "sse"].includes(transport)) {
    console.log(err("transport must be http or sse"));
    return 1;
  }
  const tokenVar = remote ? await ask("  auth token from which env var (blank for none): ") : "";
  const engineScope = (await ask("  config scope in each engine [user]: ", "user")).toLowerCase();
  if (!MCP_SCOPES.includes(engineScope)) { console.log(err(`scope must be ${MCP_SCOPES.join(" or ")}`)); return 1; }
  const enginesAnswer = await ask("  engines [all]: ", "all");
  const engines = enginesAnswer === "all" ? null : resolveMcpEngines(enginesAnswer).engines;
  if (enginesAnswer !== "all" && !engines) { console.log(err(`unknown engine in "${enginesAnswer}"`)); return 1; }

  const [command, ...args] = remote ? [target] : target.split(/\s+/);
  const headers = [];
  let auth = null;
  if (tokenVar) {
    const value = process.env[tokenVar];
    if (!value) { console.log(err(`${tokenVar} is not set in this environment`)); return 1; }
    headers.push(`Authorization: Bearer ${value}`);
    auth = { header: "Authorization", from: `env:${tokenVar}` };
  }
  const spec = { name, target: command, args, transport, env: [], headers };
  // The flag form, printed before anything is written: the next server this
  // person registers should not need the wizard at all.
  const flags = [
    `moshcode mcp add ${name}`,
    remote ? `--url ${target}` : "",
    transport && transport !== "http" ? `--transport ${transport}` : "",
    tokenVar ? `--token env:${tokenVar}` : "",
    engineScope !== "user" ? `--engine-scope ${engineScope}` : "",
    engines ? `--engines ${engines.join(",")}` : "",
    remote ? "" : `-- ${target}`,
  ].filter(Boolean).join(" ");
  console.log(ash(`  next time: ${flags}`));
  return fanOutAdd(spec, { run, installedSet, engineScope, engines, auth, catalog: null });
}

/** Run `/mcp …`. `tokens` are the words after `mcp`. `run`/`installedSet` are injectable for tests. */
export async function mcpCommand(tokens, {
  run, installedSet, sessionId, ensureSession, sharingDisabled = false, fetchImpl, credentials, login,
  probeInstalled, ask, isTty,
} = {}) {
  const parsed = parseMcp(tokens);
  if (parsed.list) {
    if (parsed.servers) {
      if (parsed.json) console.log(JSON.stringify(listServers(), null, 2));
      else printMcpServers();
      return 0;
    }
    // `--json` keeps returning exactly the engine capability array it always
    // did. The servers block is for the human view, where two questions
    // ("what did I register" and "what can take it") belong on one screen.
    if (!parsed.json) printMcpServers();
    printMcpTargets(parsed.json);
    return 0;
  }
  if (parsed.help) { console.log(renderCommand(findCommand("mcp"))); return 0; }
  if (parsed.showCatalog) { printMcpCatalog(); return 0; }
  if (parsed.bridge) {
    const { serveBridge } = await import("./mcp.mjs");
    const { moshcodeVersion } = await import("./ui.mjs");
    return serveBridge({ version: moshcodeVersion() || "" });
  }
  if (parsed.error) { console.log(err(parsed.error)); return 1; }
  if (parsed.catalogSearch) return runCatalogSearch(parsed.catalogSearch, { run, probeInstalled });
  if (parsed.wizard) return runAddWizard({ run, installedSet, ask, isTty });
  if (parsed.probe) return runProbe(parsed.probe, { run, probeInstalled });
  if (parsed.manage) return runManage(parsed.manage, { run, installedSet });
  if (parsed.remote) {
    const options = { fetchImpl, credentials, login };
    try {
      if (parsed.remote.action === "connect") {
        const creds = await connectMcp(options);
        if (ensureSession && !sharingDisabled) await ensureSession(creds, { restart: true });
        console.log(ok(`connected${creds?.email ? ` as ${creds.email}` : ""}`));
      } else if (parsed.remote.action === "share") {
        if (sharingDisabled && !parsed.remote.sessionId) {
          throw new Error("remote session sharing is disabled by MOSHCODE_NO_MIRROR; unset it and restart moshcode to share");
        }
        let liveSessionId = parsed.remote.sessionId || sessionId;
        if (!liveSessionId && ensureSession) {
          // A terminal may have started before login, or while the service was
          // unavailable. Authenticate first, then register this exact live pit
          // with the same credentials used to create the share.
          options.credentials = await ensureMcpCredentials(options);
          liveSessionId = await ensureSession(options.credentials);
        }
        const share = await createMcpShare({
          ...options,
          sessionId: liveSessionId,
          name: parsed.remote.name,
          ttl: parsed.remote.ttl,
          scope: parsed.remote.scope?.replace(/,/g, " "),
        });
        if (parsed.remote.json) console.log(JSON.stringify(share, null, 2));
        else {
          console.log(ok("remote MCP share ready"));
          console.log(`   ${acid(share.endpoint)}`);
          if (share.scopes?.length) {
            console.log(ash(`   permissions: ${share.scopes.join(", ")}`));
            if (share.scopes.length === 1 && share.scopes[0] === "sessions:read") {
              console.log(ash("   read-only; to allow answers, create a share with /mcp answer --scope sessions:read,sessions:write"));
            }
          }
          console.log(ash(`   expires ${new Date(share.expires_at).toISOString()} · revoke with /mcp revoke ${share.id}`));
        }
      } else if (parsed.remote.action === "status") {
        const result = await listMcpShares(options);
        if (parsed.remote.json) console.log(JSON.stringify(result, null, 2));
        else if (!result.shares?.length) console.log(ash("  no remote MCP shares"));
        else for (const share of result.shares) {
          console.log(`   ${share.status === "active" ? acid("●") : ash("○")} ${bone(share.id)} ${ash(share.session_live ? "live" : "offline")} ${share.endpoint}`);
        }
      } else {
        await revokeMcpShare(parsed.remote.shareId, options);
        console.log(ok(`revoked ${parsed.remote.shareId}`));
      }
      return 0;
    } catch (error) {
      console.log(err(error.message || "remote MCP request failed"));
      return 1;
    }
  }

  return fanOutAdd(parsed.spec, {
    run, installedSet, engineScope: parsed.engineScope, engines: parsed.engines,
    auth: parsed.auth, catalog: parsed.catalog,
  });
}

/** Run `/skill …`. `tokens` are the words after `skill`. `run`/`installedSet` are injectable for tests. */
export async function skillCommand(tokens, { run, installedSet, settle } = {}) {
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
  const results = await runSkillInstall(planSkillInstall(spec, { installedSet }), {
    ...(run ? { run } : {}),
    ...(settle ? { settle } : {}),
  });
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
