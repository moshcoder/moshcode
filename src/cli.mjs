// The CLI-scripting seam: moshscript verbs that are "just" the moshcode CLI.
//
// moshscript is scripting the moshcode command line. A verb like `agents("claude")`
// runs `moshcode agents claude` — the exact same command a human would type — so
// there is one implementation of every capability (the CLI) and moshscript is a
// second caller of it, not a reimplementation.
//
// cliVerb(name) builds a vocabulary command whose run() shells out to
//   moshcode <name> <...args>
//
// It uses spawnSync with inherited stdio, so the call BLOCKS until the CLI
// finishes — which is exactly right for "scripting the CLI":
//   - the simple no-`await` style works: `install("claude"); agents("claude");`
//     runs one after the other, in order;
//   - interactive engine/tool sessions own the real terminal and hand control
//     back to the script when they exit.
// Under --dry-run it narrates the argv instead of spawning.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ENGINES, aiExecArgs, pickAiEngine } from "./engines.mjs";

// Resolve THIS package's own moshcode entrypoint, so scripting stays
// self-referential and doesn't depend on `moshcode` being on PATH.
const MOSHCODE_BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

/** Run `moshcode <cmd> ...args`, blocking until it exits. Returns { ok, code }. */
export function runMoshcode(cmd, args, ctx) {
  const argv = [cmd, ...args.map(String)];
  const printable = `moshcode ${argv.join(" ")}`.trimEnd();

  if (ctx.dryRun) {
    ctx.out(`  ▶ ${cmd}(${args.join(", ")}) → would run: ${printable}`);
    return { ok: true, dryRun: true };
  }

  ctx.out(`  ▶ ${printable}`);
  const res = spawnSync(process.execPath, [MOSHCODE_BIN, ...argv], { stdio: "inherit" });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    // Fail loud for now — whether a non-zero passthrough should throw or return
    // a result is an open question in PRD 0004 (R8).
    throw new Error(`moshscript: ${cmd}() → moshcode exited with ${res.signal || res.status}`);
  }
  return { ok: true, code: res.status };
}

/** A vocabulary command mapping `name(...args)` → `moshcode name ...args`. */
export function cliVerb(name, summary) {
  return { name, summary, run: (ctx, ...args) => runMoshcode(name, args, ctx) };
}

/**
 * ai(prompt, opts?) — run a coding engine HEADLESSLY on `prompt` and RETURN its
 * output as a string (unlike agents()/start(), which hand over the terminal and
 * return nothing). Blocking (spawnSync, stdout captured). opts.engine picks the
 * engine; otherwise the first installed one. Honors dry-run (returns "").
 */
export function runAi(ctx, prompt, opts = {}) {
  if (ctx.dryRun) {
    // narrate without requiring an installed engine
    const engine = pickAiEngine(opts.engine) || opts.engine || "claude";
    const args = aiExecArgs(engine, prompt); // throws only on an unknown engine name
    ctx.out(`  🧠 ai(${JSON.stringify(String(prompt).slice(0, 48))}) → would run: ${engine} ${args.join(" ")}`);
    return "";
  }

  const engine = pickAiEngine(opts.engine);
  if (!engine) {
    throw new Error(`moshscript: ai() needs an installed engine — try install("claude")`);
  }
  const e = ENGINES[engine];
  const args = aiExecArgs(engine, prompt);
  ctx.out(`  🧠 ai() → ${engine}: ${String(prompt).slice(0, 60)}${String(prompt).length > 60 ? "…" : ""}`);

  const env = { ...process.env };
  for (const k of e.stripEnv || []) delete env[k];
  const res = spawnSync(e.bin, args, { encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`moshscript: ai() → ${engine} exited with ${res.signal || res.status}${res.stderr ? `: ${res.stderr.trim().slice(0, 200)}` : ""}`);
  }
  return (res.stdout || "").trim();
}

/** The ai() shortcut as a vocabulary command. */
export const aiVerb = {
  name: "ai",
  summary: "run a coding engine on a prompt and return its output (shortcut)",
  run: (ctx, prompt, opts) => runAi(ctx, prompt, opts),
};
