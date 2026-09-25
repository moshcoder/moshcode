// Register MCP (Model Context Protocol) servers across every engine that
// supports them, from one canonical definition. MoshCode drives each engine's
// own `mcp add` so the engine owns its config format. See prd/0003.
import { ENGINES, isInstalled, ranOk, runCmd } from "./engines.mjs";
import { isIP } from "node:net";

// Coding engines that can register MCP servers. Aider has no MCP support.
export const MCP_ENGINES = ["claude", "gemini", "qwen", "codex", "opencode", "privacycode"];

/** Is this target a remote server URL (vs a local stdio command)? */
export function isRemoteTarget(target) {
  return /^https?:\/\//i.test(String(target));
}

// Second-level labels that are part of a multi-part public suffix rather than a
// name, as in co.uk / com.au / co.za. Dropping only the TLD would leave these.
const SUFFIX_LABELS = ["co", "com", "net", "org", "gov", "edu", "ac"];

/** Derive a sane server name from a remote URL's host (e.g. mcp.sentry.dev → sentry). */
export function deriveName(target) {
  const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  try {
    const hostname = new URL(target).hostname;
    const ipHost = hostname.replace(/^\[|\]$/g, "");
    if (isIP(ipHost)) {
      const ipName = ipHost.replace(/[.:]+/g, "-").replace(/^-+|-+$/g, "");
      return sanitize(`ip-${ipName}`);
    }
    const labels = hostname.split(".").filter(Boolean);
    let withoutTld = labels.slice(0, -1); // drop the TLD
    // ...and the generic label of a multi-part suffix, as long as a real name
    // still precedes it (a bare "co.uk" host has nothing better to offer).
    if (withoutTld.length > 1 && SUFFIX_LABELS.includes(withoutTld[withoutTld.length - 1])) {
      withoutTld = withoutTld.slice(0, -1);
    }
    const meaningful = withoutTld.filter((l) => !["mcp", "www", "api", "app"].includes(l));
    const pick = meaningful[meaningful.length - 1] || withoutTld[withoutTld.length - 1] || labels[0];
    return sanitize(pick) || "server";
  } catch {
    return "server";
  }
}

/** Convert a `"Key: Value"` header into OpenCode's `Key=Value` form. */
function headerToEq(header) {
  const i = String(header).indexOf(":");
  return i === -1 ? String(header) : `${header.slice(0, i).trim()}=${header.slice(i + 1).trim()}`;
}

/**
 * Build one engine's native `mcp add` argv for a canonical server spec, or a
 * skip reason when the engine can't express it.
 *
 * spec: { name, target, args?, transport?, scope?, env?: [[k,v]], headers?: ["Key: Value"] }
 * `target` is a URL (remote) or a stdio command; `args` are stdio command args.
 * `scope` is "user" (the default everywhere) or "project"; see MCP_SCOPES for
 * why moshcode's scope is two axes and this is only one of them.
 * Returns { argv } or { skip }.
 */
export function mcpAddArgs(key, spec) {
  const { name, target, args = [], env = [], headers = [], scope = "user" } = spec;
  const remote = isRemoteTarget(target);
  const transport = spec.transport || (remote ? "http" : "stdio");

  switch (key) {
    case "claude": {
      const argv = ["mcp", "add", "-s", scope];
      if (remote) argv.push("-t", transport);
      for (const [k, v] of env) argv.push("-e", `${k}=${v}`);
      for (const h of headers) argv.push("-H", h);
      argv.push(name);
      if (remote) argv.push(target);
      else argv.push("--", target, ...args);
      return { argv };
    }
    // Qwen Code is a Gemini CLI fork and kept the whole `mcp add` surface —
    // same `-s/-t/-e/-H` flags, same "URL or command" positional. It shares the
    // builder rather than getting a copy, so the two can only drift on purpose.
    case "gemini":
    case "qwen": {
      const argv = ["mcp", "add", "-s", scope];
      if (remote) argv.push("-t", transport);
      for (const [k, v] of env) argv.push("-e", `${k}=${v}`);
      for (const h of headers) argv.push("-H", h);
      argv.push(name);
      if (remote) argv.push(target);
      else argv.push(target, ...args);
      return { argv };
    }
    case "kimi":
      // Kimi Code runs MCP servers, but nothing registers one from a script: it
      // reads ~/.kimi-code/mcp.json, edited by hand or through the in-session
      // /mcp-config picker. (The deprecated Python kimi-cli did have `kimi mcp
      // add`; Kimi Code dropped the subcommand.) MoshCode drives each engine's
      // own CLI rather than writing its config file, so this is a stated skip —
      // and a more useful one than the blanket "no MCP support", which would
      // read as "kimi cannot do MCP at all".
      return { skip: "no scriptable `mcp add` — add it in kimi with /mcp-config, or in ~/.kimi-code/mcp.json" };
    case "omp":
      // omp has the richest MCP surface of any engine here: /mcp add, test,
      // enable, disable, reauth, reload, resources, prompts, the lot. Every one
      // of them is a TUI slash command that writes .omp/mcp.json or
      // ~/.omp/agent/mcp.json itself. Its shell CLI has no `mcp` subcommand at
      // all (omp.sh/docs/cli lists thirty-odd others and not that one). So this
      // is kimi's situation, not aider's, and the generic "no MCP support" was
      // a claim about the engine that happens to be false: it supports MCP
      // better than most, and moshcode simply has no command to drive.
      return { skip: "no scriptable `mcp` subcommand. add it in omp with /mcp add, or in .omp/mcp.json" };
    case "codex": {
      if (headers.length) {
        return { skip: "Codex supports only a bearer-token env var, not literal headers" };
      }
      if (scope === "project") return { skip: NO_PROJECT_SCOPE.codex };
      const argv = ["mcp", "add", name];
      for (const [k, v] of env) argv.push("--env", `${k}=${v}`);
      if (remote) argv.push("--url", target);
      else argv.push("--", target, ...args);
      return { argv };
    }
    // privacycode is opencode-derived, so it shares opencode's `mcp add` surface
    // — including the "remote servers only, non-interactively" limitation.
    case "opencode":
    case "privacycode": {
      if (!remote) {
        return { skip: `${key === "privacycode" ? "privacycode" : "OpenCode"} CLI adds only remote (--url) servers non-interactively` };
      }
      if (scope === "project") return { skip: NO_PROJECT_SCOPE[key] };
      const argv = ["mcp", "add", name, "--url", target];
      for (const [k, v] of env) argv.push("--env", `${k}=${v}`);
      for (const h of headers) argv.push("--header", headerToEq(h));
      return { argv };
    }
    default:
      return { skip: "no MCP support" };
  }
}

/**
 * Plan the fan-out: one entry per engine with its native argv or skip reason,
 * annotated with install status. Pure + testable.
 *
 * Every engine, not just MCP_ENGINES — R6 requires an engine that cannot
 * express the server to be skipped *with a stated reason*, and the PRD's own
 * UX example ends on `· aider  skipped — no MCP support`. Mapping MCP_ENGINES
 * dropped those engines before they reached the summary, so the fan-out
 * reported five rows where /mcp list reports six. MCP_ENGINES stays the
 * capability set (it is what the matrix splits "supported" on); it is only the
 * iteration that widens. Supported engines keep their existing order.
 */
export function planMcpAdd(spec, options = {}) {
  return planMcpVerb("add", spec, options);
}

/**
 * Did this engine exit non-zero only because the server was already there?
 *
 * Registering the same server twice is the normal way to re-run `mcp install`,
 * and it is not a failure — but Claude Code and Gemini/Qwen exit 1 on it, so the
 * fan-out summary painted `claude ✗ failed (code 1)` next to opencode's cheerful
 * green box. Read from a box where four engines already had the server, that
 * says "moshcode cannot register with Claude Code" — which is exactly the wrong
 * conclusion, and the reason this function exists rather than a nicer exit code.
 *
 * Matched against the engine's own words, so it stays honest: an engine that
 * fails for any *other* reason still comes back failed.
 */
const ALREADY_RE = /already (?:exists|configured|registered|added)|exists in (?:user|global|project) config/i;
export function alreadyRegistered(r) {
  return ALREADY_RE.test(String(r?.output ?? ""));
}

/**
 * Execute a plan: run each installed, non-skipped engine's `mcp add`. Returns
 * results [{ key, status: "added"|"already"|"skipped"|"failed"|"not-installed", reason? }].
 * `run` is injectable for tests; defaults to the real spawner.
 */
export async function runMcpAdd(plan, options = {}) {
  // capture so a non-zero exit can be read for "already exists" rather than
  // reported as a failure; the child's output still reaches the terminal.
  return runMcpVerb(plan, { ...options, done: "added", already: true });
}

/* ------------------------------------------------------------------ scope */

// moshcode's scope carries two axes, not one.
//
// Every other tool's `--scope project|user` answers one question: which config
// file. That is only half the question here, because moshcode registers a
// server in SIX engines at once, and the other half is which engines. Reducing
// scope to project|user would quietly throw away the thing moshcode exists to
// do, so the two axes are two flags:
//
//   --engine-scope user|project   which config file each engine writes
//   --engines claude,codex        which engines are written to at all
//
// Both default to the widest useful answer: user scope, every installed
// MCP-capable engine. The short form still behaves the way it does everywhere
// else.
//
// The first flag is NOT called `--scope`, and that is not a style choice.
// `/mcp answer --scope sessions:read,sessions:write` already means the OAuth
// permission scope of a shared session, and one word meaning two things across
// sibling verbs of the same command is how a person hands a session write
// access while trying to pick a config file. `--engine-scope` says which scope
// it is in the name, and `parseMcp` catches a bare `--scope` on these verbs and
// points at it rather than failing silently.
export const MCP_SCOPES = ["user", "project"];

// Claude Code also has a `local` scope (this project, this machine, private to
// you). It is deliberately not in MCP_SCOPES: no other engine has it, so
// `--engine-scope local` would be a flag that silently means "claude only", and
// moshcode already spells that `--engines claude`.

/** Which engines a `--engines a,b` selection resolves to. Returns { engines } or { error }. */
export function resolveMcpEngines(selection) {
  if (!selection) return { engines: null }; // null means "every engine"
  const asked = String(selection).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!asked.length) return { error: "--engines needs at least one engine name" };
  const unknown = asked.filter((key) => !Object.hasOwn(ENGINES, key));
  if (unknown.length) {
    return { error: `unknown engine ${unknown.map((u) => `"${u}"`).join(", ")}. try ${MCP_ENGINES.join(", ")}` };
  }
  return { engines: asked };
}

// An engine that keeps MCP servers in exactly one place cannot honour `--scope
// project`. Stated per engine rather than as one shared string, because the
// reasons differ and R6 asks for a reason the reader can act on.
const NO_PROJECT_SCOPE = {
  codex: "Codex keeps MCP servers in ~/.codex/config.toml only, so there is no project scope",
  opencode: "OpenCode's `mcp add` takes no scope flag. it writes its own config, not a project .mcp.json",
  privacycode: "privacycode's `mcp add` takes no scope flag. it writes its own config, not a project .mcp.json",
};

// Kimi Code runs MCP servers and simply has no scriptable subcommand for any of
// this. One string for the five new verbs so they cannot drift into five
// different stories about the same engine. `mcpAddArgs` keeps its own, longer
// version because it can name the exact command that is missing.
const KIMI_SKIP = "no scriptable `mcp` subcommand. use kimi's /mcp-config, or ~/.kimi-code/mcp.json";

// Same shape, different engine. omp does all of this from its own TUI and edits
// its own config file; nothing about it is reachable from a shell. See the
// longer note in `mcpAddArgs`.
const OMP_SKIP = "no scriptable `mcp` subcommand. omp does this from its TUI (/mcp) and its own config";

/* ---------------------------------------------------------------- removal */

/**
 * One engine's native `mcp remove` argv, or a skip reason.
 *
 * spec: { name, scope? }. Same shape as `mcpAddArgs` so the fan-out planner can
 * take either builder and the summary reads the same way either way.
 */
export function mcpRemoveArgs(key, spec) {
  const { name, scope } = spec;
  switch (key) {
    // Claude, Gemini and Qwen all spell it `mcp remove [-s scope] <name>`. Qwen
    // is a Gemini CLI fork and kept the flag; Claude arrived at the same shape
    // on its own. They share the branch so a future divergence has to be
    // written down rather than discovered by a user.
    case "claude":
    case "gemini":
    case "qwen": {
      const argv = ["mcp", "remove"];
      if (scope) argv.push("-s", scope);
      argv.push(name);
      return { argv };
    }
    case "codex":
      if (scope === "project") return { skip: NO_PROJECT_SCOPE.codex };
      return { argv: ["mcp", "remove", name] };
    // OpenCode registers servers and never un-registers them: `opencode mcp`
    // offers add, list, auth, logout and debug, and nothing that deletes. The
    // reason points at the file rather than shrugging, because deleting the
    // entry by hand is a real answer and the user should not have to go hunting
    // for it.
    case "opencode":
    case "privacycode":
      return { skip: `${key} has no \`mcp remove\`. delete the entry from its config (\`${key} mcp list\` names it)` };
    case "kimi":
      return { skip: KIMI_SKIP };
    case "omp":
      return { skip: OMP_SKIP };
    default:
      return { skip: "no MCP support" };
  }
}

/* ------------------------------------------------------------------ oauth */

/**
 * One engine's native "authorize me against this server" argv, or a skip reason.
 *
 * moshcode mints no tokens and stores none. Every engine below runs the MCP
 * spec's own OAuth 2.1 flow against the server: authorization code with PKCE,
 * and a refresh token the engine rotates itself. Each keeps the result in its
 * own credential store. So `reauth` hands the terminal to that flow once per
 * engine and `unauth` clears what it left behind. There is no moshcode-side
 * copy of a token to leak, and nothing on this path is ever OAuth 1.0a.
 *
 * Gemini and Qwen are the gap: both authorize an OAuth MCP server from inside
 * the session rather than from their CLI, so both are skipped with the words
 * the user would have to type instead.
 */
export function mcpAuthArgs(key, spec) {
  const { name } = spec;
  switch (key) {
    case "claude":
    case "codex":
      return { argv: ["mcp", "login", name] };
    case "opencode":
    case "privacycode":
      return { argv: ["mcp", "auth", name] };
    case "gemini":
    case "qwen":
      return { skip: `${key} authorizes from inside the session. run \`${key}\` and use /mcp auth ${name}` };
    case "kimi":
      return { skip: KIMI_SKIP };
    case "omp":
      return { skip: OMP_SKIP };
    default:
      return { skip: "no MCP support" };
  }
}

/** One engine's native "forget this server's OAuth credentials" argv, or a skip reason. */
export function mcpUnauthArgs(key, spec) {
  const { name } = spec;
  switch (key) {
    case "claude":
    case "codex":
    case "opencode":
    case "privacycode":
      return { argv: ["mcp", "logout", name] };
    case "gemini":
    case "qwen":
      return { skip: `${key} clears credentials from inside the session. run \`${key}\` and use /mcp` };
    case "kimi":
      return { skip: KIMI_SKIP };
    case "omp":
      return { skip: OMP_SKIP };
    default:
      return { skip: "no MCP support" };
  }
}

/* -------------------------------------------------------------- reconnect */

/**
 * One engine's native `mcp reconnect` argv, or a skip reason.
 *
 * Only the Gemini family has this: `gemini mcp reconnect [name] [-a]` drops the
 * engine's live client for a server and dials it again. Nothing equivalent
 * exists on Claude Code, Codex or OpenCode, and moshcode holds no MCP client of
 * its own, so those engines get the thing that does work instead of a green
 * tick over a command that changed nothing.
 */
export function mcpReconnectArgs(key, spec) {
  const { name, all = false } = spec;
  switch (key) {
    case "gemini":
    case "qwen":
      return { argv: all ? ["mcp", "reconnect", "--all"] : ["mcp", "reconnect", name] };
    case "claude":
      return { skip: "Claude Code reconnects from inside the session. run `claude` and use /mcp" };
    case "codex":
      return { skip: "Codex has no `mcp reconnect`. it dials each server when a session starts" };
    case "opencode":
    case "privacycode":
      return { skip: `${key} has no \`mcp reconnect\`. \`${key} mcp debug ${name}\` inspects the connection` };
    case "kimi":
      return { skip: KIMI_SKIP };
    case "omp":
      return { skip: OMP_SKIP };
    default:
      return { skip: "no MCP support" };
  }
}

/* ------------------------------------------------------------ the fan-out */

/** The argv builder behind each fan-out verb. */
export const MCP_VERB_BUILDERS = {
  add: mcpAddArgs,
  remove: mcpRemoveArgs,
  reauth: mcpAuthArgs,
  unauth: mcpUnauthArgs,
  reconnect: mcpReconnectArgs,
};

/**
 * Plan any fan-out verb: one entry per engine with its native argv or skip
 * reason, annotated with install status. The generalization of `planMcpAdd`,
 * which now delegates here so the six verbs cannot drift on engine coverage.
 *
 * `engines` narrows the fan-out to a chosen set. That is the second axis of
 * moshcode's scope model. Narrowing DROPS the other engines rather than listing them as
 * skipped: an engine the user deliberately left out is not a surprise that
 * needs explaining, and four "skipped" rows under a command that asked for one
 * engine bury the row that matters. R6's no-silent-omission rule is about
 * engines moshcode chose to leave out, not engines the user did.
 */
export function planMcpVerb(verb, spec, { installedSet, engines = null } = {}) {
  const build = MCP_VERB_BUILDERS[verb];
  if (!build) throw new Error(`no MCP fan-out builder for "${verb}"`);
  const rest = Object.keys(ENGINES).filter((key) => !MCP_ENGINES.includes(key));
  const all = [...MCP_ENGINES, ...rest];
  const keys = engines ? all.filter((key) => engines.includes(key)) : all;
  return keys.map((key) => {
    const bin = ENGINES[key].bin;
    const installed = installedSet ? installedSet.has(key) : isInstalled(bin, ENGINES[key].binDirs);
    return { key, bin, installed, ...build(key, spec) };
  });
}

/**
 * Did this engine exit non-zero only because the server was not there to
 * remove? The mirror of `alreadyRegistered`, for the same reason: removing a
 * server that two of six engines never had is the normal shape of `mcp remove`,
 * and painting those two rows red teaches the reader to ignore the colour.
 */
const NOT_FOUND_RE = /no (?:such|mcp) server|not found|does not exist|is not (?:configured|registered)|no server (?:named|found)/i;
export function notRegistered(r) {
  return NOT_FOUND_RE.test(String(r?.output ?? ""));
}

/**
 * Execute any fan-out plan. Returns
 * [{ key, status: <done>|"already"|"missing"|"skipped"|"failed"|"not-installed" }].
 *
 * `done` is the verb's own past tense, so the summary says what happened rather
 * than "ok". `capture` is false for the interactive verbs: `reauth` opens a
 * browser and asks questions, and captured stdio swallows the prompt.
 */
export async function runMcpVerb(plan, {
  run = runCmd, done = "done", capture = true, already = false, missing = false,
} = {}) {
  const results = [];
  for (const item of plan) {
    if (item.skip) { results.push({ key: item.key, status: "skipped", reason: item.skip }); continue; }
    if (!item.installed) { results.push({ key: item.key, status: "not-installed" }); continue; }
    const r = await run(item.bin, item.argv, { capture });
    let status = done;
    if (!ranOk(r)) {
      if (already && alreadyRegistered(r)) status = "already";
      else if (missing && notRegistered(r)) status = "missing";
      else status = "failed";
    }
    results.push({ key: item.key, status, code: r.code, signal: r.signal ?? null });
  }
  return results;
}

// ---------------------------------------------------------------------------
// The bridge: moshcode's own verbs, served to an engine over MCP
// ---------------------------------------------------------------------------
//
// Everything above registers OTHER people's servers with the engines. This is
// the other direction, and the house rule behind PRD 0018 R12: a CLI ships an
// MCP bridge, so the agent in the chair can reach the same verbs a person
// types. It is stdio JSON-RPC and nothing else, which is what an engine's `mcp
// add -- <cmd>` expects and the reason it needs no transport of its own:
//
//     moshcode mcp install --name moshcode -- moshcode mcp bridge
//
// SCOPE, deliberately small. `initialize`, `tools/list`, `tools/call`, and one
// tool. A bridge that grew a verb per release without a table like this one
// would drift from the CLI the same way the old hand-written help drifted from
// the dispatcher, so every tool here is a thin call onto the module that also
// backs the CLI verb. There is no second implementation to keep in step.
//
// NOTHING HERE LAUNCHES A TERMINAL. `handoff` over MCP stops at the transcript:
// it reads the source session, writes the portable transcript and the OpenFleet
// edge, and hands back the argv that would start the target engine. An engine
// calling this tool has no terminal to give another engine, and a bridge that
// spawned an interactive session into a pipe would hang both of them.

/** The protocol version this bridge speaks. */
export const BRIDGE_PROTOCOL_VERSION = "2025-06-18";

/**
 * The tools the bridge serves.
 *
 * `run` returns a JSON-serialisable result, or throws with a message an engine
 * can read. One entry per CLI verb this PRD adds, and the import is lazy so a
 * bridge that is only listing tools never loads a transcript reader.
 */
export const BRIDGE_TOOLS = [
  {
    name: "moshcode_handoff",
    description:
      "Move a conversation from one coding engine to another. Reads the source engine's session log, "
      + "writes a portable transcript, records the OpenFleet edge, and returns the command that starts "
      + "the target engine seeded with it. Does not launch anything.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "the engine to read: claude, codex, opencode or privacycode" },
        to: { type: "string", description: "the engine to hand it to: claude, codex, opencode, privacycode, qwen, gemini or omp" },
        session: { type: "string", description: "which source session, by id or a unique prefix; the newest by default" },
        cwd: { type: "string", description: "the directory whose session to read; the current one by default" },
        max: { type: "integer", description: "how many messages to carry, newest kept" },
      },
      required: ["from", "to"],
    },
    async run(args = {}) {
      const { handoffCommand } = await import("./handoff.mjs");
      const out = [];
      const errors = [];
      const tokens = ["--json", "--dry-run", String(args.from ?? ""), String(args.to ?? "")];
      if (args.session) tokens.push("--session", String(args.session));
      if (args.cwd) tokens.push("--cwd", String(args.cwd));
      if (args.max) tokens.push("--max", String(args.max));
      const code = await handoffCommand(tokens, {
        write: (line) => out.push(line),
        fail: (line) => errors.push(line),
      });
      if (code !== 0) throw new Error(errors.join("\n") || "handoff failed");
      return JSON.parse(out.join("\n"));
    },
  },
];

/** One JSON-RPC request to one response, or null for a notification. */
export async function bridgeHandle(request, { tools = BRIDGE_TOOLS, version = "" } = {}) {
  const { id, method, params } = request || {};
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  // A notification has no id and takes no answer. `notifications/initialized`
  // is the one every client sends, and answering it is a protocol error.
  if (id === undefined || id === null) return null;

  if (method === "initialize") {
    return reply({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "moshcode", version: version || "0.0.0" },
    });
  }
  if (method === "tools/list") {
    return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === "tools/call") {
    const tool = tools.find((t) => t.name === params?.name);
    if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: `no such tool "${params?.name}"` } };
    try {
      const result = await tool.run(params?.arguments || {});
      return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false });
    } catch (error) {
      // A refused handoff is an answer, not a transport failure: the engine
      // that called it should read the reason and try something else, which
      // it cannot do with a JSON-RPC error it is not obliged to surface.
      return reply({ content: [{ type: "text", text: String(error?.message || error) }], isError: true });
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method "${method}"` } };
}

/**
 * Serve the bridge over a stream of newline-delimited JSON-RPC.
 *
 * Line-delimited because that is what stdio MCP is, and a line that does not
 * parse is skipped rather than fatal: a client that writes a stray byte must
 * not take the session down with it.
 */
export async function serveBridge({ input = process.stdin, output = process.stdout, version = "" } = {}) {
  input.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of input) {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      let request;
      try { request = JSON.parse(line); } catch { continue; }
      const response = await bridgeHandle(request, { version });
      if (response) output.write(`${JSON.stringify(response)}\n`);
    }
  }
  return 0;
}
