// Reading contact details the way they arrive, and never guessing which client.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { clientCommand, getPath, parseCommaForm, parseFields, parsePayee, resolveClient, setPath } from "../src/clients.mjs";
import { loadBusiness } from "../src/business-store.mjs";

/**
 * Point $HOME at a fresh directory for one test.
 *
 * The store derives its path per call for exactly this reason — the suite must
 * never read or write the client list of whoever is running it.
 */
function sandbox(t) {
  const previous = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "moshcode-business-"));
  t.after(() => { process.env.HOME = previous; });
  const lines = [];
  return { lines, write: (l) => lines.push(String(l)) };
}

test("the comma form sorts fields by what they look like", () => {
  const parsed = parseCommaForm('"Acme Inc", https://acme.com, +1-555-0100');
  assert.equal(parsed.name, "Acme Inc");
  assert.equal(parsed.url, "https://acme.com");
  assert.equal(parsed.phone, "+1-555-0100");
});

test("a bare domain becomes a URL, and an email is not mistaken for one", () => {
  const parsed = parseCommaForm("Globex, globex.com, jane@globex.com");
  assert.equal(parsed.url, "https://globex.com");
  assert.equal(parsed.email, "jane@globex.com");
});

test("a segment nothing claims is kept as a note, not dropped", () => {
  const parsed = parseCommaForm("Initech, net 30, https://initech.com");
  assert.equal(parsed.url, "https://initech.com");
  assert.equal(parsed.notes, "net 30");
});

test("dotted flags nest, and a bare flag is true", () => {
  const { fields, rest } = parseFields(["acme", "--contact.telephone", "+1-555-0100", "--url=https://acme.com", "--vip"]);
  assert.deepEqual(rest, ["acme"]);
  assert.equal(fields.contact.telephone, "+1-555-0100");
  assert.equal(fields.url, "https://acme.com");
  assert.equal(fields.vip, true);
});

test("a dotted path cannot reach the prototype", () => {
  const target = {};
  setPath(target, "__proto__.polluted", "yes");
  assert.equal({}.polluted, undefined, "a command line must not touch Object.prototype");
  setPath(target, "contact.deep.telephone", "+1");
  assert.equal(getPath(target, "contact.deep.telephone"), "+1");
});

test("a payee carries its chain, however it was written", () => {
  assert.deepEqual(parsePayee("solana:9xQe"), { chain: "solana", address: "9xQe" });
  assert.deepEqual(parsePayee("9xQe", "Solana"), { chain: "solana", address: "9xQe" });
  // An address with no chain is recorded, and flagged — not silently accepted
  // as if the chain were known.
  assert.equal(parsePayee("9xQe").chain, "unknown");
  assert.equal(parsePayee(""), null);
});

test("create writes a record, and refuses to write it twice", (t) => {
  const io = sandbox(t);
  assert.equal(clientCommand(["create", "Acme Inc,", "https://acme.com"], io), 0);
  const { clients } = loadBusiness();
  assert.ok(clients["acme-inc"], "filed under a handle derived from the name");
  assert.equal(clients["acme-inc"].url, "https://acme.com");
  assert.equal(clientCommand(["create", "Acme Inc"], io), 1, "a second create is an error, not an overwrite");
  assert.match(io.lines.join("\n"), /already exists/);
});

test("a new client is told it has nowhere to settle yet", (t) => {
  const io = sandbox(t);
  clientCommand(["create", "Acme"], io);
  assert.match(io.lines.join("\n"), /no payee yet/);
  clientCommand(["payee", "acme", "solana:9xQe"], io);
  assert.deepEqual(loadBusiness().clients.acme.payee, { chain: "solana", address: "9xQe" });
});

test("resolve finds a client by handle, name or prefix — and never picks between two", (t) => {
  const io = sandbox(t);
  clientCommand(["create", "Acme Inc"], io);
  clientCommand(["create", "Acme Labs"], io);
  clientCommand(["create", "Globex"], io);
  const business = loadBusiness();
  assert.equal(resolveClient(business, "globex").id, "globex");
  assert.equal(resolveClient(business, "Globex").id, "globex");
  assert.equal(resolveClient(business, "acme-inc").id, "acme-inc");
  const ambiguous = resolveClient(business, "acme");
  assert.equal(ambiguous.ok, false, "two matches is not an answer");
  assert.equal(ambiguous.reason, "ambiguous");
  assert.deepEqual(ambiguous.matches.sort(), ["acme-inc", "acme-labs"]);
});

test("set changes one field and leaves the rest, and an empty value clears", (t) => {
  const io = sandbox(t);
  clientCommand(["create", "Acme, https://acme.com, +1-555-0100"], io);
  clientCommand(["set", "acme", "--contact.name", "Jane"], io);
  let record = loadBusiness().clients.acme;
  assert.equal(record.contact.name, "Jane");
  assert.equal(record.phone, "+1-555-0100", "an unrelated field survived");
  clientCommand(["set", "acme", "--phone="], io);
  record = loadBusiness().clients.acme;
  assert.equal(record.phone, undefined, "an empty value clears rather than blanking");
});

test("rm forgets the client and its rate, and says the time is kept", (t) => {
  const io = sandbox(t);
  clientCommand(["create", "Acme"], io);
  assert.equal(clientCommand(["rm", "acme"], io), 0);
  assert.equal(loadBusiness().clients.acme, undefined);
  assert.match(io.lines.join("\n"), /tracked time is kept/);
});
