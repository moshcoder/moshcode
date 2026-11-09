import { test } from "node:test";
import assert from "node:assert/strict";
import { shortNode, statusLabel } from "../src/c0agent-repl.mjs";

test("shortNode drops the account and the node hash", () => {
  assert.equal(shortNode("anthony@profullstack-dev-vienna:e98c6ec2"), "profullstack-dev-vienna");
  assert.equal(shortNode("provider@bonita"), "bonita");
  assert.equal(shortNode(null), "a node");
});

test("statusLabel says where a c0mpute job is", () => {
  const job = { node: "anthony@dev-vienna:e98c6ec2" };
  assert.match(statusLabel({ stage: "queued", source: "p2p" }, job, { promptTokens: 640 }), /^dev-vienna has the job · waiting for the first token \(queue \+ reading ~640 prompt tokens\)$/);
  assert.match(statusLabel({ stage: "started" }, job, { promptTokens: 1400 }), /dev-vienna is reading the prompt \(~1\.4k tokens/);
  job.writingSince = 0;
  assert.equal(statusLabel({ stage: "writing", tokens: 40 }, job, { now: 10_000 }), "dev-vienna writing · 40 tokens · 4.0 tok/s");
  assert.match(statusLabel({ stage: "queued" }, job, { agent: "explore" }), /^explore · dev-vienna has the job/);
  assert.match(statusLabel({ stage: "retry", model: "m", reason: "no node" }, job), /m unavailable \(no node\)/);
});

test("runAgent forwards provider status as status events", async () => {
  const { createSession, runAgent } = await import("../src/c0agent.mjs");
  const provider = {
    async stream(req, onToken) {
      req.onStatus({ stage: "queued", jobId: "j", node: "n@x:abcdef12", source: "p2p", model: "m" });
      req.onStatus({ stage: "started", node: "n@x:abcdef12", engine: "ollama", model: "m" });
      onToken("hi");
      req.onStatus({ stage: "writing", tokens: 1 });
      return { text: "hi", model: "m" };
    },
  };
  const session = createSession({ provider, model: "m", cwd: process.cwd() });
  const events = [];
  await runAgent({ session, messages: [{ role: "user", content: "yo" }], onEvent: (e) => events.push(e) });
  const status = events.filter((e) => e.type === "status").map((e) => e.status.stage);
  assert.deepEqual(status, ["queued", "started", "writing"]);
  assert.ok(events.find((e) => e.type === "waiting").promptTokens > 0);
});
