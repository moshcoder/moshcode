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
      { name: "who.nothing", resolved: "who.nothing", aliased: false, registered: false });
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

  await t.test("listing is scoped correctly", async () => {
    const mine = await m.listTldsForUser(BOB);
    assert.deepEqual(mine.map((t) => t.tld).sort(), ["bobs"]);
    assert.ok((await m.listTlds()).length >= 5);
  });
});
