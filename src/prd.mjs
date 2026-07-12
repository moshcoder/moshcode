// OpenPRD — DIP-style numbered product requirements docs, published in-repo.
// moshcode is a conductor: `/prd` publishes a numbered proposal into the local
// repo per the OpenPRD standard from LogicSRC, then hands it to a coding engine
// to author. Layout mirrors a BIP/EIP/DIP process:
//   prd/README.md          index (maintained by this tool)
//   prd/0000-template.md   the template
//   prd/NNNN-slug.md       one numbered PRD per file (committed, NOT gitignored)
// Standard: https://github.com/profullstack/logicsrc/blob/master/docs/openprd.md
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export const OPENPRD = {
  version: "0.2",
  dir: "prd",
  standard: "https://github.com/profullstack/logicsrc/blob/master/docs/openprd.md",
};

const INDEX_START = "<!-- PRD-INDEX:START -->";
const INDEX_END = "<!-- PRD-INDEX:END -->";

/** kebab-case slug from an idea/title. */
export function slugify(text) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-").slice(0, 8).join("-");
  return s || "untitled";
}

function titleFrom(idea) {
  const raw = String(idea || "").trim();
  const t = raw.length > 80 ? raw.slice(0, 80).trim() + "…" : raw;
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Untitled PRD";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function gitEmail(root) {
  try {
    return execSync("git config user.email", { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim() || "you@example.com";
  } catch { return "you@example.com"; }
}

export function prdDir(root = process.cwd()) {
  return path.join(root, OPENPRD.dir);
}

/** The canonical OpenPRD template (prd/0000-template.md), mirroring the standard. */
export function templateFile() {
  return `---
openprd: "${OPENPRD.version}"
id: "0000"
title: "Short imperative title — start with a verb if possible"
status: Draft
authors:
  - you@example.com
created: 2026-01-01
updated: 2026-01-01
repo:
discussion:
implementation:
tags:
supersedes:
superseded-by:
---

## Problem

The user/business problem, and why it matters now.

## Goals

What success looks like, as outcomes (not features).

## Non-Goals

Explicitly out of scope, to bound the work.

## Users

Who this is for; personas or segments.

## Requirements

- R1 [P0] First required capability.
- R2 [P1] Next capability.

## UX Notes

Flows, states, and constraints that shape the experience.

## Success Metrics

How the goals will be measured.

## Risks & Open Questions

- Known risk or decision still owed.
`;
}

/** A numbered PRD body (prd/NNNN-slug.md), seeded from an idea. */
export function renderPrd({ id, title, idea, author }) {
  const seed = idea && idea !== title ? `\n<!-- seed: ${idea} -->` : "";
  return `---
openprd: "${OPENPRD.version}"
id: "${id}"
title: ${title}
status: Draft
authors:
  - ${author}
created: ${today()}
updated: ${today()}
repo:
discussion:
implementation:
tags:
supersedes:
superseded-by:
---

## Problem
${seed}
_Describe the user/business problem, and why it matters now._

## Goals
_What success looks like, as outcomes (not features)._

## Non-Goals
_Explicitly out of scope._

## Users
_Who this is for; personas or segments._

## Requirements
- R1 [P0] _First required capability._
- R2 [P1] _Next capability._

## UX Notes
_Flows, states, and constraints that shape the experience._

## Success Metrics
_How the goals will be measured._

## Risks & Open Questions
- _Known risk or decision still owed._
`;
}

/** Static README preamble + the auto-maintained index markers. */
function readmeShell() {
  return `# PRDs

Product requirements documents for this repo, following the
[OpenPRD](${OPENPRD.standard}) standard — a numbered, committed proposal
collection (like a BIP/EIP/DIP process).

Each PRD is one file: \`NNNN-slug.md\`. \`0000-template.md\` is the template.
Lifecycle: **Draft → Review → Accepted → Final** (or Rejected / Withdrawn /
Superseded). Status lives in each file's front-matter.

Start one with \`moshcode prd "<idea>"\` (TUI: \`/prd\`).

## Index

${INDEX_START}
${INDEX_END}
`;
}

/** List numbered PRDs (NNNN-slug.md, excluding the 0000 template). */
export function listPrds(root = process.cwd()) {
  const base = prdDir(root);
  let entries = [];
  try { entries = fs.readdirSync(base); } catch { return []; }
  const out = [];
  for (const name of entries) {
    const m = name.match(/^(\d{4})-(.+)\.md$/);
    if (!m || m[1] === "0000") continue;
    const file = path.join(base, name);
    let title = m[2], status = "?";
    try {
      const head = fs.readFileSync(file, "utf8").split(/\r?\n/).slice(0, 16);
      for (const l of head) {
        const t = l.match(/^title:\s*(.+)$/); if (t) title = t[1].trim();
        const s = l.match(/^status:\s*(.+)$/); if (s) status = s[1].trim();
      }
    } catch { continue; }
    out.push({ id: m[1], slug: m[2], title, status, file: name, path: file });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Next zero-padded 4-digit id (max existing + 1, min 0001). */
export function nextId(root = process.cwd()) {
  const ids = listPrds(root).map((p) => parseInt(p.id, 10)).filter(Number.isFinite);
  const max = ids.length ? Math.max(...ids) : 0;
  return String(max + 1).padStart(4, "0");
}

/** Rewrite the README index table from the current PRDs on disk. */
export function regenerateIndex(root = process.cwd()) {
  const readme = path.join(prdDir(root), "README.md");
  let body;
  try { body = fs.readFileSync(readme, "utf8"); } catch { return false; }
  const prds = listPrds(root);
  const rows = prds.length
    ? ["| # | Title | Status |", "|---|---|---|",
       ...prds.map((p) => `| [${p.id}](${p.file}) | ${p.title} | ${p.status} |`)].join("\n")
    : "_No PRDs yet._";
  const next = body.replace(
    new RegExp(`${INDEX_START}[\\s\\S]*${INDEX_END}`),
    `${INDEX_START}\n${rows}\n${INDEX_END}`,
  );
  if (next === body) return false;
  fs.writeFileSync(readme, next);
  return true;
}

/** Create prd/README.md + prd/0000-template.md if missing. Returns true if it bootstrapped. */
export function ensureBootstrap(root = process.cwd()) {
  const base = prdDir(root);
  fs.mkdirSync(base, { recursive: true });
  let did = false;
  const tpl = path.join(base, "0000-template.md");
  if (!fs.existsSync(tpl)) { fs.writeFileSync(tpl, templateFile()); did = true; }
  const readme = path.join(base, "README.md");
  if (!fs.existsSync(readme)) { fs.writeFileSync(readme, readmeShell()); did = true; }
  return did;
}

/**
 * Publish a numbered PRD into the local repo. Bootstraps prd/ on first use.
 * Returns { id, slug, path, existed, bootstrapped }.
 */
export function createPrd(idea, root = process.cwd()) {
  const bootstrapped = ensureBootstrap(root);
  const slug = slugify(idea);
  const title = titleFrom(idea);
  // Reuse an existing PRD if the same slug already has a number.
  const existing = listPrds(root).find((p) => p.slug === slug);
  const id = existing ? existing.id : nextId(root);
  const file = path.join(prdDir(root), `${id}-${slug}.md`);
  const existed = fs.existsSync(file);
  if (!existed) fs.writeFileSync(file, renderPrd({ id, title, idea, author: gitEmail(root) }));
  regenerateIndex(root);
  return { id, slug, path: file, existed, bootstrapped };
}

/** Prompt handed to a coding engine to author the scaffolded PRD in place. */
export function authoringPrompt({ path: file, idea }) {
  return [
    `Author a product requirements document at ${file} following the OpenPRD standard`,
    `(${OPENPRD.standard}).`,
    idea ? `The idea: ${idea}.` : "",
    `Fill every one of the 8 sections (Problem, Goals, Non-Goals, Users, Requirements,`,
    `UX Notes, Success Metrics, Risks & Open Questions), replacing the placeholder text.`,
    `Keep the YAML front-matter and its keys (leave status: Draft). Number requirements`,
    `R1, R2, … each with a [P0]/[P1]/[P2] priority. Be concrete and specific to this codebase.`,
  ].filter(Boolean).join(" ");
}
