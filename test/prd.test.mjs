import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPrd, listPrds, renderPrd } from "../src/prd.mjs";

test("renderPrd quotes titles so YAML metacharacters stay valid", () => {
  const body = renderPrd({
    id: "0001",
    title: 'Ship CLI: handle "quoted" flags',
    idea: 'Ship CLI: handle "quoted" flags',
    author: "dev@example.com",
  });

  assert.match(body, /^title: "Ship CLI: handle \\"quoted\\" flags"$/m);
});


test("regenerateIndex keeps the README intact when a title holds a String.replace pattern", () => {
  // `$&`, `$\``, `$'`, `$$` are special in a String.replace *replacement string*.
  // A PRD title carrying one must not splice the old index block back into itself.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-prd-"));
  try {
    createPrd("Add $& live support", root);
    createPrd("Improve docs", root);

    const readme = fs.readFileSync(path.join(root, "prd", "README.md"), "utf8");
    const starts = (readme.match(/PRD-INDEX:START/g) || []).length;
    const ends = (readme.match(/PRD-INDEX:END/g) || []).length;

    assert.equal(starts, 1, "index start marker must appear exactly once");
    assert.equal(ends, 1, "index end marker must appear exactly once");
    // The literal title text survives; it is not expanded into the match.
    assert.match(readme, /\$& live support/);
    assert.match(readme, /Improve docs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listPrds reads the title back without its YAML quotes or escapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-prd-"));
  try {
    createPrd("add a dark mode toggle", root);
    createPrd('ship CLI: handle "quoted" flags', root);

    const [plain, quoted] = listPrds(root);
    assert.equal(plain.title, "Add a dark mode toggle");
    assert.equal(quoted.title, 'Ship CLI: handle "quoted" flags');
    assert.equal(plain.status, "Draft");

    // The README index shows the title itself, not the YAML syntax around it.
    const readme = fs.readFileSync(path.join(root, "prd", "README.md"), "utf8");
    assert.match(readme, /\| Add a dark mode toggle \|/);
    assert.doesNotMatch(readme, /\| "Add a dark mode toggle" \|/);
    assert.doesNotMatch(readme, /\\"quoted\\"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("regenerateIndex escapes a pipe in a title so the row keeps its columns", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-prd-"));
  try {
    createPrd("support a|b routing", root);

    const readme = fs.readFileSync(path.join(root, "prd", "README.md"), "utf8");
    const row = readme.split(/\r?\n/).find((l) => l.includes("routing"));
    assert.ok(row, "the PRD row must be in the index");
    // Splitting on unescaped pipes must still yield exactly three cells.
    const cells = row.split(/(?<!\\)\|/).slice(1, -1);
    assert.equal(cells.length, 3, `row should have 3 cells, got ${cells.length}: ${row}`);
    assert.equal(cells[1].trim(), "Support a\\|b routing");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
