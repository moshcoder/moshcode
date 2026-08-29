// Contact on a name: the consented half of a WHOIS, and the leak it replaces.
//
// Two things are being asserted here and they are the same thing from opposite
// ends. A holder who opts in gets a guard address that forwards to them and
// never says where. A holder who does not opt in — which is everybody, until
// they act — has nothing published at all, including the account address the
// endings list used to hand out to anyone who asked.
//
// Same harness as moshpit-ending-page.test.mjs: the real router against a
// throwaway libsql file, skipped cleanly when the PWA deps are not installed.
// The pure rules run either way; they have no dependencies by design.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

import {
  guardAddress,
  isGuardToken,
  mintGuardToken,
  normalizeContactEmail,
  normalizeVisibility,
  publishedContact,
} from "../src/lib/moshpit-contact.mjs";

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = { express: require("express") };
} catch {
  deps = null;
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-contact-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
process.env.PUBLIC_ORIGIN = "https://app.example.test";
process.env.PIT_ORIGIN = "https://pit.example.test";
process.env.MOSHPIT_GUARD_DOMAIN = "moshcode.sh";
// Left unset on purpose. No mail host is the state this ships in and the state
// development runs in, and "records the contact, publishes nothing" has to be
// the behaviour rather than an error.
delete process.env.FORWARDEMAIL_API_KEY;

/* ---- the rules, which need nothing ---- */

test("an address survives being pasted out of a mail client", () => {
  assert.equal(normalizeContactEmail("Anthony <Me@Example.COM>"), "me@example.com");
  assert.equal(normalizeContactEmail("  mailto:me@example.com "), "me@example.com");
  assert.equal(normalizeContactEmail("me@example.com."), "me@example.com");
});

test("what could never be an address is refused rather than stored", () => {
  for (const bad of ["", "me", "me@", "@example.com", "me@localhost", "me@1.2.3.4", "a b@example.com", ".me@example.com", "me..you@example.com"]) {
    assert.equal(normalizeContactEmail(bad), null, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test("a guard token cannot spell a word, so it cannot collide with a real mailbox", () => {
  // The property that makes a reserved-address list unnecessary: no vowels, so
  // `support`, `abuse` and `notify` are unreachable from the alphabet itself.
  for (let i = 0; i < 200; i += 1) {
    const token = mintGuardToken();
    assert.ok(isGuardToken(token), `${token} is not a well-formed token`);
    assert.doesNotMatch(token, /[aeiou]/);
    assert.equal(token.length, 10);
  }
});

test("tokens do not repeat", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(mintGuardToken());
  assert.equal(seen.size, 500);
});

test("every character of the alphabet is reachable", () => {
  // A rejection-sampling loop that silently never emits its tail would bias
  // every address ever minted, and would still pass every other test here.
  const seen = new Set();
  for (let i = 0; i < 4000; i += 1) for (const ch of mintGuardToken()) seen.add(ch);
  assert.equal(seen.size, 27, `only ${seen.size} of 27 characters were ever emitted`);
});

test("a guard address is the token at the guard domain", () => {
  assert.equal(guardAddress("k7m2xqbn3f", "moshcode.sh"), "k7m2xqbn3f@moshcode.sh");
  assert.equal(guardAddress("not-a-token", "moshcode.sh"), null);
  assert.equal(guardAddress("k7m2xqbn3f", "not a domain"), null);
});

test("visibility is validated rather than trusted into a CHECK-constrained column", () => {
  assert.equal(normalizeVisibility("GUARD"), "guard");
  assert.equal(normalizeVisibility("public"), "public");
  assert.equal(normalizeVisibility("everyone"), null);
  assert.equal(normalizeVisibility(undefined), null);
});

test("a guard contact publishes the guard address, never the real one", () => {
  const row = {
    email: "real@example.com", visibility: "guard",
    guard_token: "k7m2xqbn3f", alias_status: "live",
  };
  assert.deepEqual(publishedContact(row, "moshcode.sh"), { kind: "guard", address: "k7m2xqbn3f@moshcode.sh" });
});

test("a guard address is withheld until the mail host has it", () => {
  // The failure this prevents is publishing an address that bounces, which is
  // worse than publishing none: the holder looks reachable and is not.
  for (const alias_status of ["pending", "failed", "revoked"]) {
    const row = { email: "real@example.com", visibility: "guard", guard_token: "k7m2xqbn3f", alias_status };
    assert.equal(publishedContact(row, "moshcode.sh"), null, `${alias_status} should publish nothing`);
  }
});

test("`public` is the only way the real address is ever shown, and `none` shows nothing", () => {
  const base = { email: "Real@Example.com", guard_token: "k7m2xqbn3f", alias_status: "live" };
  assert.deepEqual(
    publishedContact({ ...base, visibility: "public" }, "moshcode.sh"),
    { kind: "public", address: "real@example.com" },
  );
  assert.equal(publishedContact({ ...base, visibility: "none" }, "moshcode.sh"), null);
  assert.equal(publishedContact(null, "moshcode.sh"), null);
});

/* ---- storage and routes ---- */

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, get, db } = await import("../src/db.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");
  const moshpit = await import("../src/moshpit.mjs");

  await run(`INSERT OR REPLACE INTO users (id,email,created_at) VALUES ('u1','holder@example.com',1)`);
  await run(`INSERT OR REPLACE INTO users (id,email,created_at) VALUES ('u2','other@example.com',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('eggs','u1','holder@example.com',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('theirs','u2','other@example.com',1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('eggs','blue','u1',NULL,1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('eggs','green','u1',NULL,1)`);

  const app = deps.express();
  app.use(deps.express.json());
  app.use((req, _res, next) => { req.csrfToken = () => "csrf"; next(); });
  // Signing in, for the two pages that draw differently once you have. A header
  // rather than a real session: what is under test is what the page says about
  // a holder's contacts, not how the session cookie got there.
  app.use((req, _res, next) => {
    const id = req.headers["x-test-user"];
    if (id) req.user = { id, email: "holder@example.com" };
    next();
  });
  app.use(moshpitRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const getJson = async (p) => {
    const res = await fetch(`${base}${p}`);
    return { status: res.status, body: await res.json() };
  };
  const getHtml = async (p, userId = null) => {
    const res = await fetch(`${base}${p}`, { headers: userId ? { "x-test-user": userId } : {} });
    return { status: res.status, body: await res.text() };
  };
  // The one thing a test can do that the mail host would: mark the alias live.
  const goLive = (tld, label) =>
    run(`UPDATE moshpit_contacts SET alias_status = 'live', alias_id = 'fe_1' WHERE tld = ? AND label = ?`, [tld, label]);

  return { server, db, run, get, getJson, getHtml, goLive, moshpit };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

test("a contact is recorded even when there is no mail host to publish it", skip, async () => {
  const { moshpit } = await app();
  const result = await moshpit.setContact({
    tld: "eggs", label: "blue", userId: "u1", email: "Holder <me@example.com>",
  });

  assert.equal(result.ok, true);
  assert.equal(result.contact.email, "me@example.com");
  assert.equal(result.contact.visibility, "guard");
  // Not `failed`: an unconfigured mail host is a fact about the deployment, and
  // showing the holder an error for it would be blaming them for our setup.
  assert.equal(result.contact.alias_status, "pending");
  assert.equal(await moshpit.publicContactFor("eggs", "blue"), null);
});

test("once the alias is live the guard address is what the registry publishes", skip, async () => {
  const { moshpit, goLive } = await app();
  await goLive("eggs", "blue");

  const contact = await moshpit.publicContactFor("eggs", "blue");
  const row = await moshpit.getContactPrivate("eggs", "blue");
  assert.equal(contact.kind, "guard");
  assert.equal(contact.address, `${row.guard_token}@moshcode.sh`);
  assert.doesNotMatch(contact.address, /example\.com/);
});

test("correcting the address keeps the one already printed on other people's pages", skip, async () => {
  const { moshpit } = await app();
  const before = await moshpit.getContactPrivate("eggs", "blue");
  await moshpit.setContact({ tld: "eggs", label: "blue", userId: "u1", email: "corrected@example.com" });
  const after = await moshpit.getContactPrivate("eggs", "blue");

  assert.equal(after.guard_token, before.guard_token);
  assert.equal(after.email, "corrected@example.com");
});

test("taking a contact down keeps the token, so putting it back is the same address", skip, async () => {
  const { moshpit, goLive } = await app();
  const before = await moshpit.getContactPrivate("eggs", "blue");

  await moshpit.setContact({ tld: "eggs", label: "blue", userId: "u1", email: "corrected@example.com", visibility: "none" });
  assert.equal(await moshpit.publicContactFor("eggs", "blue"), null);

  await moshpit.setContact({ tld: "eggs", label: "blue", userId: "u1", email: "corrected@example.com", visibility: "guard" });
  await goLive("eggs", "blue");
  const after = await moshpit.publicContactFor("eggs", "blue");
  assert.equal(after.address, `${before.guard_token}@moshcode.sh`);
});

test("only the holder may set a contact on a name", skip, async () => {
  const { moshpit } = await app();
  const result = await moshpit.setContact({ tld: "eggs", label: "green", userId: "u2", email: "me@example.com" });
  assert.equal(result.ok, false);
  assert.match(result.error, /do not own/);
});

test("an ending gets its own contact, and it is not inherited by names under it", skip, async () => {
  const { moshpit, goLive } = await app();
  await moshpit.setContact({ tld: "eggs", userId: "u1", email: "operator@example.com" });
  await goLive("eggs", "");

  assert.ok(await moshpit.publicContactFor("eggs"));
  // `green.eggs` has no contact of its own. Falling back to the operator's
  // would send a buyer's mail — or an abuse report — to someone who does not
  // hold the name, while looking authoritative about it.
  assert.equal(await moshpit.publicContactFor("eggs", "green"), null);
});

test("giving the name up takes the contact with it", skip, async () => {
  const { moshpit, get } = await app();
  await moshpit.releaseName({ tld: "eggs", label: "blue", userId: "u1" });

  const row = await get(`SELECT tld FROM moshpit_contacts WHERE tld = 'eggs' AND label = 'blue'`);
  assert.ok(!row);
  // The next holder must not inherit a forwarding address pointing at the last.
  assert.equal(await moshpit.publicContactFor("eggs", "blue"), null);
});

test("the public contact route answers with an address or a definite 404", skip, async () => {
  const { getJson, moshpit, goLive } = await app();
  await moshpit.setContact({ tld: "eggs", label: "green", userId: "u1", email: "green@example.com" });
  await goLive("eggs", "green");

  const found = await getJson("/api/moshpit/contact?name=green.eggs");
  assert.equal(found.status, 200);
  assert.equal(found.body.contact.kind, "guard");
  assert.match(found.body.contact.address, /@moshcode\.sh$/);

  const missing = await getJson("/api/moshpit/contact?name=nobody.eggs");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.contact, null);

  const ending = await getJson("/api/moshpit/contact?name=.eggs");
  assert.equal(ending.status, 200);
  assert.equal(ending.body.label, null);
});

test("no route anywhere returns where a guard address forwards to", skip, async () => {
  const { getJson } = await app();
  for (const route of ["/api/moshpit/contact?name=green.eggs", "/api/moshpit/tlds?limit=50"]) {
    const { body } = await getJson(route);
    assert.doesNotMatch(JSON.stringify(body), /green@example\.com/, `${route} leaked the real address`);
  }
});

test("the endings list no longer hands out the account behind every ending", skip, async () => {
  const { getJson } = await app();
  const { status, body } = await getJson("/api/moshpit/tlds?limit=50");

  assert.equal(status, 200);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /owner_email/);
  assert.doesNotMatch(serialized, /holder@example\.com/);
  assert.doesNotMatch(serialized, /other@example\.com/);
  assert.doesNotMatch(serialized, /"user_id"/);
});

test("...but two endings held by one person are still visibly one person", skip, async () => {
  // The digest is what keeps "who holds how much of the namespace" answerable
  // after the email is gone. Losing that would make this a deletion rather
  // than a redaction.
  const { getJson, run } = await app();
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('yolks','u1','holder@example.com',1)`);
  const { body } = await getJson("/api/moshpit/tlds?limit=50");

  const byTld = new Map(body.tlds.map((t) => [t.tld, t.owner]));
  assert.ok(byTld.get("eggs"));
  assert.equal(byTld.get("eggs"), byTld.get("yolks"));
  assert.notEqual(byTld.get("eggs"), byTld.get("theirs"));
});

test("the list still says everything a mirror actually needs", skip, async () => {
  const { getJson } = await app();
  const { body } = await getJson("/api/moshpit/tlds?limit=50");
  const eggs = body.tlds.find((t) => t.tld === "eggs");

  assert.deepEqual(Object.keys(eggs).sort(), ["alias_of", "created_at", "owner", "price_usd", "tld"]);
  assert.equal(typeof body.total, "number");
});

/* ---- the pages ---- */

test("a name's page shows the guard address and not the address behind it", skip, async () => {
  const { getHtml } = await app();
  const { status, body } = await getHtml("/n/green.eggs");

  assert.equal(status, 200);
  assert.match(body, /Contact/);
  assert.match(body, /[0-9bcdfghjkmnpqrstvwxz]{10}@moshcode\.sh/);
  assert.match(body, /forwards to the holder/);
  assert.doesNotMatch(body, /green@example\.com/);
});

test("an ending's page shows the operator's contact, which is who a buyer needs", skip, async () => {
  const { getHtml } = await app();
  const { status, body } = await getHtml("/n/.eggs");

  assert.equal(status, 200);
  assert.match(body, /[0-9bcdfghjkmnpqrstvwxz]{10}@moshcode\.sh/);
  assert.doesNotMatch(body, /operator@example\.com/);
});

test("a name with no contact says nothing about one", skip, async () => {
  const { getHtml, moshpit, run } = await app();
  await run(`INSERT OR IGNORE INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('eggs','quiet','u1',NULL,1)`);
  assert.equal(await moshpit.publicContactFor("eggs", "quiet"), null);

  const { body } = await getHtml("/n/quiet.eggs");
  assert.doesNotMatch(body, /forwards to the holder/);
  assert.doesNotMatch(body, /holder@example\.com/);
});

test("the contact tab lists what you publish, and never where it goes", skip, async () => {
  const { getHtml } = await app();
  const { status, body } = await getHtml("/pit/contact", "u1");

  assert.equal(status, 200);
  assert.match(body, /without a WHOIS/);
  assert.match(body, /green\.eggs/);
  // The real address is withheld from the holder's own management page: it is
  // not needed to manage the contact, and a page that prints it is one
  // screenshot away from being the leak this change closes.
  assert.doesNotMatch(body, /green@example\.com/);
  assert.doesNotMatch(body, /operator@example\.com/);
});

test("the contact tab says plainly when no mail host can mint an address", skip, async () => {
  const { getHtml } = await app();
  const { body } = await getHtml("/pit/contact", "u1");
  assert.match(body, /No mail host is configured/);
});

test("signed out, the contact tab asks you to sign in rather than 500ing", skip, async () => {
  const { getHtml } = await app();
  const { status, body } = await getHtml("/pit/contact");
  assert.equal(status, 200);
  assert.match(body, /Sign in to say how you can be reached/);
});
