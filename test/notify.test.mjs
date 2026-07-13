import assert from "node:assert/strict";
import test from "node:test";

import { ingestApproval, pollApproval } from "../src/notify.mjs";

test("ingestApproval fails cleanly without an API key", async () => {
  delete process.env.MOSHCODE_API_KEY;
  const r = await ingestApproval({ message: "hi" }, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /MOSHCODE_API_KEY/);
});

test("ingestApproval posts to the app with a Bearer key and returns {id,url}", async () => {
  process.env.MOSHCODE_API_KEY = "mck_test";
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ id: "ap1", url: "https://app.moshcode.sh/approve/ap1?t=x", delivered: ["email"], charged: 1 }) };
  };
  const r = await ingestApproval({ message: "ship it?", kind: "ask" }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.id, "ap1");
  assert.match(r.url, /\/approve\/ap1/);
  assert.match(seen.url, /\/api\/approvals$/);
  assert.equal(seen.opts.headers.authorization, "Bearer mck_test");
  delete process.env.MOSHCODE_API_KEY;
});

test("pollApproval resolves with the human's submitted response", async () => {
  const replies = [
    { ok: true, json: async () => ({ status: "pending" }) },
    { ok: true, json: async () => ({ status: "submitted", response: "ship it 🤘" }) },
  ];
  let i = 0;
  const reply = await pollApproval("ap1", { fetchImpl: async () => replies[i++], sleep: async () => {} });
  assert.equal(reply, "ship it 🤘");
});

test("pollApproval returns null when the loop is killed", async () => {
  const reply = await pollApproval("ap1", {
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: "killed" }) }),
    sleep: async () => {},
  });
  assert.equal(reply, null);
});

test("pollApproval returns null on timeout", async () => {
  let t = 0;
  const reply = await pollApproval("ap1", {
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: "pending" }) }),
    timeoutMs: 10,
    now: () => (t += 20),
    sleep: async () => {},
  });
  assert.equal(reply, null);
});
