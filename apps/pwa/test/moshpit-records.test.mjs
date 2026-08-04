// The records a name publishes, against a real (throwaway) libSQL database.
//
// Two halves. The first is validation, which is pure and is where a record
// stored wrong comes from — an IPv4 literal accepted here is a name that
// resolves to a leased address six months after it stopped being the owner's.
//
// The second is the part no mock would catch: who may publish under a name that
// changed hands, what a released name leaves behind, and whether "points at"
// still says the same thing as the records after both have been edited.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let installed = true;
try { require("@libsql/client"); } catch { installed = false; }

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-records-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const ALICE = "user-alice";
const BOB = "user-bob";

const V6 = "2606:4700:4700::1111";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run } = await import("../src/db.mjs");
  for (const [id, email] of [[ALICE, "alice@example.com"], [BOB, "bob@example.com"]]) {
    await run(`INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?,?,?)`, [id, email, Date.now()]);
  }
  return { moshpit: await import("../src/moshpit.mjs"), run };
}

/* ---------- validation: pure, and the half that decides what gets stored ---------- */

test("moshpit records: what a record may say", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const { normalizeRecord, normalizeTtl, effectiveTarget, recordConflict, zoneLine } =
    await import("../src/lib/moshpit-records.mjs");

  await t.test("an IPv4 literal is refused, with the alternative in the error", () => {
    const result = normalizeRecord({ type: "AAAA", value: "203.0.113.9" });
    assert.equal(result.ok, false);
    // The rule is the same one "points at" enforces, and an error that only said
    // "invalid" would read as a typo rather than as a policy.
    assert.match(result.error, /IPv4/);
    assert.match(result.error, /AAAA|CNAME/);
  });

  await t.test("an address nobody outside your LAN can reach is refused", () => {
    for (const value of ["::1", "fe80::1", "fd00::1", "ff02::1"]) {
      assert.equal(normalizeRecord({ type: "AAAA", value }).ok, false, `${value} was accepted`);
    }
  });

  await t.test("a AAAA record carries an address and not a port", () => {
    assert.equal(normalizeRecord({ type: "AAAA", value: `[${V6}]:8080` }).ok, false);
    // Brackets on their own are how the address is pasted out of a URL.
    assert.equal(normalizeRecord({ type: "AAAA", value: `[${V6}]` }).record.value, V6);
  });

  await t.test("a hostname is normalised the way a zone file writes one", () => {
    const result = normalizeRecord({ type: "CNAME", value: "  Box.Example.COM.  " });
    assert.equal(result.ok, true);
    assert.equal(result.record.value, "box.example.com");
  });

  await t.test("a CNAME cannot point at the name it is on", () => {
    const result = normalizeRecord({ type: "CNAME", value: "blue.eggs", name: "blue.eggs" });
    assert.equal(result.ok, false);
  });

  await t.test("an address in a CNAME is named as the wrong field, not as invalid", () => {
    const result = normalizeRecord({ type: "CNAME", value: V6 });
    assert.equal(result.ok, false);
    assert.match(result.error, /AAAA/);
  });

  await t.test("MX carries a priority, and 10 is what an unset one means", () => {
    assert.equal(normalizeRecord({ type: "MX", value: "mx.example.com" }).record.priority, 10);
    assert.equal(normalizeRecord({ type: "MX", value: "mx.example.com", priority: "0" }).record.priority, 0);
    assert.equal(normalizeRecord({ type: "MX", value: "mx.example.com", priority: "-1" }).ok, false);
    assert.equal(normalizeRecord({ type: "MX", value: "mx.example.com", priority: "70000" }).ok, false);
  });

  await t.test("TXT loses the quotes a zone file puts on and refuses a newline", () => {
    assert.equal(normalizeRecord({ type: "TXT", value: '"v=spf1 -all"' }).record.value, "v=spf1 -all");
    // A newline is how one record silently becomes two.
    assert.equal(normalizeRecord({ type: "TXT", value: "one\ntwo" }).ok, false);
    assert.equal(normalizeRecord({ type: "TXT", value: "x".repeat(1025) }).ok, false);
  });

  await t.test("a TTL is clamped rather than rejected", () => {
    assert.equal(normalizeTtl(""), 300);
    assert.equal(normalizeTtl("banana"), 300);
    assert.equal(normalizeTtl("5"), 60);
    assert.equal(normalizeTtl("99999999"), 86_400);
    assert.equal(normalizeTtl("3600"), 3600);
  });

  await t.test("a CNAME will not share a name with anything else", () => {
    const cname = { type: "CNAME", value: "box.example.com" };
    const aaaa = { type: "AAAA", value: V6 };
    assert.ok(recordConflict(cname, [aaaa]), "CNAME beside an address was allowed");
    assert.ok(recordConflict(aaaa, [cname]), "an address beside a CNAME was allowed");
    assert.equal(recordConflict(aaaa, [{ type: "AAAA", value: "2606:4700:4700::1112" }]), null,
      "two addresses on one name is how a name gets a second one");
    // Re-adding what is already there is not a conflict with itself.
    assert.equal(recordConflict(cname, [cname]), null);
  });

  await t.test("the legacy target is the explicit one, else the first address", () => {
    assert.equal(effectiveTarget("typed.example.com", [{ type: "AAAA", value: V6 }]), "typed.example.com");
    assert.equal(effectiveTarget(null, [{ type: "AAAA", value: V6 }]), V6);
    assert.equal(effectiveTarget(null, [{ type: "TXT", value: "hi" }]), null);
  });

  await t.test("a record reads back as a line of a zone file", () => {
    assert.equal(zoneLine("blue.eggs", { type: "MX", value: "mx.example.com", ttl: 300, priority: 10 }),
      "blue.eggs.\t300\tIN\tMX\t10 mx.example.com");
    assert.equal(zoneLine("blue.eggs", { type: "TXT", value: "v=spf1 -all", ttl: 60, priority: null }),
      'blue.eggs.\t60\tIN\tTXT\t"v=spf1 -all"');
  });
});

/* ---------- the database half ---------- */

test("moshpit records: publishing them", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const { moshpit, run } = await boot();

  const claim = async (tld, userId) => {
    const result = await moshpit.registerTld({ tld, userId, ownerEmail: `${userId}@example.com` });
    assert.equal(result.ok, true, result.error);
  };

  await claim("eggs", ALICE);
  await moshpit.registerName({ tld: "eggs", label: "blue", userId: ALICE });

  await t.test("a record lands on the name and comes back", async () => {
    const added = await moshpit.addRecord({ tld: "eggs", label: "blue", userId: ALICE, type: "AAAA", value: V6 });
    assert.equal(added.ok, true, added.error);
    const records = await moshpit.listRecords("eggs", "blue");
    assert.deepEqual(records.map((r) => [r.type, r.value, r.ttl]), [["AAAA", V6, 300]]);
  });

  await t.test("the first address a name publishes is what it resolves to", async () => {
    // The bridge, the DoH server and the gateway all read `target` and nothing
    // else. A name with a AAAA record that still resolved to the parking page
    // would be the feature not working at all.
    const resolution = await moshpit.resolveMoshpitName("blue.eggs");
    assert.equal(resolution.target, V6);
  });

  await t.test("publishing the same record again edits it instead of duplicating it", async () => {
    const again = await moshpit.addRecord({ tld: "eggs", label: "blue", userId: ALICE, type: "AAAA", value: V6, ttl: "60" });
    assert.equal(again.ok, true, again.error);
    const records = await moshpit.listRecords("eggs", "blue");
    assert.equal(records.length, 1, "the same record was stored twice");
    assert.equal(records[0].ttl, 60);
  });

  await t.test("a second address is allowed; a CNAME beside it is not", async () => {
    const second = await moshpit.addRecord({ tld: "eggs", label: "blue", userId: ALICE, type: "AAAA", value: "2606:4700:4700::1112" });
    assert.equal(second.ok, true, second.error);

    const cname = await moshpit.addRecord({ tld: "eggs", label: "blue", userId: ALICE, type: "CNAME", value: "box.example.com" });
    assert.equal(cname.ok, false);
    assert.match(cname.error, /CNAME/);
  });

  await t.test("somebody else's name is not yours to publish on", async () => {
    const result = await moshpit.addRecord({ tld: "eggs", label: "blue", userId: BOB, type: "TXT", value: "hello" });
    assert.equal(result.ok, false);
    assert.match(result.error, /do not own/);
    assert.equal((await moshpit.listRecords("eggs", "blue")).some((r) => r.type === "TXT"), false);
  });

  await t.test("a name that was never minted has nowhere to put a record", async () => {
    const result = await moshpit.addRecord({ tld: "eggs", label: "green", userId: ALICE, type: "TXT", value: "hello" });
    assert.equal(result.ok, false);
    assert.match(result.error, /not registered/);
  });

  await t.test("withdrawing a record that is not there says so", async () => {
    const result = await moshpit.removeRecord({ tld: "eggs", label: "blue", userId: ALICE, type: "MX", value: "mx.example.com" });
    assert.equal(result.ok, false);
  });

  await t.test("withdrawing the address a name resolved to moves it to the next one", async () => {
    const gone = await moshpit.removeRecord({ tld: "eggs", label: "blue", userId: ALICE, type: "AAAA", value: V6 });
    assert.equal(gone.ok, true, gone.error);
    assert.equal((await moshpit.resolveMoshpitName("blue.eggs")).target, "2606:4700:4700::1112");
  });

  await t.test("a target the owner typed is not overruled by a record", async () => {
    await moshpit.registerName({ tld: "eggs", label: "typed", userId: ALICE, target: "box.example.com" });
    await moshpit.addRecord({ tld: "eggs", label: "typed", userId: ALICE, type: "AAAA", value: V6 });
    assert.equal((await moshpit.resolveMoshpitName("typed.eggs")).target, "box.example.com",
      "an explicit target was silently replaced by a record");
  });

  await t.test("records follow the alias, because that is where the name is served", async () => {
    await claim("agent", ALICE);
    await claim("agentic", ALICE);
    await moshpit.registerName({ tld: "agent", label: "foo", userId: ALICE });
    await moshpit.addRecord({ tld: "agent", label: "foo", userId: ALICE, type: "TXT", value: "on the target" });
    await moshpit.setAlias({ from: "agentic", to: "agent", userId: ALICE });

    const found = await moshpit.recordsForName("foo.agentic");
    assert.equal(found.resolved, "foo.agent");
    assert.deepEqual(found.records.map((r) => r.value), ["on the target"]);
  });

  await t.test("a released name takes its records with it", async () => {
    await moshpit.registerName({ tld: "eggs", label: "temp", userId: ALICE });
    await moshpit.addRecord({ tld: "eggs", label: "temp", userId: ALICE, type: "MX", value: "mx.example.com" });
    await moshpit.releaseName({ tld: "eggs", label: "temp", userId: ALICE });

    // The failure this guards is not tidiness: the next holder of the name
    // would inherit an MX pointing at the last holder's mail server.
    assert.deepEqual(await moshpit.listRecords("eggs", "temp"), []);
  });

  await t.test("the tab's list covers every name you hold, with a record count", async () => {
    // A name with nothing on it, which is the state the tab exists to change.
    await moshpit.registerName({ tld: "eggs", label: "bare", userId: ALICE });
    const names = await moshpit.listRecordNames(ALICE, { limit: 50 });
    const blue = names.find((n) => n.label === "blue" && n.tld === "eggs");
    assert.ok(blue, "a name with records is listed");
    assert.equal(blue.record_count, 1);
    // The empty ones matter more: adding the first record is what the tab is for.
    assert.ok(names.some((n) => n.record_count === 0), "names with no records are listed too");
  });

  await t.test("the filter takes a whole domain, an ending, or a prefix", async () => {
    const { nameQuery } = await import("../src/lib/moshpit-search.mjs");
    const matching = async (q) => {
      const filter = nameQuery(q);
      const names = await moshpit.listRecordNames(ALICE, { like: filter.like, exact: filter.exact, limit: 50 });
      return names.map((n) => `${n.label}.${n.tld}`);
    };

    assert.deepEqual(await matching("blue.eggs"), ["blue.eggs"], "the domain as written");
    assert.ok((await matching("eggs")).every((n) => n.endsWith(".eggs")), "every name under an ending");
    assert.deepEqual(await matching("foo.*"), ["foo.agent"], "a prefix");
    assert.deepEqual(await matching("nothinglikethis"), []);
  });

  await t.test("the count and the list agree about how many names there are", async () => {
    const total = await moshpit.countRecordNames(ALICE);
    const all = await moshpit.listRecordNames(ALICE, { limit: 500 });
    assert.equal(total, all.length);
  });

  await t.test("records for a page of names come back in one lookup", async () => {
    const names = await moshpit.listRecordNames(ALICE, { limit: 50 });
    const map = await moshpit.listRecordsForNames(names);
    assert.deepEqual((map.get("foo.agent") || []).map((r) => r.type), ["TXT"]);
    assert.equal(map.has("temp.eggs"), false, "a released name is not in the map");
  });

  await run(`DELETE FROM moshpit_records`);
});

/* ---------- the wildcard: records for everything under a name ---------- */

test("moshpit records: the wildcard", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const { moshpit, run } = await boot();

  const claimed = await moshpit.registerTld({ tld: "hacker", userId: ALICE, ownerEmail: "alice@example.com" });
  assert.equal(claimed.ok, true, claimed.error);
  await moshpit.registerName({ tld: "hacker", label: "chovy", userId: ALICE });

  await t.test("the parent's owner publishes it, stored as `*.chovy`", async () => {
    const added = await moshpit.addRecord({ tld: "hacker", label: "*.chovy", userId: ALICE, type: "AAAA", value: V6 });
    assert.equal(added.ok, true, added.error);
    const records = await moshpit.listRecords("hacker", "*.chovy");
    assert.deepEqual(records.map((r) => [r.type, r.value]), [["AAAA", V6]]);

    // The wildcard is not the parent: the apex itself publishes nothing, and
    // no target is mirrored onto it — `*.chovy` answers for what is under
    // chovy, never for chovy.
    assert.deepEqual(await moshpit.listRecords("hacker", "chovy"), []);
    assert.equal((await moshpit.getName("hacker", "chovy")).target, null);
  });

  await t.test("only the parent's owner may publish or withdraw it", async () => {
    const added = await moshpit.addRecord({ tld: "hacker", label: "*.chovy", userId: BOB, type: "TXT", value: "mine" });
    assert.equal(added.ok, false);
    assert.match(added.error, /do not own/);

    const removed = await moshpit.removeRecord({ tld: "hacker", label: "*.chovy", userId: BOB, type: "AAAA", value: V6 });
    assert.equal(removed.ok, false);
    assert.match(removed.error, /do not own/);
    assert.equal((await moshpit.listRecords("hacker", "*.chovy")).length, 1, "bob withdrew nothing");
  });

  await t.test("`*` is a whole leftmost label or it is refused", async () => {
    for (const label of ["*", "ch*vy", "*.*", "foo.*"]) {
      const result = await moshpit.addRecord({ tld: "hacker", label, userId: ALICE, type: "TXT", value: "x" });
      assert.equal(result.ok, false, `${label} was accepted`);
    }
    // Registration keeps refusing it everywhere — a wildcard is a record name,
    // never a name.
    assert.equal((await moshpit.registerName({ tld: "hacker", label: "*", userId: ALICE })).ok, false);
  });

  await t.test("every name under chovy answers with the wildcard's records, as itself", async () => {
    const found = await moshpit.recordsForName("foo.chovy.hacker");
    assert.equal(found.name, "foo.chovy.hacker");
    assert.equal(found.name_registered, true);
    assert.deepEqual(found.records.map((r) => [r.type, r.value]), [["AAAA", V6]]);

    // The wildcard's address is the effective target, through the same
    // effectiveTarget rule a registered name's first AAAA takes.
    const resolution = await moshpit.resolveMoshpitName("foo.chovy.hacker");
    assert.equal(resolution.target, V6);
    assert.equal(resolution.name_registered, true);
  });

  await t.test("an exact third-level record beats the wildcard", async () => {
    // No route publishes one — a third-level name cannot be registered — but
    // the table can hold it and the lookup order is DNS's own: exact, then
    // wildcard.
    await run(`INSERT INTO moshpit_records (tld, label, type, value, ttl, priority, user_id, created_at)
               VALUES ('hacker', 'foo.chovy', 'TXT', 'exact', 300, NULL, ?, ?)`, [ALICE, Date.now()]);

    const found = await moshpit.recordsForName("foo.chovy.hacker");
    assert.deepEqual(found.records.map((r) => r.value), ["exact"]);
    // A sibling without its own records still gets the wildcard's answer.
    const other = await moshpit.recordsForName("bar.chovy.hacker");
    assert.deepEqual(other.records.map((r) => r.value), [V6]);
  });

  await t.test("no wildcard is not-exists, even when the parent is real", async () => {
    await moshpit.registerName({ tld: "hacker", label: "plain", userId: ALICE });
    assert.equal(await moshpit.resolveMoshpitName("foo.plain.hacker"), null);
    assert.equal(await moshpit.recordsForName("foo.plain.hacker"), null);
  });

  await t.test("the wildcard's own name answers with its own records", async () => {
    const found = await moshpit.recordsForName("*.chovy.hacker");
    assert.deepEqual(found.records.map((r) => r.value), [V6]);
  });

  await t.test("withdrawing the wildcard's record makes the subdomains not-exists again", async () => {
    const gone = await moshpit.removeRecord({ tld: "hacker", label: "*.chovy", userId: ALICE, type: "AAAA", value: V6 });
    assert.equal(gone.ok, true, gone.error);
    // foo.chovy still has its exact TXT, so it answers; bar has nothing left.
    assert.equal(await moshpit.resolveMoshpitName("bar.chovy.hacker"), null);
    assert.equal((await moshpit.recordsForName("foo.chovy.hacker")).records.length, 1);
  });

  await t.test("a released name takes its wildcard with it", async () => {
    await moshpit.registerName({ tld: "hacker", label: "temp", userId: ALICE });
    await moshpit.addRecord({ tld: "hacker", label: "*.temp", userId: ALICE, type: "TXT", value: "gone soon" });
    await moshpit.releaseName({ tld: "hacker", label: "temp", userId: ALICE });

    // Same rule as the records on the name itself: the next holder of temp
    // must not inherit answers for everything under it.
    assert.deepEqual(await moshpit.listRecords("hacker", "*.temp"), []);
  });

  await run(`DELETE FROM moshpit_records WHERE tld = 'hacker'`);
});
