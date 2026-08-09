// Routing Moshpit TLDs to the local bridge, on whatever OS this is.
//
// Every supported system has a way to send *one suffix* to a different
// nameserver without becoming the resolver for everything else, and this uses
// that mechanism on each rather than the blunt one. Replacing the machine's
// nameserver would mean every lookup on the box depends on this bridge being
// alive; routing only `.moshpit` and friends means the worst failure is that
// Moshpit names stop working, which is exactly the blast radius it should have.
//
//   macOS    /etc/resolver/<tld>       one file per TLD, read per query
//   Linux    systemd-resolved drop-in  DNS= + Domains=~tld routing-only domains
//   Linux    dnsmasq                   server=/tld/host#port
//   Windows  NRPT rule per namespace   Add-DnsClientNrptRule -Namespace .tld
//
// The functions here return a *plan* — a list of steps as data — instead of
// running anything. Everything that edits system DNS wants to be inspectable
// before it runs (`--dry-run` prints the plan verbatim), and a plan is testable
// on any OS without touching that OS's resolver.

/**
 * Windows NRPT rules name a server but have nowhere to put a port, so on
 * Windows the bridge has to be on 53 or the rule cannot point at it. macOS and
 * systemd-resolved both accept a port, which is why the default elsewhere is an
 * unprivileged one.
 */
export const WINDOWS_REQUIRED_PORT = 53;

export function detectPlatform(platform = process.platform) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return null;
}

/** A step is either a file to write, a file to remove, or a command to run. */
const write = (path, content, why) => ({ kind: "write", path, content, why });
const remove = (path, why) => ({ kind: "remove", path, why });
const run = (command, args, why) => ({ kind: "run", command, args, why });

/**
 * What it would take to route `tlds` at `host:port` on this platform.
 *
 * `linuxBackend` picks between the two Linux mechanisms. systemd-resolved is
 * the default because it is what Ubuntu ships; dnsmasq is for the machines that
 * do not run it.
 */
export function enablePlan({
  platform,
  tlds,
  host = "127.0.0.1",
  port = 5354,
  linuxBackend = "systemd-resolved",
  // Catch-all routing is opt-in and conditional, never assumed. Sending every
  // lookup on the machine to the bridge is only safe if the bridge can forward
  // the ones that are not ours — so the caller passes the upstreams it found,
  // and an empty list keeps the per-ending routing that cannot break anything
  // beyond Moshpit names. Getting this backwards takes the whole box offline.
  upstreams = [],
}) {
  const catchAll = Array.isArray(upstreams) && upstreams.length > 0;
  const clean = [...new Set((tlds || []).map((t) => String(t).replace(/^\.+/, "").toLowerCase()).filter(Boolean))];
  if (!clean.length) throw new Error("no TLDs to route");

  if (platform === "macos") {
    // One file per TLD. macOS reads /etc/resolver/<name> per query, so there is
    // nothing to restart and nothing else on the machine is affected.
    return {
      platform,
      elevated: true,
      port,
      steps: clean.map((tld) =>
        write(
          `/etc/resolver/${tld}`,
          `# Written by \`moshcode dns enable\`.\nnameserver ${host}\nport ${port}\n`,
          `send .${tld} to the local bridge`,
        ),
      ),
      notes: ["macOS reads /etc/resolver per query — nothing to restart."],
    };
  }

  if (platform === "linux" && linuxBackend === "dnsmasq") {
    return {
      platform,
      elevated: true,
      port,
      steps: [
        write(
          "/etc/dnsmasq.d/moshpit.conf",
          catchAll
            ? [
              "# Written by `moshcode dns enable`.",
              "# no-resolv so dnsmasq does not also inherit upstreams that point back here.",
              "no-resolv",
              `server=${host}#${port}`,
              "",
            ].join("\n")
            : ["# Written by `moshcode dns enable`.", ...clean.map((t) => `server=/${t}/${host}#${port}`), ""].join("\n"),
          catchAll ? "send every lookup to the bridge, which forwards what is not ours" : "route the Moshpit TLDs",
        ),
        run("systemctl", ["restart", "dnsmasq"], "dnsmasq reads its config at start"),
      ],
      notes: [],
    };
  }

  if (platform === "linux") {
    // `~tld` is a routing-only domain: it sends that suffix here without making
    // this the default resolver for anything else.
    return {
      platform,
      elevated: true,
      port,
      steps: [
        write(
          "/etc/systemd/resolved.conf.d/moshpit.conf",
          catchAll
            ? [
              "# Written by `moshcode dns enable`. Sends every lookup to the local",
              "# bridge, which answers claimed Moshpit endings and forwards the rest",
              "# upstream untouched.",
              "#",
              "# Naming each ending instead does not survive the registry growing:",
              "# systemd-resolved caps how many search domains it accepts and drops",
              "# the remainder with no error a caller can see.",
              "[Resolve]",
              `DNS=${host}:${port}`,
              "Domains=~.",
              "",
            ].join("\n")
            : [
              "# Written by `moshcode dns enable`. Routes Moshpit TLDs to the local",
              "# bridge; every other name keeps using your normal resolver.",
              "[Resolve]",
              `DNS=${host}:${port}`,
              `Domains=${clean.map((t) => `~${t}`).join(" ")}`,
              "",
            ].join("\n"),
          catchAll
            ? "send every lookup to the bridge, which forwards what is not ours"
            : "route the Moshpit TLDs, and nothing else",
        ),
        run("systemctl", ["restart", "systemd-resolved"], "drop-ins are read at start"),
      ],
      notes: [],
    };
  }

  if (platform === "windows") {
    // An NRPT rule has no port field, so the bridge must be on 53 for Windows
    // to be able to reach it at all. Caught here rather than at runtime, where
    // the symptom would be every Moshpit name silently failing.
    if (port !== WINDOWS_REQUIRED_PORT) {
      throw new Error(
        `Windows NRPT rules cannot carry a port, so the bridge must listen on ${WINDOWS_REQUIRED_PORT} ` +
          `(asked for ${port}). Re-run with --port ${WINDOWS_REQUIRED_PORT}, as Administrator.`,
      );
    }
    return {
      platform,
      elevated: true,
      port,
      steps: clean.map((tld) =>
        run(
          "powershell",
          ["-NoProfile", "-Command", `Add-DnsClientNrptRule -Namespace ".${tld}" -NameServers "${host}"`],
          `send .${tld} to the local bridge`,
        ),
      ),
      notes: [`NRPT carries no port, so the bridge runs on ${WINDOWS_REQUIRED_PORT} here.`],
    };
  }

  throw new Error(`unsupported platform: ${platform}`);
}

/**
 * Undo it.
 *
 * Deliberately not derived from the enable plan: a machine may have been
 * enabled with a TLD list that has since changed, and a disable that only
 * removed what it currently knows about would strand the rest. On macOS and
 * Windows the removal is therefore by pattern, not by list.
 */
export function disablePlan({ platform, tlds = [], linuxBackend = "systemd-resolved" }) {
  const clean = [...new Set((tlds || []).map((t) => String(t).replace(/^\.+/, "").toLowerCase()).filter(Boolean))];

  if (platform === "macos") {
    return {
      platform,
      elevated: true,
      steps: clean.map((tld) => remove(`/etc/resolver/${tld}`, `stop routing .${tld}`)),
      notes: clean.length
        ? []
        : ["No TLDs known — nothing removed. Delete /etc/resolver/<tld> by hand if any remain."],
    };
  }

  if (platform === "linux" && linuxBackend === "dnsmasq") {
    return {
      platform,
      elevated: true,
      steps: [
        remove("/etc/dnsmasq.d/moshpit.conf", "stop routing Moshpit TLDs"),
        run("systemctl", ["restart", "dnsmasq"], "pick up the removal"),
      ],
      notes: [],
    };
  }

  if (platform === "linux") {
    return {
      platform,
      elevated: true,
      steps: [
        remove("/etc/systemd/resolved.conf.d/moshpit.conf", "stop routing Moshpit TLDs"),
        run("systemctl", ["restart", "systemd-resolved"], "pick up the removal"),
      ],
      notes: [],
    };
  }

  if (platform === "windows") {
    // Matched on the comment we stamp rather than on a TLD list, so a rule
    // survives us forgetting which TLDs were routed.
    return {
      platform,
      elevated: true,
      steps: [
        run(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            "Get-DnsClientNrptRule | Where-Object { $_.NameServers -contains '127.0.0.1' } | Remove-DnsClientNrptRule -Force",
          ],
          "remove every NRPT rule pointing at the local bridge",
        ),
      ],
      notes: [],
    };
  }

  throw new Error(`unsupported platform: ${platform}`);
}

/** The plan as something a person can read before agreeing to run it. */
export function describePlan(plan) {
  const lines = [];
  for (const step of plan.steps) {
    if (step.kind === "write") {
      lines.push(`write   ${step.path}    # ${step.why}`);
      for (const l of step.content.trimEnd().split("\n")) lines.push(`          ${l}`);
    } else if (step.kind === "remove") {
      lines.push(`remove  ${step.path}    # ${step.why}`);
    } else {
      lines.push(`run     ${step.command} ${step.args.join(" ")}    # ${step.why}`);
    }
  }
  for (const note of plan.notes || []) lines.push(`note    ${note}`);
  return lines.join("\n");
}

/**
 * The port the bridge must listen on for this platform's routing to reach it.
 *
 * Only Windows constrains it, but asking here rather than special-casing at
 * every call site keeps the one platform quirk in one place.
 */
export function requiredPort(platform, preferred = 5354) {
  return platform === "windows" ? WINDOWS_REQUIRED_PORT : preferred;
}

/* ------------------------------------------------------- running the plan */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

/**
 * Carry out a plan.
 *
 * Every step is attempted and reported; one failure does not abort the rest.
 * A half-applied routing config is a real state a machine can end up in — the
 * user hit Ctrl-C, or one write needed a directory that did not exist — and
 * telling them which steps landed is what makes it recoverable. Stopping at the
 * first error would leave them guessing.
 */
export async function applyPlan(plan, { runner = defaultRunner, dryRun = false } = {}) {
  const results = [];
  for (const step of plan.steps) {
    if (dryRun) {
      results.push({ step, ok: true, skipped: true });
      continue;
    }
    try {
      if (step.kind === "write") {
        await mkdir(dirname(step.path), { recursive: true });
        await writeFile(step.path, step.content);
      } else if (step.kind === "remove") {
        await rm(step.path, { force: true });
      } else {
        await runner(step.command, step.args);
      }
      results.push({ step, ok: true });
    } catch (error) {
      results.push({ step, ok: false, error: error.message });
    }
  }
  return { results, ok: results.every((r) => r.ok) };
}

function defaultRunner(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

/* ------------------------------------------------------------- the daemon */

/**
 * Where the running bridge records itself.
 *
 * Under the user's own directory rather than /var/run: the bridge does not need
 * root to listen on 5354, and requiring it to write a pidfile somewhere
 * privileged would make the whole daemon need privileges it otherwise does not.
 */
export function pidfilePath() {
  const base = process.env.XDG_RUNTIME_DIR || join(homedir(), ".moshcode") || tmpdir();
  return join(base, "moshpit-dns.pid");
}

export async function readPid(path = pidfilePath()) {
  try {
    const pid = Number((await readFile(path, "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Is that pid actually ours and alive? A stale pidfile must not read as running. */
export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function daemonStatus(path = pidfilePath()) {
  const pid = await readPid(path);
  if (!pid) return { running: false, pid: null, stale: false };
  if (isAlive(pid)) return { running: true, pid, stale: false };
  // The file outlived the process — a crash or a reboot. Reported rather than
  // cleaned up silently, because "it says it is on but it is not" is the state
  // that makes Moshpit names fail with routing still in place.
  return { running: false, pid, stale: true };
}

/**
 * Start the bridge detached, so the shell that launched it can exit.
 *
 * Not a systemd unit / launchd job / Windows service yet, which means it does
 * not survive a reboot. `moshcode dns status` says so plainly rather than
 * letting someone discover it when their names stop resolving.
 */
export async function startDaemon({ port, registryBase, path = pidfilePath(), entry, proxy = null }) {
  const existing = await daemonStatus(path);
  if (existing.running) return { started: false, pid: existing.pid, alreadyRunning: true };

  await mkdir(dirname(path), { recursive: true });
  const args = [entry, "dns", "start", "--port", String(port)];
  if (registryBase) args.push("--registry", registryBase);
  // Passed at spawn time because it is what the resolver answers with, not
  // something it can be told later — there is no channel to a detached daemon
  // short of restarting it, which is why `enable` decides this before starting.
  if (proxy) args.push("--proxy", proxy);

  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
  child.unref();
  await writeFile(path, `${child.pid}\n`);
  return { started: true, pid: child.pid, alreadyRunning: false };
}

export async function stopDaemon(path = pidfilePath()) {
  const status = await daemonStatus(path);
  if (!status.pid) return { stopped: false, reason: "not running" };
  if (status.running) {
    try {
      process.kill(status.pid, "SIGTERM");
    } catch (error) {
      return { stopped: false, reason: error.message };
    }
  }
  await rm(path, { force: true });
  return { stopped: status.running, reason: status.stale ? "cleared a stale pidfile" : null };
}

export { existsSync as _existsSync };
