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
  { key: "runtime", title: "runtime" },
  { key: "tools", title: "tools" },
  { key: "extend", title: "extend" },
  { key: "script", title: "script" },
  { key: "arcade", title: "arcade" },
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
      ["moshcode agents --json", "list engine status as machine-readable JSON"],
      ["moshcode agents <engine> [args…]", "open the engine's agent view, or start it autonomously"],
    ],
    flags: [
      ["--json", "print engine status as JSON", ""],
    ],
    examples: [
      ["moshcode agents", "which engines are here"],
      ["moshcode agents --json", "pipe engine status into a script"],
      ["moshcode agents claude", "claude's agent list"],
    ],
    seeAlso: ["start", "engines", "install"],
    note: "autonomous modes bypass approval prompts — use them in a container or a workspace you trust.",
  },
  {
    name: "start",
    group: "engines",
    description: "launch an engine with its native defaults",
    synopsis: [
      ["moshcode start <engine> [args…]", "no bypass flags, no agent view"],
      ["moshcode start <engine> --detach", "run it in the herd and keep your prompt"],
    ],
    flags: [
      ["--detach, -d", "start in the herd instead of taking this terminal", ""],
      ["--name <slug>", "name the herd session (implies --detach)", "<engine>-<dir>"],
    ],
    examples: [
      ["moshcode start opencode", ""],
      ["moshcode start claude --name api-refactor", "runs in the background; moshcode ps to see it"],
    ],
    seeAlso: ["agents", "engines", "herd", "ps"],
  },
  {
    name: "herd",
    group: "runtime",
    description: "run agent sessions that outlive this terminal",
    synopsis: [
      ["moshcode herd", "the roster — same as moshcode ps"],
      ["moshcode herd <verb> [args…]", "drive one session"],
    ],
    verbs: "HERD_VERBS",
    flags: [["--json", "machine-readable, on every verb", ""]],
    examples: [
      ["moshcode herd ui", "the clickable list — start here"],
      ["", ""],
      ["# a workspace: two shells and an agent, none of which die with this terminal", ""],
      ["moshcode herd shell --name work", "a plain $SHELL you can come back to"],
      ["moshcode herd shell --name logs", "another one"],
      ["moshcode agents claude -d --name api", "an agent, detached"],
      ["moshcode ps", "all three, and which one is blocked"],
      ["moshcode attach api", "step in · Ctrl-b s switches · Ctrl-b d leaves it running"],
      ["", ""],
      ["# an agent moshcode has no install spec for", ""],
      ["moshcode herd run --name cur -- cursor-agent", "anything at all runs in the herd"],
      ["", ""],
      ["# driving one without attaching", ""],
      ["moshcode herd prompt api \"run the tests\" --wait", "hand it work, block until it lands"],
      ["moshcode herd read api --lines 40", "read its screen"],
    ],
    seeAlso: ["ps", "attach", "wait", "restore", "start"],
    note: "`start` is for the engines moshcode installs; `run` and `shell` take anything else, "
      + "so an agent it has never heard of still gets a roster entry and blocked/idle detection. "
      + "sessions live in a tmux server moshcode owns, or under script(1) when there is no tmux. "
      + "with neither, launches stay in the foreground and say so.",
  },
  {
    name: "ps",
    group: "runtime",
    description: "list herd sessions and what each one is doing",
    synopsis: [["moshcode ps [--json]", "name, engine, state, cwd, age"]],
    flags: [["--json", "machine-readable", ""]],
    examples: [["moshcode ps", "which agent is blocked?"]],
    seeAlso: ["herd", "attach", "wait"],
    note: "state is idle, working, blocked, done or unknown — unknown is a safe answer, not a failure.",
  },
  {
    name: "attach",
    group: "runtime",
    description: "attach this terminal to a herd session",
    synopsis: [["moshcode attach <name>", "F12 for the mosh bar · Ctrl-b d detaches (Ctrl-] without tmux)"]],
    examples: [["moshcode attach api", ""]],
    seeAlso: ["ps", "herd", "kill"],
    note: "under tmux the session gets a one-line mosh bar along the bottom for as long as you are "
      + "attached, so the way out is on screen even when the agent has the keyboard: F12 reaches it, "
      + "Esc goes back, `detach` leaves. it is taken away again when you detach. "
      + "detaching leaves the session running; ending it is `moshcode kill`. "
      + "the whole herd shares one tmux server, so from inside any session Ctrl-b s picks another, "
      + "Ctrl-b ) and Ctrl-b ( step through them, and Ctrl-b L goes back to the last one — "
      + "no switcher under the no-tmux fallback, where Ctrl-] detaches instead.",
  },
  {
    name: "kill",
    group: "runtime",
    description: "end a herd session",
    synopsis: [["moshcode kill <name…> | --all", ""]],
    flags: [["--all", "end every session in the herd", ""]],
    examples: [["moshcode kill api", ""]],
    seeAlso: ["ps", "herd", "attach"],
  },
  {
    name: "wait",
    group: "runtime",
    description: "block until a session is blocked, done, or idle",
    synopsis: [["moshcode wait <name> [--state blocked,done] [--timeout 30m]", ""]],
    flags: [
      ["--state <list>", "states to wait for, comma-separated", "blocked,done"],
      ["--timeout <dur>", "give up after this long (30s, 10m, 2h)", "30m"],
      ["--json", "machine-readable", ""],
    ],
    examples: [["moshcode wait api --state blocked --timeout 1h", "exit 0 matched · 2 timed out · 3 gone"]],
    seeAlso: ["herd", "ps"],
    note: "exit codes are the point: 0 matched, 2 timed out, 3 no such session.",
  },
  {
    name: "restore",
    group: "runtime",
    description: "rebuild the herd's sessions after a reboot",
    synopsis: [["moshcode restore [--resume] [--dry-run]", ""]],
    flags: [
      ["--resume", "ask each engine to reopen its own last conversation", ""],
      ["--dry-run", "say what would come back, change nothing", ""],
    ],
    examples: [["moshcode restore --dry-run", ""]],
    seeAlso: ["herd", "ps"],
    note: "this brings back the shape — sessions, directories, engines. the processes are new; work that was in flight is not still running.",
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
    synopsis: [["moshcode whoami [--json]", ""]],
    flags: [["--json", "print account status as machine-readable JSON", ""]],
    examples: [["moshcode whoami --json", "inspect the current session from a script"]],
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
    name: "save",
    group: "account",
    description: "save this machine's pit settings to your account",
    synopsis: [["moshcode save [--dry-run] [--force] [--json]", ""]],
    flags: [
      ["--dry-run", "list what would be saved and stop", ""],
      ["--force", "save even if another machine saved after this one last synced", ""],
      ["--json", "machine-readable result", ""],
    ],
    examples: [
      ["moshcode save", "push aliases + herd rules to app.moshcode.sh"],
      ["moshcode save --dry-run", "what would go up"],
    ],
    seeAlso: ["load", "login", "alias"],
    note: "aliases (~/.moshcode/aliases.json) and herd rules (~/.moshcode/herd/rules.json). "
      + "credentials, live herd state and the package cache are never included. "
      + "each save is a numbered revision; the last ten are kept at app.moshcode.sh/settings/sync.",
  },
  {
    name: "load",
    group: "account",
    description: "bring your saved pit settings onto this machine",
    synopsis: [["moshcode load [--dry-run] [--force] [--json]", ""]],
    flags: [
      ["--dry-run", "show the per-file plan and change nothing", ""],
      ["--force", "overwrite local settings that changed since the last sync", ""],
      ["--json", "machine-readable result", ""],
    ],
    examples: [
      ["moshcode load", "on a new machine, right after moshcode login"],
      ["moshcode load --dry-run", "which files would change"],
    ],
    seeAlso: ["save", "login", "alias"],
    note: "refuses rather than overwriting a local file you edited since the last sync — "
      + "`moshcode save` to keep it, or --force to replace it.",
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
      ["--no-proxy", "with enable: answer origins rather than the local proxy", ""],
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
    name: "games",
    group: "arcade",
    description: "the moshcode arcade — sixteen games, no menus",
    synopsis: [
      ["moshcode games", "the cabinet, and what each one is"],
      ["moshcode games <game>", "play it, right here in the terminal"],
    ],
    flags: [["--json", "the roster, machine-readable", ""]],
    examples: [
      ["moshcode games", "what is in the arcade"],
      ["moshcode games tetris", ""],
      ["moshcode games chess", "real rules, and it plays back"],
      ["moshcode games pacman", "dots, ghosts, three lives"],
      ["moshcode games asteroids", "turn, thrust, shoot"],
      ["moshcode games 21", "blackjack, 100 chips, 3:2"],
      ["moshcode games invaders", "forty of them, coming down"],
      ["moshcode games stagedive", "jump the gear, take the picks"],
    ],
    seeAlso: ["help"],
    note: "every game works the same way: arrows move, q quits, r starts another. "
      + "Playing needs a real terminal because they read single keypresses — `moshcode games` on its own lists them anywhere.",
  },
  { name: "game", aliasOf: "games", description: "alias for games" },
  { name: "arcade", aliasOf: "games", description: "alias for games" },
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
    name: "trade",
    group: "tools",
    description: "look up markets and trade through Alpaca",
    synopsis: [["moshcode trade <verb> [args…]", "paper trading is Alpaca's default"]],
    verbs: "TRADE_VERBS",
    examples: [
      ["moshcode trade ticker AAPL", "asset lookup"],
      ["moshcode trade analysis AAPL", "quote/trade/bar snapshot"],
      ["moshcode trade buy AAPL 1", "preview a market order"],
      ["moshcode trade buy AAPL 1 --submit", "place it"],
    ],
    seeAlso: ["tools", "install"],
    note: "buy/sell inject --dry-run unless --submit is present. Alpaca defaults to paper trading; live trading requires its separate --live opt-in.",
  },
  {
    name: "stocks",
    group: "tools",
    description: "equity research from advis0r.com",
    synopsis: [
      ["moshcode stocks <symbol>", "the stored research report for one ticker"],
      ["moshcode stocks <verb> [args…]", ""],
    ],
    verbs: "STOCKS_VERBS",
    flags: [
      ["--json", "print the raw API response", ""],
      ["--limit <n>", "cap results (search/lookup/reports/discover)", "the API's own default"],
      ["--sort <s>", "reports order: recent | score | ticker", "score"],
      ["--horizon <n>", "discover: quarters to look ahead (1 or 2)", "2"],
      ["--provider <p>", "discover: analysis provider", "offline"],
    ],
    examples: [
      ["moshcode stocks NVDA", "score, technicals, thesis, signals, sources"],
      ["moshcode stocks lookup rivian", "company name → RIVN"],
      ["moshcode stocks signals AAPL", "what was actually said, with sources"],
      ["moshcode stocks search 'data center'", "across every indexed transcript"],
      ["moshcode stocks reports --limit 10", "the stored index, best score first"],
    ],
    seeAlso: ["trade", "plugin", "tools"],
    note: "research aid, not advice — reports are stored snapshots and every one prints when it was generated. Set MOSHCODE_ADVISOR_URL to point at another instance.",
  },
  { name: "advisor", aliasOf: "stocks", description: "alias for stocks" },
  {
    name: "crypto",
    group: "tools",
    description: "crypto market data from advis0r.com",
    synopsis: [
      ["moshcode crypto <pair>", "the full report for one pair"],
      ["moshcode crypto <verb> [args…]", ""],
    ],
    verbs: "CRYPTO_VERBS",
    flags: [
      ["--json", "print the raw API response", ""],
      ["--timeframe <tf>", "bars: 1Min | 5Min | 15Min | 1Hour | 1Day | 1Week", "1Day"],
      ["--start <iso>", "bars: window start", "the API's own default"],
      ["--end <iso>", "bars: window end", "now"],
      ["--limit <n>", "cap results (bars/lookup)", "the API's own default"],
      ["--depth <n>", "book: levels per side", "10"],
      ["--period <p>", "spark: 24h | 7d", "24h"],
      ["--horizon <n>", "technicals: quarters the score looks ahead (1 or 2)", "2"],
    ],
    examples: [
      ["moshcode crypto BTC", "price, technicals, score, supply, order book"],
      ["moshcode crypto lookup bitcoin", "asset name → BTC/USD"],
      ["moshcode crypto spark BTC ETH SOL", "24h closes as sparklines"],
      ["moshcode crypto bars ETH --timeframe 1Hour", "historical OHLCV"],
      ["moshcode crypto book BTC-USD --depth 5", "top of book, both sides"],
    ],
    seeAlso: ["stocks", "trade", "plugin"],
    note: "research aid, not advice — prices are Alpaca's US crypto venue alone and can differ materially from other exchanges. Crypto trades 24/7 with no circuit breakers. Set MOSHCODE_ADVISOR_URL to point at another instance.",
  },
  { name: "coins", aliasOf: "crypto", description: "alias for crypto" },
  {
    name: "plugin",
    group: "extend",
    description: "install moshcode's slash commands into Claude Code",
    synopsis: [["moshcode plugin <verb> [name]", ""]],
    verbs: "PLUGIN_VERBS",
    flags: [["--json", "machine-readable", ""]],
    examples: [
      ["moshcode plugin install", "add the marketplace and install ticker"],
      ["moshcode plugin list", "what this marketplace ships, and what is installed"],
    ],
    seeAlso: ["skill", "mcp", "stocks"],
    note: "Claude Code is the only engine with a plugin primitive; the others are reported as skipped, exactly as they are for skills.",
  },
  { name: "plugins", aliasOf: "plugin", description: "alias for plugin" },
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

export const TRADE_VERBS = [
  { name: "ticker", description: "look up an asset by ticker", synopsis: [["moshcode trade ticker <symbol> [flags…]", ""]] },
  { name: "quote", description: "get the latest quote", synopsis: [["moshcode trade quote <symbol> [flags…]", ""]] },
  { name: "analysis", description: "get an analysis-ready market snapshot", synopsis: [["moshcode trade analysis <symbol> [flags…]", ""]] },
  {
    name: "buy", description: "preview or submit a buy order",
    synopsis: [
      ["moshcode trade buy <symbol> <qty> [alpaca flags…] [--submit]", "share quantity"],
      ["moshcode trade buy <symbol> --notional <usd> [--submit]", "dollar amount"],
    ],
    flags: [["--submit", "place the order instead of injecting --dry-run", "preview"]],
  },
  {
    name: "sell", description: "preview or submit a sell order",
    synopsis: [
      ["moshcode trade sell <symbol> <qty> [alpaca flags…] [--submit]", "share quantity"],
      ["moshcode trade sell <symbol> --notional <usd> [--submit]", "dollar amount"],
    ],
    flags: [["--submit", "place the order instead of injecting --dry-run", "preview"]],
  },
  { name: "watch", description: "manage watchlists", synopsis: [["moshcode trade watch [list|create|get|add|remove|delete] [args…]", ""]] },
  { name: "positions", description: "list, inspect, or close positions", synopsis: [["moshcode trade positions [verb] [args…]", "default: list"]] },
  { name: "orders", description: "list, inspect, replace, or cancel orders", synopsis: [["moshcode trade orders [verb] [args…]", "default: list"]] },
  { name: "account", description: "show account details", synopsis: [["moshcode trade account [args…]", ""]] },
  { name: "login", description: "authenticate an Alpaca profile", synopsis: [["moshcode trade login [alpaca profile flags…]", "paper by default"]] },
  { name: "clock", description: "show market status and next open/close", synopsis: [["moshcode trade clock [args…]", ""]] },
  { name: "raw", description: "invoke the native Alpaca command tree", synopsis: [["moshcode trade raw <alpaca args…>", ""]] },
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

/**
 * `stocks`'s verbs.
 *
 * `report` exists so a symbol that collides with a verb name still has an
 * unambiguous spelling; without it, the bare-symbol shortcut would have no
 * escape hatch. src/advisor.mjs owns the parser and test/advisor.test.mjs
 * fails when the two lists disagree.
 */
export const STOCKS_VERBS = [
  { name: "report", description: "the stored research report for one ticker", synopsis: [["moshcode stocks report <symbol>", "same as `moshcode stocks <symbol>`"]] },
  { name: "signals", description: "every extracted signal for a ticker", synopsis: [["moshcode stocks signals <symbol>", ""]] },
  {
    name: "search", description: "full-text search across indexed transcripts",
    synopsis: [["moshcode stocks search <words…> [--limit n]", ""]],
  },
  {
    name: "lookup", description: "find a ticker by company name",
    synopsis: [["moshcode stocks lookup <company…> [--limit n]", "rivian → RIVN"]],
  },
  {
    name: "reports", description: "every stored report",
    synopsis: [["moshcode stocks reports [--sort recent|score|ticker] [--limit n]", ""]],
  },
  {
    name: "discover", description: "a ranked watchlist for a topic",
    synopsis: [["moshcode stocks discover [topic…] [--horizon 1|2] [--provider p] [--limit n]", ""]],
    note: "ranks by analyzing each candidate — this one takes minutes, not milliseconds.",
  },
  { name: "tickers", description: "every ticker present in the index", synopsis: [["moshcode stocks tickers", ""]] },
  { name: "stats", description: "index coverage counts", synopsis: [["moshcode stocks stats", ""]] },
  { name: "open", description: "open the shareable report page in a browser", synopsis: [["moshcode stocks open <symbol>", ""]] },
];

/**
 * `crypto`'s verbs.
 *
 * `report` earns its place for the same reason stocks's does — a bare pair is
 * the shortcut, so a pair that collides with a verb name needs a spelling that
 * cannot be mistaken for one. src/crypto.mjs owns the parser and
 * test/crypto.test.mjs fails when the two lists disagree.
 */
export const CRYPTO_VERBS = [
  { name: "report", description: "the full report for one pair", synopsis: [["moshcode crypto report <pair>", "same as `moshcode crypto <pair>`"]] },
  { name: "quote", description: "latest trade and quote, with the bid/ask spread", synopsis: [["moshcode crypto quote <pair>", ""]] },
  {
    name: "snapshot", description: "trade, quote and daily bars for several pairs",
    synopsis: [["moshcode crypto snapshot <pair…>", "up to 20 pairs"]],
  },
  {
    name: "technicals", description: "indicators and the technical score",
    synopsis: [["moshcode crypto technicals <pair> [--horizon 1|2]", ""]],
  },
  {
    name: "bars", description: "historical OHLCV",
    synopsis: [["moshcode crypto bars <pair> [--timeframe tf] [--start iso] [--end iso] [--limit n]", ""]],
  },
  { name: "book", description: "top of the order book, both sides", synopsis: [["moshcode crypto book <pair> [--depth n]", ""]] },
  {
    name: "spark", description: "recent closes, drawn as sparklines",
    synopsis: [["moshcode crypto spark <pair…> [--period 24h|7d]", ""]],
  },
  { name: "assets", description: "every supported pair", synopsis: [["moshcode crypto assets", ""]] },
  {
    name: "lookup", description: "find a pair by asset name",
    synopsis: [["moshcode crypto lookup <name…> [--limit n]", "bitcoin → BTC/USD"]],
  },
  { name: "open", description: "open the shareable page in a browser", synopsis: [["moshcode crypto open <pair>", ""]] },
];

export const PLUGIN_VERBS = [
  {
    name: "install", description: "add the marketplace and install a plugin",
    synopsis: [
      ["moshcode plugin install", "the default plugin (ticker)"],
      ["moshcode plugin install <name>", ""],
    ],
  },
  { name: "list", description: "show what the marketplace ships and what is installed", synopsis: [["moshcode plugin list [--json]", ""]] },
  { name: "remove", description: "uninstall a plugin from Claude Code", synopsis: [["moshcode plugin remove <name>", ""]] },
];

/** Sub-verb tables, by the name a command's `verbs` field refers to. */
export const HERD_VERBS = [
  { name: "ps", description: "the roster: every session and its state",
    synopsis: [["moshcode herd ps [--json]", ""]],
    flags: [["--json", "machine-readable", ""]] },
  { name: "status", description: "what the herd is running on, and how many sessions",
    synopsis: [["moshcode herd status [--json]", ""]],
    flags: [["--json", "machine-readable", ""]] },
  { name: "start", description: "start a session and hand the prompt back",
    synopsis: [["moshcode herd start <engine> [--name <slug>] [--agent] [args…]", ""]],
    flags: [
      ["--name <slug>", "session name", "<engine>-<dir>"],
      ["--cwd <dir>", "where to run it", "this directory"],
      ["--agent", "autonomous mode — bypasses the engine's approvals", ""],
      ["--json", "machine-readable", ""],
    ] },
  { name: "tile", description: "every member on screen at once, in a tiled window",
    synopsis: [["moshcode herd tile [herd]", "click a tile to focus · Ctrl-b z zooms · Ctrl-b d leaves them running"]],
    flags: [],
    examples: [["moshcode herd tile", "all of them"], ["moshcode herd tile scratch", "one herd"]] },
  { name: "untile", description: "put tiled members back in their own sessions",
    synopsis: [["moshcode herd untile", ""]] },
  { name: "ui", description: "sidebar of members and actions, selected one beside it",
    synopsis: [["moshcode herd ui", "click a member to show it · click it again to type in it · F12 for the mosh bar"]],
    flags: [],
    examples: [["moshcode herd ui", "the workspace — start here"]] },
  { name: "bar", description: "the one-line mosh prompt under the session (runs inside the workspace)",
    synopsis: [["moshcode herd bar", "F12 reaches it from inside an agent · Esc goes back · detach leaves"]],
    flags: [],
    examples: [
      ["F12", "jump to the bar from anywhere, even mid-agent"],
      ["start claude", "another agent, without leaving this one"],
      ["show api", "put a different member on screen"],
    ] },
  { name: "run", description: "run ANY command in the herd — an agent moshcode does not ship, a build, a script",
    synopsis: [["moshcode herd run [--name <slug>] -- <command…>", "everything after -- is the command"]],
    flags: [
      ["--name <slug>", "session name", "<command>-<dir>"],
      ["--cwd <dir>", "where to run it", "this directory"],
      ["--json", "machine-readable", ""],
    ] },
  { name: "shell", description: "a plain $SHELL in the herd",
    synopsis: [["moshcode herd shell [--name <slug>]", ""]],
    flags: [["--name <slug>", "session name", "shell-<dir>"], ["--cwd <dir>", "where to run it", "this directory"]] },
  { name: "attach", description: "put this terminal inside a session",
    synopsis: [["moshcode herd attach <name>", ""]] },
  { name: "kill", description: "end a session",
    synopsis: [["moshcode herd kill <name…> | --all", ""]],
    flags: [["--all", "every session", ""]] },
  { name: "prune", description: "forget sessions the runtime no longer has",
    synopsis: [["moshcode herd prune", "never ends anything that is running"]] },
  { name: "read", description: "read a session's screen without attaching",
    synopsis: [["moshcode herd read <name> [--lines N]", ""]],
    flags: [["--lines <n>", "how much of the screen", "60"], ["--json", "machine-readable", ""]] },
  { name: "prompt", description: "type a prompt into a session",
    synopsis: [['moshcode herd prompt <name> "<text>" [--wait]', ""]],
    flags: [
      ["--wait", "block until the session stops working", ""],
      ["--timeout <dur>", "give up waiting after this long", "30m"],
      ["--json", "machine-readable", ""],
    ] },
  { name: "send-keys", description: "send raw keys (Enter, Escape, C-c, literal text)",
    synopsis: [["moshcode herd send-keys <name> <keys…>", ""]] },
  { name: "wait", description: "block until a session reaches a state",
    synopsis: [["moshcode herd wait <name> [--state blocked,done]", ""]],
    flags: [
      ["--state <list>", "states to wait for", "blocked,done"],
      ["--timeout <dur>", "give up after this long", "30m"],
      ["--json", "machine-readable", ""],
    ] },
  { name: "restore", description: "rebuild remembered sessions after a reboot",
    synopsis: [["moshcode herd restore [--resume] [--dry-run]", ""]],
    flags: [["--resume", "reopen each engine's last conversation", ""], ["--dry-run", "change nothing", ""]] },
  { name: "report", description: "record an authoritative state (for engine hooks)",
    synopsis: [["moshcode herd report <name> <state> [--ttl 15m]", ""]],
    flags: [["--ttl <dur>", "how long the report stays authoritative", "15m"]] },
  { name: "notify", description: "page the operator when a session blocks",
    synopsis: [["moshcode herd notify <on|off|status> [--state blocked,done] [--ask]", ""]],
    flags: [
      ["--state <list>", "which transitions are worth a notification", "blocked"],
      ["--ask", "wait for a reply and type it into the session", ""],
      ["--no-ask", "notify only; never wait for a reply", ""],
    ] },
  { name: "watch", description: "deliver those notifications (run it inside the herd)",
    synopsis: [["moshcode herd watch [--interval 5s]", ""]],
    flags: [["--interval <dur>", "how often to look", "5s"], ["--force", "watch even with notifications off", ""]] },
  { name: "stop", description: "stop the whole runtime and everything in it",
    synopsis: [["moshcode herd stop --yes", ""]],
    flags: [["--yes, -y", "required when sessions are running", ""]] },
];

export const VERB_TABLES = {
  HERD_VERBS,
  MCP_VERBS,
  SKILL_VERBS,
  UPGRADE_TARGETS,
  DNS_VERBS,
  TRADE_VERBS,
  STOCKS_VERBS,
  CRYPTO_VERBS,
  PLUGIN_VERBS,
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
  { name: "new", pitOnly: true,
    description: "open and switch to another moshcode tab" },
  { name: "agents", aliases: ["agent", "engines"], args: "[name]", cli: "agents",
    description: "list engines, or launch one autonomously" },
  { name: "start", args: "<engine> [args…]", cli: "start",
    description: "raw launch; inject no engine arguments" },
  { name: "herd", args: "[verb] [args…]", cli: "herd",
    description: "sessions that keep running when you leave" },
  { name: "ps", cli: "ps",
    description: "what the herd is running, and which one wants you" },
  { name: "attach", args: "<name>", cli: "attach",
    description: "step into a herd session (detach leaves it running)" },
  { name: "kill", args: "<name…>", cli: "kill",
    description: "end a herd session" },
  { name: "wait", args: "<name> [--state …]", cli: "wait",
    description: "block until a session is blocked or done" },
  { name: "restore", args: "[--resume]", cli: "restore",
    description: "rebuild the herd's sessions after a reboot" },
  { name: "tools", args: "[name] [args…]", cli: "tools",
    description: "list workflow tools, or run one" },
  { name: "trade", args: "<verb> [args…]", cli: "trade",
    description: "look up markets and preview/place Alpaca orders" },
  { name: "stocks", aliases: ["advisor"], args: "<symbol|verb> [args…]", cli: "stocks",
    description: "equity research from advis0r.com" },
  { name: "crypto", aliases: ["coins"], args: "<pair|verb> [args…]", cli: "crypto",
    description: "crypto market data from advis0r.com" },
  { name: "plugin", aliases: ["plugins"], args: "<verb> [name]", cli: "plugin",
    description: "install moshcode's slash commands into Claude Code" },
  { name: "games", aliases: ["game", "arcade", "play"], args: "[game]", cli: "games",
    description: "the arcade — tetris, invaders, pac-man, breakout, pong, tank, chess and more" },
  { name: "socials", aliases: ["social"], pitOnly: true,
    description: "list social networks available for posting" },
  { name: "post", args: '<social> "message"', pitOnly: true,
    description: "open a social composer with a prepared post" },
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
  { name: "save", args: "[--dry-run] [--force]", cli: "save",
    description: "save this pit's settings to your moshcode.sh account" },
  { name: "load", args: "[--dry-run] [--force]", cli: "load",
    description: "bring your saved settings onto this machine" },
  { name: "pwd", aliases: ["where"], cli: "pwd",
    description: "show the current dir + git repo/branch/origin" },
  { name: "shell", aliases: ["sh"], args: "[cmd]", pitOnly: true,
    description: "drop into $SHELL (exit → back to the pit); also !cmd" },
  { name: "alias", aliases: ["aliases"], args: 'set <name> "<cmd>" | list | get | rm', pitOnly: true,
    description: "name a line you keep retyping; /<name> runs it",
    synopsis: [
      ['/alias set <name> "<command>"', "define one (also: /alias <name> \"<command>\")"],
      ["/alias [list] [--json]", "every alias"],
      ["/alias get <name>", "what one expands to"],
      ["/alias rm <name>", "forget one"],
    ],
    examples: [
      ['/alias set gs "git status"', "then /gs — and /gs -sb appends"],
      // Deliberately not `cc`: that one is already how the pit spells claude,
      // so the example would print a refusal for anyone who typed it.
      ['/alias set cx "/agents codex"', "a pit command, not a shell one"],
      ["/alias rm gs", ""],
    ],
    note: "the command runs in $SHELL unless it starts with / — then it is a pit command. "
      + "Aliases live in ~/.moshcode/aliases.json and cannot shadow a pit command, engine, or tool.",
  },
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
