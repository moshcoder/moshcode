// The A2A surface: the auth that has no off switch, the card that does not lie
// about what it can do, and the vocabulary mismatch that goes in metadata
// rather than into a state nobody meant.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  A2A_PROTOCOL_VERSION, RPC_ERRORS, a2aState, bearer, createAuth, createHerdServer,
  exposable, handleRpc, herdCard, messageText, sessionCard, taskToA2a,
} from "../src/herd-serve.mjs";
import { endTask, readTasks, startTask } from "../src/herd-tasks.mjs";

async function withHerdDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-serve-test-"));
  const previous = process.env.MOSHCODE_HERD_DIR;
  process.env.MOSHCODE_HERD_DIR = dir;
  try { return await fn(dir); }
  finally {
    if (previous === undefined) delete process.env.MOSHCODE_HERD_DIR;
    else process.env.MOSHCODE_HERD_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const session = (extra = {}) => ({
  name: "api", engine: "claude", state: "idle", authority: "screen", cwd: "/x/api",
  alive: true, exited: false, kind: "local", ...extra,
});

const rpc = (method, params) => ({ jsonrpc: "2.0", id: 1, method, params });

const harness = (rows, { screenText = "$ ", sent = { ok: true } } = {}) => ({
  member: rows[0]?.name,
  sessions: () => rows,
  prompt: () => sent,
  interrupt: () => ({ ok: true }),
  screen: () => screenText,
  now: () => 1000,
});

/* ---------------------------------------------------------------- the card */

test("the card declares the things it cannot do as off", () => {
  // A card that claimed streaming would be a client hanging on a stream that
  // never opens. These flags are false because they are false.
  const card = sessionCard(session(), { base: "http://127.0.0.1:7683" });
  assert.equal(card.protocolVersion, A2A_PROTOCOL_VERSION);
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.equal(card.supportsAuthenticatedExtendedCard, false);
  assert.equal(card.preferredTransport, "JSONRPC");
  assert.equal(card.url, "http://127.0.0.1:7683/api/");
  assert.deepEqual(card.defaultInputModes, ["text/plain"]);
  assert.deepEqual(card.security, [{ moshcode: [] }]);
});

test("the herd's own card lists its members as skills", () => {
  const card = herdCard([session(), session({ name: "web", engine: "codex" })], { base: "http://x" });
  assert.deepEqual(card.skills.map((s) => s.id), ["api", "web"]);
  assert.match(card.skills[0].description, /\/api\//, "a client cannot find where to address it");
});

test("an autonomous session is not on the protocol surface unless asked for", () => {
  // An engine with approvals bypassed, plus a network endpoint taking prompts,
  // is prompt injection reaching an agent already told not to ask.
  assert.equal(exposable(session({ agent: true })), false);
  assert.equal(exposable(session({ agent: true }), { exposeAutonomous: true }), true);
  assert.equal(exposable(session()), true);
  // A remote is somebody else's to serve, not ours to re-export.
  assert.equal(exposable(session({ kind: "remote" })), false);
});

/* -------------------------------------------------------------- the states */

test("idle and unknown round down to working, never up to input-required", () => {
  // Rounding up would page a human for a session with nothing to say, every
  // time it went quiet.
  assert.equal(a2aState("blocked"), "input-required");
  assert.equal(a2aState("working"), "working");
  assert.equal(a2aState("done"), "completed");
  assert.equal(a2aState("idle"), "working");
  assert.equal(a2aState("unknown"), "working");
});

test("a finished task is completed whatever the session went back to being", () => {
  // The idle→working rounding is about a session. Applying it to a task with an
  // outcome and an artifact leaves a client polling a job that finished.
  const done = taskToA2a({
    id: "t-1", session: "api", text: "go", submitted: 1, endedAt: 9, durationMs: 8,
    transitions: [], status: "closed", state: "idle", artifact: "the answer",
  });
  assert.equal(done.status.state, "completed");
  assert.equal(done.artifacts[0].parts[0].text, "the answer");
  assert.equal(done.metadata["sh.moshcode.herd"].state, "idle", "the honest state is still on the record");
});

test("a task that ended by asking is input-required, not completed", () => {
  const asked = taskToA2a({
    id: "t-1", session: "api", text: "go", submitted: 1, endedAt: 9,
    transitions: [], status: "closed", state: "blocked", artifact: "which environment?",
  });
  assert.equal(asked.status.state, "input-required");
});

test("an open task reports what the session is doing now", () => {
  const open = taskToA2a({
    id: "t-1", session: "api", text: "go", submitted: 1, transitions: [], status: "open", state: "working", artifact: null,
  }, { live: "blocked" });
  assert.equal(open.status.state, "input-required");
  assert.deepEqual(open.artifacts, []);
});

/* --------------------------------------------------------------- the verbs */

test("message/send types the prompt and hands back a task id", async () => {
  await withHerdDir(async () => {
    const typed = [];
    const answer = await handleRpc(rpc("message/send", {
      message: { kind: "message", role: "user", parts: [{ kind: "text", text: "port the auth routes" }] },
    }), { ...harness([session()]), prompt: (name, text) => { typed.push([name, text]); return { ok: true }; } });

    assert.deepEqual(typed, [["api", "port the auth routes"]]);
    assert.equal(answer.result.kind, "task");
    // Returned before the engine has answered, on purpose: the task model
    // exists so a client polls rather than holding a socket for half an hour.
    assert.equal(answer.result.status.state, "working");
    const [task] = readTasks("api");
    assert.equal(task.text, "port the auth routes", "the protocol did not mint a ledger task");
  });
});

test("a prompt that could not be typed is an error AND a closed task", async () => {
  // A ledger that only records successful work cannot answer what went wrong.
  await withHerdDir(async () => {
    const answer = await handleRpc(rpc("message/send", { message: { parts: [{ kind: "text", text: "hi" }] } }),
      harness([session()], { sent: { ok: false, error: new Error("no such pane") } }));
    assert.equal(answer.error.code, RPC_ERRORS.internal.code);
    const [task] = readTasks("api");
    assert.equal(task.status, "closed");
    assert.match(task.artifact, /no such pane/);
  });
});

test("a message with no text part is refused rather than sent as nothing", async () => {
  await withHerdDir(async () => {
    const answer = await handleRpc(rpc("message/send", { message: { parts: [{ kind: "file" }] } }), harness([session()]));
    assert.equal(answer.error.code, RPC_ERRORS.invalidParams.code);
  });
});

test("message/send needs a member; task verbs do not, because ids are herd-wide", async () => {
  await withHerdDir(async () => {
    const rows = [session()];
    const unaddressed = await handleRpc(rpc("message/send", { message: { parts: [{ kind: "text", text: "x" }] } }),
      { ...harness(rows), member: null });
    assert.equal(unaddressed.error.code, RPC_ERRORS.invalidParams.code);

    const id = startTask("api", "earlier work");
    endTask("api", id, { state: "done", artifact: "done then" });
    const got = await handleRpc(rpc("tasks/get", { id }), { ...harness(rows), member: null });
    assert.equal(got.result.id, id);
  });
});

test("tasks/get closes a task whose session has already stopped", async () => {
  // Without this the only thing that finishes a task is the watcher, and an
  // A2A client — whose whole protocol is send-then-poll — sits on `working`
  // forever against a herd where nobody happened to run one.
  await withHerdDir(async () => {
    const id = startTask("api", "go", { screen: "$ " });
    const answer = await handleRpc(rpc("tasks/get", { id }),
      harness([session({ state: "idle" })], { screenText: "$ go\nthe output\n$ " }));
    assert.equal(answer.result.status.state, "completed");
    assert.match(answer.result.artifacts[0].parts[0].text, /the output/);
    assert.equal(readTasks("api")[0].status, "closed");
  });
});

test("a task in a session this server does not expose does not exist here", async () => {
  await withHerdDir(async () => {
    const id = startTask("secret", "go");
    const answer = await handleRpc(rpc("tasks/get", { id }), { ...harness([session()]), member: null });
    assert.equal(answer.error.code, RPC_ERRORS.taskNotFound.code);
  });
});

test("cancel interrupts the work without ending the member", async () => {
  // An A2A task is a unit of work inside a member, and the member is something
  // a person attached to five minutes ago. Ending it is `moshcode kill`, which
  // is a decision rather than a protocol call.
  await withHerdDir(async () => {
    let interrupted = 0;
    const id = startTask("api", "sleep forever", { screen: "$ " });
    const answer = await handleRpc(rpc("tasks/cancel", { id }), {
      ...harness([session({ state: "working" })], { screenText: "$ sleep\n^C\n$ " }),
      interrupt: () => { interrupted++; return { ok: true }; },
    });
    assert.equal(interrupted, 1);
    assert.equal(answer.result.status.state, "canceled");
    assert.equal(readTasks("api")[0].status, "closed");
  });
});

test("a finished task cannot be cancelled, and says which error that is", async () => {
  await withHerdDir(async () => {
    const id = startTask("api", "go");
    endTask("api", id, { state: "done", artifact: "" });
    const answer = await handleRpc(rpc("tasks/cancel", { id }), harness([session()]));
    assert.equal(answer.error.code, RPC_ERRORS.taskNotCancelable.code);
  });
});

test("an unknown task and an unknown method are distinct errors", async () => {
  await withHerdDir(async () => {
    const missing = await handleRpc(rpc("tasks/get", { id: "t-nope" }), harness([session()]));
    assert.equal(missing.error.code, RPC_ERRORS.taskNotFound.code);
    const unsupported = await handleRpc(rpc("message/stream", {}), harness([session()]));
    assert.equal(unsupported.error.code, RPC_ERRORS.methodNotFound.code);
    assert.equal(unsupported.error.data, "message/stream");
  });
});

test("a dead session takes no prompts", async () => {
  await withHerdDir(async () => {
    const answer = await handleRpc(rpc("message/send", { message: { parts: [{ kind: "text", text: "x" }] } }),
      harness([session({ exited: true })]));
    assert.equal(answer.error.code, RPC_ERRORS.invalidParams.code);
  });
});

/* ----------------------------------------------------------------- the auth */

test("text parts only, per the scope note", () => {
  assert.equal(messageText({ parts: [{ kind: "text", text: "a" }, { kind: "file", file: {} }] }), "a");
  assert.equal(messageText({}), "");
  assert.equal(messageText(null), "");
});

test("a bearer token is read from the header, or is absent", () => {
  assert.equal(bearer({ headers: { authorization: "Bearer abc" } }), "abc");
  assert.equal(bearer({ headers: { authorization: "bearer abc" } }), "abc");
  assert.equal(bearer({ headers: {} }), "");
  assert.equal(bearer({}), "");
});

test("a verified token is cached, and a rejected one is not", async () => {
  let asked = 0;
  const auth = createAuth({ verify: async (_api, token) => { asked++; return token === "good" ? "a@b.c" : null; } });
  assert.equal(await auth.check("good"), "a@b.c");
  assert.equal(await auth.check("good"), "a@b.c");
  assert.equal(asked, 1, "a polling client would become a load test on the app");
  assert.equal(await auth.check("bad"), null);
  assert.equal(await auth.check("bad"), null);
  assert.equal(asked, 3, "a rejection must not be cached as a rejection forever either");
});

test("a minted credential is accepted without asking the app again", async () => {
  let asked = 0;
  const auth = createAuth({ verify: async () => { asked++; return "a@b.c"; } });
  const credential = auth.mint("a@b.c");
  assert.equal(await auth.check(credential), "a@b.c");
  assert.equal(asked, 0);
});

test("there is no unauthenticated request, loopback included", async () => {
  // message/send is keystrokes into a real pty, which is strictly more
  // dangerous than a browser terminal that at least shows you what it is doing.
  await withHerdDir(async () => {
    const auth = createAuth({ verify: async () => null });
    const server = createHerdServer({ auth, sessions: () => [session()], base: "http://127.0.0.1:0" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      for (const [path, options] of [
        ["/.well-known/agent-card.json", {}],
        ["/api/.well-known/agent-card.json", {}],
        ["/api/", { method: "POST", body: JSON.stringify(rpc("tasks/get", { id: "t-1" })) }],
        ["/auth", { method: "POST" }],
      ]) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
        assert.equal(res.status, 401, `${path} answered ${res.status} without a credential`);
        assert.match(res.headers.get("www-authenticate") || "", /Bearer/);
      }
    } finally { server.close(); }
  });
});

test("a 404 is not a way to ask which session names exist", async () => {
  await withHerdDir(async () => {
    const auth = createAuth({ verify: async () => null });
    const server = createHerdServer({ auth, sessions: () => [session()], base: "http://127.0.0.1:0" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/does-not-exist/.well-known/agent-card.json`);
      assert.equal(res.status, 401, "an unauthenticated caller learned a name does not exist");
    } finally { server.close(); }
  });
});

test("an oversized body is refused before it is parsed", async () => {
  await withHerdDir(async () => {
    const auth = { mint: () => "x", check: async () => "a@b.c" };
    const server = createHerdServer({ auth, sessions: () => [session()], base: "http://127.0.0.1:0" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/`, {
        method: "POST",
        headers: { authorization: "Bearer good", "content-type": "application/json" },
        body: "x".repeat(2 * 1024 * 1024),
      }).catch(() => ({ status: 413 }));
      assert.equal(res.status, 413);
    } finally { server.close(); }
  });
});
