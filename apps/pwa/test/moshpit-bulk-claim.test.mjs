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

test("settings applied to a whole list", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run } = await import("../src/db.mjs");
  await run(`INSERT OR IGNORE INTO users (id,email,created_at) VALUES (?,?,?)`, [ALICE, "alice@example.com", Date.now()]);
  const m = await import("../src/moshpit.mjs");
  const uniq = () => `s${randomBytes(4).toString("hex")}`;

  await t.test("a price is set on every ending that lands", async () => {
    const a = uniq(), b = uniq();
    const result = await m.registerTlds({ input: `${a}\n${b}`, userId: ALICE, priceUsd: "12.50" });

    assert.equal(result.settingsFailed.length, 0);
    for (const tld of [a, b]) assert.equal((await m.getTld(tld)).price_usd, 12.5);
  });

  await t.test("no price leaves them unlisted rather than free", async () => {
    const a = uniq();
    await m.registerTlds({ input: a, userId: ALICE });
    // NULL means not for sale; 0 would mean anyone can drain the namespace.
    assert.equal((await m.getTld(a)).price_usd, null);
  });

  await t.test("a bad price is reported, and the ending is still claimed", async () => {
    const a = uniq();
    const result = await m.registerTlds({ input: a, userId: ALICE, priceUsd: "-5" });

    assert.deepEqual(result.claimed, [a], "losing the claim over a typo'd price would be worse");
    assert.equal(result.settingsFailed.length, 1);
    assert.match(result.settingsFailed[0].error, /positive number/);
  });

  await t.test("a whole list can be pointed at one ending", async () => {
    const target = uniq();
    await m.registerTld({ tld: target, userId: ALICE });
    const a = uniq(), b = uniq();

    const result = await m.registerTlds({ input: `${a}\n${b}`, userId: ALICE, aliasOf: `.${target}` });
    assert.equal(result.settingsFailed.length, 0);
    for (const tld of [a, b]) assert.equal((await m.getTld(tld)).alias_of, target);
  });

  await t.test("an ending that is its own alias target is skipped, not rejected", async () => {
    const a = uniq(), b = uniq();
    // Pasting a list that happens to contain the target is ordinary.
    const result = await m.registerTlds({ input: `${a}\n${b}`, userId: ALICE, aliasOf: a });

    assert.deepEqual(result.claimed.sort(), [a, b].sort());
    assert.equal(result.settingsFailed.length, 0);
    assert.equal((await m.getTld(a)).alias_of, null, "not pointed at itself");
    assert.equal((await m.getTld(b)).alias_of, a);
  });

  await t.test("price and target together", async () => {
    const target = uniq();
    await m.registerTld({ tld: target, userId: ALICE });
    const a = uniq();

    await m.registerTlds({ input: a, userId: ALICE, priceUsd: "3", aliasOf: target });
    const row = await m.getTld(a);
    assert.equal(row.price_usd, 3);
    assert.equal(row.alias_of, target);
  });

  await t.test("one ending still reads as one ending", async () => {
    const a = uniq();
    const line = m.summarizeBulkClaim(await m.registerTlds({ input: `.${a}`, userId: ALICE }));
    assert.equal(line, `.${a} is yours.`);
  });
});

test("the default price", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const { DEFAULT_TLD_PRICE_USD } = await import("../src/lib/moshpit-name.mjs");
  const m = await import("../src/moshpit.mjs");
  const uniq = () => `d${randomBytes(4).toString("hex")}`;

  await t.test("is the cap PRD 0005 R3 sets, not a round number below it", async () => {
    const { MAX_CHILD_PRICE_USD } = await import("../src/lib/moshpit-name.mjs");
    assert.equal(MAX_CHILD_PRICE_USD, 1.99);
    assert.equal(DEFAULT_TLD_PRICE_USD, MAX_CHILD_PRICE_USD);
  });

  await t.test("an explicit price still wins over it", async () => {
    const a = uniq();
    await m.registerTlds({ input: a, userId: ALICE, priceUsd: "0.99" });
    assert.equal((await m.getTld(a)).price_usd, 0.99);
  });

  await t.test("free is allowed — the cap is a ceiling, not a floor", async () => {
    const a = uniq();
    await m.registerTlds({ input: a, userId: ALICE, priceUsd: "0.01" });
    assert.equal((await m.getTld(a)).price_usd, 0.01);
  });

  await t.test("clearing the field still means not for sale", async () => {
    // The default is the form's opinion, not a floor the library enforces —
    // otherwise there would be no way to hold an ending off the market.
    const a = uniq();
    await m.registerTlds({ input: a, userId: ALICE, priceUsd: "" });
    assert.equal((await m.getTld(a)).price_usd, null);
  });
});
