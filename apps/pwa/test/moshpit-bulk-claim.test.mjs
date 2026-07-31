// Claiming a pasted list of endings.
//
// The parser is pure and tested on its own; the claiming half runs against a
// real throwaway libSQL database, because partial success — some endings land,
// some are already held — is the normal outcome and is exactly what a stub
// would paper over.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { MAX_BULK_TLDS, parseTldList } from "../src/lib/moshpit-name.mjs";

const require = createRequire(import.meta.url);
let installed = true;
try { require("@libsql/client"); } catch { installed = false; }

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-bulk-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const ALICE = "user-alice";
const BOB = "user-bob";

test("parsing a pasted list", async (t) => {
  await t.test("one per line, dots optional", () => {
    assert.deepEqual(parseTldList(".eggs\nyeah\n.oranges").tlds, ["eggs", "yeah", "oranges"]);
  });

  await t.test("commas, semicolons and stray whitespace all separate", () => {
    // People paste spreadsheet columns and CSV exports; neither should need
    // reformatting first.
    assert.deepEqual(parseTldList("eggs, yeah ;oranges\t\tmosh").tlds,
      ["eggs", "yeah", "oranges", "mosh"]);
  });

  await t.test("# comments to end of line are dropped", () => {
    assert.deepEqual(parseTldList("eggs # the good one\n# all of these are taken\nyeah").tlds,
      ["eggs", "yeah"]);
  });

  await t.test("case and leading dots are one ending, not three", () => {
    assert.deepEqual(parseTldList(".Eggs\nEGGS\neggs").tlds, ["eggs"]);
  });

  await t.test("blank input yields nothing rather than a phantom entry", () => {
    for (const input of ["", "   \n\n  ", null, undefined, "# only a comment"]) {
      assert.deepEqual(parseTldList(input).tlds, [], `for ${JSON.stringify(input)}`);
    }
  });

  await t.test("past the limit is counted, not silently dropped", () => {
    const many = Array.from({ length: MAX_BULK_TLDS + 25 }, (_, i) => `t${i}`).join("\n");
    const { tlds, skipped } = parseTldList(many);
    assert.equal(tlds.length, MAX_BULK_TLDS);
    assert.equal(skipped, 25, "\"I pasted 225 and got 200\" has to be visible");
  });

  await t.test("the limit is on distinct endings, not on lines", () => {
    const { tlds, skipped } = parseTldList("eggs\neggs\neggs\nyeah", 2);
    assert.deepEqual(tlds, ["eggs", "yeah"]);
    assert.equal(skipped, 0);
  });
});

test("claiming a pasted list", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run } = await import("../src/db.mjs");
  for (const [id, email] of [[ALICE, "alice@example.com"], [BOB, "bob@example.com"]]) {
    await run(`INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?,?,?)`, [id, email, Date.now()]);
  }
  const m = await import("../src/moshpit.mjs");
  const uniq = () => `b${randomBytes(4).toString("hex")}`;

  await t.test("every ending in the list lands", async () => {
    const a = uniq(), b = uniq(), c = uniq();
    const result = await m.registerTlds({ input: `.${a}\n${b}\n.${c}`, userId: ALICE });

    assert.deepEqual(result.claimed.sort(), [a, b, c].sort());
    assert.equal(result.taken.length, 0);
    assert.equal(result.rejected.length, 0);
    for (const tld of [a, b, c]) assert.equal((await m.getTld(tld)).user_id, ALICE);
  });

  await t.test("someone else's ending is reported, and the rest still land", async () => {
    const theirs = uniq(), mine1 = uniq(), mine2 = uniq();
    await m.registerTld({ tld: theirs, userId: BOB });

    const result = await m.registerTlds({ input: `${mine1}\n${theirs}\n${mine2}`, userId: ALICE });

    // Partial success is the normal outcome for any real list.
    assert.deepEqual(result.claimed.sort(), [mine1, mine2].sort());
    assert.deepEqual(result.taken, [theirs]);
    assert.equal((await m.getTld(theirs)).user_id, BOB, "not stolen");
  });

  await t.test("re-pasting your own list reads as already yours, not as a collision", async () => {
    const a = uniq(), b = uniq();
    await m.registerTlds({ input: `${a}\n${b}`, userId: ALICE });

    const again = await m.registerTlds({ input: `${a}\n${b}`, userId: ALICE });
    assert.deepEqual(again.mine.sort(), [a, b].sort());
    assert.equal(again.taken.length, 0);
    assert.equal(again.claimed.length, 0);
  });

  await t.test("reserved and malformed endings are rejected with their reason", async () => {
    const good = uniq();
    const result = await m.registerTlds({ input: `bank\na\n${good}\nfoo.bar`, userId: ALICE });

    assert.deepEqual(result.claimed, [good], "one bad entry must not sink the list");
    const rejected = Object.fromEntries(result.rejected.map((r) => [r.tld, r.error]));
    assert.match(rejected.bank, /reserved/);
    assert.match(rejected.a, /at least 2/);
    assert.ok("foo.bar" in rejected, "a domain is not an ending");
  });

  await t.test("the summary names what happened", async () => {
    const good = uniq();
    const theirs = uniq();
    await m.registerTld({ tld: theirs, userId: BOB });

    const line = m.summarizeBulkClaim(await m.registerTlds({
      input: `${good}\n${theirs}\nbank`, userId: ALICE,
    }));
    assert.match(line, /claimed 1/);
    assert.match(line, /1 taken by someone else/);
    assert.match(line, /rejected/);
    assert.match(line, /reserved/, "the reason, not just the count");
  });

  await t.test("an empty paste says so instead of claiming nothing quietly", async () => {
    const result = await m.registerTlds({ input: "   \n# nothing here\n", userId: ALICE });
    assert.equal(result.attempted, 0);
    assert.match(m.summarizeBulkClaim(result), /nothing to claim/);
  });
});
