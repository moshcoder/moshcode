// `moshcode oneshot <engine> "<prompt>"` — one prompt, the answer on stdout.
//
// Not `moshcode ask`: moshscript already has an ask() verb (ask the human), and
// `moshcode help ask` answers for it; a CLI command of the same name would
// shadow that help.
//
// Works for every engine with a one-shot form: a CLI engine runs its headless
// argv here in this directory (the same one ai() uses, minus any autonomous
// flag), an API engine is one chat-completions call. The prompt may also come
// on stdin (`-`, or no prompt and a pipe), so `git diff | moshcode oneshot zai -`
// is a review.
import fs from "node:fs";

import { resolveAnyEngine } from "./engines.mjs";
import { oneShotEngines, runOneShot } from "./oneshot.mjs";

export const ONESHOT_USAGE = `usage: moshcode oneshot <engine> "<prompt>" [--timeout <s>] [--json]
       moshcode oneshot <engine> -            read the prompt from stdin
       moshcode oneshot --list [--json]       which engines can answer here`;

export async function oneshotCommand(argv, {
  out = (s) => process.stdout.write(s),
  err = (s) => process.stderr.write(s),
  readStdin = () => fs.readFileSync(0, "utf8"),
  stdinIsTTY = process.stdin.isTTY,
  env = process.env,
  fetch,
} = {}) {
  const json = argv.includes("--json");
  let timeoutS = 180;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") continue;
    if (a === "--list") { positional.unshift("--list"); continue; }
    if (a === "--timeout") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) { err(`✗ --timeout needs a positive number of seconds\n${ONESHOT_USAGE}\n`); return 1; }
      timeoutS = n;
      continue;
    }
    positional.push(a);
  }

  if (positional[0] === "--list") {
    const engines = oneShotEngines(env);
    if (json) out(`${JSON.stringify({ engines }, null, 2)}\n`);
    else for (const e of engines) out(`${e.available ? "●" : "○"} ${e.name.padEnd(11)} ${e.kind}${e.reason ? `  — ${e.reason}` : ""}\n`);
    return 0;
  }

  const [name, ...words] = positional;
  if (!name) { err(`${ONESHOT_USAGE}\n`); return 1; }
  if (!resolveAnyEngine(name)) { err(`✗ unknown engine "${name}" — moshcode oneshot --list\n`); return 1; }
  let prompt = words.join(" ");
  if (prompt === "-" || (!prompt && !stdinIsTTY)) prompt = readStdin();
  if (!prompt.trim()) { err(`✗ no prompt\n${ONESHOT_USAGE}\n`); return 1; }

  // A person at a terminal gets the whole answer; the 64 KB cap is for webhooks.
  const r = await runOneShot(name, prompt, { env, timeoutMs: timeoutS * 1000, maxBytes: 16 * 1024 * 1024, ...(fetch ? { fetch } : {}) });
  if (json) {
    out(`${JSON.stringify(r, null, 2)}\n`);
    return r.ok ? 0 : 1;
  }
  if (!r.ok) {
    err(`✗ ${r.engine}: ${r.error}\n`);
    if (r.output) out(`${r.output}\n`);
    return 1;
  }
  out(`${r.output}\n`);
  if (r.truncated) err(`⚠ output truncated\n`);
  return 0;
}
