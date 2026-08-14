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
 * How to ask a helper to cache a credential without running anything real.
 *
 * `sudo -v` exists for exactly this: validate, refresh the timestamp, run no
 * command. doas has no equivalent flag, so it gets the smallest possible real
 * command instead — the point is only to make it prompt.
 */
function primeArgs(tool) {
  return tool === "sudo" ? ["-v"] : ["true"];
}

/** `-n` is "never prompt" in both, so a zero exit means a credential is ready. */
function alreadyCached(tool, spawn) {
  return spawn(tool, ["-n", "true"], { stdio: "ignore" })?.status === 0;
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
 * Does installing or upgrading this entry need root *on this machine*?
 *
 * A spec says `needsRoot: true` when it always does, or `{ except: [...] }` when
 * a platform is the exception. tailscale is the reason for the second form: its
 * script goes through the distro package manager on Linux and delegates to the
 * App Store on macOS, where nothing escalates. Without the distinction, every
 * mac running `moshcode update` would be asked for a password by a step that
 * never wanted one — which is the same bug as prompting halfway through, just
 * earlier and more annoying.
 */
export function needsRootHere(entry, platform = process.platform) {
  const spec = entry?.needsRoot;
  if (!spec) return false;
  if (spec === true) return true;
  if (Array.isArray(spec)) return spec.includes(platform);
  if (Array.isArray(spec.except)) return !spec.except.includes(platform);
  return false;
}

/**
 * Ask for the password now, for a step that will need root later.
 *
 * Some installers escalate on their own partway through their own work —
 * tailscale's goes through the distro package manager, so it calls sudo after
 * refreshing package lists. That is fine when it is the only thing running and
 * miserable inside `moshcode update`, which walks a plan: moshcode itself, then
 * every installed engine, then every tool. The operator sees a long stream of
 * downloads scroll past, looks away, and comes back to a run that has been
 * parked on a password prompt — or worse, to sudo's own timeout having failed
 * the step. The work is not interactive, so nobody is watching the one moment
 * that is.
 *
 * So we prompt before starting instead. sudo caches the credential against the
 * terminal, and every installer we hand off to inherits that same terminal, so
 * the escalation they do later finds it already there and never asks.
 *
 * Returns `{ primed, tool, reason }` and never throws. `primed: false` is not
 * fatal anywhere it is called: the caller carries on and the installer prompts
 * whenever it was going to, which is exactly the old behaviour. Being unable to
 * ask early is a missed convenience, not a reason to refuse to install.
 */
export function primeEscalation({
  what = "this",
  env = process.env,
  isTTY = Boolean(process.stdin?.isTTY && process.stdout?.isTTY),
  spawn = spawnSync,
  probe = defaultProbe,
  out = console.log,
  getuid = typeof process.getuid === "function" ? process.getuid : null,
} = {}) {
  // Already root — nothing to ask for, and nothing to ask with.
  if (getuid && getuid() === 0) return { primed: true, tool: null, reason: "already-root" };
  // No terminal means no prompt. Warming a credential here would either fail or
  // hang a CI job on a password nobody can type, which is the thing this exists
  // to prevent rather than to cause.
  if (!isTTY) return { primed: false, tool: null, reason: "no-tty" };

  const tool = findEscalator({ env, probe });
  if (!tool) return { primed: false, tool: null, reason: "no-escalator" };

  // Silence is the right outcome when a credential is already cached, or when
  // this operator's rule is NOPASSWD. Printing "asking for your password" and
  // then not asking reads as a bug.
  if (alreadyCached(tool, spawn)) return { primed: true, tool, reason: "cached" };

  out(`· ${what} needs root partway through — asking ${tool} for your password now, so it doesn't stop halfway.`);
  const result = spawn(tool, primeArgs(tool), { stdio: "inherit" });
  if (result?.error) return { primed: false, tool, reason: "spawn-failed" };
  // A non-zero exit is a wrong password, a cancelled prompt, or an operator who
  // is not in sudoers. All three mean "carry on unprimed" rather than "stop":
  // the installer may well not need root on this machine at all.
  if (result?.status !== 0) return { primed: false, tool, reason: "declined" };
  return { primed: true, tool, reason: "prompted" };
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
