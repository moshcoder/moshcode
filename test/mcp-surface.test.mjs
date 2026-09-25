// The verbs beyond `install`/`add`: remove, enable, disable, test, reauth,
// unauth, reconnect, resources, prompts, notifications, catalog search.
//
// Two standards carry over from test/mcp-add-fanout.test.mjs and are asserted
// here for every new fan-out verb rather than only for `add`: the plan must
// cover EVERY engine, and an engine that cannot do the thing must say why. A
// verb that quietly drops four engines looks like it worked everywhere.
//
// The probe verbs are the other half. They delegate to mcpjam rather than
// speaking MCP, so what is testable is the argv they build and the message they
// print when mcpjam is not installed — both without a network or a subprocess.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ENGINES } from "../src/engines.mjs";
import {
  MCP_ENGINES, MCP_SCOPES, mcpAddArgs, mcpAuthArgs, mcpReconnectArgs, mcpRemoveArgs,
  mcpUnauthArgs, notRegistered, planMcpVerb, resolveMcpEngines, runMcpVerb,
} from "../src/mcp.mjs";
import { catalogSearchArgs, mcpjamArgs, mcpjamTargetArgs, missingProbeTool } from "../src/mcp-probe.mjs";
import {
  forgetServer, getServer, listServers, recordServer, redactSpec, registryFile, setServerEnabled,
} from "../src/mcp-registry.mjs";
import {
  parseMcp, resolveServerSpec, runAddWizard, runManage, runProbe,
} from "../src/integrations.mjs";

const byKey = (items) => Object.fromEntries(items.map((i) => [i.key, i]));
const NO_MCP = Object.keys(ENGINES).filter((key) => !MCP_ENGINES.includes(key));

/** Point the registry at a throwaway file. The real one belongs to the operator. */
function isolateRegistry() {
  process.env.MOSHCODE_MCP_FILE = path.join(mkdtempSync(path.join(tmpdir(), "moshcode-mcp-reg-")), "mcp.json");
}
isolateRegistry();

/* ------------------------------------------------- scope: the two axes */

test("--engine-scope reaches the engines that have a scope flag", () => {
  const spec = { name: "s", target: "https://x.dev/mcp", env: [], headers: [], scope: "project" };
  for (const key of ["claude", "gemini", "qwen"]) {
    assert.deepEqual(mcpAddArgs(key, spec).argv.slice(0, 4), ["mcp", "add", "-s", "project"]);
  }
});

test("an engine with one config location is skipped for project scope, with a reason", () => {
  const spec = { name: "s", target: "https://x.dev/mcp", env: [], headers: [], scope: "project" };
  for (const key of ["codex", "opencode", "privacycode"]) {
    const { skip, argv } = mcpAddArgs(key, spec);
    assert.equal(argv, undefined, `${key} must not be handed a scope it cannot express`);
    assert.match(skip, /scope/i, `${key} should say why`);
  }
});

test("user scope is still the default, byte for byte", () => {
  const spec = { name: "s", target: "https://x.dev/mcp", env: [], headers: [] };
  assert.deepEqual(mcpAddArgs("claude", spec).argv.slice(0, 4), ["mcp", "add", "-s", "user"]);
  assert.deepEqual(mcpAddArgs("codex", spec).argv, ["mcp", "add", "s", "--url", "https://x.dev/mcp"]);
});

test("--engines narrows the fan-out to exactly what was asked for", () => {
  const spec = { name: "s", target: "https://x.dev/mcp", env: [], headers: [] };
  const keys = planMcpVerb("add", spec, { installedSet: new Set(), engines: ["claude", "codex"] })
    .map((p) => p.key);
  assert.deepEqual(keys, ["claude", "codex"]);
});

test("resolveMcpEngines rejects a name that is not an engine", () => {
  assert.deepEqual(resolveMcpEngines("claude,codex").engines, ["claude", "codex"]);
  assert.equal(resolveMcpEngines(null).engines, null);
  assert.match(resolveMcpEngines("clawed").error, /unknown engine "clawed"/);
  assert.match(resolveMcpEngines(",,").error, /at least one engine/);
  // A plain object literal: these are truthy keys and are not engines.
  assert.match(resolveMcpEngines("constructor").error, /unknown engine/);
});

/* ------------------------------ every new verb covers every engine (R6) */

for (const [verb, build] of [
  ["remove", mcpRemoveArgs],
  ["reauth", mcpAuthArgs],
  ["unauth", mcpUnauthArgs],
  ["reconnect", mcpReconnectArgs],
]) {
  test(`${verb} plans every engine, never a subset`, () => {
    const keys = planMcpVerb(verb, { name: "s" }, { installedSet: new Set() }).map((p) => p.key);
    assert.deepEqual([...keys].sort(), Object.keys(ENGINES).sort());
  });

  test(`every engine ${verb} cannot do carries a stated reason`, () => {
    for (const key of Object.keys(ENGINES)) {
      const { argv, skip } = build(key, { name: "s" });
      assert.ok(argv || skip, `${key} returned neither an argv nor a reason for ${verb}`);
      if (!argv) assert.ok(skip.length > 4, `${key}'s ${verb} reason is not a sentence`);
      else assert.equal(skip, undefined, "a planned engine must not also carry a skip");
    }
  });

  test(`${verb} skips every engine with no MCP support at all`, () => {
    for (const key of NO_MCP) assert.ok(build(key, { name: "s" }).skip, `${key} should be skipped`);
  });
}

test("remove speaks each engine's own dialect", () => {
  assert.deepEqual(mcpRemoveArgs("claude", { name: "s" }).argv, ["mcp", "remove", "s"]);
  assert.deepEqual(mcpRemoveArgs("claude", { name: "s", scope: "project" }).argv, ["mcp", "remove", "-s", "project", "s"]);
  assert.deepEqual(mcpRemoveArgs("qwen", { name: "s" }).argv, ["mcp", "remove", "s"]);
  assert.deepEqual(mcpRemoveArgs("codex", { name: "s" }).argv, ["mcp", "remove", "s"]);
  // OpenCode's `mcp` has add, list, auth, logout and debug, and nothing that
  // deletes — so the reason names the file rather than shrugging.
  assert.match(mcpRemoveArgs("opencode", { name: "s" }).skip, /no `mcp remove`/);
});

test("reauth and unauth use each engine's own word for it", () => {
  assert.deepEqual(mcpAuthArgs("claude", { name: "s" }).argv, ["mcp", "login", "s"]);
  assert.deepEqual(mcpAuthArgs("codex", { name: "s" }).argv, ["mcp", "login", "s"]);
  assert.deepEqual(mcpAuthArgs("opencode", { name: "s" }).argv, ["mcp", "auth", "s"]);
  assert.deepEqual(mcpUnauthArgs("opencode", { name: "s" }).argv, ["mcp", "logout", "s"]);
  // The Gemini family authorizes from inside the session, so the skip has to
  // tell the reader where to go rather than only that it did not happen.
  assert.match(mcpAuthArgs("gemini", { name: "s" }).skip, /\/mcp auth s/);
});

test("reconnect is the Gemini family only, and --all is its own argv", () => {
  assert.deepEqual(mcpReconnectArgs("qwen", { name: "s" }).argv, ["mcp", "reconnect", "s"]);
  assert.deepEqual(mcpReconnectArgs("gemini", { all: true }).argv, ["mcp", "reconnect", "--all"]);
  for (const key of ["claude", "codex", "opencode"]) {
    assert.ok(mcpReconnectArgs(key, { name: "s" }).skip, `${key} has no mcp reconnect`);
  }
});

test("omp is skipped for a stated reason, not the blanket no-MCP-support line", () => {
  // omp supports MCP better than most engines here. What it has no scriptable
  // command for is the part moshcode drives, and the row must say that rather
  // than send somebody looking for an engine they already have.
  for (const build of [mcpAddArgs, mcpRemoveArgs, mcpAuthArgs, mcpUnauthArgs, mcpReconnectArgs]) {
    const { skip } = build("omp", { name: "s", target: "https://x.dev/mcp", env: [], headers: [] });
    assert.ok(skip, "omp cannot be planned");
    assert.notEqual(skip, "no MCP support");
    assert.match(skip, /omp|TUI/);
  }
});

/* ------------------------------------------------------- the fan-out runner */

test("a remove that finds nothing is grey, not a failure", async () => {
  const plan = planMcpVerb("remove", { name: "s" }, { installedSet: new Set(["claude", "codex"]) });
  const results = byKey(await runMcpVerb(plan, {
    done: "removed",
    missing: true,
    run: async (bin) => (bin === "claude"
      ? { ok: true, code: 0 }
      : { ok: false, code: 1, output: "No such server: s" }),
  }));
  assert.equal(results.claude.status, "removed");
  assert.equal(results.codex.status, "missing");
});

test("a genuine failure is still a failure", async () => {
  const plan = planMcpVerb("remove", { name: "s" }, { installedSet: new Set(["claude"]) });
  const results = byKey(await runMcpVerb(plan, {
    done: "removed", missing: true, run: async () => ({ ok: false, code: 1, output: "permission denied" }),
  }));
  assert.equal(results.claude.status, "failed");
});

test("notRegistered reads the engine's own words, and nothing else", () => {
  assert.equal(notRegistered({ output: "Error: no such server \"x\"" }), true);
  assert.equal(notRegistered({ output: "x is not configured" }), true);
  assert.equal(notRegistered({ output: "EACCES: permission denied" }), false);
  assert.equal(notRegistered({}), false);
});

test("reauth inherits the terminal rather than capturing it", async () => {
  // Captured stdio swallows an OAuth prompt, and the flow's whole job is to
  // talk to the person sitting there.
  const seen = [];
  const plan = planMcpVerb("reauth", { name: "s" }, { installedSet: new Set(["claude"]) });
  await runMcpVerb(plan, {
    done: "authorized", capture: false,
    run: async (bin, argv, opts) => { seen.push(opts); return { ok: true, code: 0 }; },
  });
  assert.deepEqual(seen, [{ capture: false }]);
});

test("planMcpVerb refuses a verb it has no builder for", () => {
  assert.throws(() => planMcpVerb("nonsense", { name: "s" }), /no MCP fan-out builder/);
});

/* --------------------------------------------------------------- parsing */

test("--scope is refused on the spec verbs and on the name verbs alike", () => {
  for (const tokens of [["add", "--scope", "project", "https://x.dev/mcp"], ["remove", "s", "--scope", "project"]]) {
    const { error } = parseMcp(tokens);
    assert.match(error, /OAuth permissions/);
    assert.match(error, /--engine-scope/);
  }
});

test("--engine-scope only takes the scopes every engine could mean", () => {
  assert.equal(parseMcp(["add", "s", "https://x.dev/mcp", "--engine-scope", "project"]).engineScope, "project");
  assert.match(parseMcp(["add", "s", "https://x.dev/mcp", "--engine-scope", "local"]).error, /must be user or project/);
  assert.deepEqual(MCP_SCOPES, ["user", "project"]);
});

test("--engines rides beside the spec rather than inside it", () => {
  const parsed = parseMcp(["add", "s", "https://x.dev/mcp", "--engines", "claude,codex"]);
  assert.deepEqual(parsed.engines, ["claude", "codex"]);
  // The spec is what gets spliced into every engine's argv and recorded; a
  // fan-out policy field in there would be registered along with the server.
  assert.deepEqual(Object.keys(parsed.spec).sort(), ["args", "env", "headers", "name", "target", "transport"]);
});

test("--url is the explicit spelling of a remote target", () => {
  const { spec } = parseMcp(["add", "sentry", "--url", "https://mcp.sentry.dev/mcp"]);
  assert.equal(spec.target, "https://mcp.sentry.dev/mcp");
  assert.deepEqual(spec.args, []);
});

test("--url and a `--` command together are refused, not silently resolved", () => {
  const { error } = parseMcp(["add", "s", "--url", "https://x.dev/mcp", "--", "npx", "srv"]);
  assert.match(error, /pick one/);
});

test("a transport nobody implements is rejected at the door", () => {
  assert.match(parseMcp(["add", "s", "https://x.dev/mcp", "-t", "carrier-pigeon"]).error, /http, sse, or stdio/);
});

test("--token env:VAR never puts the literal on the command line", () => {
  process.env.MOSHCODE_TEST_MCP_TOKEN = "sekret";
  const parsed = parseMcp(["add", "s", "https://x.dev/mcp", "--token", "env:MOSHCODE_TEST_MCP_TOKEN"]);
  assert.deepEqual(parsed.spec.headers, ["Authorization: Bearer sekret"]);
  assert.deepEqual(parsed.auth, { header: "Authorization", from: "env:MOSHCODE_TEST_MCP_TOKEN" });
  delete process.env.MOSHCODE_TEST_MCP_TOKEN;
});

test("--token env:VAR fails loudly when the variable is empty", () => {
  const { error } = parseMcp(["add", "s", "https://x.dev/mcp", "--token", "env:MOSHCODE_TEST_MISSING"]);
  assert.match(error, /MOSHCODE_TEST_MISSING is not set/);
});

test("a literal --token still works, and is marked as the form it is", () => {
  const parsed = parseMcp(["add", "s", "https://x.dev/mcp", "--token", "abc123"]);
  assert.deepEqual(parsed.spec.headers, ["Authorization: Bearer abc123"]);
  assert.equal(parsed.auth.from, "inline");
});

test("the probe verbs take one server and reject a second", () => {
  assert.deepEqual(parseMcp(["test", "sentry"]).probe.name, "sentry");
  assert.match(parseMcp(["test"]).error, /needs a server name or URL/);
  assert.match(parseMcp(["test", "a", "b"]).error, /takes one server/);
});

test("--for without --listen is an error rather than a silent wait", () => {
  assert.match(parseMcp(["notifications", "s", "--for", "5000"]).error, /only applies with --listen/);
  const { probe } = parseMcp(["notifications", "s", "--listen", "--for", "5000"]);
  assert.equal(probe.durationMs, 5000);
});

test("reconnect --all is the one name-less manage verb", () => {
  assert.equal(parseMcp(["reconnect", "--all"]).manage.all, true);
  assert.match(parseMcp(["remove", "--all"]).error, /only applies to mcp reconnect/);
  assert.match(parseMcp(["remove"]).error, /needs a server name/);
});

test("catalog search bounds its own limit", () => {
  assert.equal(parseMcp(["catalog", "search", "postgres"]).catalogSearch.query, "postgres");
  assert.equal(parseMcp(["catalog", "search", "postgres", "--limit", "5"]).catalogSearch.limit, 5);
  assert.match(parseMcp(["catalog", "search", "x", "--limit", "0"]).error, /1 to 100/);
  assert.match(parseMcp(["catalog", "search", "x", "--limit", "101"]).error, /1 to 100/);
  assert.match(parseMcp(["catalog", "search"]).error, /needs a keyword/);
  assert.match(parseMcp(["catalog", "nonsense"]).error, /try search/);
});

test("`mcp add` with nothing after it asks for the wizard, not for a name", () => {
  assert.deepEqual(parseMcp(["add"]), { wizard: true });
});

test("`mcp list --servers` narrows without changing the old shape", () => {
  assert.deepEqual(parseMcp(["list"]), { list: true, json: false });
  assert.deepEqual(parseMcp(["list", "--json"]), { list: true, json: true });
  assert.deepEqual(parseMcp(["list", "--servers"]), { list: true, json: false, servers: true });
});

/* ---------------------------------------------------------- the mcpjam argv */

test("a remote spec becomes mcpjam's http flags", () => {
  const argv = mcpjamTargetArgs({ target: "https://x.dev/mcp", headers: ["Authorization: Bearer z"], env: [] });
  assert.deepEqual(argv, ["--transport", "http", "--url", "https://x.dev/mcp", "--header", "Authorization: Bearer z"]);
});

test("a stdio spec becomes mcpjam's command flags", () => {
  const argv = mcpjamTargetArgs({ target: "npx", args: ["-y", "srv"], env: [["K", "v"]] });
  assert.deepEqual(argv, ["--transport", "stdio", "--command", "npx", "--args", "-y", "srv", "-e", "K=v"]);
});

test("each probe verb maps to the mcpjam subcommand that answers it", () => {
  const spec = { target: "https://x.dev/mcp", headers: [], env: [] };
  assert.deepEqual(mcpjamArgs("test", spec).slice(0, 2), ["server", "info"]);
  assert.deepEqual(mcpjamArgs("resources", spec).slice(0, 2), ["resources", "list"]);
  assert.deepEqual(mcpjamArgs("prompts", spec).slice(0, 2), ["prompts", "list"]);
  // The default reads what the server declares and returns; --listen streams.
  assert.deepEqual(mcpjamArgs("notifications", spec).slice(0, 2), ["server", "capabilities"]);
  assert.deepEqual(mcpjamArgs("notifications", spec, { listen: true }).slice(0, 3),
    ["subscriptions", "listen", "--list-changed"]);
  assert.ok(mcpjamArgs("notifications", spec, { listen: true, durationMs: 50 }).includes("--duration-ms"));
});

test("--format json is a program-level flag and leads the argv", () => {
  const argv = mcpjamArgs("test", { target: "https://x.dev/mcp", headers: [], env: [] }, { json: true });
  assert.deepEqual(argv.slice(0, 2), ["--format", "json"]);
});

test("catalog search builds a registry search, with no moshcode-side API key", () => {
  const argv = catalogSearchArgs("postgres", { limit: 5 });
  assert.deepEqual(argv, ["registry", "search", "postgres", "--limit", "5"]);
  assert.ok(!argv.includes("--api-key"), "the key is mcpjam's to hold, not moshcode's to copy");
});

test("mcpjamArgs refuses a verb it has no probe for", () => {
  assert.throws(() => mcpjamArgs("nonsense", { target: "x" }), /no mcpjam probe/);
});

test("the missing-tool message names the command that fixes it", () => {
  const lines = missingProbeTool("test").join(" ");
  assert.match(lines, /moshcode install mcpjam/);
  assert.match(lines, /not installed/);
});

test("a probe with mcpjam missing explains itself and never spawns anything", async () => {
  const spawned = [];
  const code = await runProbe({ verb: "test", name: "https://x.dev/mcp" }, {
    probeInstalled: () => false,
    run: async (...args) => { spawned.push(args); return { ok: true, code: 0 }; },
  });
  assert.equal(code, 1);
  assert.deepEqual(spawned, [], "nothing to run when the runner is not there");
});

test("a probe against an unknown name fails before it reaches mcpjam", async () => {
  const spawned = [];
  const code = await runProbe({ verb: "test", name: "not-a-server" }, {
    probeInstalled: () => true,
    run: async (...args) => { spawned.push(args); return { ok: true, code: 0 }; },
  });
  assert.equal(code, 1);
  assert.deepEqual(spawned, []);
});

test("a probe takes a bare URL, because that is when people ask", async () => {
  const spawned = [];
  const code = await runProbe({ verb: "test", name: "https://mcp.sentry.dev/mcp" }, {
    probeInstalled: () => true,
    run: async (bin, argv) => { spawned.push([bin, argv]); return { ok: true, code: 0 }; },
  });
  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0][0], "mcpjam");
  assert.ok(spawned[0][1].includes("https://mcp.sentry.dev/mcp"));
});

/* -------------------------------------------------------------- the wizard */

test("the wizard refuses to run where nothing can answer it", async () => {
  // `mcp add` in a script would otherwise block forever on a read.
  const calls = [];
  const code = await runAddWizard({
    isTty: () => false,
    ask: async () => { calls.push("asked"); return "x"; },
    run: async () => ({ ok: true, code: 0 }),
  });
  assert.equal(code, 1);
  assert.deepEqual(calls, [], "it must not prompt into the void");
});

test("the wizard's answers become the same spec the flags would have built", async () => {
  isolateRegistry();
  const answers = ["wizard", "https://wiz.example.com/mcp", "http", "", "user", "claude"];
  const calls = [];
  const code = await runAddWizard({
    isTty: () => true,
    ask: async (_q, fallback = "") => (answers.shift() ?? fallback) || fallback,
    run: async (bin, argv) => { calls.push([bin, ...argv]); return { ok: true, code: 0 }; },
    installedSet: new Set(["claude"]),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [
    ["claude", "mcp", "add", "-s", "user", "-t", "http", "wizard", "https://wiz.example.com/mcp"],
  ]);
  assert.equal(getServer("wizard").target, "https://wiz.example.com/mcp");
});

/* -------------------------------------------------------------- the record */

test("redactSpec keeps header names and drops every value", () => {
  const redacted = redactSpec({
    target: "https://x.dev/mcp",
    args: [],
    env: [["PORKBUN_API_KEY", "pk-live-secret"]],
    headers: ["Authorization: Bearer sk-live-secret"],
    auth: { header: "Authorization", from: "env:TOKEN" },
  });
  const serialized = JSON.stringify(redacted);
  assert.deepEqual(redacted.headers, ["Authorization"]);
  assert.deepEqual(redacted.env, ["PORKBUN_API_KEY"]);
  assert.ok(!serialized.includes("sk-live-secret"), "a bearer token must never reach the file");
  assert.ok(!serialized.includes("pk-live-secret"), "an API key value must never reach the file");
});

test("a recorded server round-trips, and the file on disk holds no secret", () => {
  isolateRegistry();
  recordServer("sentry", {
    name: "sentry", target: "https://mcp.sentry.dev/mcp", args: [], env: [], transport: "http",
    headers: ["Authorization: Bearer sk-live-nope"],
    auth: { header: "Authorization", from: "env:SENTRY_TOKEN" },
  }, { engineScope: "user", engines: ["claude"] });

  const back = getServer("sentry");
  assert.equal(back.target, "https://mcp.sentry.dev/mcp");
  assert.deepEqual(back.engines, ["claude"]);
  assert.equal(back.enabled, true);
  assert.ok(!readFileSync(registryFile(), "utf8").includes("sk-live-nope"));
});

test("getServer does not resolve off Object.prototype", () => {
  isolateRegistry();
  recordServer("real", { name: "real", target: "npx", args: [], env: [], headers: [] });
  for (const bogus of ["constructor", "__proto__", "toString", ""]) {
    assert.equal(getServer(bogus), null, `${bogus} is not a server`);
  }
});

test("disable keeps the spec so enable has something to restore", () => {
  isolateRegistry();
  recordServer("keepme", { name: "keepme", target: "npx", args: ["-y", "srv"], env: [], headers: [] });
  setServerEnabled("keepme", false);
  const off = getServer("keepme");
  assert.equal(off.enabled, false);
  assert.deepEqual(off.args, ["-y", "srv"], "a disabled server that forgot its spec is a one-way door");
  setServerEnabled("keepme", true);
  assert.equal(getServer("keepme").enabled, true);
  assert.equal(setServerEnabled("nope", false), null);
});

test("forgetServer is idempotent and listing is name-sorted", () => {
  isolateRegistry();
  recordServer("b", { name: "b", target: "npx", args: [], env: [], headers: [] });
  recordServer("a", { name: "a", target: "npx", args: [], env: [], headers: [] });
  assert.deepEqual(listServers().map((s) => s.name), ["a", "b"]);
  assert.equal(forgetServer("a"), true);
  assert.equal(forgetServer("a"), false);
  assert.deepEqual(listServers().map((s) => s.name), ["b"]);
});

test("an unreadable or hand-mangled record reads as nothing registered", () => {
  process.env.MOSHCODE_MCP_FILE = path.join(mkdtempSync(path.join(tmpdir(), "moshcode-mcp-gone-")), "absent.json");
  assert.deepEqual(listServers(), []);
});

/* ----------------------------------------------------------- resolution */

test("a registered server resolves by name, and says when its credential is gone", () => {
  isolateRegistry();
  recordServer("withauth", {
    name: "withauth", target: "https://x.dev/mcp", args: [], env: [], headers: ["Authorization: Bearer x"],
    auth: { header: "Authorization", from: "env:MOSHCODE_TEST_ABSENT" },
  });
  const resolved = resolveServerSpec("withauth");
  assert.equal(resolved.source, "registry");
  assert.deepEqual(resolved.spec.headers, [], "a value that was never stored cannot be rebuilt");
  assert.equal(resolved.unauthenticated, true);
});

test("a registered server rebuilds its header when the variable is still set", () => {
  isolateRegistry();
  process.env.MOSHCODE_TEST_PRESENT = "zzz";
  recordServer("live", {
    name: "live", target: "https://x.dev/mcp", args: [], env: [], headers: ["Authorization: Bearer zzz"],
    auth: { header: "Authorization", from: "env:MOSHCODE_TEST_PRESENT" },
  });
  const resolved = resolveServerSpec("live");
  assert.deepEqual(resolved.spec.headers, ["Authorization: Bearer zzz"]);
  assert.equal(resolved.unauthenticated, false);
  delete process.env.MOSHCODE_TEST_PRESENT;
});

test("resolution falls through the record, the catalog, then a bare URL", () => {
  isolateRegistry();
  assert.equal(resolveServerSpec("porkbun").source, "catalog");
  assert.equal(resolveServerSpec("https://x.dev/mcp").source, "url");
  assert.equal(resolveServerSpec("nothing-like-this"), null);
  assert.equal(resolveServerSpec(""), null);
});

/* --------------------------------------------------- disable is a round trip */

test("disable deregisters everywhere and enable puts the same spec back", async () => {
  isolateRegistry();
  recordServer("roundtrip", { name: "roundtrip", target: "npx", args: ["-y", "srv"], env: [], headers: [] });

  const calls = [];
  const run = async (bin, argv) => { calls.push([bin, ...argv]); return { ok: true, code: 0 }; };
  const installedSet = new Set(["claude"]);

  assert.equal(await runManage({ verb: "disable", name: "roundtrip" }, { run, installedSet }), 0);
  // The scope comes back off the record, so the removal targets the exact place
  // the registration wrote rather than "wherever claude happens to find it".
  assert.deepEqual(calls.at(-1), ["claude", "mcp", "remove", "-s", "user", "roundtrip"]);
  assert.equal(getServer("roundtrip").enabled, false, "the spec must survive the disable");

  assert.equal(await runManage({ verb: "enable", name: "roundtrip" }, { run, installedSet }), 0);
  assert.deepEqual(calls.at(-1), ["claude", "mcp", "add", "-s", "user", "roundtrip", "--", "npx", "-y", "srv"]);
  assert.equal(getServer("roundtrip").enabled, true);
});

test("enable refuses a server moshcode never registered", async () => {
  isolateRegistry();
  const calls = [];
  const code = await runManage({ verb: "enable", name: "ghost" }, {
    run: async (...a) => { calls.push(a); return { ok: true, code: 0 }; },
    installedSet: new Set(["claude"]),
  });
  assert.equal(code, 1);
  assert.deepEqual(calls, [], "there is no spec to register");
});

test("acting on a server again reaches only the engines it was registered into", async () => {
  // `mcp add x --engines claude` then `mcp remove x` used to fan the removal
  // out to all six: five that never had it, and two belonging to somebody who
  // never asked moshcode to touch them.
  isolateRegistry();
  recordServer("narrow", { name: "narrow", target: "npx", args: [], env: [], headers: [] },
    { engineScope: "project", engines: ["claude"] });
  const calls = [];
  const run = async (bin, argv) => { calls.push([bin, ...argv]); return { ok: true, code: 0 }; };
  await runManage({ verb: "remove", name: "narrow" }, { run, installedSet: new Set(Object.keys(ENGINES)) });
  assert.deepEqual(calls, [["claude", "mcp", "remove", "-s", "project", "narrow"]]);
});

test("an explicit --engines still beats what was recorded", async () => {
  isolateRegistry();
  recordServer("narrow2", { name: "narrow2", target: "npx", args: [], env: [], headers: [] },
    { engineScope: "user", engines: ["claude"] });
  const calls = [];
  const run = async (bin, argv) => { calls.push([bin, ...argv]); return { ok: true, code: 0 }; };
  await runManage({ verb: "remove", name: "narrow2", engines: ["codex"] }, {
    run, installedSet: new Set(Object.keys(ENGINES)),
  });
  assert.deepEqual(calls, [["codex", "mcp", "remove", "narrow2"]]);
});

test("remove drops the record too, so the listing cannot lie", async () => {
  isolateRegistry();
  recordServer("gone", { name: "gone", target: "npx", args: [], env: [], headers: [] });
  await runManage({ verb: "remove", name: "gone" }, {
    run: async () => ({ ok: true, code: 0 }), installedSet: new Set(["claude"]),
  });
  assert.equal(getServer("gone"), null);
});
