// Register MCP (Model Context Protocol) servers across every engine that
// supports them, from one canonical definition. MoshCode drives each engine's
// own `mcp add` so the engine owns its config format. See prd/0003.
import { ENGINES, isInstalled, runCmd } from "./engines.mjs";

// Coding engines that can register MCP servers. Aider has no MCP support.
export const MCP_ENGINES = ["claude", "gemini", "codex", "opencode"];

/** Is this target a remote server URL (vs a local stdio command)? */
export function isRemoteTarget(target) {
  return /^https?:\/\//i.test(String(target));
}

/** Derive a sane server name from a remote URL's host (e.g. mcp.sentry.dev → sentry). */
export function deriveName(target) {
  const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  try {
    const labels = new URL(target).hostname.split(".").filter(Boolean);
    const withoutTld = labels.slice(0, -1); // drop the TLD
    const meaningful = withoutTld.filter((l) => !["mcp", "www", "api", "app"].includes(l));
    const pick = meaningful[meaningful.length - 1] || withoutTld[withoutTld.length - 1] || labels[0];
    return sanitize(pick) || "server";
  } catch {
    return "server";
  }
}

/** Convert a `"Key: Value"` header into OpenCode's `Key=Value` form. */
function headerToEq(header) {
  const i = String(header).indexOf(":");
  return i === -1 ? String(header) : `${header.slice(0, i).trim()}=${header.slice(i + 1).trim()}`;
}

/**
 * Build one engine's native `mcp add` argv for a canonical server spec, or a
 * skip reason when the engine can't express it.
 *
 * spec: { name, target, args?, transport?, env?: [[k,v]], headers?: ["Key: Value"] }
 * `target` is a URL (remote) or a stdio command; `args` are stdio command args.
 * Returns { argv } or { skip }.
 */
export function mcpAddArgs(key, spec) {
  const { name, target, args = [], env = [], headers = [] } = spec;
  const remote = isRemoteTarget(target);
  const transport = spec.transport || (remote ? "http" : "stdio");

  switch (key) {
    case "claude": {
      const argv = ["mcp", "add", "-s", "user"];
      if (remote) argv.push("-t", transport);
      for (const [k, v] of env) argv.push("-e", `${k}=${v}`);
      for (const h of headers) argv.push("-H", h);
      argv.push(name);
      if (remote) argv.push(target);
      else argv.push("--", target, ...args);
      return { argv };
    }
    case "gemini": {
      const argv = ["mcp", "add", "-s", "user"];
      if (remote) argv.push("-t", transport);
      for (const [k, v] of env) argv.push("-e", `${k}=${v}`);
      for (const h of headers) argv.push("-H", h);
      argv.push(name);
      if (remote) argv.push(target);
      else argv.push(target, ...args);
      return { argv };
    }
    case "codex": {
      if (headers.length) {
        return { skip: "Codex supports only a bearer-token env var, not literal headers" };
      }
      const argv = ["mcp", "add", name];
      for (const [k, v] of env) argv.push("--env", `${k}=${v}`);
      if (remote) argv.push("--url", target);
      else argv.push("--", target, ...args);
      return { argv };
    }
    case "opencode": {
      if (!remote) {
        return { skip: "OpenCode CLI adds only remote (--url) servers non-interactively" };
      }
      const argv = ["mcp", "add", name, "--url", target];
      for (const [k, v] of env) argv.push("--env", `${k}=${v}`);
      for (const h of headers) argv.push("--header", headerToEq(h));
      return { argv };
    }
    default:
      return { skip: "no MCP support" };
  }
}

/**
 * Plan the fan-out: one entry per MCP engine with its native argv or skip
 * reason, annotated with install status. Pure + testable.
 */
export function planMcpAdd(spec, { installedSet } = {}) {
  return MCP_ENGINES.map((key) => {
    const bin = ENGINES[key].bin;
    const installed = installedSet ? installedSet.has(key) : isInstalled(bin);
    return { key, bin, installed, ...mcpAddArgs(key, spec) };
  });
}

/**
 * Execute a plan: run each installed, non-skipped engine's `mcp add`. Returns
 * results [{ key, status: "added"|"skipped"|"failed"|"not-installed", reason? }].
 * `run` is injectable for tests; defaults to the real spawner.
 */
export async function runMcpAdd(plan, { run = runCmd } = {}) {
  const results = [];
  for (const item of plan) {
    if (item.skip) { results.push({ key: item.key, status: "skipped", reason: item.skip }); continue; }
    if (!item.installed) { results.push({ key: item.key, status: "not-installed" }); continue; }
    const r = await run(item.bin, item.argv);
    results.push({ key: item.key, status: r.ok && (r.code === 0 || r.code == null) ? "added" : "failed", code: r.code });
  }
  return results;
}
