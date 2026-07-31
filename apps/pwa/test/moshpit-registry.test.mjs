// The registry against a real (throwaway) libSQL database: claiming, the
// first-writer-wins race, aliases, exemptions and resolution.
//
// Skips cleanly when the PWA dependencies are not installed.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let installed = true;
try { require("@libsql/client"); } catch { installed = false; }

// Point at a throwaway database BEFORE importing app modules (config reads the
// environment once, at import time).
const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-moshpit-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const ALICE = "user-alice";
const BOB = "user-bob";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run } = await import("../src/db.mjs");
  for (const [id, email] of [[ALICE, "alice@example.com"], [BOB, "bob@example.com"]]) {
    await run(`INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?,?,?)`, [id, email, Date.now()]);
  }
  return import("../src/moshpit.mjs");
}

test("moshpit registry", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const m = await boot();

  await t.test("claiming a free TLD works and is logged", async () => {
    const r = await m.registerTld({ tld: ".Eggs", userId: ALICE, ownerEmail: "alice@example.com" });
    assert.equal(r.ok, true);
    assert.equal(r.tld.tld, "eggs");
    assert.equal(r.tld.user_id, ALICE);

    const log = await m.tldLog();
    assert.ok(log.some((e) => e.tld === "eggs" && e.action === "register"),
      "the allocation log is the record of who claimed it first");
  });

  await t.test("a second claim loses to the first writer", async () => {
    const r = await m.registerTld({ tld: "eggs", userId: BOB });
    assert.equal(r.ok, false);
    assert.equal(r.taken, true, "so the route can answer 409 rather than 400");
  });

  await t.test("reserved names are refused unless explicitly allowed", async () => {
    assert.equal((await m.registerTld({ tld: "bank", userId: ALICE })).ok, false);
    assert.equal((await m.registerTld({ tld: "moshpit", userId: ALICE })).ok, false);
    // The one legitimate bypass: assigning our own name to us.
    assert.equal((await m.registerTld({ tld: "moshpit", userId: ALICE, allowReserved: true })).ok, true);
  });

  await t.test("invalid input is refused", async () => {
    assert.equal((await m.registerTld({ tld: "a.b", userId: ALICE })).ok, false);
    assert.equal((await m.registerTld({ tld: "", userId: ALICE })).ok, false);
  });

  await t.test("an unregistered name resolves to itself, unregistered", async () => {
    assert.deepEqual(await m.resolveMoshpitName("who.nothing"),
      { name: "who.nothing", resolved: "who.nothing", aliased: false, registered: false,
        name_registered: false, target: null });
  });

  await t.test("aliasing carries the label across", async () => {
    await m.registerTld({ tld: "agent", userId: ALICE });
    await m.registerTld({ tld: "agentic", userId: ALICE });
    assert.equal((await m.setAlias({ from: "agentic", to: "agent", userId: ALICE })).ok, true);

    const r = await m.resolveMoshpitName("foo.agentic");
    assert.equal(r.resolved, "foo.agent", "an alias redirects the namespace, not the name");
    assert.equal(r.aliased, true);
  });

  await t.test("you cannot alias a TLD you do not own", async () => {
    await m.registerTld({ tld: "bobs", userId: BOB });
    const r = await m.setAlias({ from: "bobs", to: "agent", userId: ALICE });
    assert.equal(r.ok, false, "otherwise aliasing becomes a land-grab");
  });

  await t.test("alias chains are refused, so resolution stays one hop", async () => {
    await m.registerTld({ tld: "agents", userId: ALICE });
    // .agentic already points at .agent, so .agent must not point elsewhere...
    assert.equal((await m.setAlias({ from: "agent", to: "agents", userId: ALICE })).ok, false);
    // ...and nothing may point at an alias either.
    assert.equal((await m.setAlias({ from: "agents", to: "agentic", userId: ALICE })).ok, false);
  });

  await t.test("a TLD cannot point at itself", async () => {
    assert.equal((await m.setAlias({ from: "agent", to: "agent", userId: ALICE })).ok, false);
  });

  await t.test("an exempt name outranks the alias", async () => {
    assert.equal((await m.setExempt({ tld: "agentic", label: "keepme", userId: ALICE })).ok, true);
    const r = await m.resolveMoshpitName("keepme.agentic");
    assert.equal(r.resolved, "keepme.agentic");
    assert.equal(r.exempt, true);
    assert.equal(r.aliased, false);
    // ...while everything else still follows it.
    assert.equal((await m.resolveMoshpitName("other.agentic")).resolved, "other.agent");
  });

  await t.test("numeric labels resolve and can be exempted", async () => {
    assert.equal((await m.resolveMoshpitName("123.agentic")).resolved, "123.agent");
    assert.equal((await m.setExempt({ tld: "agentic", label: "123", userId: ALICE })).ok, true);
    const r = await m.resolveMoshpitName("123.agentic");
    assert.equal(r.resolved, "123.agentic");
    assert.equal(r.exempt, true);
  });

  await t.test("exemptions survive the alias being repointed", async () => {
    await m.clearAlias("agentic", ALICE);
    await m.setAlias({ from: "agentic", to: "agents", userId: ALICE });
    const r = await m.resolveMoshpitName("keepme.agentic");
    assert.equal(r.resolved, "keepme.agentic", "which is why exemption is checked at read time");
    assert.equal((await m.resolveMoshpitName("other.agentic")).resolved, "other.agents");
  });

  await t.test("clearing an exemption lets the name follow the alias again", async () => {
    assert.equal((await m.clearExempt({ tld: "agentic", label: "keepme", userId: ALICE })).ok, true);
    assert.equal((await m.resolveMoshpitName("keepme.agentic")).resolved, "keepme.agents");
  });

  await t.test("you cannot exempt a name under someone else's TLD", async () => {
    assert.equal((await m.setExempt({ tld: "bobs", label: "x", userId: ALICE })).ok, false);
  });

  await t.test("clearing an alias returns the TLD to standing on its own", async () => {
    assert.equal((await m.clearAlias("agentic", ALICE)).ok, true);
    const r = await m.resolveMoshpitName("foo.agentic");
    assert.equal(r.resolved, "foo.agentic");
    assert.equal(r.aliased, false);
  });

  await t.test("the TLD operator can mint names under it", async () => {
    const r = await m.registerName({ tld: "eggs", label: "Blue", userId: ALICE, target: "https://example.com" });
    assert.equal(r.ok, true);
    assert.equal(r.name.label, "blue");
    assert.equal(r.name.target, "https://example.com");
    assert.deepEqual((await m.listNames("eggs")).map((n) => n.label), ["blue"]);
  });

  await t.test("a name can be reserved before it points anywhere", async () => {
    assert.equal((await m.registerName({ tld: "eggs", label: "later", userId: ALICE })).ok, true);
    assert.equal((await m.getName("eggs", "later")).target, null);
  });

  await t.test("the same name cannot be minted twice", async () => {
    const r = await m.registerName({ tld: "eggs", label: "blue", userId: ALICE });
    assert.equal(r.ok, false);
    assert.equal(r.taken, true);
  });

  await t.test("nobody else can mint under your TLD", async () => {
    const r = await m.registerName({ tld: "eggs", label: "stolen", userId: BOB });
    assert.equal(r.ok, false, "holding the TLD is what buys you the namespace under it");
    assert.equal(await m.getName("eggs", "stolen"), null);
  });

  await t.test("names cannot be minted under an unregistered TLD", async () => {
    assert.equal((await m.registerName({ tld: "nothing", label: "x", userId: ALICE })).ok, false);
  });

  await t.test("invalid labels are refused", async () => {
    assert.equal((await m.registerName({ tld: "eggs", label: "a.b", userId: ALICE })).ok, false);
    assert.equal((await m.registerName({ tld: "eggs", label: "", userId: ALICE })).ok, false);
  });

  await t.test("resolving a minted name reports it, and its target", async () => {
    const r = await m.resolveMoshpitName("blue.eggs");
    assert.equal(r.registered, true, "the TLD is claimed");
    assert.equal(r.name_registered, true);
    assert.equal(r.target, "https://example.com");
  });

  await t.test("an unminted name under a claimed TLD is not registered", async () => {
    const r = await m.resolveMoshpitName("ghost.eggs");
    assert.equal(r.registered, true, "the TLD is still claimed");
    assert.equal(r.name_registered, false);
    assert.equal(r.target, null);
  });

  await t.test("a name is looked up on the TLD it resolves to", async () => {
    // .agentic points at .agents; a name minted on .agents answers for both.
    await m.setAlias({ from: "agentic", to: "agents", userId: ALICE });
    await m.registerName({ tld: "agents", label: "foo", userId: ALICE, target: "https://foo.example" });

    const viaAlias = await m.resolveMoshpitName("foo.agentic");
    assert.equal(viaAlias.resolved, "foo.agents");
    assert.equal(viaAlias.name_registered, true);
    assert.equal(viaAlias.target, "https://foo.example");
    await m.clearAlias("agentic", ALICE);
  });

  await t.test("retargeting and releasing work, and are owner-only", async () => {
    assert.equal((await m.setNameTarget({ tld: "eggs", label: "blue", userId: BOB, target: "x" })).ok, false);
    assert.equal((await m.releaseName({ tld: "eggs", label: "blue", userId: BOB })).ok, false);

    assert.equal((await m.setNameTarget({ tld: "eggs", label: "blue", userId: ALICE, target: "https://new.example" })).ok, true);
    assert.equal((await m.getName("eggs", "blue")).target, "https://new.example");

    assert.equal((await m.releaseName({ tld: "eggs", label: "blue", userId: ALICE })).ok, true);
    assert.equal(await m.getName("eggs", "blue"), null);
  });

  await t.test("minting is logged", async () => {
    const log = await m.tldLog();
    assert.ok(log.some((e) => e.action === "name:blue"));
    assert.ok(log.some((e) => e.action === "unname:blue"));
  });

  await t.test("listing is scoped correctly", async () => {
    const mine = await m.listTldsForUser(BOB);
    assert.deepEqual(mine.map((t) => t.tld).sort(), ["bobs"]);
    assert.ok((await m.listTlds()).length >= 5);
  });
});
