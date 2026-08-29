// Installer for the tools that only ship through a system package manager.
//
// ffmpeg and ImageMagick are the odd ones in TOOLS: they are not a vendor's CLI
// with a `curl … | sh` of its own, and they are not a static binary on a GitHub
// release either. They are distro packages, which is why they are installed the
// way a distro package is installed — and why this is a separate file from
// release-install.mjs rather than another descriptor in it.
//
// Static builds do exist for both. They are third-party redistributions of
// somebody else's codec stack, unsigned, and updated by nobody in particular.
// Downloading one to avoid a sudo prompt would be trading a password for a
// binary we cannot vouch for, on the two tools most likely to be pointed at a
// file from the internet.
//
// Everything that decides *what to run* is a pure function so the per-manager
// argv (which differ in irritating ways) is unit-tested offline; the only
// impure part is the loop at the bottom that runs it.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { findEscalator } from "./escalate.mjs";

/**
 * How each manager installs, non-interactively.
 *
 * Non-interactive is the point: this runs inside `moshcode install` and inside
 * `moshcode upgrade tools`, and a manager that stops to ask "Do you want to
 * continue? [Y/n]" inside an upgrade sweep parks the whole plan.
 *
 * apt refreshes first because its index goes stale on its own: a box that has
 * not run `apt-get update` in a few months gets a 404 on the archive rather
 * than a package, and the error names a URL instead of the actual problem.
 */
export const MANAGERS = {
  brew: {
    // Never escalated. Homebrew refuses to run as root and says so at length.
    root: false,
    steps: (pkg) => [["brew", ["install", pkg]]],
  },
  "apt-get": {
    root: true,
    steps: (pkg) => [
      ["apt-get", ["update", "-qq"]],
      ["apt-get", ["install", "-y", "--no-install-recommends", pkg]],
    ],
  },
  dnf: { root: true, steps: (pkg) => [["dnf", ["install", "-y", pkg]]] },
  zypper: { root: true, steps: (pkg) => [["zypper", ["--non-interactive", "install", pkg]]] },
  pacman: { root: true, steps: (pkg) => [["pacman", ["-S", "--needed", "--noconfirm", pkg]]] },
  apk: { root: true, steps: (pkg) => [["apk", ["add", "--no-cache", pkg]]] },
};

/** The order managers are probed in. brew first, and only because of macOS. */
export const MANAGER_ORDER = ["brew", "apt-get", "dnf", "zypper", "pacman", "apk"];

/**
 * Package names per tool, per manager, in the order they are worth trying.
 *
 * Two entries have more than one name and both are facts about somebody else's
 * archive rather than hedging:
 *
 *   Fedora ships `ffmpeg-free` in the main repositories and the full `ffmpeg`
 *   only from RPM Fusion, so a box without that repo enabled has exactly one of
 *   the two names and `dnf install ffmpeg` fails outright on it.
 *
 *   `imagemagick` is one name for two different programs: on Ubuntu up to
 *   24.04 it depends on the 6.x package and puts `convert` on PATH, and from
 *   25.04 it depends on the 7.x one and puts `magick` there instead. The
 *   package name is stable, which is why this table has one entry and the
 *   tool's `bin` has two.
 */
export const PACKAGES = {
  ffmpeg: {
    brew: ["ffmpeg"],
    "apt-get": ["ffmpeg"],
    dnf: ["ffmpeg", "ffmpeg-free"],
    zypper: ["ffmpeg"],
    pacman: ["ffmpeg"],
    apk: ["ffmpeg"],
  },
  imagemagick: {
    brew: ["imagemagick"],
    "apt-get": ["imagemagick"],
    dnf: ["ImageMagick"],
    zypper: ["ImageMagick"],
    pacman: ["imagemagick"],
    apk: ["imagemagick"],
  },
};

function defaultProbe(tool) {
  return spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0;
}

/** Resolve a name to its package table, or throw. Own properties only. */
export function resolvePackage(tool) {
  const key = String(tool ?? "").trim().toLowerCase();
  if (!Object.hasOwn(PACKAGES, key)) {
    throw new Error(
      `unknown package ${JSON.stringify(tool)} — expected one of ${Object.keys(PACKAGES).join(", ")}`,
    );
  }
  return [key, PACKAGES[key]];
}

/** Which package manager this machine has, or null. */
export function findManager({ probe = defaultProbe, order = MANAGER_ORDER } = {}) {
  for (const name of order) {
    if (probe(name)) return name;
  }
  return null;
}

/**
 * The commands that install one package name with one manager.
 *
 * Escalation is applied here rather than by the caller because whether a step
 * needs it is a property of the manager: brew must not be escalated, the rest
 * must be unless we are already root. A `null` escalator on a manager that
 * needs one yields the bare command, which fails with the manager's own
 * permission message — better advice than anything we would write.
 */
export function installSteps(manager, pkg, { escalator = null, isRoot = false } = {}) {
  const spec = MANAGERS[manager];
  if (!spec) throw new Error(`unknown package manager ${JSON.stringify(manager)}`);
  const escalate = spec.root && !isRoot && escalator;
  return spec.steps(pkg).map(([cmd, args]) =>
    escalate ? { cmd: escalator, args: [cmd, ...args] } : { cmd, args },
  );
}

/**
 * Install a tool through whichever package manager is here.
 *
 * Package names are tried in order and the first that installs wins, because a
 * name that is absent from this box's archive is a normal outcome (see the
 * Fedora note above) rather than a failure to report. Only when every candidate
 * has failed is there something to say.
 */
export function installPackage(tool, { run = spawnSync, probe = defaultProbe, log = console.log } = {}) {
  const [key, table] = resolvePackage(tool);
  const manager = findManager({ probe });
  if (!manager) {
    throw new Error(
      `no supported package manager found (${MANAGER_ORDER.join(", ")}) — install ${key} yourself and re-run`,
    );
  }

  const candidates = table[manager];
  if (!candidates?.length) {
    throw new Error(`${key} has no known package name for ${manager} — install it yourself and re-run`);
  }

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const escalator = MANAGERS[manager].root && !isRoot ? findEscalator({ probe }) : null;

  const failures = [];
  for (const pkg of candidates) {
    log(`↓ ${manager} ${pkg}`);
    let ok = true;
    for (const step of installSteps(manager, pkg, { escalator, isRoot })) {
      const result = run(step.cmd, step.args, { stdio: "inherit" });
      if (result?.error || result?.status !== 0) {
        failures.push(`${pkg}: ${step.cmd} ${step.args.join(" ")} ${result?.error ? `(${result.error.message})` : `exited ${result?.status}`}`);
        ok = false;
        break;
      }
    }
    if (ok) {
      log(`✓ ${key} installed with ${manager}`);
      return { manager, pkg };
    }
  }

  throw new Error(`could not install ${key} with ${manager}:\n  ${failures.join("\n  ")}`);
}

/** True when this file was executed directly rather than imported. */
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1] || "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    installPackage(process.argv[2]);
  } catch (e) {
    console.error(`install failed: ${e.message}`);
    process.exit(1);
  }
}
