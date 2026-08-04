// Adjacent workflow CLIs moshcode can install and transparently invoke.
// These are deliberately separate from coding engines: UGig owns marketplace
// workflows, CoinPay owns payment workflows, c0mpute owns the compute network,
// the cloud CLIs below own deploys/secrets/infra, and moshcode only conducts
// their native command lines.
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isInstalled, openPassthrough } from "./engines.mjs";

// gh, supabase, and doctl publish only GitHub release binaries — no official
// cross-platform install script between them — so their install spec runs our
// own downloader instead of a vendor one. See src/release-install.mjs.
const RELEASE_INSTALLER = path.join(path.dirname(fileURLToPath(import.meta.url)), "release-install.mjs");
const releaseInstall = (tool) => ({ cmd: process.execPath, args: [RELEASE_INSTALLER, tool] });

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
    install: { cmd: "sh", args: ["-c", "curl -fsSL https://tailscale.com/install.sh | sh"] },
    // Native updater on Linux (v1.36+) and Windows. macOS updates come from the
    // App Store, so there it fails with tailscale's own message rather than
    // silently re-adding package repos.
    upgrade: { cmd: "tailscale", args: ["update"] },
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
    .map(([key, tool]) => `  ${key.padEnd(10)} ${tool.desc}`)
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
