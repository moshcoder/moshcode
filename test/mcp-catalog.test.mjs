// `mcp add porkbun` should be enough — but the catalog must never be able to
// override a command the user actually typed, and it must never quietly bake an
// API key into five engines' config files.
import assert from "node:assert/strict";
import test from "node:test";

import { MCP_CATALOG, catalogList, catalogNames, resolveCatalog } from "../src/mcp-catalog.mjs";
import { parseMcp } from "../src/integrations.mjs";

test("porkbun resolves to the official npx invocation", () => {
  const e = resolveCatalog("porkbun");
  assert.equal(e.key, "porkbun");
  assert.equal(e.target, "npx");
  assert.deepEqual(e.args, ["-y", "@porkbunllc/mcp-server"]);
  assert.deepEqual(e.env, ["PORKBUN_API_KEY", "PORKBUN_SECRET_API_KEY"]);
});

test("catalog lookup is case-insensitive and ignores Object.prototype", () => {
  assert.equal(resolveCatalog("PORKBUN").key, "porkbun");
  assert.equal(resolveCatalog("  porkbun  ").key, "porkbun");
  // A plain object literal: these are truthy but are not servers, and would
  // otherwise be handed downstream with no target.
  assert.equal(resolveCatalog("constructor"), null);
  assert.equal(resolveCatalog("__proto__"), null);
  assert.equal(resolveCatalog("toString"), null);
  assert.equal(resolveCatalog(""), null);
  assert.equal(resolveCatalog(undefined), null);
});

test("resolveCatalog copies args so a caller cannot mutate the catalog", () => {
  const first = resolveCatalog("porkbun");
  first.args.push("--rogue");
  assert.deepEqual(resolveCatalog("porkbun").args, ["-y", "@porkbunllc/mcp-server"]);
  assert.deepEqual(MCP_CATALOG.porkbun.args, ["-y", "@porkbunllc/mcp-server"]);
});

test("`mcp add porkbun` expands to the full spec", () => {
  const { spec, catalog, error } = parseMcp(["add", "porkbun"]);
  assert.equal(error, undefined);
  assert.equal(spec.name, "porkbun");
  assert.equal(spec.target, "npx");
  assert.deepEqual(spec.args, ["-y", "@porkbunllc/mcp-server"]);
  assert.equal(catalog.key, "porkbun");
});

test("an explicit command always beats the catalog", () => {
  // Someone running a fork or a local build must get exactly what they typed.
  const { spec } = parseMcp(["add", "porkbun", "--", "node", "./my-fork.js"]);
  assert.equal(spec.name, "porkbun");
  assert.equal(spec.target, "node");
  assert.deepEqual(spec.args, ["./my-fork.js"]);
});

test("an unknown bare name still errors rather than guessing", () => {
  const { error } = parseMcp(["add", "not-a-known-server"]);
  assert.match(error, /missing server URL or command/);
});

test("catalog expansion does not disturb ordinary registrations", () => {
  const { spec, catalog } = parseMcp(["add", "sentry", "https://mcp.sentry.dev/mcp"]);
  assert.equal(spec.name, "sentry");
  assert.equal(spec.target, "https://mcp.sentry.dev/mcp");
  assert.equal(catalog, undefined, "a normal add is not a catalog hit");
});

test("credentials are never written into the spec", () => {
  // The env the server *needs* is documented on the catalog entry; the spec
  // that gets registered with each engine must stay empty of it.
  const { spec, catalog } = parseMcp(["add", "porkbun"]);
  assert.deepEqual(spec.env, [], "an API key must not be baked into engine config");
  assert.ok(catalog.env.includes("PORKBUN_API_KEY"));
});

test("`mcp catalog` is its own verb, and unknown verbs mention it", () => {
  assert.deepEqual(parseMcp(["catalog"]), { showCatalog: true });
  assert.match(parseMcp(["bogus"]).error, /install, add, catalog, or list/);
});

test("the catalog listing names every entry", () => {
  const listing = catalogList();
  for (const name of catalogNames()) assert.match(listing, new RegExp(name));
  assert.match(listing, /Porkbun/);
});

test("bufferoverride resolves to the remote HTTP server, with no args", () => {
  const e = resolveCatalog("bufferoverride");
  assert.equal(e.key, "bufferoverride");
  assert.equal(e.target, "https://bufferoverride.com/mcp");
  // A remote server takes no command arguments — every engine's builder pushes
  // the target alone — and parseMcp rejects a leftover one rather than dropping
  // it, so an entry that carried args would break `mcp add bufferoverride`.
  assert.deepEqual(e.args, []);
  // The credential is a bearer header, not a variable: nothing to name here.
  assert.equal(e.env, undefined);
});

test("`mcp add bufferoverride` expands to the remote spec", () => {
  const { spec, catalog, error } = parseMcp(["add", "bufferoverride"]);
  assert.equal(error, undefined);
  // Named as the CLI's own `bo mcp config` names it, so registering it either
  // way produces one server rather than two.
  assert.equal(spec.name, "bufferoverride");
  assert.equal(spec.target, "https://bufferoverride.com/mcp");
  assert.deepEqual(spec.args, []);
  assert.deepEqual(spec.headers, []);
  assert.equal(catalog.key, "bufferoverride");
});

test("the catalog listing keeps its column when a name overruns the old pad", () => {
  // `bufferoverride` is longer than the fixed pad this used to carry, which
  // left a single space before its description while porkbun kept a column.
  const rows = catalogList().split("\n");
  assert.ok(rows.length >= 2, "this only says anything with more than one entry");
  const columns = Object.values(MCP_CATALOG).map((e) => {
    const row = rows.find((line) => line.includes(e.desc));
    assert.ok(row, `no row for ${e.desc}`);
    return row.indexOf(e.desc);
  });
  assert.equal(new Set(columns).size, 1, `descriptions must line up:\n${catalogList()}`);
});
