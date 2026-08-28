// Backfilling a name with a clearnet domain, against a real (throwaway) libSQL
// database.
//
// The behaviour worth checking is in the ownership rules, the uniqueness
// constraints and the lapse arithmetic, and none of that survives being mocked.
// DNS is the one thing stubbed: verification takes its resolver as an argument
// precisely so this can cover the only part of it worth covering.
//
// Skips cleanly when the PWA dependencies are not installed.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import test from "node:test";

const require = createRequire(import.meta.url);
let installed = true;
try { require("@libsql/client"); } catch { installed = false; }

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-twins-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const ALICE = "user-alice";
const BOB = "user-bob";
const DAY = 24 * 60 * 60 * 1000;

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run } = await import("../src/db.mjs");
  for (const [id, email] of [[ALICE, "alice@example.com"], [BOB, "bob@example.com"]]) {
    await run(`INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?,?,?)`, [id, email, Date.now()]);
  }
  return { moshpit: await import("../src/moshpit.mjs"), run };
}

/** A resolver that answers with exactly these TXT records, in DNS's chunked shape. */
const dnsWith = (...values) => async () => values.map((v) => [v]);
/** A resolver that answers the way DNS answers when there is nothing there. */
const dnsEmpty = async () => { const e = new Error("no data"); e.code = "ENODATA"; throw e; };
/** A resolver that is simply broken, which is a different thing. */
const dnsBroken = async () => { const e = new Error("servfail"); e.code = "ESERVFAIL"; throw e; };

test("moshpit twins", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const { moshpit: m } = await boot();
  let n = 0;

  /** A fresh ending with one name under it, held by `userId`. */
  const freshName = async (userId = ALICE, label = "blue") => {
    const tld = `t${n++}${randomBytes(3).toString("hex")}`;
    const claimed = await m.registerTld({ tld, userId, ownerEmail: null });
    assert.ok(claimed.ok, `could not claim .${tld}: ${claimed.error}`);
    const named = await m.registerName({ tld, label, userId });
    assert.ok(named.ok, `could not mint ${label}.${tld}: ${named.error}`);
    return { tld, label, name: `${label}.${tld}` };
  };

  /** Claim and prove a twin in one step, for tests about what happens afterwards. */
  const backfilled = async ({ tld, label, name }, domain, opts = {}) => {
    const claim = await m.claimTwin({ tld, label, userId: ALICE, domain, ...opts });
    assert.ok(claim.ok, `claim failed: ${claim.error}`);
    const verified = await m.verifyTwin({
      tld, label, userId: ALICE,
      resolveTxt: dnsWith(m.twinProof({ name, token: claim.token })),
      ...(opts.now ? { now: opts.now } : {}),
    });
    assert.ok(verified.ok, `verify failed: ${verified.error}`);
    return { claim, verified };
  };

  await t.test("only the name's holder may back it with a domain", async () => {
    const { tld, label } = await freshName(ALICE);
    const theirs = await m.claimTwin({ tld, label, userId: BOB, domain: "example.com" });
    assert.equal(theirs.ok, false);
    assert.match(theirs.error, /do not own/);
    // ...and an unminted name has nobody to authorise it at all.
    const orphan = await m.claimTwin({ tld, label: "nobody", userId: ALICE, domain: "example.com" });
    assert.equal(orphan.ok, false);
    assert.match(orphan.error, /not registered/);
  });

  await t.test("a claim issues a challenge and the record to publish", async () => {
    const name = await freshName();
    const claim = await m.claimTwin({ ...name, userId: ALICE, domain: "HTTPS://Example.COM/path" });
    assert.equal(claim.ok, true);
    assert.equal(claim.domain, "example.com", "normalised on the way in");
    assert.match(claim.token, /^[0-9a-f]{32}$/);
    // One string, at one place. Handing back the pieces is how it gets typed in
    // wrong.
    assert.deepEqual(claim.proof, {
      host: "_moshpit.example.com",
      type: "TXT",
      value: `v=moshpit1 name=${name.name} token=${claim.token}`,
    });
    // Claimed is not served.
    assert.equal(await m.twinForName(name.name), null);
  });

  await t.test("a domain that reads as another name's twin is refused", async () => {
    const name = await freshName(ALICE, "blue");
    const wrong = await m.claimTwin({ ...name, userId: ALICE, domain: "red-eggs.net" });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /reads as the twin of red\.eggs/);

    // Its own twin is fine, and so is a domain that is not twin-shaped at all --
    // somebody who already owns `financialadvisors.com` may use it.
    const own = await m.claimTwin({ ...name, userId: ALICE, domain: `blue-${name.tld}.net` });
    assert.equal(own.ok, true, own.error);
    const unshaped = await m.claimTwin({ ...name, userId: ALICE, domain: "financialadvisors.com" });
    assert.equal(unshaped.ok, true, unshaped.error);
  });

  await t.test("verification distinguishes no record from no answer", async () => {
    const name = await freshName();
    const claim = await m.claimTwin({ ...name, userId: ALICE, domain: "proofme.com" });

    const missing = await m.verifyTwin({ ...name, userId: ALICE, resolveTxt: dnsEmpty });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /no matching proof/);
    assert.equal(missing.retryable, true);
    assert.equal(missing.proof.value, `v=moshpit1 name=${name.name} token=${claim.token}`,
      "told again what to publish");

    // A resolver that is broken calls for waiting, not for re-typing a record
    // that was always correct -- so it says something different.
    const broken = await m.verifyTwin({ ...name, userId: ALICE, resolveTxt: dnsBroken });
    assert.equal(broken.ok, false);
    assert.match(broken.error, /could not read TXT/);
    assert.equal(broken.retryable, true);

    // A proof for somebody else's name is not this name's proof.
    const theirs = await m.verifyTwin({
      ...name, userId: ALICE,
      resolveTxt: dnsWith(m.twinProof({ name: "red.eggs", token: claim.token })),
    });
    assert.equal(theirs.ok, false);
  });

  await t.test("a published proof starts the twin serving", async () => {
    const name = await freshName();
    const claim = await m.claimTwin({ ...name, userId: ALICE, domain: "serveme.com" });
    const ok = await m.verifyTwin({
      ...name, userId: ALICE,
      // Alongside the records a domain in real use actually carries.
      resolveTxt: dnsWith("v=spf1 include:example.com ~all", m.twinProof({ name: name.name, token: claim.token })),
    });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.domain, "serveme.com");

    const live = await m.twinForName(name.name);
    assert.equal(live.domain, "serveme.com");
    assert.equal(live.status, "verified");
  });

  await t.test("one domain backfills one name", async () => {
    const first = await freshName();
    await backfilled(first, "contested.com");
    const second = await freshName();
    const clash = await m.claimTwin({ ...second, userId: ALICE, domain: "contested.com" });
    assert.equal(clash.ok, false);
    assert.equal(clash.taken, true);
    assert.match(clash.error, new RegExp(`already backfills ${first.name.replace(".", "\\.")}`));
  });

  await t.test("a pending claim does not reserve a domain against the person who holds it", async () => {
    // Two people may both be trying; only one can finish. An abandoned pending
    // claim must not be what stops the real holder proving it.
    const squatter = await freshName();
    await m.claimTwin({ ...squatter, userId: ALICE, domain: "unproven.com" });

    const real = await freshName();
    const claim = await m.claimTwin({ ...real, userId: ALICE, domain: "unproven.com" });
    assert.equal(claim.ok, true, claim.error);
    const ok = await m.verifyTwin({
      ...real, userId: ALICE,
      resolveTxt: dnsWith(m.twinProof({ name: real.name, token: claim.token })),
    });
    assert.equal(ok.ok, true, ok.error);
  });

  await t.test("replacing a live twin is a deliberate act", async () => {
    const name = await freshName();
    await backfilled(name, "firstchoice.com");

    const accidental = await m.claimTwin({ ...name, userId: ALICE, domain: "secondchoice.com" });
    assert.equal(accidental.ok, false);
    assert.equal(accidental.replaceable, true);
    assert.equal(accidental.current, "firstchoice.com");
    // Refused, and the old one is still serving.
    assert.equal((await m.twinForName(name.name)).domain, "firstchoice.com");

    const deliberate = await m.claimTwin({ ...name, userId: ALICE, domain: "secondchoice.com", replace: true });
    assert.equal(deliberate.ok, true, deliberate.error);
    // Which takes the name off the clearnet until the new domain proves itself.
    assert.equal(await m.twinForName(name.name), null);
  });

  await t.test("re-claiming issues a fresh token", async () => {
    const name = await freshName();
    const first = await m.claimTwin({ ...name, userId: ALICE, domain: "rotate.com" });
    const second = await m.claimTwin({ ...name, userId: ALICE, domain: "rotate.com" });
    assert.notEqual(first.token, second.token);
    // A proof published for the abandoned claim must not satisfy the new one.
    const stale = await m.verifyTwin({
      ...name, userId: ALICE,
      resolveTxt: dnsWith(m.twinProof({ name: name.name, token: first.token })),
    });
    assert.equal(stale.ok, false);
  });

  await t.test("the twin follows the ending's alias", async () => {
    // `.agentic` points at `.agent`, so what serves foo.agent is what a visitor
    // reaches -- and its twin is the one that leads anywhere.
    const target = await freshName(ALICE, "foo");
    await backfilled(target, "aliasedtarget.com");

    const from = `a${n++}${randomBytes(3).toString("hex")}`;
    await m.registerTld({ tld: from, userId: ALICE, ownerEmail: null });
    const aliased = await m.setAlias({ from, to: target.tld, userId: ALICE });
    assert.ok(aliased.ok, aliased.error);

    const twin = await m.twinForName(`foo.${from}`);
    assert.equal(twin?.domain, "aliasedtarget.com");
  });

  await t.test("an expiry has to be a date a registration could actually have", async () => {
    const name = await freshName();
    await backfilled(name, "expiring.com");
    const now = Date.now();

    for (const [bad, why] of [[now - DAY, /in the past/], ["not a date", /must be a timestamp/], [now + 20 * 365 * DAY, /further out/]]) {
      const r = await m.setTwinExpiry({ ...name, userId: ALICE, expiresAt: bad, now });
      assert.equal(r.ok, false, String(bad));
      assert.match(r.error, why);
    }

    const ok = await m.setTwinExpiry({ ...name, userId: ALICE, expiresAt: now + 365 * DAY, now });
    assert.equal(ok.ok, true, ok.error);
    // Null clears it: a domain its holder renews elsewhere has no date we can learn.
    const cleared = await m.setTwinExpiry({ ...name, userId: ALICE, expiresAt: null, now });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.expires_at, null);
  });

  await t.test("a twin goes dark before its domain drops", async () => {
    const name = await freshName();
    await backfilled(name, "lapsing.com");
    const now = Date.now();
    const lead = m.TWIN_UNLINK_LEAD_MS;

    await m.setTwinExpiry({ ...name, userId: ALICE, expiresAt: now + lead + 2 * DAY, now });
    assert.ok(await m.twinForName(name.name, now), "still outside the window");

    // The domain is still registered for another six days, and the pit has
    // already stopped handing it out. That is the whole point.
    await m.setTwinExpiry({ ...name, userId: ALICE, expiresAt: now + lead - 2 * DAY, now });
    assert.equal(await m.twinForName(name.name, now), null);
  });

  await t.test("the renewal nag reads the date the name goes dark", async () => {
    const name = await freshName();
    await backfilled(name, "nagme.com");
    const now = Date.now();
    const lead = m.TWIN_UNLINK_LEAD_MS;

    await m.setTwinExpiry({ ...name, userId: ALICE, expiresAt: now + lead + 3 * DAY, now });
    const soon = await m.expiringTwins({ within: 5 * DAY, now });
    assert.ok(soon.some((r) => r.domain === "nagme.com"), "drops in 3 days, inside a 5 day window");

    const notYet = await m.expiringTwins({ within: 1 * DAY, now });
    assert.equal(notYet.some((r) => r.domain === "nagme.com"), false);
  });

  await t.test("releasing the name takes the twin with it", async () => {
    const name = await freshName();
    await backfilled(name, "handedback.com");

    const released = await m.releaseName({ ...name, userId: ALICE });
    assert.equal(released.ok, true, released.error);
    assert.equal(await m.getTwin(name.tld, name.label), null,
      "an inherited twin would point the next holder's visitors at a stranger's site");

    // And the domain is free for whoever takes the name next. Re-minted by the
    // same account here because only an ending's owner may mint under it -- a
    // real change of hands goes through settleNamePurchase -- but what is being
    // checked is the name, not the person: the row it inherits must be empty.
    const retaken = await m.registerName({ tld: name.tld, label: name.label, userId: ALICE });
    assert.ok(retaken.ok, retaken.error);
    assert.equal(await m.twinForName(name.name), null, "re-minted with no twin");
    const reclaimed = await m.claimTwin({ ...name, userId: ALICE, domain: "handedback.com" });
    assert.equal(reclaimed.ok, true, reclaimed.error);
  });

  await t.test("removing a twin stops it being served", async () => {
    const name = await freshName();
    await backfilled(name, "removeme.com");
    assert.ok(await m.twinForName(name.name));

    const gone = await m.removeTwin({ ...name, userId: ALICE });
    assert.equal(gone.ok, true);
    assert.equal(await m.twinForName(name.name), null);
    // Removing one that is not there says so rather than reporting success.
    const again = await m.removeTwin({ ...name, userId: ALICE });
    assert.equal(again.ok, false);
  });

  await t.test("suggests the twins that are actually available", async () => {
    const taken = await freshName(ALICE, "picked");
    const all = m.clearnetTwins(taken.name);
    assert.equal(all.length, 3);

    await backfilled(taken, all[0]);
    const left = await m.availableTwins(taken.name);
    assert.deepEqual(left, all.slice(1), "the .com is spoken for");
  });

  await t.test("a twin is listed to the person who bought it", async () => {
    const name = await freshName();
    await backfilled(name, "mine-to-see.com");
    const mine = await m.listTwinsForUser(ALICE);
    assert.ok(mine.some((r) => r.domain === "mine-to-see.com"));
    assert.equal((await m.listTwinsForUser(BOB)).some((r) => r.domain === "mine-to-see.com"), false);
  });
});
