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

test("renderPrd keeps a `-->` in the idea from closing the seed comment", () => {
  const idea = "add a dark mode toggle <!-- oops --> and then some more idea text";
  const body = renderPrd({ id: "0007", title: "Add a dark mode toggle", idea, author: "you@example.com" });

  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith("<!-- seed:"));
  assert.notEqual(at, -1, "the seed marker must be on its own line");
  const seedLine = lines[at];
  // Exactly one comment terminator: the one this template owns, at the end.
  assert.equal(seedLine.match(/-->/g).length, 1, `seed comment closes early: ${seedLine}`);
  assert.ok(seedLine.endsWith(" and then some more idea text -->"), seedLine);
  assert.ok(seedLine.includes("<!-- oops --&gt;"), `idea terminator not neutralised: ${seedLine}`);
  // The Problem section past the marker is untouched template text.
  assert.match(lines[at + 1], /^_Describe the user\/business problem/);
});

test("createPrd hides the whole idea even when it contains a comment terminator", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-prd-"));
  try {
    const { path: file } = createPrd("ship a parser for --> arrows in specs", root);

    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const at = lines.findIndex((l) => l.startsWith("<!-- seed:"));
    assert.notEqual(at, -1, "createPrd must write a seed marker for a truncated idea");
    assert.equal(lines[at].match(/-->/g).length, 1, `seed comment closes early: ${lines[at]}`);
    assert.match(lines[at + 1], /^_Describe the user\/business problem/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listPrds ignores body lines that look like front matter", () => {
  // A PRD documenting an API often shows a YAML sample in a fenced block. Those
  // lines start at column 0 like real keys do, so a scan that runs past the
  // closing `---` reads them as the PRD's own title and status.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-prd-"));
  try {
    const dir = path.join(root, "prd");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "0001-job-api.md"), [
      "---",
      'title: "Job API v2"',
      "status: Accepted",
      "---",
      "",
      "## Requirements",
      "",
      "- R1 [P0] Return the job record:",
      "",
      "```yaml",
      "title: nightly-import",
      "status: queued",
      "```",
      "",
    ].join("\n"));

    const [prd] = listPrds(root);
    assert.equal(prd.title, "Job API v2");
    assert.equal(prd.status, "Accepted");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listPrds does not take a title or status from a PRD with no front matter", () => {
  // A doc dropped into prd/ without front matter has no declared status. Prose
  // is not front matter, so fall back to the slug and the unknown marker rather
  // than lifting whatever a line happens to start with.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-prd-"));
  try {
    const dir = path.join(root, "prd");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "0002-import-notes.md"), [
      "# Import notes",
      "",
      "Fields the importer needs from each upstream row:",
      "",
      "title: taken from the H1",
      "status: derived, never authored by hand",
      "",
    ].join("\n"));

    const [prd] = listPrds(root);
    assert.equal(prd.title, "import-notes");
    assert.equal(prd.status, "?");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
