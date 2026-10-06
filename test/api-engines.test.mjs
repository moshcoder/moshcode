// API-only engines (zai, perplexity, fugu), the one-shot core they share with
// the CLI engines, and `moshcode oneshot`.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  API_ENGINES, apiEngineAvailable, apiEngineConfig, buildChatRequest, interactiveError,
  resolveApiEngine, runApiEngine, stripThink,
} from "../src/api-engines.mjs";
import { ENGINES, pickAiEngine, resolveAnyEngine, resolveEngine } from "../src/engines.mjs";
import { AUTONOMOUS_FLAGS, oneShotArgs, oneShotEngines, runCapped, runOneShot } from "../src/oneshot.mjs";
import { oneshotCommand } from "../src/oneshot-cli.mjs";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

function fakeFetch(reply = { choices: [{ message: { content: "<think>hmm</think>\n\nThe answer." } }], model: "glm-5.2" }, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status });
  };
  fn.calls = calls;
  return fn;
}

/** A directory holding fake engine binaries that print their argv and cwd. */
function fakeBinDir(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-fakebin-"));
  for (const name of names) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\necho "argv: $*"\necho "cwd: $(pwd)"\n`);
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

/* ------------------------------------------------------------ the table */

test("the three API engines resolve by name and alias, and are not CLI engines", () => {
  for (const [token, key] of [["zai", "zai"], ["glm", "zai"], ["perplexity", "perplexity"], ["pplx", "perplexity"], ["sonar", "perplexity"], ["fugu", "fugu"], ["SAKANA", "fugu"]]) {
    assert.equal(resolveApiEngine(token)?.[0], key, token);
    assert.equal(resolveAnyEngine(token)?.kind, "api", token);
    assert.equal(resolveEngine(token), null, `${token} must not reach a launch surface`);
  }
  for (const key of Object.keys(API_ENGINES)) {
    assert.equal(API_ENGINES[key].kind, "api");
    assert.ok(!Object.hasOwn(ENGINES, key), `${key} must not be in ENGINES (install/herd/launch loop over it)`);
  }
  assert.equal(resolveApiEngine("constructor"), null);
  assert.equal(resolveAnyEngine("cc")?.kind, "cli");
});

test("defaults match crawlproof, and every one is overridable from env", () => {
  assert.deepEqual(
    Object.fromEntries(Object.keys(API_ENGINES).map((k) => [k, (({ baseUrl, model }) => ({ baseUrl, model }))(apiEngineConfig(k, {}))])),
    {
      zai: { baseUrl: "https://api.z.ai/api/coding/paas/v4", model: "glm-5.2" },
      perplexity: { baseUrl: "https://api.perplexity.ai", model: "sonar-reasoning-pro" },
      fugu: { baseUrl: "https://api.sakana.ai/v1", model: "fugu" },
    },
  );
  const cfg = apiEngineConfig("fugu", { FUGU_API_KEY: "k", FUGU_MODEL: "fugu-ultra", FUGU_BASE_URL: "https://example.test/v9/", FUGU_MAX_TOKENS: "123" });
  assert.equal(cfg.model, "fugu-ultra");
  assert.equal(cfg.baseUrl, "https://example.test/v9");
  assert.equal(cfg.maxTokens, 123);
  assert.equal(apiEngineConfig("zai", { ZAI_MODEL: "glm-4.6" }).model, "glm-4.6");
  assert.equal(apiEngineConfig("perplexity", { PERPLEXITY_MODEL: "sonar" }).model, "sonar");
});

test("an API engine is available exactly when its key is set", () => {
  assert.deepEqual(apiEngineAvailable("zai", {}), { available: false, reason: "ZAI_API_KEY is not set" });
  assert.deepEqual(apiEngineAvailable("zai", { ZAI_API_KEY: " " }).available, false);
  assert.deepEqual(apiEngineAvailable("zai", { ZAI_API_KEY: "x" }), { available: true });
});

/* ------------------------------------------------------- the request */

test("one prompt is one POST to /chat/completions with Bearer auth", () => {
  const { url, init } = buildChatRequest(apiEngineConfig("perplexity", { PERPLEXITY_API_KEY: "sekrit" }), "why?");
  assert.equal(url, "https://api.perplexity.ai/chat/completions");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, "Bearer sekrit");
  assert.equal(init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), {
    model: "sonar-reasoning-pro", messages: [{ role: "user", content: "why?" }], max_tokens: 8192, stream: false,
  });
});

test("runApiEngine sends that request through fetch and strips the thinking", async () => {
  const fetch = fakeFetch();
  const r = await runApiEngine("zai", "2+2?", { env: { ZAI_API_KEY: "k1" }, fetch });
  assert.equal(r.ok, true);
  assert.equal(r.output, "The answer.");
  assert.equal(r.model, "glm-5.2");
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, "https://api.z.ai/api/coding/paas/v4/chat/completions");
  assert.equal(fetch.calls[0].init.headers.authorization, "Bearer k1");
  assert.equal(fetch.calls[0].body.messages[0].content, "2+2?");
});

test("runApiEngine reports, never throws: missing key, HTTP error, no content, timeout", async () => {
  const none = await runApiEngine("fugu", "x", { env: {}, fetch: fakeFetch() });
  assert.deepEqual([none.ok, none.error], [false, "FUGU_API_KEY is not set"]);

  const denied = await runApiEngine("fugu", "x", { env: { FUGU_API_KEY: "secret-key-value" }, fetch: fakeFetch({ error: { message: "bad key" } }, 401) });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 401);
  assert.match(denied.error, /HTTP 401: bad key/);
  assert.ok(!denied.error.includes("secret-key-value"), "the key never reaches an error");

  const empty = await runApiEngine("fugu", "x", { env: { FUGU_API_KEY: "k" }, fetch: fakeFetch({ choices: [] }) });
  assert.match(empty.error, /no choices/);

  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const slow = await runApiEngine("fugu", "x", { env: { FUGU_API_KEY: "k" }, fetch: hang, timeoutMs: 50 });
  assert.match(slow.error, /timed out/);
});

test("content parts are joined", async () => {
  const fetch = fakeFetch({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] });
  assert.equal((await runApiEngine("zai", "x", { env: { ZAI_API_KEY: "k" }, fetch })).output, "ab");
});

test("stripThink drops closed and unterminated think blocks", () => {
  assert.equal(stripThink("<think>step 1\nstep 2</think>\n\nAnswer"), "Answer");
  assert.equal(stripThink("<THINK>a</THINK>x<think>b</think>y"), "xy");
  assert.equal(stripThink("Answer first <think>then ran out of tok"), "Answer first");
  assert.equal(stripThink("no thinking here"), "no thinking here");
  assert.equal(stripThink(null), "");
});

/* ------------------------------------------------ one-shot, any engine */

test("availability: CLI engines by (mocked) PATH, API engines by env", () => {
  const dir = fakeBinDir(["claude", "codex"]);
  try {
    const roster = oneShotEngines({ PATH: dir, ZAI_API_KEY: "k" });
    const by = Object.fromEntries(roster.map((e) => [e.name, e]));
    assert.deepEqual(by.claude, { name: "claude", kind: "cli", available: true });
    assert.equal(by.codex.available, true);
    assert.equal(by.gemini.available, false);
    assert.match(by.gemini.reason, /gemini not on PATH/);
    assert.deepEqual(by.openagents, { name: "openagents", kind: "cli", available: false, reason: "no one-shot mode" });
    assert.deepEqual(by.zai, { name: "zai", kind: "api", available: true });
    assert.deepEqual(by.perplexity, { name: "perplexity", kind: "api", available: false, reason: "PERPLEXITY_API_KEY is not set" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("one-shot argv is plain print mode: no autonomous flag survives", () => {
  assert.deepEqual(oneShotArgs("claude", "hi"), ["-p", "hi"]);
  assert.deepEqual(oneShotArgs("aider", "hi"), ["--message", "hi", "--no-auto-commits"]);
  assert.deepEqual(oneShotArgs("codex", "hi"), ["exec", "--skip-git-repo-check", "hi"]);
  // The caller's prompt is never filtered, even when it reads like a flag.
  assert.deepEqual(oneShotArgs("claude", "--yes"), ["-p", "--yes"]);
  for (const key of Object.keys(ENGINES)) {
    let args;
    try { args = oneShotArgs(key, "PROMPT"); } catch { continue; }
    for (const a of args.slice(0, -1)) assert.ok(!AUTONOMOUS_FLAGS.has(a), `${key} one-shot carries ${a}`);
  }
});

test("runOneShot runs a CLI engine's headless form in the given directory", async () => {
  const dir = fakeBinDir(["claude"]);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-cwd-"));
  try {
    const r = await runOneShot("cc", "hello there", { env: { PATH: `${dir}:/usr/bin:/bin` }, cwd });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.engine, "claude");
    assert.equal(r.kind, "cli");
    assert.equal(r.exit_code, 0);
    assert.match(r.output, /argv: -p hello there/);
    assert.match(r.output, new RegExp(`cwd: ${fs.realpathSync(cwd)}`));
    assert.doesNotMatch(r.output, /dangerously/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("runOneShot names a missing engine instead of spawning nothing", async () => {
  const r = await runOneShot("gemini", "x", { env: { PATH: "/nonexistent" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /not installed/);
  assert.match((await runOneShot("nope", "x")).error, /unknown engine/);
  assert.match((await runOneShot("openagents", "x")).error, /no one-shot mode/);
});

test("runCapped kills the whole process tree at the deadline", { skip: process.platform === "win32" }, async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-tree-")), "pid");
  const started = Date.now();
  const r = await runCapped("sh", ["-c", `sleep 30 & echo $! > ${pidFile}; sleep 30`], { timeoutMs: 300, graceMs: 200 });
  assert.ok(Date.now() - started < 5000, "the deadline was not enforced");
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(r.error, /timed out/);
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.throws(() => process.kill(grandchild, 0), /ESRCH/, "the grandchild outlived the deadline");
  fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
});

test("runCapped caps stdout", async () => {
  const r = await runCapped(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"], { maxBytes: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.output.length, 1000);
  assert.equal(r.truncated, true);
});

/* ------------------------------------------------------- ai() + ask */

test("pickAiEngine picks an API engine when it is named and keyed", () => {
  assert.equal(pickAiEngine("glm", { ZAI_API_KEY: "k" }), "zai");
  assert.equal(pickAiEngine("glm", {}), null);
});

test("moshcode oneshot prints an API engine's answer", async () => {
  let stdout = "";
  let stderr = "";
  const fetch = fakeFetch();
  const code = await oneshotCommand(["zai", "what", "is", "2+2"], {
    env: { ZAI_API_KEY: "k" }, fetch, out: (s) => { stdout += s; }, err: (s) => { stderr += s; }, stdinIsTTY: true,
  });
  assert.equal(code, 0, stderr);
  assert.equal(stdout, "The answer.\n");
  assert.equal(fetch.calls[0].body.messages[0].content, "what is 2+2");
});

test("moshcode oneshot reads the prompt from stdin, and fails loudly", async () => {
  let stdout = "";
  let stderr = "";
  const io = { out: (s) => { stdout += s; }, err: (s) => { stderr += s; } };
  const fetch = fakeFetch();
  assert.equal(await oneshotCommand(["pplx", "-"], { ...io, env: { PERPLEXITY_API_KEY: "k" }, fetch, readStdin: () => "from a pipe" }), 0);
  assert.equal(fetch.calls[0].body.messages[0].content, "from a pipe");
  assert.equal(await oneshotCommand(["fugu", "hi"], { ...io, env: {}, fetch, stdinIsTTY: true }), 1);
  assert.match(stderr, /FUGU_API_KEY is not set/);
  assert.equal(await oneshotCommand(["nope", "hi"], { ...io, stdinIsTTY: true }), 1);
  assert.match(stderr, /unknown engine "nope"/);
  assert.ok(stdout.includes("The answer."));
});

test("launching an API engine interactively is a clear error, not a crash", async () => {
  for (const args of [["zai"], ["start", "pplx"], ["agents", "fugu"]]) {
    const result = await run(process.execPath, [BIN, ...args], { env: { ...process.env, MOSHCODE_NESTED: "1" } })
      .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, /API-only engine: it has no interactive session/, args.join(" "));
    assert.match(result.stderr, /moshcode oneshot (zai|perplexity|fugu)/);
  }
  assert.match(interactiveError("zai"), /moshcode oneshot zai/);
});
