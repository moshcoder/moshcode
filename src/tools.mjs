// Adjacent workflow CLIs moshcode can install and transparently invoke.
// These are deliberately separate from coding engines: UGig owns marketplace
// workflows, CoinPay owns payment workflows, c0mpute owns the compute network,
// c0upons owns community coupons and bounties, the cloud CLIs below own
// deploys/secrets/infra, Coral owns read-only data access across those systems,
// and moshcode only conducts their native command lines.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mergeAliases } from "./aliases.mjs";
import { isInstalled, openPassthrough } from "./engines.mjs";

// gh, supabase, and doctl publish only GitHub release binaries — no official
// cross-platform install script between them — so their install spec runs our
// own downloader instead of a vendor one. See src/release-install.mjs.
const RELEASE_INSTALLER = path.join(path.dirname(fileURLToPath(import.meta.url)), "release-install.mjs");
const releaseInstall = (tool) => ({ cmd: process.execPath, args: [RELEASE_INSTALLER, tool] });

// ffmpeg and ImageMagick ship as distro packages and nothing else — no vendor
// installer, no release binary we would trust. See src/pkg-install.mjs for why
// the static rebuilds floating around are not an option here.
const PACKAGE_INSTALLER = path.join(path.dirname(fileURLToPath(import.meta.url)), "pkg-install.mjs");
const packageInstall = (tool) => ({ cmd: process.execPath, args: [PACKAGE_INSTALLER, tool] });

export const TOOLS = {
  ugig: {
    desc: "UGig — freelance marketplace CLI for humans and agents",
    bin: "ugig",
    // UGig isn't published to npm — it ships via its own install script.
    install: { cmd: "bash", args: ["-c", "curl -fsSL https://ugig.net/install.sh | bash"] },
  },
  coinpay: {
    desc: "CoinPay — wallets, payments, swaps, escrow, and settlement",
    bin: "coinpay",
    // CoinPay ships via its own install script (fetched from GitHub), not npm.
    install: { cmd: "sh", args: ["-c", "curl -fsSL https://coinpayportal.com/install.sh | sh"] },
  },
  c0mpute: {
    desc: "c0mpute — decentralized compute network CLI",
    bin: "c0mpute",
    // c0mpute ships via its own install script (the v1 stack installer).
    install: { cmd: "sh", args: ["-c", "curl -fsSL https://c0mpute.com/install.sh | sh"] },
  },
  c0upons: {
    desc: "c0upons — community coupon search, submissions, and bounties",
    bin: "c0upons",
    // c0upons ships its own POSIX-sh installer, so `| sh` is enough here (the
    // script avoids bashisms deliberately) — no npm package to install from.
    install: { cmd: "sh", args: ["-c", "curl -fsSL https://c0upons.com/install.sh | sh"] },
    // The CLI updates itself in place from the same origin the installer uses.
    upgrade: { cmd: "c0upons", args: ["upgrade"] },
  },
  "cli-tools": {
    desc: "Profullstack cli-tools — blog publishing, domain availability, and GitHub PR sweeps",
    // The odd shape here: this is a *set* of commands, not one binary. The
    // installer symlinks blog-post, domainfree, domainjson, gh-prs,
    // gh-prs-merge, gh-prs-fix-all and tcfeed into ~/.local/bin, and `cli-tools`
    // is the dispatcher that fronts them. Probing the dispatcher is what makes
    // "installed" mean "the whole set is installed" rather than "one of seven
    // names happens to exist".
    bin: "cli-tools",
    install: {
      cmd: "sh",
      args: [
        "-c",
        "curl -fsSL https://raw.githubusercontent.com/profullstack/cli-tools/master/install.sh | sh",
      ],
    },
    // The installer symlinks into ~/.local/bin and appends nothing to PATH, so
    // the shell that ran the install cannot see the commands — the same gap
    // turso, gradient and kimi have.
    binDirs: [path.join(homedir(), ".local", "bin")],
    // Its own updater, which pulls and relinks. Deliberately not the installer:
    // re-running that would re-clone for someone whose checkout lives
    // elsewhere, and `cli-tools update` refuses to move a dirty or diverged
    // tree rather than discarding work.
    upgrade: { cmd: "cli-tools", args: ["update"] },
    // The pit aliases this set offers. Read at the end of /install and
    // /upgrade, so installing the set is also configuring it — seven commands
    // behind one dispatcher are not reachable from the pit until the words that
    // reach them exist. `/alias install cli-tools` re-runs it on demand.
    //
    // Declared rather than probed: a command that prints a set of aliases is
    // only safe to run against a tool we already know answers it, and an
    // `aliases --json` guessed at every installed CLI would eventually hit one
    // where those words mean something else entirely.
    aliases: { cmd: "cli-tools", args: ["aliases", "--json"] },
  },
  timer: {
    desc: "Profullstack timer - track time against projects, for people and for agents",
    bin: "timer",
    // The standalone half of what /timer used to do entirely in-process. It
    // lives outside moshcode because tracking time is not a moshcode idea: it
    // works under any agentic CLI, on Linux, macOS and Windows, and
    // @profullstack/billing reads its timesheet directly. `npm install -g` is
    // idempotent, so it doubles as the upgrade path.
    install: { cmd: "npm", args: ["install", "-g", "@profullstack/timer"] },
  },
  billing: {
    desc: "Profullstack billing - clients, rates and invoices from tracked hours",
    bin: "billing",
    // The other half. It carries the rate model /rate parses ($100/hour/agent/
    // upto:4) and bills agent-hours from the timer's entries. `billing import`
    // brings across a ledger that started in ~/.moshcode/business.json.
    install: { cmd: "npm", args: ["install", "-g", "@profullstack/billing"] },
  },
  bo: {
    desc: "BufferOverride — capture a failing command, redact it, and find the answer that already exists",
    // The product is BufferOverride and the binary is `bo`, the same split
    // `secrets` → `logicsrc` and `spinifex` → `spx` have. It is keyed the other
    // way round from those two on purpose: `bo` is what its own documentation
    // tells you to type, and this is a command you run every time something
    // fails, so the short word is the one worth having in the pit.
    bin: "bo",
    // An ordinary global npm package with no dependencies of its own, and
    // `npm install -g` is idempotent, so re-running the install IS the upgrade
    // — no `upgrade` key, the same as mcpjam and railway.
    install: { cmd: "npm", args: ["install", "-g", "@profullstack/bufferoverride"] },
  },
  secrets: {
    desc: "LogicSRC — end-to-end-encrypted team credential sharing (login, teams, credentials)",
    // The passthrough target is the `logicsrc` binary; the moshcode command is
    // `/secrets` so it reads as "manage secrets". LOGICSRC_BIN points at a local
    // build before logicsrc ships a global install.
    bin: process.env.LOGICSRC_BIN || "logicsrc",
    // LogicSRC ships via its own install script (same pattern as the others).
    install: { cmd: "sh", args: ["-c", "curl -fsSL https://logicsrc.com/install.sh | sh"] },
  },
  railway: {
    desc: "Railway — deploy and manage Railway projects, services, and env vars",
    bin: "railway",
    // Railway's shell installer wants bash process substitution
    // (`bash <(curl …)`), which does not survive `sh -c "curl … | sh"`, and the
    // agents.railway.com variant additionally runs `railway setup agent`, which
    // rewrites local agent tool configs — a side effect an install command has
    // no business having. The official npm package is cross-platform and
    // idempotent, so it doubles as the upgrade path.
    install: { cmd: "npm", args: ["install", "-g", "@railway/cli"] },
  },
  gh: {
    desc: "GitHub CLI — repos, PRs, issues, releases, and Actions",
    bin: "gh",
    install: releaseInstall("gh"),
  },
  supabase: {
    desc: "Supabase — local stack, migrations, edge functions, and projects",
    bin: "supabase",
    // Supabase does not support a global npm install, so fetching the release
    // binary is what gives you a real `supabase` on PATH instead of `npx supabase`.
    install: releaseInstall("supabase"),
  },
  doppler: {
    desc: "Doppler — sync secrets and run commands with injected env",
    bin: "doppler",
    // Doppler's official script installs to /usr/local/bin via sudo by default;
    // --install-path keeps it user-local (and implies --no-package-manager).
    // The script verifies its own signature, so it needs `gpgv` on PATH — it
    // exits 3 with an explicit message when gnupg is missing.
    install: {
      cmd: "sh",
      args: [
        "-c",
        'mkdir -p "$HOME/.local/bin" && curl -fsSL https://cli.doppler.com/install.sh | sh -s -- --install-path "$HOME/.local/bin"',
      ],
    },
    upgrade: { cmd: "doppler", args: ["update"] },
  },
  doctl: {
    desc: "DigitalOcean — droplets, apps, databases, Kubernetes, and Spaces",
    bin: "doctl",
    install: releaseInstall("doctl"),
  },
  turso: {
    desc: "Turso — libSQL/SQLite at the edge (auth signup/login, db, replicas)",
    bin: "turso",
    // https://github.com/tursodatabase/turso-cli — the official installer, which
    // unpacks to $HOME/.turso and appends that dir to your shell profile. It is
    // therefore on PATH only for the NEXT shell, so PATH alone would report turso
    // as missing (and /turso would fail to launch it) in the session that
    // installed it — and in every already-running one. binDirs searches the
    // install dir after PATH so the binary is found either way.
    binDirs: [path.join(homedir(), ".turso")],
    install: { cmd: "bash", args: ["-c", "curl -sSfL https://get.tur.so/install.sh | bash"] },
  },
  tailscale: {
    desc: "Tailscale — WireGuard mesh VPN (up, status, ssh, serve, funnel)",
    bin: "tailscale",
    // The odd one out: tailscale is a system daemon, not a standalone binary, so
    // it cannot be dropped in ~/.local/bin like gh/supabase/doctl. The official
    // script goes through the distro package manager and enables `tailscaled`,
    // which means it needs root — it finds sudo/doas itself and may prompt for a
    // password (stdio is inherited, so the prompt works). On macOS the same
    // script delegates to the App Store.
    //
    // `needsRoot` is what lets us get that prompt out of the way before the work
    // starts rather than partway through it. It says nothing about how the
    // escalation happens — the vendor script still does its own — only that one
    // is coming, which is all primeEscalation needs to know. `tailscale update`
    // needs root for the same reason, so it covers both directions.
    //
    // macOS is the exception, and the same line above says why: there the script
    // delegates to the App Store, which does its own authorisation. Asking for a
    // sudo password there would be a prompt for a step that never escalates.
    needsRoot: { except: ["darwin"] },
    install: { cmd: "sh", args: ["-c", "curl -fsSL https://tailscale.com/install.sh | sh"] },
    // Native updater on Linux (v1.36+) and Windows. macOS updates come from the
    // App Store, so there it fails with tailscale's own message rather than
    // silently re-adding package repos.
    upgrade: { cmd: "tailscale", args: ["update"] },
  },
  coral: {
    desc: "Coral — read-only SQL across your APIs, databases, and internal systems",
    bin: "coral",
    // The vendor script resolves the latest GitHub release, verifies its
    // sha256, and drops the binary in $HOME/.local/bin (CORAL_INSTALL_DIR
    // overrides) — the same dir gh/supabase/doctl land in, so no binDirs.
    // The script is POSIX sh, but withcoral.com documents `| bash`, so that is
    // the pipeline we run. Re-running it is Coral's own documented upgrade path
    // for a direct install, and toolUpgradeSpec falls back to install, so there
    // is deliberately no upgrade key here.
    install: { cmd: "bash", args: ["-c", "curl -fsSL https://withcoral.com/install.sh | bash"] },
  },
  alpaca: {
    desc: "Alpaca — paper/live trading, market data, positions, and watchlists",
    bin: "alpaca",
    // Official Go install documented by Alpaca. Go writes to $GOBIN when set,
    // otherwise $GOPATH/bin (normally ~/go/bin); binDirs covers that default in
    // an already-running shell whose PATH has not picked it up yet.
    binDirs: [path.join(homedir(), "go", "bin")],
    install: {
      cmd: "go",
      args: ["install", "github.com/alpacahq/cli/cmd/alpaca@latest"],
    },
    installHelp: "Go is required to install Alpaca; install Go, then retry `moshcode install alpaca`.",
  },
  gradient: {
    desc: "DigitalOcean Gradient ADK — build, run, deploy and evaluate agents (A2A-capable)",
    bin: "gradient",
    // The one tool here that is not a self-contained binary. gradient-adk is a
    // Python package, and moshcode stays Node: the tool owns its runtime, the
    // same way CoinPay owns Node 20. So the install spec checks for a Python
    // the package can actually run on and NAMES the requirement when it is
    // missing, rather than letting pip fail three screens later with a
    // resolution error nobody reads. `--user` keeps it out of the system
    // site-packages, which is also the only place a non-root install can go on
    // a modern distro.
    install: {
      cmd: "sh",
      args: [
        "-c",
        'python3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" 2>/dev/null '
        + '|| { echo "gradient-adk needs Python 3.10 or newer on PATH as python3 — install it, then re-run: moshcode install gradient" >&2; exit 1; }; '
        + "python3 -m pip install --user --upgrade gradient-adk",
      ],
    },
    installHelp: "gradient-adk is a Python package: it needs python3 (3.10+) and pip. moshcode does not install Python for you.",
    // pip --user drops console scripts here, and appends nothing to PATH for
    // the shell that ran the install — the same gap turso and kimi have.
    binDirs: [path.join(homedir(), ".local", "bin")],
    // How the ADK's dev server reads in the herd (PRD 0011 R15). `gradient
    // agent run --dev` is uvicorn underneath, and its startup banner is a clear
    // "I am up and waiting", which is `idle`.
    //
    // There is deliberately no `working` rule. uvicorn writes its access line
    // when a request has FINISHED, so a screen showing one is a screen showing
    // a server that is free again — a rule matching it would pin the tile to
    // `working` from the first request until the line scrolled away, which is
    // the exact kind of rot the sub-kinds and hooks exist to get away from. So
    // the completed request counts as idle too, and it is right both times.
    // Watching a *deployed* agent's state is what `herd remote add` is for.
    state: {
      idle: [
        /\buvicorn running on\b/i,
        /\bapplication startup complete\b/i,
        /"(?:POST|GET|PUT) \/[^"]*" \d{3}\b/,
      ],
    },
  },
  mcpjam: {
    desc: "MCPJam — test, debug, and validate MCP servers (health, OAuth, tool-surface diffs)",
    bin: "mcpjam",
    // The companion to `moshcode mcp`: that registers a server across engines,
    // this one tells you whether the server is actually worth registering.
    // Published as an ordinary global npm package, and `npm install -g` is
    // idempotent, so it doubles as the upgrade path — no `upgrade` key needed.
    install: { cmd: "npm", args: ["install", "-g", "@mcpjam/cli"] },
  },
  spinifex: {
    desc: "Spinifex — AWS-compatible cloud on your own hardware (EC2, EBS, S3, VPC, IAM)",
    // The product is Spinifex; the binary it installs is `spx`. Same split as
    // `secrets` → `logicsrc`: the moshcode command reads as the product name.
    bin: "spx",
    // https://docs.mulgadc.com/docs/install — the vendor script drops
    // /usr/local/bin/spx, installs systemd units and scoped sudoers rules, and
    // pulls QEMU/OVN/AWS CLI through apt, so it is Linux-only (Ubuntu 26.04 /
    // Debian 13) and always escalates. It finds sudo itself, like tailscale's,
    // so needsRoot only says a password prompt is coming — see primeEscalation.
    //
    // The script is bash (it uses bashisms and documents `| bash`), so `sh -c
    // "curl … | sh"` would not do.
    //
    // INSTALL_SPINIFEX_SKIP_NEWGRP is the important part: on a TTY the
    // installer finishes with `exec newgrp spinifex`, replacing itself with an
    // interactive subshell to activate the new group. Under `moshcode install`
    // that never returns — the operator lands in a subshell instead of back in
    // the pit, and inside `moshcode update` it would park the rest of the plan
    // behind a shell nobody asked for. Skipping it costs nothing a new login
    // shell does not fix.
    needsRoot: true,
    install: {
      cmd: "bash",
      args: ["-c", "curl -fsSL https://install.mulgadc.com | INSTALL_SPINIFEX_SKIP_NEWGRP=1 bash"],
    },
    // Re-running the installer is Spinifex's own documented update path — it
    // detects the existing install, replaces the binary, runs pending config
    // migrations, and restarts the services. toolUpgradeSpec falls back to
    // install, so there is deliberately no upgrade key.
  },
  alchemy: {
    desc: "Alchemy — onchain data, apps and webhooks, agent wallets, and x402 payments (EVM + Solana)",
    bin: "alchemy",
    // An ordinary global npm package, and `npm install -g` is idempotent, so
    // re-running the install IS the upgrade — same shape as mcpjam, hence no
    // upgrade key. Its postinstall only prints a banner on a global install:
    // the skill-sync branch above it needs a skills-lock.json that the
    // published tarball does not ship, so nothing reaches out or is written.
    //
    // No installHelp: that line is for a MISSING installer (alpaca's go,
    // gradient's python3), and npm is already here — moshcode runs on it. The
    // package does declare node >=22, which npm warns about rather than
    // refuses; the CLI then says so itself on first run, which is a better
    // place to hear it than an install that succeeded.
    install: { cmd: "npm", args: ["install", "-g", "@alchemy/cli"] },
  },
  elevenlabs: {
    desc: "ElevenLabs — build, configure and deploy Eleven Agents (plus voices, TTS, dubbing, and the rest of the API)",
    bin: "elevenlabs",
    // A workflow tool rather than an engine, despite the name. ElevenLabs calls
    // these "agents", but they are conversational voice agents you configure and
    // deploy to their platform: `elevenlabs agents push/pull/list` is an API
    // client that runs one request and exits. `/agents` promises to hand the
    // terminal to a live session, and there is no session here to hand it, so
    // this belongs next to the other workflow CLIs. Docs:
    // https://elevenlabs.io/docs/eleven-agents/operate/cli
    //
    // Authenticate once with `moshcode elevenlabs auth login` — a PKCE OAuth
    // flow that stores the credential in the system keyring (falling back to a
    // file under ~/.config), rather than an env var to keep exporting.
    //
    // The published package is a tiny Node shim; the real CLI is a native
    // binary shipped per platform as an OPTIONAL dependency
    // (@elevenlabs/cli-linux-x64 and friends). That is why the install spec is
    // the plain global install with no flags: an install run with
    // `--omit=optional` or `--no-optional` still succeeds and still puts
    // `elevenlabs` on PATH, but every invocation then dies with "the platform
    // package is not installed". `npm install -g` is idempotent and the CLI
    // ships no updater of its own, so this doubles as the upgrade path and
    // there is deliberately no `upgrade` key.
    install: { cmd: "npm", args: ["install", "-g", "@elevenlabs/cli"] },
  },
  "yt-dlp": {
    desc: "yt-dlp — download video and audio from a URL (a thousand sites, not just YouTube)",
    bin: "yt-dlp",
    // The three tools below are not workflow CLIs like everything above: they
    // are the media toolchain `cli-tools` builds on. `dl` is a front for
    // yt-dlp, `vid` for ffmpeg and `img` for ImageMagick, and all three used to
    // tell you to go and install a system package by hand. Now the same
    // registry that installs cli-tools can install what it runs on.
    //
    // A PyInstaller bundle from the project's own releases, so it needs no
    // python and no package manager, and it lands in ~/.local/bin like
    // gh/supabase/doctl. Distro packages of yt-dlp are the one thing worth
    // avoiding here: extractors break whenever a site changes, upstream ships a
    // fix within days, and a distro package is frozen for the life of a release.
    install: releaseInstall("yt-dlp"),
    // Which is also why the upgrade is yt-dlp's own `-U` rather than a
    // re-download: it is the update path the project documents, it checks
    // before it fetches, and it is the one an operator will reach for anyway.
    // On a yt-dlp that came from a package manager instead, `-U` declines and
    // says so, which is the correct answer rather than a failure.
    upgrade: { cmd: "yt-dlp", args: ["-U"] },
    // Same gap turso, gradient and kimi have: nothing appends to PATH.
    binDirs: [path.join(homedir(), ".local", "bin")],
  },
  ffmpeg: {
    desc: "ffmpeg — convert, cut, scale and inspect audio and video",
    bin: "ffmpeg",
    // Through the distro package manager, which means root everywhere but
    // macOS, where Homebrew refuses to run as root at all. Same shape as
    // tailscale, and for the same reason: get the password prompt out of the
    // way before a sweep starts rather than partway through one.
    needsRoot: { except: ["darwin"] },
    install: packageInstall("ffmpeg"),
    // No upgrade key: `apt-get install` / `brew install` on a package that is
    // already there upgrades it, so re-running the install IS the upgrade —
    // the same reasoning as mcpjam and railway, and toolUpgradeSpec falls back
    // to install on its own.
  },
  imagemagick: {
    desc: "ImageMagick — resize, convert and composite images from the command line",
    // Two names, deliberately. The command is `magick` on ImageMagick 7 and
    // `convert` on 6, and both are current: Ubuntu 24.04 and earlier ship 6,
    // 25.04 and later ship 7, and the package is called `imagemagick` on both.
    // A single name would report a perfectly good install as missing on
    // whichever half of the fleet has the other one.
    bin: ["magick", "convert"],
    needsRoot: { except: ["darwin"] },
    install: packageInstall("imagemagick"),
  },
};

/** Resolve a name to `[key, tool]`, or null. */
export function resolveTool(token) {
  if (!token) return null;
  const key = String(token).trim().toLowerCase();
  // Own properties only: TOOLS is a plain object literal, so a name like
  // `constructor` or `__proto__` would otherwise resolve to something off
  // Object.prototype and be handed on as a tool with no bin/install.
  return Object.hasOwn(TOOLS, key) ? [key, TOOLS[key]] : null;
}

/** Tool entries annotated with native executable install status. */
export function toolStatus() {
  return Object.entries(TOOLS).map(([key, tool]) => ({
    key,
    ...tool,
    installed: isInstalled(tool.bin, tool.binDirs),
  }));
}

export function toolList() {
  return Object.entries(TOOLS)
    .map(([key, tool]) => `  ${key.padEnd(11)} ${tool.desc}`)
    .join("\n");
}

/** Prefer a native updater when one is added; npm installs are idempotent. */
export function toolUpgradeSpec(tool) {
  return tool.upgrade || tool.install;
}

/** Invoke a tool without parsing or modifying its arguments or streams. */
export function openTool(tool, args = [], opts = {}) {
  return openPassthrough(tool, args, opts);
}

/** The command that prints a tool's proposed pit aliases, or null. */
export function toolAliasSpec(tool) {
  return tool?.aliases || null;
}

/**
 * Adopt a tool's aliases and describe the result in plain lines.
 *
 * The unpainted counterpart to the pit's renderer, for `moshcode install` —
 * which is a plain-stdout surface, and may be a script's stdout. Returns [] for
 * everything with nothing to say, so hanging this off an install costs a tool
 * that offers no aliases exactly one function call and no output.
 *
 * Silent on failure by design: an installer that succeeded must not be followed
 * by an error about a nicety, and `/alias install <tool>` says the same thing
 * loudly for anyone who goes looking.
 */
export function adoptAliasLines(key, tool, { isReserved = () => false, read = readToolAliases } = {}) {
  if (!toolAliasSpec(tool)) return [];
  const answer = read(tool);
  if (!answer.ok) return [];
  const result = mergeAliases(answer.aliases, { isReserved });
  if (!result.ok || !result.added.length) return [];
  return [
    `\n${key} also offers ${result.added.length} pit alias${result.added.length === 1 ? "" : "es"}:`,
    ...result.added.map(({ name, value }) => `  /${name} → ${value}`),
    ...(result.kept.length ? [`  (kept ${result.kept.length} you had already bound)`] : []),
  ];
}

/** Every tool that offers pit aliases, as `[key, tool]`. */
export function toolsWithAliases() {
  return Object.entries(TOOLS).filter(([, tool]) => toolAliasSpec(tool));
}

/**
 * How long a tool gets to print its aliases before we stop waiting.
 *
 * This runs on an interactive verb, so the failure we care about is a CLI that
 * blocks on something — a login prompt, a network read — rather than one that
 * is merely slow. Printing a constant should take milliseconds.
 */
const ALIAS_TIMEOUT_MS = 10_000;

/**
 * Ask a tool for the pit aliases it proposes: `{ ok, aliases, error }`.
 *
 * Captured rather than passed through, because the output is data we are about
 * to merge into the operator's config and not something to put on their
 * screen. Every failure is a returned reason instead of a throw — a tool that
 * is not installed, prints nothing, or prints something that is not JSON is an
 * ordinary outcome of this verb, not an error the pit should fall over on.
 *
 * `run` is injectable so the tests do not need seven CLIs on PATH.
 */
export function readToolAliases(tool, { run = spawnSync } = {}) {
  const spec = toolAliasSpec(tool);
  if (!spec) return { ok: false, error: "offers no aliases" };
  let result;
  try {
    result = run(spec.cmd, spec.args, {
      encoding: "utf8",
      timeout: ALIAS_TIMEOUT_MS,
      // No inherited stdin: a tool that decides to ask a question here would
      // otherwise hang the pit on a prompt nobody can see.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    const said = String(result.stderr || "").trim().split("\n")[0];
    return { ok: false, error: said || `${spec.cmd} exited ${result.status}` };
  }
  let parsed;
  try { parsed = JSON.parse(String(result.stdout || "")); }
  catch { return { ok: false, error: `${spec.cmd} didn't print JSON` }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: `${spec.cmd} printed JSON, but not a set of aliases` };
  }
  return { ok: true, aliases: parsed };
}

// Generic utilities used by the app/package surface.

/**
 * Format a number as currency
 */
export function formatCurrency(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency
  }).format(amount);
}

/**
 * Generate a random ID
 */
export function generateId(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Debounce function calls
 */
export function debounce(fn, delay = 300) {
  let timeoutId;
  return function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Deep clone an object
 */
export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Sleep for ms milliseconds
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function retry(fn, maxAttempts = 3, baseDelay = 1000) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('retry maxAttempts must be a positive integer');
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      await sleep(baseDelay * Math.pow(2, attempt - 1));
    }
  }
}
