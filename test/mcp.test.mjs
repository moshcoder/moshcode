import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  deriveName, isRemoteTarget, mcpAddArgs, planMcpAdd, runMcpAdd,
} from "../src/mcp.mjs";
import { parseMcp } from "../src/integrations.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

test("deriveName pulls a sane name from a remote host", () => {
  assert.equal(deriveName("https://mcp.sentry.dev/mcp"), "sentry");
  assert.equal(deriveName("https://api.githubcopilot.com/mcp/"), "githubcopilot");
  assert.equal(deriveName("http://localhost:3000/sse"), "localhost");
  assert.equal(deriveName("not a url"), "server");
});

test("isRemoteTarget distinguishes URLs from commands", () => {
  assert.equal(isRemoteTarget("https://x.dev/mcp"), true);
  assert.equal(isRemoteTarget("npx"), false);
});

test("mcpAddArgs builds each engine's native remote invocation", () => {
  const spec = { name: "sentry", target: "https://mcp.sentry.dev/mcp", env: [], headers: [] };
  assert.deepEqual(mcpAddArgs("claude", spec).argv, ["mcp", "add", "-s", "user", "-t", "http", "sentry", "https://mcp.sentry.dev/mcp"]);
  assert.deepEqual(mcpAddArgs("gemini", spec).argv, ["mcp", "add", "-s", "user", "-t", "http", "sentry", "https://mcp.sentry.dev/mcp"]);
  assert.deepEqual(mcpAddArgs("codex", spec).argv, ["mcp", "add", "sentry", "--url", "https://mcp.sentry.dev/mcp"]);
  assert.deepEqual(mcpAddArgs("opencode", spec).argv, ["mcp", "add", "sentry", "--url", "https://mcp.sentry.dev/mcp"]);
});

test("mcpAddArgs builds each engine's native stdio invocation", () => {
  const spec = { name: "t", target: "npx", args: ["-y", "srv"], env: [["K", "v"]], headers: [] };
  assert.deepEqual(mcpAddArgs("claude", spec).argv, ["mcp", "add", "-s", "user", "-e", "K=v", "t", "--", "npx", "-y", "srv"]);
  assert.deepEqual(mcpAddArgs("gemini", spec).argv, ["mcp", "add", "-s", "user", "-e", "K=v", "t", "npx", "-y", "srv"]);
  assert.deepEqual(mcpAddArgs("codex", spec).argv, ["mcp", "add", "t", "--env", "K=v", "--", "npx", "-y", "srv"]);
  assert.equal(mcpAddArgs("opencode", spec).skip !== undefined, true);
});

test("engines that can't express a server are skipped with a reason", () => {
  const withHeaders = { name: "s", target: "https://x.dev/mcp", env: [], headers: ["Authorization: Bearer z"] };
  assert.ok(mcpAddArgs("codex", withHeaders).skip); // codex: no literal headers
  assert.deepEqual(mcpAddArgs("opencode", withHeaders).argv, ["mcp", "add", "s", "--url", "https://x.dev/mcp", "--header", "Authorization=Bearer z"]);
});

test("planMcpAdd annotates install status per engine", () => {
  const plan = planMcpAdd({ name: "s", target: "https://x.dev/mcp", env: [], headers: [] }, { installedSet: new Set(["claude"]) });
  assert.equal(plan.find((p) => p.key === "claude").installed, true);
  assert.equal(plan.find((p) => p.key === "gemini").installed, false);
});

test("parseMcp: install derives the name from a URL", () => {
  assert.deepEqual(parseMcp(["install", "https://mcp.sentry.dev/mcp"]).spec, {
    name: "sentry", target: "https://mcp.sentry.dev/mcp", args: [], transport: undefined, env: [], headers: [],
  });
});

test("parseMcp: add takes an explicit name; flags and stdio parse", () => {
  const p = parseMcp(["add", "tools", "--", "npx", "-y", "srv"]);
  assert.equal(p.spec.name, "tools");
  assert.equal(p.spec.target, "npx");
  assert.deepEqual(p.spec.args, ["-y", "srv"]);

  const q = parseMcp(["install", "https://x.dev/mcp", "--name", "x", "-H", "A: b", "-e", "K=v"]);
  assert.equal(q.spec.name, "x");
  assert.deepEqual(q.spec.headers, ["A: b"]);
  assert.deepEqual(q.spec.env, [["K", "v"]]);
});

test("parseMcp: a stdio install without a name errors", () => {
  assert.ok(parseMcp(["install", "--", "npx", "srv"]).error);
  assert.ok(parseMcp(["list"]).list);
  assert.ok(parseMcp(["bogus"]).error);
});

test("parseMcp: env and header flags reject empty names", () => {
  assert.match(parseMcp(["install", "https://x.dev/mcp", "--env", "=secret"]).error, /--env requires a non-empty key/);
  assert.match(parseMcp(["install", "https://x.dev/mcp", "--header", ": Bearer token"]).error, /--header requires a non-empty header name/);
  assert.match(parseMcp(["install", "https://x.dev/mcp", "--header", "Authorization"]).error, /--header requires a Name: Value header/);
  assert.deepEqual(parseMcp(["install", "https://x.dev/mcp", "--env", "EMPTY="]).spec.env, [["EMPTY", ""]]);
});

test("runMcpAdd summarizes added / skipped / not-installed", async () => {
  const spec = { name: "s", target: "https://x.dev/mcp", env: [], headers: ["A: b"] };
  const plan = planMcpAdd(spec, { installedSet: new Set(["claude", "opencode"]) }); // gemini/codex not installed; codex also skips
  const calls = [];
  const results = await runMcpAdd(plan, { run: async (bin, argv) => { calls.push([bin, ...argv]); return { ok: true, code: 0 }; } });
  const byKey = Object.fromEntries(results.map((r) => [r.key, r.status]));
  assert.equal(byKey.claude, "added");
  assert.equal(byKey.opencode, "added");
  assert.equal(byKey.gemini, "not-installed");
  assert.equal(byKey.codex, "skipped");
  assert.equal(calls.length, 2); // only the two installed, non-skipped engines ran
});

// ---- end-to-end through the CLI with fake engines on PATH ----

function tempDir(prefix = "moshcode-mcp-") { return mkdtempSync(path.join(tmpdir(), prefix)); }

function run(args, { binDir, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, ...env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` },
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code }));
  });
}

test("moshcode mcp install fans the right argv out to each installed engine", async () => {
  const root = tempDir();
  const binDir = path.join(root, "bin");
  const caps = path.join(root, "caps");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(caps, { recursive: true });
  for (const name of ["claude", "gemini", "codex", "opencode"]) {
    writeFileSync(path.join(binDir, name), `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
fs.writeFileSync(path.join(process.env.CAPS, "${name}.json"), JSON.stringify(process.argv.slice(2)));
`);
    chmodSync(path.join(binDir, name), 0o755);
  }

  const result = await run(["mcp", "install", "https://mcp.sentry.dev/mcp"], { binDir, env: { CAPS: caps } });
  assert.equal(result.code, 0);

  assert.deepEqual(JSON.parse(readFileSync(path.join(caps, "claude.json"), "utf8")), ["mcp", "add", "-s", "user", "-t", "http", "sentry", "https://mcp.sentry.dev/mcp"]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(caps, "gemini.json"), "utf8")), ["mcp", "add", "-s", "user", "-t", "http", "sentry", "https://mcp.sentry.dev/mcp"]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(caps, "codex.json"), "utf8")), ["mcp", "add", "sentry", "--url", "https://mcp.sentry.dev/mcp"]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(caps, "opencode.json"), "utf8")), ["mcp", "add", "sentry", "--url", "https://mcp.sentry.dev/mcp"]);
});
