// Where /timer and /billing actually run.
//
// Both started life inside moshcode (PRD 0012) and now also exist as their own
// cross-platform CLIs — @profullstack/timer and @profullstack/billing — because
// neither is a moshcode idea: tracking time and sending an invoice are things
// you want under any agentic CLI, and on Windows, where moshcode does not go.
//
// So the rule here is: if the real CLI is installed, moshcode conducts it, the
// same way /gh conducts gh. The built-in implementation stays as the fallback
// for a machine that has not installed it yet, so nothing breaks on upgrade and
// nobody has to install anything to keep working.
//
// The two are NOT kept in sync, and that is the point of preferring the
// external one: a second copy of a billing model is a copy that drifts, and the
// published package is the one that gets the fixes.
import { isInstalled } from "./engines.mjs";
import { TOOLS, openTool } from "./tools.mjs";

/** Commands that have an external CLI, and the TOOLS key that owns it. */
export const DELEGATED = { timer: "timer", billing: "billing", invoice: "billing" };

/**
 * Force the in-process implementation.
 *
 * An escape hatch rather than a setting: somebody debugging a difference
 * between the two needs to run the built-in one on a box where the CLI is
 * installed, and that is the whole reason this exists.
 */
export function builtinForced() {
  return /^(1|true|yes)$/i.test(String(process.env.MOSHCODE_BUILTIN_BILLING || ""));
}

/** The external CLI for a command, if this machine has it. */
export function externalFor(cmd) {
  if (builtinForced()) return null;
  const key = DELEGATED[String(cmd || "").toLowerCase()];
  if (!key) return null;
  const tool = TOOLS[key];
  if (!tool || !isInstalled(tool.bin, tool.binDirs)) return null;
  return { key, tool };
}

/**
 * Hand a command to its CLI, or report that there is nothing to hand it to.
 *
 * Returns `{ delegated: false }` when the CLI is absent so the caller can fall
 * through to the built-in rather than failing — a missing optional tool is not
 * an error, it is just the older path.
 */
export async function delegate(cmd, argv = [], opts = {}) {
  const found = externalFor(cmd);
  if (!found) return { delegated: false, code: 0 };
  // openPassthrough resolves { ok, code, signal }, not a number. Assigning the
  // object straight to process.exitCode throws ERR_INVALID_ARG_TYPE *after* the
  // child has already printed its output, which reads as the tool crashing when
  // in fact it succeeded.
  const result = await openTool(found.tool, argv, opts);
  return { delegated: true, code: exitCodeOf(result) };
}

/**
 * One number out of a passthrough result.
 *
 * A child killed by a signal reports `code: null`, and passing that on as 0
 * would call an interrupted invoice run a success.
 */
export function exitCodeOf(result) {
  if (typeof result === "number") return result;
  if (!result || typeof result !== "object") return 0;
  if (Number.isInteger(result.code)) return result.code;
  if (result.signal) return 1;
  return result.ok === false ? 1 : 0;
}

/**
 * The one-line nudge shown after the built-in runs.
 *
 * Written to stderr, and only when the CLI is missing, so it never lands in the
 * middle of `--json` output that something is parsing.
 */
export function installHint(cmd) {
  const key = DELEGATED[String(cmd || "").toLowerCase()];
  if (!key || externalFor(cmd) || builtinForced()) return null;
  return `tip: moshcode install ${key} — runs @profullstack/${key}, which also works outside moshcode`;
}
