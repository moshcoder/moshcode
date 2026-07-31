export const CORE_CLI_COMMANDS = [
  { name: "agents", description: "list engines or launch one autonomously" },
  { name: "start", description: "launch an engine with its native defaults" },
  { name: "install", description: "install an engine or workflow tool" },
  { name: "upgrade", description: "update moshcode, engines, or tools" },
  { name: "update", description: "alias for upgrade" },
  { name: "mcp", description: "register and inspect MCP servers" },
  { name: "skill", description: "install and inspect agent skills" },
  { name: "skills", description: "alias for skill" },
  { name: "prd", description: "create or list product requirement documents" },
  { name: "login", description: "authenticate with app.moshcode.sh" },
  { name: "whoami", description: "show the logged-in account" },
  { name: "logout", description: "clear the logged-in account" },
  { name: "console", description: "serve or connect to the browser terminal" },
  { name: "dns", description: "manage DNS records" },
  { name: "pwd", description: "show the current directory and git context" },
  { name: "where", description: "alias for pwd" },
  { name: "engines", description: "list engines and installation status" },
  { name: "tools", description: "list workflow tools and installation status" },
  { name: "commands", description: "list built-in moshscript commands" },
  { name: "completion", description: "print a shell completion script" },
  { name: "run", description: "run a moshscript" },
  { name: "help", description: "show command help" },
  { name: "version", description: "show the installed version" },
  { name: "--version", description: "show the installed version" },
  { name: "-v", description: "show the installed version" },
];

export const CORE_CLI_COMMAND_NAMES = CORE_CLI_COMMANDS.map(({ name }) => name);

export const MCP_VERBS = [
  {
    name: "install",
    description: "register an MCP server across engines",
    acceptsServerSpec: true,
  },
  {
    name: "add",
    description: "register a named MCP server",
    acceptsServerSpec: true,
  },
  { name: "catalog", description: "show known MCP servers" },
  { name: "list", description: "show MCP support and install status" },
];

export const SKILL_VERBS = [
  {
    name: "install",
    description: "install a skill across supported engines",
    acceptsSource: true,
  },
  { name: "list", description: "show skills support and install status" },
];

export const UPGRADE_TARGETS = [
  { name: "all", description: "update moshcode and all installed integrations" },
  { name: "self", description: "update moshcode itself" },
  { name: "moshcode", description: "alias for self" },
  { name: "engines", description: "update all installed engines" },
  { name: "tools", description: "update all installed workflow tools" },
];
