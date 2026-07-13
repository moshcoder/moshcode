import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { planUpgrade } from "../src/upgrade.mjs";

function withFakeTools(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "moshcode-upgrade-"));
  for (const name of ["ugig", "coinpay"]) {
    const file = path.join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before || ""}`;
  try { return fn(); }
  finally { process.env.PATH = before; }
}

test("upgrade tools selects installed workflow tools without self or engines", () => {
  withFakeTools(() => {
    const plan = planUpgrade(["tools"]);
    assert.equal(plan.self, false);
    assert.deepEqual(plan.unknown, []);
    assert.deepEqual(plan.items.map(({ key, kind }) => ({ key, kind })), [
      { key: "ugig", kind: "tool" },
      { key: "coinpay", kind: "tool" },
    ]);
  });
});

test("explicit tool upgrades use official installers even when not installed", () => {
  const plan = planUpgrade(["ugig", "coinpay"]);

  assert.equal(plan.self, false);
  assert.deepEqual(plan.items.map(({ key, kind, spec }) => ({ key, kind, spec })), [
    {
      key: "ugig",
      kind: "tool",
      spec: { cmd: "npm", args: ["install", "-g", "ugig"] },
    },
    {
      key: "coinpay",
      kind: "tool",
      spec: { cmd: "npm", args: ["install", "-g", "@profullstack/coinpay"] },
    },
  ]);
});

test("default upgrade includes self and every installed tool", () => {
  withFakeTools(() => {
    const plan = planUpgrade([]);
    assert.equal(plan.self, true);
    assert.ok(plan.items.some(({ key, kind }) => key === "ugig" && kind === "tool"));
    assert.ok(plan.items.some(({ key, kind }) => key === "coinpay" && kind === "tool"));
  });
});

test("unknown upgrade targets remain visible to the caller", () => {
  const plan = planUpgrade(["not-a-tool"]);
  assert.deepEqual(plan.unknown, ["not-a-tool"]);
  assert.equal(plan.items.length, 0);
});
