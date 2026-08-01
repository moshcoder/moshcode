// `/mcp list` and `/skill list` print a support matrix. Both must account for
// EVERY engine in ENGINES: a missing row is worse than a "not supported" row,
// because the user cannot tell whether the engine is unsupported or whether
// they typed the name wrong.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ENGINES } from "../src/engines.mjs";
import { MCP_ENGINES } from "../src/mcp.mjs";
import { SKILL_ENGINES } from "../src/skills.mjs";
import {
  mcpTargetStatus, printMcpTargets, printSkillTargets, skillTargetStatus,
} from "../src/integrations.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

/** Run a printer and return its output with the ANSI colours stripped. */
function capture(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

/** The engine rows only: the header line names no engine. */
function rowKeys(out) {
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim().replace(/^[●○]\s*/, "").split(/\s+/)[0])
    .filter(Boolean);
}

test("integration status models separate installation from capability support", () => {
  const installedSet = new Set(["claude", "aider"]);
  for (const [status, supportedKeys] of [
    [mcpTargetStatus, MCP_ENGINES],
    [skillTargetStatus, SKILL_ENGINES],
  ]) {
    const rows = status({ installedSet });
    assert.deepEqual([...rows.map(({ name }) => name)].sort(), Object.keys(ENGINES).sort());
    assert.equal(new Set(rows.map(({ name }) => name)).size, rows.length);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row), ["name", "binary", "installed", "supported"]);
      assert.equal(row.binary, ENGINES[row.name].bin);
      assert.equal(row.installed, installedSet.has(row.name));
      assert.equal(row.supported, supportedKeys.includes(row.name));
    }
  }
});

for (const [command, supportedKeys] of [
  ["mcp", MCP_ENGINES],
  ["skill", SKILL_ENGINES],
  ["skills", SKILL_ENGINES],
]) {
  test(`moshcode ${command} list --json prints machine-readable capability status`, () => {
    const result = spawnSync(process.execPath, [BIN, command, "list", "--json"], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const rows = JSON.parse(result.stdout);
    assert.deepEqual([...rows.map(({ name }) => name)].sort(), Object.keys(ENGINES).sort());
    for (const row of rows) {
      assert.deepEqual(Object.keys(row), ["name", "binary", "installed", "supported"]);
      assert.equal(typeof row.installed, "boolean");
      assert.equal(row.supported, supportedKeys.includes(row.name));
    }
  });
}

test("/skill list lists every engine exactly once", () => {
  const keys = rowKeys(capture(printSkillTargets));
  assert.deepEqual([...keys].sort(), Object.keys(ENGINES).sort());
  assert.equal(new Set(keys).size, keys.length);
});

test("/skill list marks privacycode as having no skills primitive", () => {
  // privacycode is an opencode derivative, so it has no skills primitive — but
  // it must still appear. It was absent from the matrix entirely.
  const out = capture(printSkillTargets);
  assert.match(out, /privacycode\s+no skills primitive/);
});

test("/skill list splits the rows by SKILL_ENGINES", () => {
  const out = capture(printSkillTargets);
  for (const key of Object.keys(ENGINES)) {
    const supported = SKILL_ENGINES.includes(key);
    assert.match(
      out,
      new RegExp(`${key}\\s+${supported ? "skills supported" : "no skills primitive"}`),
      `${key} row should say ${supported ? "supported" : "no skills primitive"}`,
    );
  }
});

test("/mcp list lists every engine exactly once", () => {
  const keys = rowKeys(capture(printMcpTargets));
  assert.deepEqual([...keys].sort(), Object.keys(ENGINES).sort());
  assert.equal(new Set(keys).size, keys.length);
});

test("/mcp list splits the rows by MCP_ENGINES", () => {
  const out = capture(printMcpTargets);
  for (const key of Object.keys(ENGINES)) {
    const supported = MCP_ENGINES.includes(key);
    assert.match(
      out,
      new RegExp(`${key}\\s+${supported ? "mcp add supported" : "no MCP support"}`),
      `${key} row should say ${supported ? "supported" : "no MCP support"}`,
    );
  }
});
