// Who the work is for.
//
// A client is the noun the rest of the business layer hangs off: a timer is
// started *for* one, a rate belongs *to* one, an invoice is addressed *to* one,
// and a team is granted access *on behalf of* one. Everything else here is
// derived from that, which is why this file is mostly a record and a resolver
// rather than a feature.
//
// `/business` and `/merchant` are the same verb. They are not synonyms in
// general English, but they are the same thing in every conversation this is
// for — the party on the other end of an invoice — and the word somebody
// reaches for depends on which product taught it to them. Three doors, one room.
//
// Contact details are written the way they arrive:
//
//   /client create "Acme Inc", https://acme.com, +1-555-0100
//   /client create acme --contact.telephone +1-555-0100 --contact.name "Jane"
//
// The comma form is what a person pastes out of an email signature; the dotted
// form is what a script wants. Neither is a schema — `--contact.telephone` sets
// `contact.telephone` because that is what it says, and any other dotted flag
// does the same, so the record grows the fields a business actually keeps
// without this file having to guess them in advance.
import { loadBusiness, newId, slugify, updateBusiness } from "./business-store.mjs";
import { acid, ash, bone, err, info, ok, table, warn } from "./ui.mjs";

/** Fields the comma form recognises by shape, in the order it tries them. */
const LOOKS_LIKE = [
  ["url", (v) => /^https?:\/\//i.test(v) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v)],
  ["email", (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)],
  ["phone", (v) => /^[+(]?[\d][\d\s().+-]{5,}$/.test(v)],
];

/** Set `a.b.c` on an object, creating the objects in between. */
export function setPath(obj, dotted, value) {
  const parts = String(dotted).split(".").filter(Boolean);
  if (!parts.length) return obj;
  // Own properties only, and never a prototype key: these paths come straight
  // off a command line, and `--__proto__.x` must set a field called
  // `__proto__`, not reach the prototype of every object in the process.
  let node = obj;
  for (const part of parts.slice(0, -1)) {
    if (part === "__proto__" || part === "constructor" || part === "prototype") return obj;
    if (!node[part] || typeof node[part] !== "object" || Array.isArray(node[part])) node[part] = {};
    node = node[part];
  }
  const leaf = parts[parts.length - 1];
  if (leaf === "__proto__" || leaf === "constructor" || leaf === "prototype") return obj;
  node[leaf] = value;
  return obj;
}

/** Read `a.b.c` back out, or undefined. */
export function getPath(obj, dotted) {
  return String(dotted).split(".").filter(Boolean)
    .reduce((node, part) => (node == null ? undefined : node[part]), obj);
}

/**
 * Split an argv into `{ fields, rest }`.
 *
 * `--k v` and `--k=v` both set `k`; a `--k` with nothing after it is a flag and
 * lands as `true`. Dotted names nest. Anything that is not a flag stays in
 * `rest`, in order, for the caller to read positionally.
 */
export function parseFields(argv = []) {
  const fields = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (!arg.startsWith("--")) { rest.push(arg); continue; }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) { setPath(fields, body.slice(0, eq), body.slice(eq + 1)); continue; }
    const next = argv[i + 1];
    if (next === undefined || String(next).startsWith("--")) { setPath(fields, body, true); continue; }
    setPath(fields, body, String(next));
    i += 1;
  }
  return { fields, rest };
}

/**
 * Read the comma form: `"Acme Inc", https://acme.com, +1-555-0100`.
 *
 * The first segment is always the name — it is the only field with no shape to
 * recognise it by — and the rest are sorted by what they look like. A segment
 * nothing claims becomes a note rather than being dropped, because the thing
 * somebody pasted was in the signature for a reason.
 */
export function parseCommaForm(text) {
  const segments = String(text ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  const out = { notes: [] };
  for (const segment of segments) {
    if (!out.name) { out.name = segment; continue; }
    const match = LOOKS_LIKE.find(([field, test]) => !out[field] && test(segment));
    if (match) { out[match[0]] = segment; continue; }
    out.notes.push(segment);
  }
  out.notes = out.notes.join("; ");
  if (!out.notes) delete out.notes;
  if (out.url && !/^https?:\/\//i.test(out.url)) out.url = `https://${out.url}`;
  return out;
}

/** `solana:ADDR`, or an address with `--chain` alongside, or null. */
export function parsePayee(value, chain) {
  if (!value || value === true) return null;
  const text = String(value).trim();
  const split = text.indexOf(":");
  if (split > 0 && split < 12) {
    return { chain: text.slice(0, split).toLowerCase(), address: text.slice(split + 1) };
  }
  return { chain: String(chain || "").toLowerCase() || "unknown", address: text };
}

/**
 * Find a client by id, name, or unambiguous prefix.
 *
 * Returns `{ ok, id, client }` or `{ ok: false, reason, matches }` — never
 * throws and never guesses between two candidates, because the callers are
 * `/timer on` and `/billing`, and picking the wrong client silently is how
 * hours end up on the wrong invoice.
 */
export function resolveClient(business, token) {
  const clients = business?.clients || {};
  const want = String(token ?? "").trim().toLowerCase();
  if (!want) return { ok: false, reason: "no client named" };
  if (Object.hasOwn(clients, want)) return { ok: true, id: want, client: clients[want] };
  const slug = slugify(want);
  if (Object.hasOwn(clients, slug)) return { ok: true, id: slug, client: clients[slug] };
  const matches = Object.entries(clients).filter(([id, c]) =>
    id.startsWith(slug) || String(c.name || "").toLowerCase().includes(want));
  if (matches.length === 1) return { ok: true, id: matches[0][0], client: matches[0][1] };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", matches: matches.map(([id]) => id) };
  return { ok: false, reason: "unknown", matches: [] };
}

/** The one-line "who is this" a report puts next to an id. */
export function clientLabel(id, client) {
  const name = client?.name && slugify(client.name) !== id ? ` ${ash(`(${client.name})`)}` : "";
  return `${bone(id)}${name}`;
}

const USAGE = [
  "usage: /client create <name>[, url][, phone|email] [--field value…]",
  "       /client list [--json] · /client show <id> · /client set <id> --field value",
  "       /client rm <id> · /client payee <id> <chain:address>   where their payments land",
  "  aliases: /business /merchant /customer — same command",
];

export function clientCommand(argv = [], { write = console.log } = {}) {
  const verb = String(argv[0] ?? "list").toLowerCase();
  const args = argv.slice(1);

  if (["create", "add", "new"].includes(verb)) return createClient(args, write);
  if (["list", "ls"].includes(verb)) return listClients(argv.includes("--json"), write);
  if (["show", "get", "info"].includes(verb)) return showClient(args, write);
  if (["set", "edit", "update"].includes(verb)) return setClient(args, write);
  if (["rm", "remove", "delete"].includes(verb)) return removeClient(args, write);
  if (verb === "payee") return setPayee(args, write);

  // `/client acme` is "show me acme", which is what the word means when it is
  // followed by something that is already a client.
  const business = loadBusiness();
  const found = resolveClient(business, verb);
  if (found.ok) return showClient([verb], write);
  if (verb === "list" || !argv.length) return listClients(false, write);

  write(err(`unknown /client verb ${JSON.stringify(verb)}`));
  USAGE.forEach(write);
  return 1;
}

function createClient(args, write) {
  const { fields, rest } = parseFields(args);
  const commas = parseCommaForm(rest.join(" "));
  const name = fields.name || commas.name;
  if (!name) { write(err("a client needs a name")); USAGE.forEach(write); return 1; }

  const id = String(fields.id || slugify(name));
  if (!id) { write(err(`can't make a handle out of ${JSON.stringify(name)} — pass --id`)); return 1; }

  const business = loadBusiness();
  if (business.clients[id]) {
    write(err(`${bone(id)} already exists — ${acid(`/client set ${id} --field value`)} to change it`));
    return 1;
  }

  const now = new Date().toISOString();
  const record = {
    id,
    name,
    ...commas,
    ...fields,
    payee: parsePayee(fields.payee, fields.chain),
    createdAt: now,
    updatedAt: now,
  };
  delete record.chain;
  if (!record.payee) delete record.payee;

  updateBusiness((data) => { data.clients[id] = record; });
  write(ok(`${bone(id)} — ${record.name}`));
  for (const line of describeClient(record)) write(`  ${line}`);
  if (!record.payee) {
    // The payee is where *their* money lands — our receiving address for this
    // relationship, not theirs. CoinPay refuses to settle to an undecided
    // address, and finding that out at invoice time is finding it out too late.
    write(`  ${ash("no payee yet —")} ${acid(`/client payee ${id} solana:<address>`)} ${ash("says where their payments land")}`);
  }
  return 0;
}

function describeClient(client) {
  const lines = [];
  const pairs = [["url", client.url], ["email", client.email], ["phone", client.phone]];
  for (const [key, value] of pairs) if (value) lines.push(`${ash(key.padEnd(8))} ${value}`);
  for (const [key, value] of Object.entries(client.contact || {})) {
    lines.push(`${ash(`contact.${key}`.padEnd(8))} ${value}`);
  }
  if (client.payee) lines.push(`${ash("payee".padEnd(8))} ${acid(`${client.payee.chain}:${client.payee.address}`)}`);
  if (client.notes) lines.push(`${ash("notes".padEnd(8))} ${client.notes}`);
  return lines;
}

function listClients(json, write) {
  const { clients } = loadBusiness();
  const ids = Object.keys(clients).sort();
  if (json) { write(JSON.stringify(clients, null, 2)); return 0; }
  if (!ids.length) {
    write(info("no clients yet."));
    write(`  ${acid('/client create "Acme Inc", https://acme.com, +1-555-0100')}`);
    return 0;
  }
  write(table(
    ids.map((id) => [
      bone(id),
      clients[id].name || "",
      ash(clients[id].url || clients[id].email || clients[id].phone || ""),
      clients[id].payee ? acid("payee ✓") : ash("no payee"),
    ]),
    { columns: ["id", "name", "reach", "settle"], indent: 2 },
  ));
  return 0;
}

function showClient(args, write) {
  const business = loadBusiness();
  const found = resolveClient(business, args[0]);
  if (!found.ok) return reportMiss(found, args[0], write);
  if (args.includes("--json")) { write(JSON.stringify(found.client, null, 2)); return 0; }
  write(`  ${clientLabel(found.id, found.client)}`);
  for (const line of describeClient(found.client)) write(`  ${line}`);
  return 0;
}

function setClient(args, write) {
  const { fields, rest } = parseFields(args);
  const business = loadBusiness();
  const found = resolveClient(business, rest[0]);
  if (!found.ok) return reportMiss(found, rest[0], write);
  if (!Object.keys(fields).length) { write(err("nothing to set — /client set <id> --url https://…")); return 1; }
  const updated = updateBusiness((data) => {
    const record = data.clients[found.id];
    for (const [key, value] of Object.entries(fields)) {
      if (key === "payee") { record.payee = parsePayee(value, fields.chain); continue; }
      if (key === "chain") continue;
      if (value && typeof value === "object") {
        for (const [sub, subValue] of Object.entries(value)) setPath(record, `${key}.${sub}`, subValue);
        continue;
      }
      // `--url ""` is how you clear a field; setting it to an empty string
      // would leave a blank line in every report that prints it.
      if (value === "") delete record[key];
      else record[key] = value;
    }
    record.updatedAt = new Date().toISOString();
    return record;
  });
  write(ok(`updated ${clientLabel(found.id, updated)}`));
  for (const line of describeClient(updated)) write(`  ${line}`);
  return 0;
}

function setPayee(args, write) {
  const { fields, rest } = parseFields(args);
  const business = loadBusiness();
  const found = resolveClient(business, rest[0]);
  if (!found.ok) return reportMiss(found, rest[0], write);
  const payee = parsePayee(rest[1] || fields.payee, fields.chain);
  if (!payee) { write(err("usage: /client payee <id> <chain:address>")); return 1; }
  updateBusiness((data) => {
    data.clients[found.id].payee = payee;
    data.clients[found.id].updatedAt = new Date().toISOString();
  });
  write(ok(`${bone(found.id)} settles to ${acid(`${payee.chain}:${payee.address}`)}`));
  if (payee.chain === "unknown") write(warn("no chain given — say which one, e.g. solana:<address>"));
  return 0;
}

function removeClient(args, write) {
  const business = loadBusiness();
  const found = resolveClient(business, args[0]);
  if (!found.ok) return reportMiss(found, args[0], write);
  updateBusiness((data) => {
    delete data.clients[found.id];
    // The rate was a fact about a relationship that no longer exists; tracked
    // time is not, so it stays in the ledger with the id it was booked against.
    delete data.rates[found.id];
  });
  write(ok(`dropped ${bone(found.id)} ${ash("(tracked time is kept — /timer log to see it)")}`));
  return 0;
}

function reportMiss(found, token, write) {
  if (found.reason === "ambiguous") {
    write(err(`${JSON.stringify(token)} matches ${found.matches.join(", ")} — say which`));
    return 1;
  }
  write(err(`no client ${JSON.stringify(token ?? "")} — ${acid("/client list")} to see them`));
  return 1;
}

export { USAGE as CLIENT_USAGE };
