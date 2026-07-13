import assert from "node:assert/strict";
import test from "node:test";

import { approvalUrl, newApprovalId, pollApproval } from "../src/notify.mjs";

test("approvalUrl points at moshcode.sh/approve/:id", () => {
  assert.match(approvalUrl("abc123"), /\/approve\/abc123$/);
});

test("newApprovalId is a unique-ish token", () => {
  const a = newApprovalId();
  const b = newApprovalId();
  assert.equal(typeof a, "string");
  assert.ok(a.length >= 8);
  assert.notEqual(a, b);
});

test("pollApproval resolves with the human's submitted response", async () => {
  // fake server: not-ready twice, then submitted
  const replies = [
    { ok: true, json: async () => ({ status: "pending" }) },
    { ok: true, json: async () => ({ status: "pending" }) },
    { ok: true, json: async () => ({ status: "submitted", response: "ship it 🤘" }) },
  ];
  let calls = 0;
  const fetchImpl = async () => replies[calls++];

  const reply = await pollApproval("id-1", {
    fetchImpl,
    intervalMs: 0,
    sleep: async () => {},
  });

  assert.equal(reply, "ship it 🤘");
  assert.equal(calls, 3);
});

test("pollApproval keeps polling through network errors", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 2) throw new Error("network down");
    return { ok: true, json: async () => ({ status: "submitted", response: "ok" }) };
  };
  const reply = await pollApproval("id-2", { fetchImpl, sleep: async () => {} });
  assert.equal(reply, "ok");
});

test("pollApproval returns null on timeout", async () => {
  let t = 0;
  const reply = await pollApproval("id-3", {
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: "pending" }) }),
    timeoutMs: 10,
    now: () => (t += 20), // jump past the deadline on the first check
    sleep: async () => {},
  });
  assert.equal(reply, null);
});
