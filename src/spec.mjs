// OpenSpec integration — spec-driven development, saved in your repo.
// moshcode stays a conductor, not a fork: `spec` is a passthrough to the
// `openspec` CLI (github.com/Fission-AI/OpenSpec). `openspec init` writes an
// openspec/ folder (specs/ + changes/) that you commit — the plan layer your
// coding agents read *before* they write code. Same deal as engines: we don't
// vendor it, we drive it.
import { spawn } from "node:child_process";
import { isInstalled } from "./engines.mjs";

export const OPENSPEC = {
  pkg: "@fission-ai/openspec",
  bin: "openspec",
  desc: "OpenSpec — spec-driven development for coding agents (Fission-AI)",
  install: { cmd: "npm", args: ["install", "-g", "@fission-ai/openspec@latest"] },
  home: "https://github.com/Fission-AI/OpenSpec",
};

/**
 * How to invoke openspec: prefer a globally-installed `openspec` on PATH, else
 * fall back to `npx -y @fission-ai/openspec@latest` so `moshcode spec` runs with
 * zero setup. Returns { cmd, args, viaNpx }.
 */
export function resolveSpec(args = []) {
  if (isInstalled(OPENSPEC.bin)) return { cmd: OPENSPEC.bin, args, viaNpx: false };
  return { cmd: "npx", args: ["-y", `${OPENSPEC.pkg}@latest`, ...args], viaNpx: true };
}

/**
 * Run openspec with stdio inherited so it fully owns the terminal (its own
 * prompts/output — full passthrough). Resolves { ok, code, viaNpx }.
 */
export function runSpec(args = []) {
  const { cmd, args: full, viaNpx } = resolveSpec(args);
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, full, { stdio: "inherit" }); }
    catch (e) { resolve({ ok: false, error: e, viaNpx }); return; }
    child.on("error", (e) => resolve({ ok: false, error: e, viaNpx }));
    child.on("exit", (code, signal) => resolve({ ok: true, code, signal, viaNpx }));
  });
}
