// The keys a name may present, against a real (throwaway) libSQL database.
//
// The behaviour worth checking is in the SQL and the ownership checks — who may
// publish under a name that changed hands, what a sold name inherits — and none
// of that survives being mocked.
//
// Skips cleanly when the PWA dependencies are not installed.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

const require = createRequire(import.meta.url);
let installed = true;
try { require("@libsql/client"); } catch { installed = false; }

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pins-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const ALICE = "user-alice";
const BOB = "user-bob";

/** A pin is SHA-256 over an SPKI; any 32 random bytes stand in for one here. */
const somePin = () => createHash("sha256").update(randomBytes(32)).digest("base64");

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run } = await import("../src/db.mjs");
  for (const [id, email] of [[ALICE, "alice@example.com"], [BOB, "bob@example.com"]]) {
    await run(`INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?,?,?)`, [id, email, Date.now()]);
  }
  return { moshpit: await import("../src/moshpit.mjs"), run };
}

test("moshpit pins", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const { moshpit: m, run } = await boot();
  let n = 0;
  const freshTld = async (userId = ALICE) => {
    const tld = `p${n++}${randomBytes(3).toString("hex")}`;
    const r = await m.registerTld({ tld, userId, ownerEmail: null });
    assert.ok(r.ok, `could not claim .${tld}: ${r.error}`);
    return tld;
  };

  await t.test("a pin is 32 base64 bytes and nothing else", () => {
    assert.equal(m.isPin(somePin()), true);
    // Each of these has been a real bug in someone's pinning code.
    assert.equal(m.isPin(""), false);
    assert.equal(m.isPin("hunter2"), false);
    assert.equal(m.isPin(createHash("sha1").update("x").digest("base64")), false, "sha-1 is 20 bytes");
    assert.equal(m.isPin(createHash("sha512").update("x").digest("base64")), false, "sha-512 is 64 bytes");
    assert.equal(m.isPin(randomBytes(32).toString("hex")), false, "hex is not base64");
    assert.equal(m.isPin(somePin().replace("=", "")), false, "unpadded");
    assert.equal(m.isPin(null), false);
  });

  await t.test("kinds are exactly tls and mtp", () => {
    assert.deepEqual(m.PIN_KINDS, ["tls", "mtp"]);
    assert.equal(m.normalizePinKind("TLS"), "tls");
    assert.equal(m.normalizePinKind(" mtp "), "mtp");
    assert.equal(m.normalizePinKind("ssh"), null);
    assert.equal(m.normalizePinKind(null), null);
  });

  await t.test("a published key comes back for that name", async () => {
    const tld = await freshTld();
    await m.registerName({ tld, label: "blue", userId: ALICE });
    const pin = somePin();
    assert.ok((await m.addPin({ tld, label: "blue", pin, kind: "tls", userId: ALICE })).ok);

    const found = await m.pinsForName(`blue.${tld}`);
    assert.deepEqual(found.pins.map((p) => p.pin), [pin]);
    assert.equal(found.label, "blue");
  });

  await t.test("a sibling name is unaffected", async () => {
    const tld = await freshTld();
    await m.registerName({ tld, label: "one", userId: ALICE });
    await m.registerName({ tld, label: "two", userId: ALICE });
    await m.addPin({ tld, label: "one", pin: somePin(), kind: "tls", userId: ALICE });

    assert.deepEqual((await m.pinsForName(`two.${tld}`)).pins, [], "keys must not leak across names");
  });

  await t.test("the TLD operator cannot publish a key for a name they sold", async () => {
    const tld = await freshTld(ALICE);
    // Bob bought `mine.<tld>`: the name row is his, the TLD is still Alice's.
    await run(`INSERT INTO moshpit_names (tld, label, user_id, target, created_at) VALUES (?,?,?,?,?)`,
      [tld, "mine", BOB, null, Date.now()]);

    // This is the whole reason pins are per name here rather than per TLD.
    const hijack = await m.addPin({ tld, label: "mine", pin: somePin(), kind: "tls", userId: ALICE });
    assert.equal(hijack.ok, false);
    assert.match(hijack.error, /do not own/);

    assert.ok((await m.addPin({ tld, label: "mine", pin: somePin(), kind: "tls", userId: BOB })).ok);
  });

  await t.test("kinds are kept apart", async () => {
    const tld = await freshTld();
    await m.registerName({ tld, label: "both", userId: ALICE });
    const tls = somePin();
    const mtp = somePin();
    await m.addPin({ tld, label: "both", pin: tls, kind: "tls", userId: ALICE });
    await m.addPin({ tld, label: "both", pin: mtp, kind: "mtp", userId: ALICE });

    assert.deepEqual((await m.listPins(tld, "both", "tls")).map((p) => p.pin), [tls]);
    assert.deepEqual((await m.listPins(tld, "both", "mtp")).map((p) => p.pin), [mtp]);
    assert.equal((await m.listPins(tld, "both")).length, 2);
  });

  await t.test("the same pin cannot be two kinds", async () => {
    const tld = await freshTld();
    await m.registerName({ tld, label: "dup", userId: ALICE });
    const pin = somePin();
    await m.addPin({ tld, label: "dup", pin, kind: "tls", userId: ALICE });

    const clash = await m.addPin({ tld, label: "dup", pin, kind: "mtp", userId: ALICE });
    assert.equal(clash.ok, false);
    assert.equal(clash.taken, true);
    // Publishing it twice under the same kind is a no-op, not a duplicate.
    assert.equal((await m.addPin({ tld, label: "dup", pin, kind: "tls", userId: ALICE })).ok, true);
    assert.equal((await m.listPins(tld, "dup")).length, 1);
  });

  await t.test("rotation: both keys live, then the old one goes", async () => {
    const tld = await freshTld();
    await m.registerName({ tld, label: "rot", userId: ALICE });
    const oldKey = somePin();
    const newKey = somePin();
    await m.addPin({ tld, label: "rot", pin: oldKey, kind: "tls", userId: ALICE });
    await m.addPin({ tld, label: "rot", pin: newKey, kind: "tls", userId: ALICE });

    assert.equal((await m.pinsForName(`rot.${tld}`)).pins.length, 2, "the window that makes rotation possible");

    assert.ok((await m.removePin({ tld, label: "rot", pin: oldKey, userId: ALICE })).ok);
    assert.deepEqual((await m.pinsForName(`rot.${tld}`)).pins.map((p) => p.pin), [newKey]);
  });

  await t.test("withdrawing the last key is allowed — that is revocation", async () => {
    const tld = await freshTld();
    await m.registerName({ tld, label: "gone", userId: ALICE });
    const pin = somePin();
    await m.addPin({ tld, label: "gone", pin, kind: "tls", userId: ALICE });

    assert.ok((await m.removePin({ tld, label: "gone", pin, userId: ALICE })).ok);
    assert.deepEqual((await m.pinsForName(`gone.${tld}`)).pins, [], "no key means refuse, not allow");
  });

  await t.test("releasing a name takes its keys with it", async () => {
    const tld = await freshTld();
    await m.registerName({ tld, label: "handover", userId: ALICE });
    await m.addPin({ tld, label: "handover", pin: somePin(), kind: "tls", userId: ALICE });

    assert.ok((await m.releaseName({ tld, label: "handover", userId: ALICE })).ok);

    // SQLite only honours ON DELETE CASCADE with PRAGMA foreign_keys = ON, which
    // this app never sets — so without an explicit delete the next holder would
    // inherit Alice's published keys.
    assert.deepEqual(await m.listPins(tld, "handover"), [], "a new owner must not inherit old keys");

    await run(`INSERT INTO moshpit_names (tld, label, user_id, target, created_at) VALUES (?,?,?,?,?)`,
      [tld, "handover", BOB, null, Date.now()]);
    assert.deepEqual((await m.pinsForName(`handover.${tld}`)).pins, []);
  });

  await t.test("only the name's holder may publish or withdraw", async () => {
    const tld = await freshTld();
    await m.registerName({ tld, label: "mine", userId: ALICE });
    const pin = somePin();

    assert.equal((await m.addPin({ tld, label: "mine", pin, kind: "tls", userId: BOB })).ok, false);
    await m.addPin({ tld, label: "mine", pin, kind: "tls", userId: ALICE });
    assert.equal((await m.removePin({ tld, label: "mine", pin, userId: BOB })).ok, false);
    assert.equal((await m.listPins(tld, "mine")).length, 1, "the key survived the attempt");
  });

  await t.test("an unregistered name cannot be pinned", async () => {
    const tld = await freshTld();
    const result = await m.addPin({ tld, label: "ghost", pin: somePin(), kind: "tls", userId: ALICE });
    assert.equal(result.ok, false);
    assert.match(result.error, /not registered/);
  });

  await t.test("malformed input is refused at the door", async () => {
    const tld = await freshTld();
    await m.registerName({ tld, label: "strict", userId: ALICE });
    for (const bad of ["", "hunter2", randomBytes(32).toString("hex"), null]) {
      assert.equal((await m.addPin({ tld, label: "strict", pin: bad, kind: "tls", userId: ALICE })).ok, false,
        `accepted ${JSON.stringify(bad)}`);
    }
    assert.equal((await m.addPin({ tld, label: "strict", pin: somePin(), kind: "ssh", userId: ALICE })).ok, false);
  });

  await t.test("an aliased name is pinned by the TLD it points at", async () => {
    const target = await freshTld();
    const alias = await freshTld();
    await m.registerName({ tld: target, label: "foo", userId: ALICE });
    await m.registerName({ tld: alias, label: "foo", userId: ALICE });

    const targetPin = somePin();
    const aliasPin = somePin();
    await m.addPin({ tld: target, label: "foo", pin: targetPin, kind: "tls", userId: ALICE });
    await m.addPin({ tld: alias, label: "foo", pin: aliasPin, kind: "tls", userId: ALICE });
    assert.ok((await m.setAlias({ from: alias, to: target, userId: ALICE })).ok);

    // foo.<alias> connects to whatever serves foo.<target>, so that is the key
    // which will be presented. Answering with the alias's own would refuse
    // every working connection.
    const found = await m.pinsForName(`foo.${alias}`);
    assert.equal(found.resolved, `foo.${target}`);
    assert.deepEqual(found.pins.map((p) => p.pin), [targetPin]);
  });

  await t.test("a name outside the namespace is not merely unpinned", async () => {
    // Answering "no key published" about example.com would invite a client to
    // treat clearnet as something the pit has an opinion about.
    assert.equal(await m.pinsForName("example.com"), null);
    assert.equal(await m.pinsForName("not-a-name"), null);
  });
});
