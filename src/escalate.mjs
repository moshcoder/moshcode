// Escalating one command, instead of asking the operator to escalate the CLI.
//
// `dns enable` genuinely needs root: it writes /etc/resolver/<tld>, an
// /etc/systemd/resolved.conf.d drop-in, or /etc/dnsmasq.d, and binds :53. The
// old advice was to re-run the whole CLI — `sudo moshcode dns enable`. That
// works, but it teaches a habit that has a sharp edge elsewhere in this same
// CLI: `moshcode update` self-updates by re-running the installer, and every
// path the installer uses comes from $HOME. Under sudo that is /root, so
// `sudo moshcode update` reinstalls moshcode into root's home and leaves the
// operator with a `moshcode` on PATH they cannot execute.
//
// So: never ask for a privileged CLI. Ask for a privileged *step*, and let
// sudo do what it is for — prompt for a password, raise one command.
//
// Every input is injectable because the interesting cases (no tty, no sudo,
// user cancels at the prompt) are ones you cannot reach from a test suite
// otherwise.

import { spawnSync } from "node:child_process";

/** Set on the re-executed child so a misconfigured escalator cannot loop. */
export const ESCALATION_MARKER = "MOSHCODE_ESCALATED";

const CANDIDATES = ["sudo", "doas"];

function defaultProbe(tool) {
  return spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0;
}

/**
 * Which escalation helper this machine has, honouring an explicit override.
 * Returns null when there is none — a container running as a non-root user
 * with no sudo is a normal place to end up, and it should get advice rather
 * than a crash.
 */
export function findEscalator({ env = process.env, probe = defaultProbe } = {}) {
  const override = env.MOSHCODE_ESCALATOR;
  if (override) return probe(override) ? override : null;
  for (const tool of CANDIDATES) {
    if (probe(tool)) return tool;
  }
  return null;
}

/**
 * Re-run this CLI's own argv under the escalation helper.
 *
 * Returns `{ ran: false, reason }` when escalation is not possible, so the
 * caller can fall back to printing the manual command. It never throws: a
 * failure to escalate has to degrade into advice, not a stack trace.
 *
 * `{ ran: true, code }` means the privileged child ran to completion — code 1
 * covers the operator cancelling at the password prompt, which is a refusal,
 * not an error to retry.
 */
export function escalateSelf({
  args,
  what = args.join(" "),
  env = process.env,
  argv = process.argv,
  isTTY = Boolean(process.stdin?.isTTY && process.stdout?.isTTY),
  spawn = spawnSync,
  probe = defaultProbe,
  out = console.log,
} = {}) {
  if (env[ESCALATION_MARKER]) return { ran: false, reason: "already-escalated" };
  // Without a terminal there is nowhere to type a password. sudo would either
  // fail or, worse, sit waiting in a CI log until the job times out.
  if (!isTTY) return { ran: false, reason: "no-tty" };

  const tool = findEscalator({ env, probe });
  if (!tool) return { ran: false, reason: "no-escalator" };

  const [runtime, script] = argv;
  if (!runtime || !script) return { ran: false, reason: "no-argv" };

  out(`· ${what} needs root — re-running it with ${tool}. You may be prompted for your password.`);
  const result = spawn(tool, [runtime, script, ...args], {
    stdio: "inherit",
    env: { ...env, [ESCALATION_MARKER]: "1" },
  });

  if (result?.error) return { ran: false, reason: "spawn-failed" };
  return { ran: true, code: typeof result?.status === "number" ? result.status : 1 };
}
