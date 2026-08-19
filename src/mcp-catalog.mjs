// Known MCP servers, so a name is enough: `moshcode mcp add porkbun` instead of
// remembering an npx invocation and its package scope.
//
// This is a convenience layer, not a gate — `mcp add <name> -- <cmd> …` still
// takes anything. An entry here only means "we know the canonical way to run
// this one".
//
// `env` lists the variables the server needs to do real work. They are NOT
// baked into the registration: an API key belongs in the environment (or a
// secrets manager), not copied into five engines' config files. They are
// printed as a reminder instead.

export const MCP_CATALOG = {
  porkbun: {
    target: "npx",
    args: ["-y", "@porkbunllc/mcp-server"],
    desc: "Porkbun — domains, DNS records, SSL, email forwarding",
    // Linked as the official MCP server from Porkbun's own API documentation,
    // though the source lives on an individual's account rather than a Porkbun
    // org — worth knowing before handing it DNS-write credentials.
    docs: "https://porkbun.com/api/json/v3/documentation",
    env: ["PORKBUN_API_KEY", "PORKBUN_SECRET_API_KEY"],
    // The doc tools work with no credentials at all, so it is worth trying
    // before deciding whether to trust it with keys.
    note: "API access is off by default and must be enabled per-domain; the docs tools work without keys",
  },
  bufferoverride: {
    // A remote HTTP server, so the target is the URL and there are no args —
    // every engine's builder pushes the target alone for a remote server.
    target: "https://bufferoverride.com/mcp",
    args: [],
    desc: "BufferOverride — version-aware technical answers, with provenance and reproductions",
    docs: "https://bufferoverride.com/docs/mcp",
    // Named to match what the CLI's own `bo mcp config` emits, so registering
    // it either way produces one server rather than two under different names.
    //
    // No `env`: the credential is a bearer header, not a variable, and it is
    // deliberately not listed here. Five read tools work with no key at all,
    // and the write tools are gated on the scopes a key actually carries — so
    // the useful default really is unauthenticated. `bo mcp config` prints the
    // header form for a terminal that has signed in.
    note: "reads need no credential; to publish, add -H \"Authorization: Bearer bo_…\" (see `bo mcp config`)",
  },
};

/** Resolve a catalog name to a spec fragment, or null. Own properties only. */
export function resolveCatalog(token) {
  if (!token) return null;
  const key = String(token).trim().toLowerCase();
  // MCP_CATALOG is a plain object literal, so `constructor` and friends would
  // otherwise resolve to something off Object.prototype with no target.
  if (!Object.hasOwn(MCP_CATALOG, key)) return null;
  const entry = MCP_CATALOG[key];
  return { key, ...entry, args: [...(entry.args || [])] };
}

/** Names, for help text and error messages. */
export function catalogNames() {
  return Object.keys(MCP_CATALOG);
}

/** One line per known server, for `mcp catalog`. */
export function catalogList() {
  // Width from the longest name rather than a fixed pad: `bufferoverride` is
  // wider than the old 10, and a name that overruns the pad loses the column.
  const width = Math.max(10, ...Object.keys(MCP_CATALOG).map((key) => key.length));
  return Object.entries(MCP_CATALOG)
    .map(([key, e]) => `  ${key.padEnd(width)} ${e.desc}`)
    .join("\n");
}
