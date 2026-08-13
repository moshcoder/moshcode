// SQL this app writes, against the parser that actually runs it.
//
// The app is developed against a `file:` database and deployed against Turso.
// Those are not the same parser, and the gap is silent in exactly the wrong
// direction: SQLite accepts things Turso rejects, so a statement can pass every
// test here and throw on every request in production.
//
// That is not hypothetical. `/save` answered 502 for its entire life because
// insertRevision() used a bare HAVING on an implicit single-group aggregate:
//
//   INSERT INTO settings_snapshots (…) SELECT …
//   FROM settings_snapshots WHERE user_id = ?
//   HAVING COALESCE(MAX(revision),0) = ?
//
// SQLite treats the whole result as one group and runs it. Turso answers
// `SQL string could not be parsed: near HAVING, "None": syntax error`. The
// test suite covered that path, passed, and proved nothing about the deployment.
//
// So this checks the source text rather than the behaviour. It cannot catch
// every divergence, only the one that has already cost something — which is the
// bar for a guard like this.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every .mjs under src/, recursively. */
function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

/**
 * Blank out comments, keeping offsets so reported line numbers stay true.
 *
 * Necessary because "having" is an ordinary English word and this codebase
 * writes long comments. Matching it inside prose flagged four files that
 * contain no SQL at all.
 */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

test("no HAVING without a GROUP BY — Turso refuses to parse it", () => {
  const offenders = [];

  for (const file of sources(SRC)) {
    const text = withoutComments(fs.readFileSync(file, "utf8"));

    // Case-sensitive on purpose: SQL keywords are written uppercase here, so
    // this matches the keyword and not the English word.
    for (const match of text.matchAll(/\bHAVING\b/g)) {
      const before = text.slice(0, match.index);
      // SQL lives in template literals, so the opening backtick is the left
      // edge of the statement this HAVING belongs to.
      const start = before.lastIndexOf("`");
      const statement = text.slice(start === -1 ? 0 : start, match.index);
      if (!/\bGROUP\s+BY\b/i.test(statement)) {
        offenders.push(`${path.relative(SRC, file)}:${before.split("\n").length}`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    `HAVING with no GROUP BY parses on SQLite and fails on Turso:\n  ${offenders.join("\n  ")}`);
});
