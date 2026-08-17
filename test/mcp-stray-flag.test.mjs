// An unsupported flag before `--` used to be swallowed as a positional, which
// meant it became the server NAME (and its value became the command). The spec
// is spliced verbatim into every engine's native `mcp add` argv, so
// `mcp add -s user https://…` shipped `claude mcp add -s user -s -- user https://…`
// to Claude: a server called `-s`, a command called `user`, and the real URL
// demoted to an argument. Reject the stray flag instead — but only before `--`,
// because everything after it is the user's own command line.
import test from "node:test";
import assert from "node:assert/strict";

import { parseMcp } from "../src/integrations.mjs";
import { planMcpAdd } from "../src/mcp.mjs";

// ---------- the bug ----------

test("an engine-native scope flag is rejected, not turned into the server name", () => {
  const { error, spec } = parseMcp(["add", "-s", "user", "https://mcp.sentry.dev/mcp"]);
  assert.equal(spec, undefined);
  assert.match(error, /unknown mcp flag "-s"/);
});

test("a long unsupported flag is rejected too", () => {
  const { error, spec } = parseMcp(["add", "--scope", "user", "https://mcp.example.com/mcp"]);
  assert.equal(spec, undefined);
  assert.match(error, /unknown mcp flag "--scope"/);
});

test("a misspelled supported flag is rejected rather than silently accepted", () => {
  const { error } = parseMcp(["add", "--transportt", "http", "https://mcp.example.com/mcp"]);
  assert.match(error, /unknown mcp flag "--transportt"/);
});

test("a stray flag in the command position is rejected", () => {
  const { error, spec } = parseMcp(["add", "tools", "--verbose", "npx"]);
  assert.equal(spec, undefined);
  assert.match(error, /unknown mcp flag "--verbose"/);
});

test("install reports the stray flag, not a misleading missing-name error", () => {
  const { error } = parseMcp(["install", "--scope", "user", "https://mcp.example.com/mcp"]);
  assert.match(error, /unknown mcp flag "--scope"/);
  assert.doesNotMatch(error, /explicit --name/);
});

test("the error names the flags mcp does take, and points at --", () => {
  const { error } = parseMcp(["add", "-s", "user", "https://mcp.example.com/mcp"]);
  for (const flag of ["--name", "--transport", "--env", "--header"]) {
    assert.ok(error.includes(flag), `expected the error to mention ${flag}`);
  }
  assert.match(error, /after --/);
});

test("no stray flag ever reaches an engine's native argv", () => {
  // The end-to-end consequence: nothing to plan, so nothing to splice.
  const parsed = parseMcp(["add", "-s", "user", "https://mcp.sentry.dev/mcp"]);
  assert.equal(parsed.spec, undefined);
  assert.throws(() => planMcpAdd(parsed.spec));
});

test("a stray flag cannot smuggle a bogus name past the catalog lookup", () => {
  const { error } = parseMcp(["add", "--scope", "porkbun"]);
  assert.match(error, /unknown mcp flag "--scope"/);
});

// ---------- controls: the opposite direction ----------

test("a command's own flags after -- are still passed through untouched", () => {
  const { spec } = parseMcp(["add", "tools", "--", "npx", "-y", "srv", "--port", "3000"]);
  assert.equal(spec.name, "tools");
  assert.equal(spec.target, "npx");
  assert.deepEqual(spec.args, ["-y", "srv", "--port", "3000"]);
});

test("a command's own flags after the target are still arguments, not strays", () => {
  const { spec, error } = parseMcp(["add", "tools", "npx", "-y", "srv"]);
  assert.equal(error, undefined);
  assert.equal(spec.target, "npx");
  assert.deepEqual(spec.args, ["-y", "srv"]);
});

test("every supported flag still parses exactly as before", () => {
  const { spec } = parseMcp([
    "install", "https://x.dev/mcp",
    "--name", "x", "-t", "http", "-e", "K=v", "-H", "A: b",
  ]);
  assert.deepEqual(spec, {
    name: "x",
    target: "https://x.dev/mcp",
    args: [],
    transport: "http",
    env: [["K", "v"]],
    headers: ["A: b"],
  });
});

test("the catalog shortcut is unaffected", () => {
  const { spec, catalog, error } = parseMcp(["add", "porkbun"]);
  assert.equal(error, undefined);
  assert.equal(catalog.key, "porkbun");
  assert.equal(spec.name, "porkbun");
  assert.equal(spec.target, "npx");
});

test("a bare URL install still derives its name", () => {
  const { spec, error } = parseMcp(["install", "https://mcp.sentry.dev/mcp"]);
  assert.equal(error, undefined);
  assert.equal(spec.target, "https://mcp.sentry.dev/mcp");
  assert.ok(spec.name);
});

test("the pre-existing missing-value guards still fire first", () => {
  assert.match(parseMcp(["install", "https://x.dev/mcp", "--name"]).error, /--name requires a value/);
  assert.match(parseMcp(["install", "https://x.dev/mcp", "--transport", "--"]).error, /--transport requires a value/);
});

test("an unknown verb still reports an unknown verb, not an unknown flag", () => {
  assert.match(parseMcp(["bogus"]).error, /unknown mcp verb/);
});

test("a stdio install with no name still asks for --name", () => {
  assert.match(parseMcp(["install", "--", "npx", "srv"]).error, /explicit --name/);
});

// ---------- flags AFTER a remote URL were swallowed too ----------
//
// The guard above only inspected the server name and the target. A flag typed
// *after* a remote URL landed in `args`, which every engine's remote builder
// discards — so it vanished with no error and the install went ahead. The case
// that bites is `--dry-run`, a flag mcp does not have: someone expecting a
// preview got five engines' config files written instead.

test("an unknown flag after a remote URL is rejected, not silently dropped", () => {
  const { error, spec } = parseMcp(["install", "https://mcp.example.com", "--dry-run"]);
  assert.equal(spec, undefined, "the install must not proceed");
  assert.match(error, /unknown mcp flag "--dry-run"/);
  assert.match(error, /no --dry-run/);
});

test("the first stray flag is the one named, whichever follows it", () => {
  const { error } = parseMcp(["install", "https://mcp.example.com", "--wat", "--dry-run"]);
  assert.match(error, /unknown mcp flag "--wat"/);
});

test("a stray non-flag argument after a remote URL is reported as unexpected", () => {
  const { error, spec } = parseMcp(["install", "https://mcp.example.com", "extra"]);
  assert.equal(spec, undefined);
  assert.match(error, /unexpected argument "extra"/);
});

test("the same guard applies to `mcp add`, not just `install`", () => {
  const { error } = parseMcp(["add", "sentry", "https://mcp.sentry.dev/mcp", "--dry-run"]);
  assert.match(error, /unknown mcp flag "--dry-run"/);
});

test("a legitimate remote install is unaffected", () => {
  const { error, spec } = parseMcp(["install", "https://mcp.sentry.dev/mcp"]);
  assert.equal(error, undefined);
  assert.equal(spec.name, "sentry");
  assert.deepEqual(spec.args, []);
});

test("supported flags around a remote URL still parse", () => {
  const { error, spec } = parseMcp([
    "install", "https://mcp.example.com", "-H", "Authorization: Bearer z", "-e", "TOKEN=z", "--name", "mine",
  ]);
  assert.equal(error, undefined);
  assert.equal(spec.name, "mine");
  assert.deepEqual(spec.headers, ["Authorization: Bearer z"]);
  assert.deepEqual(spec.env, [["TOKEN", "z"]]);
});

test("a stdio command's own flags after `--` are still not second-guessed", () => {
  const { error, spec } = parseMcp(["add", "mine", "--", "npx", "-y", "my-mcp-server", "--dry-run"]);
  assert.equal(error, undefined);
  assert.equal(spec.target, "npx");
  assert.deepEqual(spec.args, ["-y", "my-mcp-server", "--dry-run"]);
});

test("a stdio server given without `--` keeps its arguments", () => {
  // Not a remote target, so the discard guard must not fire: these args really
  // are spliced into the engine's argv and do reach the command.
  const { error, spec } = parseMcp(["add", "mine", "npx", "my-mcp-server"]);
  assert.equal(error, undefined);
  assert.deepEqual(spec.args, ["my-mcp-server"]);
});
