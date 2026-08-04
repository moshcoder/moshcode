// The command table, and everything help needs to describe it.
//
// One table, three consumers: the dispatcher in bin/moshcode.mjs, shell
// completion (src/completion.mjs), and help (src/help.mjs). Help used to be an
// 87-line template literal that re-typed all of this by hand, which is why
// `dns` and `version` were dispatchable, completable, and absent from `moshcode
// help` at the same time (PRD 0006).
//
// `description` stays the one-line summary completion already renders. The rest
// — synopsis, flags, examples — exists so per-command help can be rendered
// rather than written. A flag that is parsed but not listed here is a flag
// nobody can discover, so test/help.test.mjs greps the parsers and fails when
// the two disagree.

/**
 * Groups for the one-screen overview.
 *
 * The top-level help is a menu, not an index: 30-odd verbs in one flat list is
 * the wall this replaces. Order is the order they appear.
 */
export const COMMAND_GROUPS = [
  { key: "engines", title: "engines" },
  { key: "tools", title: "tools" },
  { key: "extend", title: "extend" },
  { key: "script", title: "script" },
  { key: "account", title: "account" },
  { key: "hosting", title: "hosting" },
  { key: "system", title: "system" },
];

export const CORE_CLI_COMMANDS = [
  {
    name: "agents",
    group: "engines",
    description: "list engines or launch one autonomously",
    synopsis: [
      ["moshcode agents", "list engines and their install status"],
      ["moshcode agents <engine> [args…]", "open the engine's agent view, or start it autonomously"],
    ],
    examples: [
      ["moshcode agents", "which engines are here"],
      ["moshcode agents claude", "claude's agent list"],
    ],
    seeAlso: ["start", "engines", "install"],
    note: "autonomous modes bypass approval prompts — use them in a container or a workspace you trust.",
  },
  {
    name: "start",
    group: "engines",
    description: "launch an engine with its native defaults",
    synopsis: [["moshcode start <engine> [args…]", "no bypass flags, no agent view"]],
    examples: [["moshcode start opencode", ""]],
    seeAlso: ["agents", "engines"],
  },
  {
    name: "install",
    group: "engines",
    description: "install an engine or workflow tool",
    synopsis: [["moshcode install <engine|tool>", ""]],
    examples: [
      ["moshcode install claude", "an engine"],
      ["moshcode install gh", "a workflow tool"],
    ],
    seeAlso: ["uninstall", "upgrade", "engines", "tools"],
  },
  {
    name: "uninstall",
    group: "engines",
    description: "take an engine or workflow tool off this machine",
    synopsis: [["moshcode uninstall <engine|tool> [--yes] [--dry-run]", ""]],
    flags: [
      ["-y, --yes", "actually delete a binary this did not install", ""],
      ["--dry-run", "print the plan and stop", ""],
    ],
    examples: [
      ["moshcode uninstall codex --dry-run", "what would happen"],
      ["moshcode uninstall codex --yes", "do it"],
    ],
    seeAlso: ["install"],
    note: "removing a plain binary needs --yes; a package-manager uninstall does not.",
  },
  { name: "remove", aliasOf: "uninstall", description: "alias for uninstall" },
  {
    name: "upgrade",
    group: "engines",
    description: "update moshcode, engines, or tools",
    synopsis: [
      ["moshcode upgrade [target…]", "default: everything installed"],
      ["moshcode upgrade --check", "report what is stale and exit"],
    ],
    flags: [
      ["--check", "report available updates without installing", ""],
      ["--if-newer", "install only when the remote is newer", ""],
      ["--timer <interval>", "install a scheduled self-update", ""],
    ],
    verbs: "UPGRADE_TARGETS",
    examples: [
      ["moshcode upgrade", "moshcode + engines + tools"],
      ["moshcode upgrade engines", "just the engines"],
    ],
    seeAlso: ["install", "version"],
  },
  { name: "update", aliasOf: "upgrade", description: "alias for upgrade" },
  {
    name: "mcp",
    group: "extend",
    description: "register and inspect MCP servers",
    synopsis: [["moshcode mcp <verb> [args…]", ""]],
    verbs: "MCP_VERBS",
    examples: [
      ["moshcode mcp list --json", "support and install status"],
      ["moshcode mcp install https://mcp.example.com", "a remote server"],
    ],
    seeAlso: ["skill", "engines"],
  },
  {
    name: "skill",
    group: "extend",
    description: "install and inspect agent skills",
    synopsis: [["moshcode skill <verb> [args…]", ""]],
    verbs: "SKILL_VERBS",
    examples: [["moshcode skill list", ""]],
    seeAlso: ["mcp"],
  },
  { name: "skills", aliasOf: "skill", description: "alias for skill" },
  {
    name: "prd",
    group: "script",
    description: "publish or list product requirement documents",
    synopsis: [
      ["moshcode prd", "list the PRDs in this repo"],
      ["moshcode prd list [--json]", "the same, explicitly"],
      ["moshcode prd <idea…>", "publish prd/NNNN-slug.md (Draft) and hand it to an engine"],
    ],
    flags: [["--json", "machine-readable listing", ""]],
    examples: [
      ["moshcode prd", "the index"],
      ['moshcode prd "a --help that works"', "publish + author"],
    ],
    seeAlso: ["run", "commands"],
    note: "publishing writes a file and commits it. `moshcode prd --help` does neither.",
  },
  {
    name: "login",
    group: "account",
    description: "authenticate with app.moshcode.sh",
    synopsis: [["moshcode login [--device] [--browser]", ""]],
    flags: [
      ["-d, --device", "device-code flow", "default when stdin is not a TTY"],
      ["-b, --browser", "force the browser flow", ""],
    ],
    examples: [["moshcode login --device", "on a headless box"]],
    seeAlso: ["whoami", "logout", "console"],
  },
  {
    name: "whoami",
    group: "account",
    description: "show the logged-in account",
    synopsis: [["moshcode whoami", ""]],
    seeAlso: ["login", "logout"],
  },
  {
    name: "logout",
    group: "account",
    description: "clear the logged-in account",
    synopsis: [["moshcode logout", ""]],
    seeAlso: ["login"],
  },
  {
    name: "console",
    group: "account",
    description: "serve or connect to the browser terminal",
    synopsis: [["moshcode console [--port N] [--bind addr] [--ttyd host:port] [--url u]", ""]],
    flags: [
      ["--port <n>", "port to serve on", ""],
      ["--bind <addr>", "interface to bind", ""],
      ["--ttyd <host:port>", "front an existing ttyd", ""],
      ["--url <url>", "connect to a console already running", ""],
    ],
    examples: [["moshcode console --port 7681", ""]],
    seeAlso: ["login"],
  },
  {
    name: "dns",
    group: "hosting",
    description: "resolve Moshpit names on this machine",
    synopsis: [["moshcode dns <verb> [args…]", ""]],
    verbs: "DNS_VERBS",
    flags: [
      ["--port <n>", "port for the bridge", "5354"],
      ["--registry <url>", "registry to resolve against", "https://pit.moshcode.sh"],
      ["--no-trust", "with enable: route names but skip the local CA", ""],
    ],
    examples: [
      ["sudo moshcode dns enable", "route Moshpit endings here"],
      ["moshcode dns resolve blue.eggs", "what a machine actually gets"],
    ],
    seeAlso: ["doh", "site"],
  },
  {
    name: "doh",
    group: "hosting",
    description: "run the DNS-over-HTTPS resolver",
    synopsis: [
      ["moshcode doh [--port N]", "serve DoH"],
      ["moshcode doh --nginx <name> [--tls]", "print an nginx site and exit"],
    ],
    flags: [
      ["--port <n>", "port to listen on", ""],
      ["--nginx <name>", "emit an nginx server block instead of serving", ""],
      ["--tls", "include TLS directives in the emitted block", ""],
      ["--no-guards", "disable rate limiting and bans", "guards on"],
    ],
    examples: [["moshcode doh --nginx dns.example", ""]],
    seeAlso: ["dns"],
    note: "has no TLS of its own and trusts X-Forwarded-For — never expose it directly.",
  },
  {
    name: "site",
    group: "hosting",
    description: "install web-server config for a Moshpit name",
    synopsis: [["moshcode site <name> [args…]", ""]],
    examples: [["moshcode site blue.eggs", ""]],
    seeAlso: ["template", "dns"],
  },
  { name: "serve", aliasOf: "site", description: "alias for site" },
  {
    name: "template",
    group: "hosting",
    description: "scaffold a stack for a Moshpit-hosted service",
    synopsis: [
      ["moshcode template list [--json]", "what there is"],
      ["moshcode template install <name>", "write it here"],
    ],
    flags: [
      ["--into <dir>", "write somewhere other than the current directory", ""],
      ["--force", "overwrite files that are already there", ""],
      ["--dry-run", "show changes without writing anything", ""],
      ["--json", "machine-readable template list", ""],
    ],
    examples: [["moshcode template install bun-caddy-sqlite", ""]],
    seeAlso: ["site"],
  },
  { name: "templates", aliasOf: "template", description: "alias for template" },
  {
    name: "pwd",
    group: "system",
    description: "show the current directory and git context",
    synopsis: [["moshcode pwd [--json]", ""]],
    flags: [["--json", "machine-readable", ""]],
    seeAlso: ["commands"],
  },
  { name: "where", aliasOf: "pwd", description: "alias for pwd" },
  {
    name: "engines",
    group: "engines",
    description: "list engines and installation status",
    synopsis: [["moshcode engines [--json]", ""]],
    flags: [["--json", "machine-readable", ""]],
    seeAlso: ["agents", "install"],
  },
  {
    name: "tools",
    group: "tools",
    description: "list workflow tools and installation status",
    synopsis: [["moshcode tools [--json]", ""]],
    flags: [["--json", "machine-readable, and suppresses the trailing note", ""]],
    seeAlso: ["install"],
  },
  {
    name: "commands",
    group: "script",
    description: "list built-in moshscript commands",
    synopsis: [["moshcode commands [--json]", ""]],
    flags: [["--json", "machine-readable", ""]],
    seeAlso: ["run", "prd"],
  },
  {
    name: "completion",
    group: "extend",
    description: "print a shell completion script",
    synopsis: [["moshcode completion <bash|zsh|fish|powershell>", ""]],
    examples: [["moshcode completion zsh > ~/.moshcode-completion.zsh", ""]],
    seeAlso: ["help"],
  },
  {
    name: "run",
    group: "script",
    description: "run a moshscript",
    synopsis: [
      ["moshcode run [flags] [file] [args…]", "no file → the bundled example"],
      ["moshcode run -", "read the script from stdin"],
    ],
    flags: [
      ["-n, --max <n>", "loop ceiling", "3"],
      ["--dry-run", "parse and report without side effects", ""],
      ["--", "everything after this reaches the script as argv", ""],
    ],
    examples: [
      ["moshcode run deploy.mosh", ""],
      ["moshcode run deploy.mosh -- --verbose", "--verbose goes to the script"],
    ],
    seeAlso: ["commands", "prd"],
    note: "--help before the file is the runner's; after it, it belongs to the script.",
  },
  {
    name: "help",
    group: "system",
    description: "show command help",
    synopsis: [
      ["moshcode help", "the one-screen overview"],
      ["moshcode help <command> [verb]", "drill into one"],
      ["moshcode help --all", "every command, in full"],
      ["moshcode help --json", "the machine-readable model"],
    ],
    flags: [
      ["--all", "render every command instead of the overview", ""],
      ["--json", "emit the help model as JSON", ""],
      ["--markdown", "emit the command table for README.md", ""],
    ],
    examples: [
      ["moshcode help mcp install", "a sub-verb"],
      ["moshcode help --json | jq '.commands[].name'", "for an agent"],
    ],
    seeAlso: ["commands", "completion"],
  },
  { name: "--help", aliasOf: "help", description: "show command help" },
  { name: "-h", aliasOf: "help", description: "show command help" },
  {
    name: "version",
    group: "system",
    description: "show the installed version",
    synopsis: [["moshcode version", ""]],
    seeAlso: ["upgrade"],
  },
  { name: "--version", aliasOf: "version", description: "show the installed version" },
  { name: "-v", aliasOf: "version", description: "show the installed version" },
];

export const CORE_CLI_COMMAND_NAMES = CORE_CLI_COMMANDS.map(({ name }) => name);

export const MCP_VERBS = [
  {
    name: "install",
    description: "register an MCP server across engines",
    acceptsServerSpec: true,
    synopsis: [
      ["moshcode mcp install <url>", "remote server (http/sse)"],
      ["moshcode mcp install --name <n> -- <cmd…>", "local stdio server"],
      ["moshcode mcp install <catalog-name>", "e.g. porkbun, sentry"],
    ],
    flags: [
      ["--name <n>", "override the derived server name", ""],
      ["-t, --transport <t>", "http | sse | stdio", "inferred from the target"],
      ["-e, --env K=V", "repeatable", ""],
      ["-H, --header 'K: V'", "repeatable", ""],
      ["--", "everything after this is the server's argv", ""],
    ],
  },
  {
    name: "add",
    description: "register a named MCP server",
    acceptsServerSpec: true,
    synopsis: [["moshcode mcp add --name <n> <target>", ""]],
  },
  { name: "catalog", description: "show known MCP servers", synopsis: [["moshcode mcp catalog", ""]] },
  {
    name: "list",
    description: "show MCP support and install status",
    synopsis: [["moshcode mcp list [--json]", ""]],
    flags: [["--json", "machine-readable", ""]],
  },
];

export const SKILL_VERBS = [
  {
    name: "install",
    description: "install a skill across supported engines",
    acceptsSource: true,
    synopsis: [["moshcode skill install <source>", ""]],
  },
  {
    name: "list",
    description: "show skills support and install status",
    synopsis: [["moshcode skill list [--json]", ""]],
    flags: [["--json", "machine-readable", ""]],
  },
];

export const UPGRADE_TARGETS = [
  { name: "all", description: "update moshcode and all installed integrations" },
  { name: "self", description: "update moshcode itself" },
  { name: "moshcode", description: "alias for self" },
  { name: "engines", description: "update all installed engines" },
  { name: "tools", description: "update all installed workflow tools" },
];

/**
 * `dns` sub-verbs.
 *
 * New here rather than in completion, which never had them: the bridge grew
 * these verbs after the completion table was written, so they were dispatchable
 * and invisible to both help and the shell.
 */
export const DNS_VERBS = [
  { name: "enable", description: "route Moshpit endings to the local bridge (needs sudo)" },
  { name: "disable", description: "undo enable" },
  { name: "status", description: "what is running, what is routed, does it work" },
  { name: "refresh", description: "re-apply routing for endings claimed since" },
  { name: "start", description: "run the bridge in the foreground" },
  { name: "install", description: "print the resolver config without applying it" },
  { name: "service", description: "install or remove the background service" },
  { name: "tlds", description: "list the endings claimed in the Pit" },
  { name: "resolve", description: "what a name resolves to, and why" },
  { name: "trust", description: "trust one name's certificate, after checking it against the registry pin" },
];

/** Sub-verb tables, by the name a command's `verbs` field refers to. */
export const VERB_TABLES = {
  MCP_VERBS,
  SKILL_VERBS,
  UPGRADE_TARGETS,
  DNS_VERBS,
};

/**
 * The pit's own command surface (PRD 0006 R12).
 *
 * Separate from CORE_CLI_COMMANDS because it genuinely is: the pit dispatches
 * `/shell` and `/quit`, which have no CLI equivalent, and does not dispatch
 * `dns`, `console`, `doh`, `site`, `template`, `completion` or `uninstall`,
 * which do. `/help` used to imply otherwise by omission — it listed neither the
 * commands it lacked nor `/logout`, which it has.
 *
 * `cli` points at the CORE_CLI_COMMANDS entry that documents the same verb, so
 * `/help <command>` renders the flags and examples already written there rather
 * than a second, thinner copy that drifts.
 */
export const PIT_COMMANDS = [
  { name: "agents", aliases: ["agent", "engines"], args: "[name]", cli: "agents",
    description: "list engines, or launch one autonomously" },
  { name: "start", args: "<engine> [args…]", cli: "start",
    description: "raw launch; inject no engine arguments" },
  { name: "tools", args: "[name] [args…]", cli: "tools",
    description: "list workflow tools, or run one" },
  { name: "install", args: "<engine|tool>", cli: "install",
    description: "install an engine or workflow tool" },
  { name: "upgrade", aliases: ["update"], args: "[name…]", cli: "upgrade",
    description: "update moshcode + installed engines/tools" },
  { name: "mcp", args: "<verb> [args…]", cli: "mcp",
    description: "register and inspect MCP servers" },
  { name: "skill", aliases: ["skills"], args: "<verb> [args…]", cli: "skill",
    description: "install and inspect agent skills" },
  { name: "prd", args: "[idea…]", cli: "prd",
    description: "publish a numbered PRD, or list them with no argument" },
  { name: "run", args: "<file.mosh> [--max N] [--dry-run]", cli: "run",
    description: "run a moshscript" },
  { name: "login", args: "[--device] [--browser]", cli: "login",
    description: "connect this machine to app.moshcode.sh" },
  { name: "whoami", cli: "whoami", description: "who this machine is logged in as" },
  // Dispatched since forever and missing from /help until now.
  { name: "logout", cli: "logout", description: "clear the logged-in account" },
  { name: "pwd", aliases: ["where"], cli: "pwd",
    description: "show the current dir + git repo/branch/origin" },
  { name: "shell", aliases: ["sh"], args: "[cmd]", pitOnly: true,
    description: "drop into $SHELL (exit → back to the pit); also !cmd" },
  { name: "help", aliases: ["?", "h"], args: "[command]", pitOnly: true,
    description: "this, or one command in detail" },
  { name: "quit", aliases: ["exit", "q"], pitOnly: true,
    description: "leave the pit  (or Ctrl-D)" },
];

/**
 * CLI verbs the pit does not have.
 *
 * Named rather than silently absent: "it isn't here" is a different answer from
 * "you typed it wrong", and only one of them tells you to use the CLI instead.
 */
export const NOT_IN_PIT = ["uninstall", "dns", "doh", "site", "template", "console", "completion", "commands", "version"];
