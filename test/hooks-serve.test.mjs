// `moshcode hooks serve`: a signed prompt in, one signed result per engine out.
//
// The server tests run the real HTTP server and the real @profullstack/webhooks
// signing on both legs; only the engines are fakes (or fake binaries on PATH),
// so nothing here reaches a real model.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as webhooks from "@profullstack/webhooks";

import {
  COMPLETED_TYPE, MAX_PROMPT_CHARS, REQUEST_TYPE, RESULT_TYPE,
  callbackAllowed, createHooksServer, executeRun, hooksCommand, limiter, parseServeArgs, validateRequest,
} from "../src/hooks-serve.mjs";

const SECRET = webhooks.generateSecret();

const ROSTER = [
  { name: "claude", kind: "cli", available: true },
  { name: "codex", kind: "cli", available: false, reason: "codex not on PATH" },
  { name: "zai", kind: "api", available: true },
  { name: "fugu", kind: "api", available: false, reason: "FUGU_API_KEY is not set" },
];

function request(data, overrides = {}) {
  return webhooks.createEvent(REQUEST_TYPE, data, { source: "urn:test", ...overrides });
}

const DATA = { run_id: "run-1", prompt: "say hi", callback_url: "https://example.test/cb" };

/* ---------------------------------------------------------- validation */

test("callback_url: https anywhere, http only to this machine", () => {
  for (const ok of ["https://x.example/cb", "http://localhost:9/cb", "http://127.0.0.1/cb", "http://host.docker.internal:8080/x", "http://[::1]:3000/"]) {
    assert.ok(callbackAllowed(ok), ok);
  }
  for (const bad of ["http://example.com/cb", "http://10.0.0.1/cb", "ftp://localhost/x", "file:///etc/passwd", "not a url", "https://user:pw@x.example/"]) {
    assert.ok(!callbackAllowed(bad), bad);
  }
});

test("validateRequest accepts a good request and defaults to every available engine", () => {
  const r = validateRequest(request(DATA), { available: ROSTER, maxTimeout: 180 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.run, { runId: "run-1", prompt: "say hi", engines: ["claude", "zai"], skipped: [], timeoutMs: 180_000, callbackUrl: "https://example.test/cb" });
});

test("validateRequest: named engines resolve aliases, skip the unavailable, refuse strangers", () => {
  const r = validateRequest(request({ ...DATA, engines: ["cc", "glm", "codex", "claude"] }), { available: ROSTER });
  assert.deepEqual(r.run.engines, ["claude", "zai"]);
  assert.deepEqual(r.run.skipped, [{ name: "codex", reason: "codex not on PATH" }]);
  assert.deepEqual(validateRequest(request({ ...DATA, engines: ["nope"] }), { available: ROSTER }), { ok: false, status: 400, error: 'unknown engine "nope"' });
  assert.equal(validateRequest(request({ ...DATA, engines: ["fugu"] }), { available: ROSTER }).status, 422);
  assert.equal(validateRequest(request({ ...DATA, engines: [] }), { available: ROSTER }).status, 400);
});

test("validateRequest rejects every malformed field", () => {
  const v = (event) => validateRequest(event, { available: ROSTER, maxTimeout: 60 });
  assert.match(v(webhooks.createEvent("something.else.v1", DATA)).error, /type must be/);
  assert.match(v(request(null)).error, /data must be an object/);
  assert.match(v(request({ ...DATA, run_id: "" })).error, /run_id/);
  assert.match(v(request({ ...DATA, run_id: "a b" })).error, /run_id/);
  assert.match(v(request({ ...DATA, prompt: "   " })).error, /prompt/);
  const long = v(request({ ...DATA, prompt: "x".repeat(MAX_PROMPT_CHARS + 1) }));
  assert.deepEqual([long.status, /longer than 20000/.test(long.error)], [413, true]);
  assert.equal(v(request({ ...DATA, prompt: "x".repeat(MAX_PROMPT_CHARS) })).ok, true);
  assert.match(v(request({ ...DATA, callback_url: "http://evil.example/cb" })).error, /callback_url/);
  assert.match(v(request({ ...DATA, callback_url: undefined })).error, /callback_url/);
  assert.match(v(request({ ...DATA, timeout_s: -1 })).error, /timeout_s/);
  assert.match(v(request({ ...DATA, timeout_s: "10" })).error, /timeout_s/);
  // A caller can shorten the deadline, never lengthen it past the server's.
  assert.equal(v(request({ ...DATA, timeout_s: 5 })).run.timeoutMs, 5000);
  assert.equal(v(request({ ...DATA, timeout_s: 9999 })).run.timeoutMs, 60_000);
});

test("parseServeArgs: defaults, flags, and refusals", () => {
  assert.deepEqual(parseServeArgs([]).opts, { port: 7690, host: "127.0.0.1", concurrency: 4, timeout: 180 });
  assert.deepEqual(parseServeArgs(["--port", "0", "--host", "0.0.0.0", "--concurrency", "2", "--timeout", "30"]).opts, { port: 0, host: "0.0.0.0", concurrency: 2, timeout: 30 });
  assert.match(parseServeArgs(["--port", "x"]).error, /--port/);
  assert.match(parseServeArgs(["--concurrency", "0"]).error, /--concurrency/);
  assert.match(parseServeArgs(["--yolo"]).error, /unknown option/);
  assert.match(parseServeArgs(["--port"]).error, /needs a value/);
});

test("serve refuses to start without MOSHCODE_HOOKS_SECRET", async () => {
  let stderr = "";
  const code = await hooksCommand(["serve", "--port", "0"], { env: {}, err: (s) => { stderr += s; }, out: () => {} });
  assert.equal(code, 1);
  assert.match(stderr, /MOSHCODE_HOOKS_SECRET is not set/);
});

test("limiter never runs more than n at once", async () => {
  const limit = limiter(2);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => limit(async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
  })));
  assert.equal(peak, 2);
});

/* ------------------------------------------------------- the run loop */

test("executeRun: one result per engine in its own temp dir (deleted after), then completed", async () => {
  const sent = [];
  const dirs = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-hooks-root-"));
  const runOne = async (engine, prompt, { cwd, timeoutMs }) => {
    dirs.push(cwd);
    assert.ok(fs.existsSync(cwd) && fs.readdirSync(cwd).length === 0, "the engine gets a fresh, empty directory");
    assert.equal(timeoutMs, 5000);
    if (engine === "zai") return { engine, kind: "api", ok: false, output: "", error: "HTTP 500", exit_code: null, ms: 3, model: "glm-5.2" };
    return { engine, kind: "cli", ok: true, output: `${engine}: ${prompt}`, error: null, exit_code: 0, ms: 2, model: null };
  };
  const { completed } = await executeRun(
    { runId: "r9", prompt: "p", engines: ["claude", "zai"], skipped: [], timeoutMs: 5000, callbackUrl: "https://x.test/cb" },
    { runOne, send: async (url, event) => { sent.push({ url, event }); return { ok: true }; }, createEvent: webhooks.createEvent, tmpRoot },
  );
  assert.equal(dirs.length, 2);
  assert.notEqual(dirs[0], dirs[1]);
  for (const d of dirs) assert.ok(!fs.existsSync(d), `${d} was not deleted`);
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  assert.deepEqual(sent.map((s) => s.event.type), [RESULT_TYPE, RESULT_TYPE, COMPLETED_TYPE]);
  const byEngine = Object.fromEntries(sent.slice(0, 2).map((s) => [s.event.data.engine, s.event.data]));
  assert.deepEqual(byEngine.claude, { run_id: "r9", engine: "claude", kind: "cli", ok: true, output: "claude: p", error: null, exit_code: 0, ms: 2, model: null, truncated: false });
  assert.equal(byEngine.zai.ok, false);
  assert.equal(byEngine.zai.error, "HTTP 500");
  assert.equal(sent[2].event.data.run_id, "r9");
  assert.deepEqual([completed.total, completed.ok, completed.failed], [2, 1, 1]);
  assert.equal(sent[0].event.subject, "run:r9");
});

test("executeRun survives an engine that throws and a callback that fails", async () => {
  const logs = [];
  const { completed } = await executeRun(
    { runId: "r10", prompt: "p", engines: ["claude"], skipped: [], timeoutMs: 1000, callbackUrl: "https://x.test/cb" },
    {
      runOne: async () => { throw new Error("boom"); },
      send: async () => { throw new Error("connection refused"); },
      createEvent: webhooks.createEvent,
      log: (l) => logs.push(l),
    },
  );
  assert.deepEqual([completed.total, completed.failed], [1, 1]);
  assert.ok(logs.some((l) => /boom/.test(l)));
  assert.ok(logs.some((l) => /connection refused/.test(l)));
});

/* --------------------------------------------- the server, end to end */

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** A callback receiver that verifies every delivery with the shared secret. */
async function receiver() {
  const events = [];
  const rejected = [];
  let waiters = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = webhooks.verifyAndParse({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8"), secret: SECRET });
    if (!r.ok) { rejected.push(r.reason); res.writeHead(401).end(); return; }
    events.push(r.event);
    res.writeHead(204).end();
    waiters = waiters.filter((w) => !w());
  });
  const port = await listen(server);
  const until = (pred) => new Promise((resolve) => {
    const check = () => (pred(events) ? (resolve(events), true) : false);
    if (!check()) waiters.push(check);
  });
  return { server, url: `http://127.0.0.1:${port}/cb`, events, rejected, until };
}

async function signedPost(port, event, secret = SECRET) {
  const body = JSON.stringify(event);
  const headers = webhooks.signRequest({ id: event.id, body, secret });
  return fetch(`http://127.0.0.1:${port}/hooks`, { method: "POST", headers: { ...headers, "content-type": "application/cloudevents+json" }, body });
}

test("the server: 401 unsigned or mis-signed, 202 signed, then signed callbacks per engine", async (t) => {
  const cb = await receiver();
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-hooks-bin-"));
  const claude = path.join(fakeBin, "claude");
  // A fake claude that reports its argv and cwd, so the test sees print mode
  // and a fresh directory without any model.
  fs.writeFileSync(claude, '#!/bin/sh\necho "argv: $*"\necho "cwd: $(pwd)"\n');
  fs.chmodSync(claude, 0o755);
  const env = { PATH: `${fakeBin}:/usr/bin:/bin`, ZAI_API_KEY: "k" };
  const zaiFetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "<think>x</think>glm says hi" } }], model: "glm-5.2" }));

  const { runOneShot } = await import("../src/oneshot.mjs");
  const { server, idle } = createHooksServer({
    secret: SECRET,
    webhooks,
    env,
    sendOptions: { retryDelaysMs: [0] },
    runOne: (engine, prompt, opts) => runOneShot(engine, prompt, { ...opts, fetch: zaiFetch }),
    version: "9.9.9",
  });
  const port = await listen(server);
  t.after(() => { server.close(); cb.server.close(); fs.rmSync(fakeBin, { recursive: true, force: true }); });

  // Unsigned.
  const event = request({ run_id: "e2e-1", prompt: "say hi", callback_url: cb.url, engines: ["claude", "zai", "fugu"] });
  const unsigned = await fetch(`http://127.0.0.1:${port}/hooks`, { method: "POST", body: JSON.stringify(event) });
  assert.equal(unsigned.status, 401);
  // Signed with the wrong secret.
  assert.equal((await signedPost(port, event, webhooks.generateSecret())).status, 401);
  // Signed, but invalid: the error is only visible once the signature is good.
  const invalid = await signedPost(port, request({ ...DATA, callback_url: "http://evil.example/" }));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /callback_url/);

  // Signed and valid.
  const accepted = await signedPost(port, event);
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { run_id: "e2e-1", engines: ["claude", "zai"], skipped: [{ name: "fugu", reason: "FUGU_API_KEY is not set" }] });

  await cb.until((events) => events.some((e) => e.type === COMPLETED_TYPE && e.data.run_id === "e2e-1"));
  await idle();
  assert.deepEqual(cb.rejected, [], "every callback must verify with the shared secret");
  const results = cb.events.filter((e) => e.type === RESULT_TYPE && e.data.run_id === "e2e-1");
  const by = Object.fromEntries(results.map((e) => [e.data.engine, e.data]));
  assert.equal(by.claude.ok, true);
  assert.equal(by.claude.kind, "cli");
  assert.match(by.claude.output, /^argv: --strict-mcp-config -p say hi$/m);
  assert.doesNotMatch(by.claude.output, /dangerously|yolo/);
  const cwd = by.claude.output.match(/cwd: (.*)/)[1];
  assert.match(path.basename(cwd), /^moshcode-hook-/);
  assert.ok(!fs.existsSync(cwd), "the run's temp dir is deleted");
  assert.deepEqual([by.zai.ok, by.zai.kind, by.zai.output, by.zai.model], [true, "api", "glm says hi", "glm-5.2"]);
  const completed = cb.events.find((e) => e.type === COMPLETED_TYPE && e.data.run_id === "e2e-1");
  assert.deepEqual([completed.data.total, completed.data.ok, completed.data.failed], [2, 2, 0]);
  assert.equal(typeof completed.data.ms, "number");
});

test("the server: /engines and /healthz are unsigned, and nothing else is routed", async (t) => {
  const { server } = createHooksServer({ secret: SECRET, webhooks, roster: () => ROSTER, version: "1.2.3" });
  const port = await listen(server);
  t.after(() => server.close());
  const engines = await fetch(`http://127.0.0.1:${port}/engines`);
  assert.equal(engines.status, 200);
  assert.deepEqual(await engines.json(), { engines: ROSTER });
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.deepEqual(health, { ok: true, version: "1.2.3", running: 0 });
  assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/hooks`)).status, 405);
});

test("the server refuses a second run with the same run_id while the first is running", async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { server, idle } = createHooksServer({
    secret: SECRET,
    webhooks,
    roster: () => ROSTER,
    runOne: async (engine) => { await gate; return { engine, kind: "cli", ok: true, output: "", error: null, exit_code: 0, ms: 1, model: null }; },
    sendOptions: { retryDelaysMs: [0], fetchImpl: async () => new Response(null, { status: 204 }) },
  });
  const port = await listen(server);
  t.after(() => server.close());
  const ev = request({ ...DATA, run_id: "dup", engines: ["claude"] });
  assert.equal((await signedPost(port, ev)).status, 202);
  const again = await signedPost(port, request({ ...DATA, run_id: "dup", engines: ["claude"] }));
  assert.equal(again.status, 409);
  release();
  await idle();
});

test("the server refuses an oversized body before verifying it", async (t) => {
  const { server } = createHooksServer({ secret: SECRET, webhooks, roster: () => ROSTER });
  const port = await listen(server);
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${port}/hooks`, { method: "POST", body: "x".repeat(300 * 1024) }).catch((e) => e);
  // Either the 413 arrives or the socket is cut mid-upload; both are refusals.
  if (res instanceof Response) assert.equal(res.status, 413);
});
