// Remote members: the translation table between A2A and the herd, the auth that
// is never written down, and the honesty about what a URL can and cannot say.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readManifest, remoteStatus } from "../src/herd.mjs";
import {
  A2A_TO_HERD, addRemote, cancelRemote, cardUrl, herdStateFor, listRemotes, parseRemoteUrl,
  partsText, pingRemote, promptRemote, readA2aTask, readRemote, removeRemote, runAnswer,
  tokenEnvVar, waitRemote,
} from "../src/herd-remote.mjs";
import { sessionState } from "../src/herd-state.mjs";

// Async on purpose: a sync `finally` would delete the directory and restore
// the environment the moment the callback returned its *promise*, leaving the
// test to run against a herd dir that is already gone. Every caller awaits.
async function withHerdDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-remote-test-"));
  const previous = process.env.MOSHCODE_HERD_DIR;
  process.env.MOSHCODE_HERD_DIR = dir;
  try { return await fn(dir); }
  finally {
    if (previous === undefined) delete process.env.MOSHCODE_HERD_DIR;
    else process.env.MOSHCODE_HERD_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A fetch that answers from a table and records what it was asked. */
function stubFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method || "GET", body, headers: options.headers || {} });
    const answer = await handler({ url: String(url), body, options });
    return {
      ok: answer.status ? answer.status < 400 : true,
      status: answer.status || 200,
      text: async () => (typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? {})),
    };
  };
  impl.calls = calls;
  return impl;
}

const a2aTask = (state, artifact) => ({
  jsonrpc: "2.0", id: "1",
  result: {
    kind: "task", id: "remote-1", contextId: "c1", status: { state },
    artifacts: artifact ? [{ artifactId: "a", parts: [{ kind: "text", text: artifact }] }] : [],
  },
});

/* ------------------------------------------------------- the mapping table */

test("A2A's task states map onto the herd's, and input-required is blocked", () => {
  // The whole premise: this is a translation table, not an integration.
  assert.equal(herdStateFor("input-required"), "blocked");
  assert.equal(herdStateFor("working"), "working");
  assert.equal(herdStateFor("submitted"), "working");
  assert.equal(herdStateFor("completed"), "done");
  assert.equal(herdStateFor("canceled"), "done");
  assert.equal(herdStateFor("nonsense"), "unknown");
  for (const state of Object.values(A2A_TO_HERD)) {
    assert.ok(["working", "blocked", "done", "unknown"].includes(state), `${state} is not a herd state`);
  }
});

test("a task's text comes out of its parts, artifacts first", () => {
  assert.equal(partsText({ parts: [{ kind: "text", text: "a" }, { kind: "file" }, { kind: "text", text: "b" }] }), "a\nb");
  assert.equal(readA2aTask(a2aTask("completed", "the answer").result).artifact, "the answer");
  assert.equal(readA2aTask(a2aTask("input-required").result).state, "blocked");
});

/* ------------------------------------------------------------- registering */

test("only http(s) URLs can be registered", () => {
  // `herd prompt` on a remote POSTs user text to whatever this says. The one
  // thing that must not be possible is a scheme that means something else.
  assert.equal(parseRemoteUrl("file:///etc/passwd").ok, false);
  assert.equal(parseRemoteUrl("not a url").ok, false);
  assert.equal(parseRemoteUrl("https://agents.do-ai.run/x/y").ok, true);
});

test("adding a remote contacts nothing and writes no token", async () => {
  await withHerdDir(() => {
    const added = addRemote("research", "https://agents.do-ai.run/w/prod", { kind: "a2a" });
    assert.equal(added.ok, true);
    const entry = readManifest().sessions.research;
    assert.equal(entry.kind, "remote");
    assert.equal(entry.remoteKind, "a2a");
    assert.equal(entry.cwd, "agents.do-ai.run", "the host is what `ps` shows where a local shows its cwd");
    // 0010's allowlist reasoning, verbatim: a bearer token for someone else's
    // agent must not ride along to another machine.
    assert.equal(JSON.stringify(entry).includes("token"), false);
    assert.equal(tokenEnvVar("research"), "MOSHCODE_REMOTE_RESEARCH_TOKEN");
  });
});

test("a remote cannot take the name of a local session", async () => {
  await withHerdDir(async () => {
    const { rememberSession } = await import("../src/herd.mjs");
    rememberSession("api", { engine: "claude" });
    assert.equal(addRemote("api", "https://example.com").ok, false);
  });
});

test("an unknown kind is refused rather than guessed at", async () => {
  await withHerdDir(() => {
    assert.equal(addRemote("x", "https://example.com", { kind: "grpc" }).ok, false);
  });
});

test("removing a remote deregisters it and forgets what it last said", async () => {
  await withHerdDir(() => {
    addRemote("research", "https://example.com", { kind: "run" });
    assert.equal(removeRemote("research").ok, true);
    assert.equal(listRemotes().length, 0);
    assert.equal(remoteStatus("research"), null);
    assert.equal(removeRemote("research").ok, false);
  });
});

/* ------------------------------------------------------------------ state */

test("a remote's state is reported as the remote's claim, never as ours", async () => {
  await withHerdDir(() => {
    addRemote("research", "https://example.com", { kind: "run" });
    const before = sessionState({ name: "research", kind: "remote" });
    assert.deepEqual(before, { state: "unknown", authority: "remote" },
      "a remote nobody has asked yet is unknown, not idle");
  });
});

test("a request/response endpoint is idle when it is up, and says nothing more", async () => {
  await withHerdDir(async () => {
    addRemote("deployed", "https://example.com", { kind: "run" });
    const fetchImpl = stubFetch(() => ({ status: 200, body: { status: "ok" } }));
    const pinged = await pingRemote("deployed", { fetchImpl });
    assert.equal(pinged.state, "idle");
    assert.equal(sessionState({ name: "deployed", kind: "remote" }).authority, "remote");
    assert.equal(sessionState({ name: "deployed", kind: "remote" }).state, "idle");
  });
});

test("an unreachable remote reads unknown, not gone", () => {
  // `gone` is a claim about a process we started. We did not start this one.
  return withHerdDir(async () => {
    addRemote("deployed", "https://example.com", { kind: "run" });
    const fetchImpl = stubFetch(() => { throw new Error("ECONNREFUSED"); });
    const pinged = await pingRemote("deployed", { fetchImpl });
    assert.equal(pinged.ok, false);
    assert.equal(remoteStatus("deployed").state, "unknown");
  });
});

/* --------------------------------------------------------------- prompting */

test("prompting an a2a member sends a message and keeps its task id", async () => {
  await withHerdDir(async () => {
    addRemote("research", "https://example.com", { kind: "a2a" });
    const fetchImpl = stubFetch(({ body }) => {
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.method, "message/send");
      assert.equal(body.params.message.parts[0].text, "summarise the week");
      return { body: a2aTask("working") };
    });
    const sent = await promptRemote("research", "summarise the week", { fetchImpl });
    assert.equal(sent.ok, true);
    assert.equal(sent.state, "working");
    assert.equal(remoteStatus("research").taskId, "remote-1");
  });
});

test("prompting a run member posts a prompt and takes the answer back", async () => {
  await withHerdDir(async () => {
    addRemote("deployed", "https://example.com", { kind: "run" });
    const fetchImpl = stubFetch(({ body }) => {
      assert.deepEqual(body, { prompt: "hello" });
      return { body: { output: "the deployed answer" } };
    });
    const sent = await promptRemote("deployed", "hello", { fetchImpl });
    assert.equal(sent.artifact, "the deployed answer");
    assert.equal(sent.state, "done", "a request/response call is finished when it returns");
    assert.equal(readRemote("deployed"), "the deployed answer");
  });
});

test("the answer is found under whichever key the endpoint chose", () => {
  // No standard says what the key is, so the fallback returns the whole body
  // rather than "" — an empty artifact is a lie about an agent that answered.
  assert.equal(runAnswer({ output: "a" }), "a");
  assert.equal(runAnswer({ response: "b" }), "b");
  assert.equal(runAnswer({ message: { parts: [{ kind: "text", text: "c" }] } }), "c");
  assert.match(runAnswer({ surprise: 1 }), /surprise/);
  assert.equal(runAnswer(null, "plain text"), "plain text");
});

test("a token in the environment is sent, and its absence is not an error", async () => {
  await withHerdDir(async () => {
    addRemote("research", "https://example.com", { kind: "run" });
    const fetchImpl = stubFetch(() => ({ body: { output: "ok" } }));
    await promptRemote("research", "hi", { fetchImpl, env: { MOSHCODE_REMOTE_RESEARCH_TOKEN: "sekrit" } });
    assert.equal(fetchImpl.calls.at(-1).headers.authorization, "Bearer sekrit");
    await promptRemote("research", "hi", { fetchImpl, env: {} });
    assert.equal(fetchImpl.calls.at(-1).headers.authorization, undefined);
  });
});

/* ------------------------------------------------------------ wait, cancel */

test("waiting on an a2a member polls tasks/get until it stops working", async () => {
  await withHerdDir(async () => {
    addRemote("research", "https://example.com", { kind: "a2a" });
    let polls = 0;
    const fetchImpl = stubFetch(({ body }) => {
      if (body.method === "message/send") return { body: a2aTask("working") };
      polls++;
      return { body: polls >= 3 ? a2aTask("completed", "done at last") : a2aTask("working") };
    });
    await promptRemote("research", "go", { fetchImpl });
    const result = await waitRemote("research", ["done"], { fetchImpl, intervalMs: 1, sleep: async () => {} });
    assert.equal(result.outcome, "matched");
    assert.equal(result.state, "done");
    assert.equal(readRemote("research"), "done at last");
  });
});

test("input-required is what a remote asking for help looks like to `wait`", async () => {
  await withHerdDir(async () => {
    addRemote("research", "https://example.com", { kind: "a2a" });
    const fetchImpl = stubFetch(({ body }) =>
      ({ body: body.method === "message/send" ? a2aTask("working") : a2aTask("input-required", "which environment?") }));
    await promptRemote("research", "deploy it", { fetchImpl });
    const result = await waitRemote("research", ["blocked"], { fetchImpl, intervalMs: 1, sleep: async () => {} });
    assert.equal(result.state, "blocked");
  });
});

test("cancelling is best effort, and a run endpoint says so plainly", async () => {
  await withHerdDir(async () => {
    addRemote("deployed", "https://example.com", { kind: "run" });
    const refused = await cancelRemote("deployed");
    assert.equal(refused.ok, false);
    assert.match(String(refused.error.message), /nothing to cancel/);

    addRemote("research", "https://example.com", { kind: "a2a" });
    const fetchImpl = stubFetch(({ body }) =>
      ({ body: body.method === "message/send" ? a2aTask("working") : a2aTask("canceled") }));
    await promptRemote("research", "go", { fetchImpl });
    const cancelled = await cancelRemote("research", { fetchImpl });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.a2aState, "canceled");
  });
});

test("discovery looks where the spec says it does", () => {
  assert.equal(cardUrl("https://agents.do-ai.run/w/prod/"), "https://agents.do-ai.run/w/prod/.well-known/agent-card.json");
});

test("an RPC error comes back as a failure, not as a task", async () => {
  await withHerdDir(async () => {
    addRemote("research", "https://example.com", { kind: "a2a" });
    const fetchImpl = stubFetch(() => ({ body: { jsonrpc: "2.0", id: "1", error: { code: -32601, message: "Method not found" } } }));
    const sent = await promptRemote("research", "go", { fetchImpl });
    assert.equal(sent.ok, false);
    assert.match(String(sent.error.message), /Method not found/);
    assert.equal(remoteStatus("research").state, "unknown");
  });
});
