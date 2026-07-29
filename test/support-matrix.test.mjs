// `/mcp list` and `/skill list` print a support matrix. Both must account for
// EVERY engine in ENGINES: a missing row is worse than a "not supported" row,
// because the user cannot tell whether the engine is unsupported or whether
// they typed the name wrong.
import assert from "node:assert/strict";
import test from "node:test";

import { ENGINES } from "../src/engines.mjs";
import { MCP_ENGINES } from "../src/mcp.mjs";
import { SKILL_ENGINES } from "../src/skills.mjs";
import { printMcpTargets, printSkillTargets } from "../src/integrations.mjs";

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
