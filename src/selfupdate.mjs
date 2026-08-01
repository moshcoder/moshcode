// Keeping moshcode current without reinstalling it every time.
//
// `moshcode update` re-fetches Node, bun and the release tarball on every run,
// which is fine as a thing you type and wrong as a thing a timer runs every
// fifteen minutes: it is minutes of network and disk to discover that nothing
// changed. So the version is checked first and the install only happens when
// the answer is yes.
//
// Automatic updates carry a real cost that is worth stating where the code
// lives rather than only in a changelog: they propagate a bad release with no
// one in the loop. A release that breaks DNS reaches every machine on the
// timer within the interval. That is the trade for not having to think about
// upgrading, and it is why the timer logs what it did and why `--check` exists
// as a way to look before leaping.

import { moshcodeVersion } from "./ui.mjs";

export const DEFAULT_INTERVAL = "15min";
const RELEASE_API = "https://api.github.com/repos/moshcoder/moshcode/releases/latest";

/** Strip the `v` and anything after the patch, so `v1.2.3` and `1.2.3` compare. */
export function normalizeVersion(input) {
  const match = String(input ?? "").trim().match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

/**
 * Is `candidate` newer than `installed`?
 *
 * Ordered comparison rather than string inequality, so a rolled-back release
 * does not read as an upgrade — 0.16.4 against a published 0.16.3 means the
 * machine is ahead, not behind, and reinstalling would be a downgrade nobody
 * asked for.
 */
export function isNewer(candidate, installed) {
  const a = normalizeVersion(candidate);
  const b = normalizeVersion(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/** The published version, or null when the question cannot be answered. */
export async function latestRelease({ fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(RELEASE_API, {
      signal: controller.signal,
      headers: { accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json?.tag_name === "string" ? json.tag_name : null;
  } catch {
    // Unreachable registry, rate limit, offline. All the same answer: we do not
    // know, so we do nothing. A timer that reinstalls on every failed check
    // would hammer a machine that is merely offline.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What an update run should do, without doing any of it. */
export async function updatePlan({ installed = moshcodeVersion(), fetchImpl = fetch } = {}) {
  const latest = await latestRelease({ fetchImpl });
  if (!latest) return { act: false, installed, latest: null, why: "could not reach the release feed" };
  if (!isNewer(latest, installed)) {
    return { act: false, installed, latest, why: `already on ${installed}` };
  }
  return { act: true, installed, latest, why: `${installed} → ${latest}` };
}

/**
 * A systemd timer that checks on an interval.
 *
 * `Persistent=true` so a laptop that was asleep at the scheduled moment checks
 * once when it wakes, rather than skipping until the next one. The service is
 * oneshot and the timer owns the schedule, which is what makes the interval
 * editable without touching the command.
 */
export function timerUnits({ interval = DEFAULT_INTERVAL, bin = "moshcode" } = {}) {
  return {
    "moshcode-update.service": [
      "[Unit]",
      "Description=Check for a newer moshcode and install it if there is one",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=oneshot",
      `ExecStart=/usr/bin/env ${bin} update --if-newer`,
      "",
    ].join("\n"),
    "moshcode-update.timer": [
      "[Unit]",
      "Description=Check for a newer moshcode on a schedule",
      "",
      "[Timer]",
      `OnBootSec=${interval}`,
      `OnUnitActiveSec=${interval}`,
      // A machine asleep at the scheduled moment checks once on waking rather
      // than waiting for the next interval.
      "Persistent=true",
      "",
      "[Install]",
      "WantedBy=timers.target",
      "",
    ].join("\n"),
  };
}

const USAGE = `moshcode update --if-newer — install only when a newer release exists

  moshcode update --check              say what would happen; change nothing
  moshcode update --if-newer           install only if the published version is newer
  moshcode update --timer              print the systemd units for a scheduled check
  moshcode update --timer --install    write and enable them (needs root)
  moshcode update --timer --interval 1h

Automatic updates hand a bad release to every machine on the timer within the
interval, with nobody in the loop. That is the trade.`;

/** The `--check` / `--if-newer` / `--timer` half of `moshcode update`. */
export async function selfUpdateCommand(args = [], out = console.log, deps = {}) {
  const { plan = updatePlan, upgrade = null, write = null, runner = null } = deps;

  if (args.includes("--help")) {
    out(USAGE);
    return 0;
  }

  if (args.includes("--timer")) {
    const at = args.indexOf("--interval");
    const units = timerUnits({ interval: at >= 0 ? args[at + 1] : DEFAULT_INTERVAL });
    if (!args.includes("--install")) {
      for (const [name, body] of Object.entries(units)) {
        out(`--- /etc/systemd/system/${name} ---`);
        out(body);
      }
      out("nothing written. re-run with --install (as root).");
      return 0;
    }
    if (!write || !runner) {
      out("moshcode update: cannot write units here");
      return 1;
    }
    for (const [name, body] of Object.entries(units)) {
      await write(`/etc/systemd/system/${name}`, body);
      out(`  wrote /etc/systemd/system/${name}`);
    }
    await runner("systemctl", ["daemon-reload"]);
    await runner("systemctl", ["enable", "--now", "moshcode-update.timer"]);
    out("checking on a schedule now. `systemctl list-timers moshcode-update` to see when.");
    return 0;
  }

  const decision = await plan();
  out(decision.act
    ? `update available: ${decision.why}`
    : `no update: ${decision.why}`);

  // --check reports and stops. Without it, acting is the point.
  if (args.includes("--check") || !decision.act) return 0;
  if (!upgrade) return 0;
  return (await upgrade()) ?? 0;
}
