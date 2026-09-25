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
 * spec: { name, target, args?, transport?, env?: [[k,v]], headers?: ["Key: Value"] }
 * `target` is a URL (remote) or a stdio command; `args` are stdio command args.
 * Returns { argv } or { skip }.
 */
export function mcpAddArgs(key, spec) {
  const { name, target, args = [], env = [], headers = [] } = spec;
  const remote = isRemoteTarget(target);
  const transport = spec.transport || (remote ? "http" : "stdio");

  switch (key) {
    case "claude": {
      const argv = ["mcp", "add", "-s", "user"];
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
      const argv = ["mcp", "add", "-s", "user"];
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
    case "codex": {
      if (headers.length) {
        return { skip: "Codex supports only a bearer-token env var, not literal headers" };
      }
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
export function planMcpAdd(spec, { installedSet } = {}) {
  const rest = Object.keys(ENGINES).filter((key) => !MCP_ENGINES.includes(key));
  return [...MCP_ENGINES, ...rest].map((key) => {
    const bin = ENGINES[key].bin;
    const installed = installedSet ? installedSet.has(key) : isInstalled(bin, ENGINES[key].binDirs);
    return { key, bin, installed, ...mcpAddArgs(key, spec) };
  });
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
export async function runMcpAdd(plan, { run = runCmd } = {}) {
  const results = [];
  for (const item of plan) {
    if (item.skip) { results.push({ key: item.key, status: "skipped", reason: item.skip }); continue; }
    if (!item.installed) { results.push({ key: item.key, status: "not-installed" }); continue; }
    // capture so a non-zero exit can be read for "already exists" rather than
    // reported as a failure; the child's output still reaches the terminal.
    const r = await run(item.bin, item.argv, { capture: true });
    const status = ranOk(r) ? "added" : alreadyRegistered(r) ? "already" : "failed";
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
