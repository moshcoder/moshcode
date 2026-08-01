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

  await t.test("commas and semicolons separate endings", () => {
    // People paste spreadsheet columns and CSV exports; neither should need
    // reformatting first.
    assert.deepEqual(parseTldList("eggs, yeah ;oranges").tlds, ["eggs", "yeah", "oranges"]);
  });

  await t.test("whitespace inside a line is fields, not more endings", () => {
    // The cost of per-line settings: `a b` on one line used to be two endings
    // and is now one ending pointed at another. Commas and newlines are the
    // separators, which is what the placeholder shows.
    assert.deepEqual(parseTldList("oranges\t\tmosh").entries,
      [{ tld: "oranges", label: null, aliasOf: "mosh", priceUsd: null }]);
  });

  await t.test("# comments to end of line are dropped", () => {
    assert.deepEqual(parseTldList("eggs # the good one\n# all of these are taken\nyeah").tlds,
      ["eggs", "yeah"]);
  });

  await t.test("case and leading dots are one ending, not three", () => {
    assert.deepEqual(parseTldList(".Eggs\nEGGS\neggs").tlds, ["eggs"]);
  });

  await t.test("all four shapes of a pasted line are understood", () => {
    // `foo`, `bar.foo`, `.whatever` and `.foo.whatever` — the ending and the
    // name under it, each with and without the decorative leading dot. Anything
    // with a dot used to be refused outright as "not a valid TLD", which
    // described the field rather than the mistake.
    const { tlds, names } = parseTldList("foo\nbar.foo\n.whatever\n.foo.whatever");
    assert.deepEqual(tlds, ["foo", "whatever"]);
    assert.deepEqual(names, [
      { tld: "foo", label: "bar" },
      { tld: "whatever", label: "foo" },
    ]);
  });

  await t.test("an ending and a name under it are two entries, not one", () => {
    // Deduplication keys on the whole thing. `.eggs` and `blue.eggs` share a
    // TLD and nothing else, and collapsing them would drop whichever came second.
    const { tlds, names } = parseTldList(".eggs\nblue.eggs\neggs\nblue.eggs");
    assert.deepEqual(tlds, ["eggs"]);
    assert.deepEqual(names, [{ tld: "eggs", label: "blue" }]);
  });

  await t.test("a name carries per-line settings the same way an ending does", () => {
    assert.deepEqual(parseTldList("blue.eggs $5 mosh").entries,
      [{ tld: "eggs", label: "blue", aliasOf: "mosh", priceUsd: 5 }]);
  });

  await t.test("something that is neither is kept, to be rejected by name", () => {
    // `a.b.c` is not a name and not an ending. Dropping it in the parser would
    // leave it out of the report entirely, so it survives as its own bad text
    // for registerTlds to refuse and say why.
    const { entries, tlds, names } = parseTldList("a.b.c");
    assert.deepEqual(names, []);
    assert.deepEqual(tlds, ["a.b.c"]);
    assert.equal(entries[0].label, null);
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
    const result = await m.registerTlds({ input: `bank\na\n${good}\na.b.c`, userId: ALICE });

    assert.deepEqual(result.claimed, [good], "one bad entry must not sink the list");
    const rejected = Object.fromEntries(result.rejected.map((r) => [r.tld, r.error]));
    assert.match(rejected.bank, /reserved/);
    assert.match(rejected.a, /at least 2/);
    // Two labels is a name and one is an ending; three is neither, and it is
    // refused by name rather than dropped out of the report.
    assert.ok("a.b.c" in rejected, "three labels is neither an ending nor a name");
  });

  await t.test("a pasted name claims the ending it needs, then registers under it", async () => {
    const ending = uniq();
    const result = await m.registerTlds({ input: `blue.${ending}`, userId: ALICE });

    assert.deepEqual(result.claimed, [ending], "the ending a name needs is claimed for you");
    assert.deepEqual(result.names, [`blue.${ending}`]);
    assert.equal(result.rejected.length, 0);
    assert.equal((await m.getName(ending, "blue")).user_id, ALICE);
  });

  await t.test("the ending is claimed once when both halves are pasted", async () => {
    const ending = uniq();
    const result = await m.registerTlds({ input: `.${ending}\nblue.${ending}\ngreen.${ending}`, userId: ALICE });

    assert.deepEqual(result.claimed, [ending]);
    assert.deepEqual(result.names.sort(), [`blue.${ending}`, `green.${ending}`].sort());
  });

  await t.test("a name under someone else's ending says who owns it, not 'no dots'", async () => {
    // The report this replaces said "not a valid TLD — letters, digits and
    // dashes only, no dots", which sent you off to fix a paste that was fine.
    const theirs = uniq();
    await m.registerTld({ tld: theirs, userId: BOB });

    const result = await m.registerTlds({ input: `blue.${theirs}`, userId: ALICE });
    assert.deepEqual(result.names, []);
    assert.equal(result.namesRejected.length, 1);
    assert.match(result.namesRejected[0].error, /do not own/);
    assert.equal((await m.getTld(theirs)).user_id, BOB, "not stolen on the way past");
  });

  await t.test("re-pasting a name you hold reads as already yours", async () => {
    const ending = uniq();
    await m.registerTlds({ input: `blue.${ending}`, userId: ALICE });

    const again = await m.registerTlds({ input: `blue.${ending}`, userId: ALICE });
    assert.deepEqual(again.namesMine, [`blue.${ending}`]);
    assert.equal(again.names.length, 0);
    assert.equal(again.namesTaken.length, 0);
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

  await t.test("both prices are round, and neither ends in .99", async () => {
    const { CHILD_PRICE_USD, ENDING_PRICE_USD, MAX_CHILD_PRICE_USD } =
      await import("../src/lib/moshpit-name.mjs");

    assert.equal(CHILD_PRICE_USD, 2, "foo.bar");
    assert.equal(ENDING_PRICE_USD, 5, ".bar");
    assert.equal(DEFAULT_TLD_PRICE_USD, CHILD_PRICE_USD);
    assert.equal(MAX_CHILD_PRICE_USD, CHILD_PRICE_USD);

    // PRD 0005 §10.1 wrote these as $1.99 and $4.99. Superseded: the trailing
    // cent buys nothing and every number here is one a person has to reason
    // about. A regression to .99 should fail rather than ship quietly.
    for (const price of [CHILD_PRICE_USD, ENDING_PRICE_USD]) {
      assert.equal(price, Math.round(price), `${price} should be whole dollars`);
    }
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

test("a line can carry its own price and target", async (t) => {
  const { parseTldList } = await import("../src/lib/moshpit-name.mjs");

  await t.test("reads tld, target and price off one line", () => {
    assert.deepEqual(parseTldList(".toplevel .redirect $2.00USD").entries,
      [{ tld: "toplevel", label: null, aliasOf: "redirect", priceUsd: 2 }]);
  });

  await t.test("accepts the shapes a person actually types", () => {
    for (const [text, price] of [
      [".a $5", 5], [".b $5USD", 5], [".c 5.00", 5], [".d USD5", 5], [".e $1.50", 1.5],
    ]) {
      assert.equal(parseTldList(text).entries[0].priceUsd, price, text);
    }
  });

  await t.test("order on the line does not matter", () => {
    assert.deepEqual(parseTldList(".a $5 .b").entries, [{ tld: "a", label: null, aliasOf: "b", priceUsd: 5 }]);
    assert.deepEqual(parseTldList(".a .b $5").entries, [{ tld: "a", label: null, aliasOf: "b", priceUsd: 5 }]);
  });

  await t.test("a bare list still means one ending per entry", () => {
    // Commas separate records, so this must not read as tld+target+price.
    assert.deepEqual(parseTldList("eggs, yeah, oranges").tlds, ["eggs", "yeah", "oranges"]);
    assert.deepEqual(parseTldList("eggs\nyeah").entries.map((e) => e.aliasOf), [null, null]);
  });

  await t.test("a line with nothing extra inherits the form's settings", () => {
    const [entry] = parseTldList("plain").entries;
    assert.equal(entry.priceUsd, null, "null means 'use the default', not 'free'");
    assert.equal(entry.aliasOf, null);
  });

  await t.test("junk on a line is read as a target, never as a price", () => {
    // The safe misreading: a stray token becomes an alias, which fails loudly
    // against an ending you do not own, rather than silently setting a price.
    assert.equal(parseTldList(".a hunter2").entries[0].priceUsd, null);
    assert.equal(parseTldList(".a hunter2").entries[0].aliasOf, "hunter2");
    assert.equal(parseTldList(".a $0").entries[0].priceUsd, null, "zero is not a price");
    assert.equal(parseTldList(".a $-5").entries[0].priceUsd, null);
  });

  await t.test("the limit still counts endings, not fields", () => {
    const many = Array.from({ length: 5 }, (_, i) => `t${i} .hub $3`).join("\n");
    const { entries, skipped } = parseTldList(many, 3);
    assert.equal(entries.length, 3);
    assert.equal(skipped, 2);
  });
});

test("per-line settings beat the form", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run } = await import("../src/db.mjs");
  await run(`INSERT OR IGNORE INTO users (id,email,created_at) VALUES (?,?,?)`, [ALICE, "alice@example.com", Date.now()]);
  const m = await import("../src/moshpit.mjs");
  const uniq = () => `o${randomBytes(4).toString("hex")}`;

  await t.test("a line's price overrides the form's, upwards", async () => {
    const cheap = uniq(), dear = uniq();
    await m.registerTlds({ input: `${cheap}\n${dear} $5USD`, userId: ALICE, priceUsd: "2" });

    assert.equal((await m.getTld(cheap)).price_usd, 2, "no line price -> the form's");
    assert.equal((await m.getTld(dear)).price_usd, 5, "a line price wins, even above the default");
  });

  await t.test("a line's target overrides the form's", async () => {
    const hub = uniq(), other = uniq();
    await m.registerTld({ tld: hub, userId: ALICE });
    await m.registerTld({ tld: other, userId: ALICE });
    const a = uniq(), b = uniq();

    await m.registerTlds({ input: `${a}\n${b} .${other}`, userId: ALICE, aliasOf: hub });
    assert.equal((await m.getTld(a)).alias_of, hub);
    assert.equal((await m.getTld(b)).alias_of, other);
  });

  await t.test("a line works with no form defaults at all", async () => {
    const hub = uniq();
    await m.registerTld({ tld: hub, userId: ALICE });
    const a = uniq();

    await m.registerTlds({ input: `${a} .${hub} $3.50`, userId: ALICE });
    const row = await m.getTld(a);
    assert.equal(row.price_usd, 3.5);
    assert.equal(row.alias_of, hub);
  });
});

test("a big paste lands in one go", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run } = await import("../src/db.mjs");
  await run(`INSERT OR IGNORE INTO users (id,email,created_at) VALUES (?,?,?)`, [ALICE, "alice@example.com", Date.now()]);
  await run(`INSERT OR IGNORE INTO users (id,email,created_at) VALUES (?,?,?)`, [BOB, "bob@example.com", Date.now()]);
  const m = await import("../src/moshpit.mjs");
  const { MAX_BULK_TLDS, BULK_CHUNK } = await import("../src/lib/moshpit-name.mjs");
  const uniq = () => `z${randomBytes(5).toString("hex")}`;

  await t.test("the ceiling is 1000 and a chunk bounds request size, not throughput", () => {
    assert.equal(MAX_BULK_TLDS, 1000);
    assert.ok(BULK_CHUNK > 0 && BULK_CHUNK <= MAX_BULK_TLDS);
  });

  await t.test("300 endings all get claimed — none left over", async () => {
    // The paste that used to stop at 54 of 313 when every ending cost six
    // round trips. Nothing is deferred now, so `remaining` stays empty.
    const names = Array.from({ length: 300 }, uniq);
    const started = Date.now();
    const result = await m.registerTlds({ input: names.join("\n"), userId: ALICE });

    assert.equal(result.claimed.length, 300, "every one landed");
    assert.deepEqual(result.remaining, []);
    assert.ok(Date.now() - started < 20_000, "and inside what used to be the whole budget");
  });

  await t.test("more than one chunk still reports every ending exactly once", async () => {
    const names = Array.from({ length: BULK_CHUNK + 7 }, uniq);
    const result = await m.registerTlds({ input: names.join("\n"), userId: ALICE, chunkSize: 10 });

    assert.equal(result.claimed.length, names.length);
    assert.equal(new Set(result.claimed).size, names.length, "no ending counted twice across chunks");
  });

  await t.test("claimed, already-yours and someone-else's are still told apart", async () => {
    const fresh = uniq(), yours = uniq(), theirs = uniq();
    await m.registerTld({ tld: yours, userId: ALICE });
    await m.registerTld({ tld: theirs, userId: BOB });

    const result = await m.registerTlds({ input: [fresh, yours, theirs].join("\n"), userId: ALICE });
    assert.deepEqual(result.claimed, [fresh]);
    assert.deepEqual(result.mine, [yours]);
    assert.deepEqual(result.taken, [theirs]);
    assert.equal((await m.getTld(theirs)).user_id, BOB, "not stolen by the batch");
  });

  await t.test("over the ceiling is still reported, not dropped", async () => {
    const names = Array.from({ length: 4 }, uniq);
    const result = await m.registerTlds({ input: names.join("\n"), userId: ALICE, limit: 2 });

    assert.equal(result.claimed.length, 2);
    assert.equal(result.skipped, 2);
    assert.match(m.summarizeBulkClaim(result), /2 not attempted — paste them again/);
  });

  await t.test("a reserved ending never costs a round trip", async () => {
    const good = uniq();
    const result = await m.registerTlds({ input: `bank\na\n${good}`, userId: ALICE });
    assert.deepEqual(result.claimed, [good]);
    assert.equal(result.rejected.length, 2, "filtered in memory, before any batch");
  });
});

test("a ceiling reads like a rough promise", async () => {
  const { shortCount, MAX_BULK_TLDS } = await import("../src/lib/moshpit-name.mjs");
  assert.equal(shortCount(1000), "1k");
  assert.equal(shortCount(2000), "2k");
  assert.equal(shortCount(MAX_BULK_TLDS), "1k");
  // Anything not a round thousand stays exact — "1.2k" would be a lie about
  // where the ceiling actually is.
  assert.equal(shortCount(200), "200");
  assert.equal(shortCount(1500), "1500");
});
