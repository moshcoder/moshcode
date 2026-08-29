// Where /timer and /billing actually run.
//
// Both started life inside moshcode (PRD 0012) and now also exist as their own
// cross-platform CLIs — @profullstack/timer and @profullstack/billing — because
// neither is a moshcode idea: tracking time and sending an invoice are things
// you want under any agentic CLI, and on Windows, where moshcode does not go.
//
// So the rule here is: when asked, moshcode conducts them the way /gh conducts
// gh. The two are NOT kept in sync, and that is the point of preferring the
// external one where it is wanted: a second copy of a billing model is a copy
// that drifts, and the published package is the one that gets the fixes.
//
// ---------------------------------------------------------------------------
// Why this is opt-in rather than "delegate whenever the CLI is on PATH", which
// is what it did when it first landed:
//
// Only half the business layer has somewhere to go. /timer and /billing have
// standalone equivalents; /client, /rate, /payments and /team do not — the
// rails and the permission model are moshcode's, and /client's freeform dotted
// fields have no shape in the package's typed client model, so moving it would
// lose data rather than relocate it.
//
// Delegating that half by default splits one person's records across two
// stores. /client and /rate keep writing ~/.moshcode/business.json while
// /billing reads ~/.profullstack/billing/ledger.json, so:
//
//   /client create "Acme Inc"      → written to moshcode
//   /rate set acme-inc $100/hour   → written to moshcode
//   /billing acme-inc              → "no client acme-inc"
//
// That is not a missing feature, it is somebody's invoice failing to exist. And
// it only happens on a machine that installed the CLIs, so CI — which has not —
// stays green while every developer box that took the install goes red.
//
// Hence: opt in, knowing that `billing import` is how the existing ledger comes
// across. When the whole layer has an outside home, this becomes the default.
import { isInstalled } from "./engines.mjs";
import { TOOLS, openTool } from "./tools.mjs";

/** Commands that have an external CLI, and the TOOLS key that owns it. */
export const DELEGATED = { timer: "timer", billing: "billing", invoice: "billing" };

/** Whether this machine has asked for the standalone CLIs to be used. */
export function externalEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.MOSHCODE_EXTERNAL_BILLING || ""));
}

/** The external CLI for a command, if it is enabled and this machine has it. */
export function externalFor(cmd) {
  if (!externalEnabled()) return null;
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
 * Written to stderr, and only when the CLI is actually installed and simply not
 * switched on, so it never lands in the middle of `--json` output and never
 * advertises a tool that is not there. Someone who has installed the package is
 * the only person for whom the variable is worth mentioning.
 */
export function installHint(cmd) {
  const key = DELEGATED[String(cmd || "").toLowerCase()];
  if (!key || externalEnabled()) return null;
  const tool = TOOLS[key];
  if (!tool || !isInstalled(tool.bin, tool.binDirs)) return null;
  return `tip: @profullstack/${key} is installed — set MOSHCODE_EXTERNAL_BILLING=1 to use it`
    + " (move your records first with: billing import)";
}
