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
  return Object.entries(MCP_CATALOG)
    .map(([key, e]) => `  ${key.padEnd(10)} ${e.desc}`)
    .join("\n");
}
