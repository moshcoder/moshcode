// Unit tests for the tiny .env loader in src/config.mjs.
//
// No PWA dependencies are needed — config.mjs only uses node builtins — so
// these run on a bare repo clone. Each test uses its own key names and clears
// them out of process.env afterwards, because the loader writes there.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { loadEnv } = await import("../src/config.mjs");

const workdir = mkdtempSync(join(tmpdir(), "moshcode-env-"));
let n = 0;

/** Write a throwaway .env and hand back its path. */
function envFile(contents) {
  const file = join(workdir, `env-${n++}`);
  writeFileSync(file, contents);
  return file;
}

/** Load a throwaway .env and hand back the keys it set, then clear them. */
function load(contents, keys) {
  const file = envFile(contents);
  for (const k of keys) delete process.env[k];
  try {
    loadEnv(file);
    return Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  } finally {
    for (const k of keys) delete process.env[k];
  }
}

test("a trailing space is not part of the value", () => {
  const env = load("MC_TEST_ORIGIN=https://app.moshcode.sh \n", ["MC_TEST_ORIGIN"]);
  assert.equal(env.MC_TEST_ORIGIN, "https://app.moshcode.sh");
});

test("a trailing tab is not part of the value", () => {
  const env = load("MC_TEST_TOKEN=123:AAbb\t\n", ["MC_TEST_TOKEN"]);
  assert.equal(env.MC_TEST_TOKEN, "123:AAbb");
});

test("a CRLF file parses without a carriage return on the value", () => {
  const env = load("MC_TEST_DB=file:./data/local.db\r\nMC_TEST_PORT=8080\r\n", ["MC_TEST_DB", "MC_TEST_PORT"]);
  assert.equal(env.MC_TEST_DB, "file:./data/local.db");
  assert.equal(env.MC_TEST_PORT, "8080");
});

test("a quoted value is still unquoted when the line has trailing whitespace", () => {
  const env = load('MC_TEST_KEY="re_live_key" \n', ["MC_TEST_KEY"]);
  assert.equal(env.MC_TEST_KEY, "re_live_key");
});

test("spaces inside a value are kept", () => {
  const env = load("MC_TEST_FROM=moshcode <notify@moshcoding.com>\n", ["MC_TEST_FROM"]);
  assert.equal(env.MC_TEST_FROM, "moshcode <notify@moshcoding.com>");
});

test("plain, quoted, empty and padded lines still parse", () => {
  const env = load(
    "MC_TEST_PLAIN=plain\nMC_TEST_SQ='single'\n\n  MC_TEST_PAD  =  padded  \nnot a pair\n",
    ["MC_TEST_PLAIN", "MC_TEST_SQ", "MC_TEST_PAD"],
  );
  assert.equal(env.MC_TEST_PLAIN, "plain");
  assert.equal(env.MC_TEST_SQ, "single");
  assert.equal(env.MC_TEST_PAD, "padded");
});

test("an empty value stays an empty string", () => {
  const env = load("MC_TEST_EMPTY=\n", ["MC_TEST_EMPTY"]);
  assert.equal(env.MC_TEST_EMPTY, "");
});

test("the environment still wins over the file", () => {
  process.env.MC_TEST_WINS = "from-environment";
  try {
    loadEnv(envFile("MC_TEST_WINS=from-file\n"));
    assert.equal(process.env.MC_TEST_WINS, "from-environment");
  } finally {
    delete process.env.MC_TEST_WINS;
  }
});

test("a missing file is a no-op", () => {
  assert.doesNotThrow(() => loadEnv(join(workdir, "does-not-exist")));
});
