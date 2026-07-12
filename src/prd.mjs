// OpenPRD — lightweight product requirements docs, one file per decision.
// moshcode stays a conductor: `/prd` scaffolds a private prd/<slug>/prd.md that
// conforms to the OpenPRD standard published in LogicSRC, then hands the file to
// a coding engine to author. The standard lives at:
//   https://github.com/profullstack/logicsrc/blob/master/docs/openprd.md
// PRDs are PRIVATE by convention — we gitignore prd/ so they never get published.
import fs from "node:fs";
import path from "node:path";

export const OPENPRD = {
  version: "0.1",
  dir: "prd",
  standard: "https://github.com/profullstack/logicsrc/blob/master/docs/openprd.md",
};

/** kebab-case slug from an idea/title. Falls back to a generic name. */
export function slugify(text) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-").slice(0, 8).join("-");
  return s || "untitled-prd";
}

/** Title-case-ish heading from a slug or idea. */
function titleFrom(idea, slug) {
  const raw = String(idea || slug).trim();
  const t = raw.length > 80 ? raw.slice(0, 80).trim() + "…" : raw;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Render an OpenPRD-conformant prd.md (front-matter + the 8 required sections). */
export function renderPrd({ slug, title, idea }) {
  const seed = idea && idea !== title ? idea : "";
  return `---
openprd: "${OPENPRD.version}"
id: ${slug}
title: ${title}
status: draft
created: ${today()}
---

## Problem
${seed ? `<!-- seed: ${seed} -->\n` : ""}_Describe the user/business problem, and why it matters now._

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

/** Absolute path to prd/<slug>/prd.md under the given root (default cwd). */
export function prdPath(slug, root = process.cwd()) {
  return path.join(root, OPENPRD.dir, slug, "prd.md");
}

/** Ensure `prd/` is gitignored so PRDs stay private. Best-effort, idempotent. */
export function ensureGitignored(root = process.cwd()) {
  const gi = path.join(root, ".gitignore");
  const line = `${OPENPRD.dir}/`;
  let body = "";
  try { body = fs.readFileSync(gi, "utf8"); } catch { /* no .gitignore yet */ }
  if (body.split(/\r?\n/).some((l) => l.trim() === line || l.trim() === OPENPRD.dir)) return false;
  const sep = body && !body.endsWith("\n") ? "\n" : "";
  try {
    fs.writeFileSync(gi, `${body}${sep}# OpenPRD documents are private\n${line}\n`);
    return true;
  } catch { return false; }
}

/**
 * Create a private PRD scaffold from an idea. Returns
 * { slug, path, existed, gitignored }. Never overwrites an existing PRD.
 */
export function createPrd(idea, root = process.cwd()) {
  const slug = slugify(idea);
  const title = titleFrom(idea, slug);
  const file = prdPath(slug, root);
  const existed = fs.existsSync(file);
  if (!existed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderPrd({ slug, title, idea }));
  }
  const gitignored = ensureGitignored(root);
  return { slug, path: file, existed, gitignored };
}

/** List existing PRDs under prd/ with their title + status from front-matter. */
export function listPrds(root = process.cwd()) {
  const base = path.join(root, OPENPRD.dir);
  let entries = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(base, e.name, "prd.md");
    let title = e.name, status = "?";
    try {
      const head = fs.readFileSync(file, "utf8").split(/\r?\n/).slice(0, 12);
      for (const l of head) {
        const t = l.match(/^title:\s*(.+)$/); if (t) title = t[1].trim();
        const s = l.match(/^status:\s*(.+)$/); if (s) status = s[1].trim();
      }
    } catch { continue; }
    out.push({ slug: e.name, title, status, path: file });
  }
  return out;
}

/** Prompt handed to a coding engine to author the scaffolded PRD in place. */
export function authoringPrompt({ path: file, idea }) {
  return [
    `Author a product requirements document at ${file} following the OpenPRD standard`,
    `(${OPENPRD.standard}).`,
    idea ? `The idea: ${idea}.` : "",
    `Keep it a single file. Fill every one of the 8 sections (Problem, Goals, Non-Goals,`,
    `Users, Requirements, UX Notes, Success Metrics, Risks & Open Questions), replacing the`,
    `placeholder text. Keep the YAML front-matter and its keys. Number requirements R1, R2, …`,
    `each with a [P0]/[P1]/[P2] priority. Be concrete and specific to this codebase.`,
  ].filter(Boolean).join(" ");
}
