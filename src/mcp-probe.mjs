// The half of `/mcp` that talks to a server instead of registering one.
//
// moshcode does not implement an MCP client and is not going to. It already
// installs one: `mcpjam` is in TOOLS, and its entry there says what the split
// is meant to be. "The companion to `moshcode mcp`: that registers a server
// across engines, this one tells you whether the server is actually worth
// registering". So `test`, `resources`, `prompts` and `notifications` build an
// mcpjam command line out of the canonical spec and hand over. Nothing here
// speaks JSON-RPC, opens a socket, or holds a protocol version that will be
// wrong in six weeks.
//
// The reuse is more than a shortcut. mcpjam's flag surface is uniform across
// its subcommands: the same --transport/--url/--header/--command/--args/-e on
// every one of them. That is why one builder covers four verbs. The engines
// moshcode registers into have six different dialects; the thing it *probes*
// with has one.
import { TOOLS } from "./tools.mjs";
import { isInstalled } from "./engines.mjs";
import { isRemoteTarget } from "./mcp.mjs";

export const MCPJAM = TOOLS.mcpjam;

/** Is the probe tool on this box? Injectable for tests. */
export function mcpjamInstalled(probe = isInstalled) {
  return probe(MCPJAM.bin, MCPJAM.binDirs);
}

/**
 * The mcpjam flags that describe WHICH server to talk to.
 *
 * mcpjam takes "http" or "stdio" and resolves SSE underneath; moshcode's spec
 * may say "sse" because that is a word the engines accept. Collapsing it to
 * http here rather than passing it through keeps the failure honest: an
 * unsupported --transport value would come back as a usage error about a flag
 * the user never typed.
 */
export function mcpjamTargetArgs(spec) {
  const argv = [];
  if (isRemoteTarget(spec.target)) {
    argv.push("--transport", "http", "--url", spec.target);
    for (const header of spec.headers || []) argv.push("--header", header);
  } else {
    argv.push("--transport", "stdio", "--command", spec.target);
    if (spec.args?.length) argv.push("--args", ...spec.args);
  }
  for (const [key, value] of spec.env || []) argv.push("-e", `${key}=${value}`);
  return argv;
}

// Which mcpjam subcommand answers each moshcode verb.
//
// `notifications` is the one that needed a judgement. mcpjam can stream a live
// subscription (`subscriptions listen`), which blocks until Ctrl-C, and it can
// read the capabilities a server declares, which returns. A verb whose default
// hangs the terminal is a verb people run once, so the default is the reading
// and `--listen` is the stream.
const PROBES = {
  test: () => ["server", "info"],
  resources: () => ["resources", "list"],
  prompts: () => ["prompts", "list"],
  notifications: ({ listen = false, durationMs = null } = {}) => (
    listen
      ? ["subscriptions", "listen", "--list-changed", ...(durationMs ? ["--duration-ms", String(durationMs)] : [])]
      : ["server", "capabilities"]
  ),
};

export const PROBE_VERBS = Object.keys(PROBES);

/**
 * The full mcpjam argv for one probe verb against one server spec.
 *
 * Program-level flags go before the subcommand. mcpjam declares --format on the
 * program rather than on each command, and a parser that accepts it in both
 * places today is not a promise it will tomorrow.
 */
export function mcpjamArgs(verb, spec, options = {}) {
  const probe = PROBES[verb];
  if (!probe) throw new Error(`no mcpjam probe for "${verb}"`);
  return [
    ...(options.json ? ["--format", "json"] : []),
    ...probe(options),
    ...mcpjamTargetArgs(spec),
  ];
}

/**
 * `mcp catalog search <keyword>`: the generic form of the Smithery verbs.
 *
 * The parity list asked for `smithery-search`, `smithery-login` and
 * `smithery-logout`: three top-level verbs branded with one registry's name.
 * moshcode already has a catalog, and a second parallel registry concept beside
 * it is how you end up explaining to someone why `mcp catalog` and
 * `mcp smithery-search` disagree about what exists. So searching is a verb of
 * the catalog moshcode already has, and the registry behind it is an
 * implementation detail. It is mcpjam's `registry search`, which sweeps the
 * scraped MCP directories (Smithery among them) rather than one vendor's.
 *
 * That also disposes of the login pair. A registry API key is mcpjam's
 * credential, mcpjam already stores it (MCPJAM_API_KEY, `mcpjam cloud login`),
 * and moshcode caching a second copy would be a second place to leak it from
 * and a second one to rotate. Same rule the catalog states about `env`.
 * When the search needs a key, mcpjam says so in its own words.
 */
export function catalogSearchArgs(query, { limit = null, source = null, json = false } = {}) {
  return [
    ...(json ? ["--format", "json"] : []),
    "registry", "search", query,
    ...(source ? ["--source", source] : []),
    ...(limit ? ["--limit", String(limit)] : []),
  ];
}

/**
 * What to print when mcpjam is not installed.
 *
 * Kept as data rather than a console.log so the caller owns the colours and a
 * test can assert the words without capturing stdout. "Degrade gracefully with
 * a clear message" means naming the command that fixes it: `/install mcpjam`
 * already exists and already does the right thing.
 */
export function missingProbeTool(verb) {
  return [
    `\`mcp ${verb}\` talks to the server through mcpjam, which is not installed`,
    "install it with `moshcode install mcpjam` (or `/install mcpjam` in the pit), then run this again",
    `mcpjam is a tool moshcode already knows about: ${MCPJAM.desc}`,
  ];
}
