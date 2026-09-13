import assert from "node:assert/strict";
import test from "node:test";

import { parseMcp, mcpCommand } from "../src/integrations.mjs";
import { parseMcpTtl } from "../src/mcp-share.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

async function quietly(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try { return { code: await fn(), lines }; }
  finally { console.log = original; }
}

test("remote MCP verbs parse separately from server registration", () => {
  assert.deepEqual(parseMcp(["answer", "--ttl", "8h", "--scope", "sessions:read,sessions:write", "--json"]), {
    remote: {
      action: "share",
      ttl: "8h",
      scope: "sessions:read,sessions:write",
      json: true,
    },
  });
  assert.deepEqual(parseMcp(["revoke", "mcs_123"]), { remote: { action: "revoke", shareId: "mcs_123" } });
  assert.match(parseMcp(["status", "--wat"]).error, /only takes --json/);
});

test("MCP share TTLs accept useful units and enforce the server range", () => {
  assert.equal(parseMcpTtl("90"), 90);
  assert.equal(parseMcpTtl("30m"), 1800);
  assert.equal(parseMcpTtl("2d"), 172800);
  assert.throws(() => parseMcpTtl("5msec"), /duration/);
  assert.throws(() => parseMcpTtl("8d"), /7 days/);
});

test("mcp answer shares the active TUI session through the authenticated API", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return json({ id: "mcs_share", endpoint: "https://moshcode.sh/api/v1/mcp/mcs_share", expires_at: 1 });
  };
  const result = await quietly(() => mcpCommand(["answer", "--ttl", "8h", "--scope", "sessions:read,sessions:write"], {
    sessionId: "session-live",
    credentials: { api: "https://app.example.test", token: "mck_test" },
    fetchImpl,
  }));

  assert.equal(result.code, 0);
  assert.equal(request.url, "https://app.example.test/api/v1/mcp/shares");
  assert.equal(request.options.headers.authorization, "Bearer mck_test");
  assert.deepEqual(request.body, {
    session_id: "session-live",
    ttl_seconds: 28800,
    scope: "sessions:read sessions:write",
  });
  assert.match(result.lines.join("\n"), /https:\/\/moshcode\.sh\/api\/v1\/mcp\/mcs_share/);
});

test("mcp answer refuses to invent a session outside the live TUI", async () => {
  const result = await quietly(() => mcpCommand(["answer"], {
    credentials: { api: "https://app.example.test", token: "mck_test" },
    fetchImpl: async () => { throw new Error("must not fetch"); },
  }));
  assert.equal(result.code, 1);
  assert.match(result.lines.join("\n"), /no live session/);
});

test("a pit started before login authenticates before registering and sharing the same session", async () => {
  const steps = [];
  const creds = { api: "https://app.example.test", token: "mck_new" };
  const result = await quietly(() => mcpCommand(["answer"], {
    credentials: null,
    login: async () => { steps.push("login"); return creds; },
    ensureSession: async (authenticated) => {
      assert.equal(authenticated, creds); steps.push("register"); return "new-live-session";
    },
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, "Bearer mck_new");
      assert.equal(JSON.parse(options.body).session_id, "new-live-session");
      steps.push("share");
      return json({ id: "mcs_new", endpoint: "https://moshcode.sh/api/v1/mcp/mcs_new", expires_at: 1 });
    },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(steps, ["login", "register", "share"]);
});

test("retrying a failed live registration does not create a stale share", async () => {
  let attempts = 0, shares = 0;
  const options = {
    credentials: { api: "https://app.example.test", token: "mck_test" },
    ensureSession: async () => { if (++attempts === 1) throw new Error("offline; retry /mcp answer"); return "live"; },
    fetchImpl: async () => { shares++; return json({ id: "mcs_new", endpoint: "https://moshcode.sh/api/v1/mcp/mcs_new", expires_at: 1 }); },
  };
  assert.equal((await quietly(() => mcpCommand(["answer"], options))).code, 1);
  assert.equal(shares, 0);
  assert.equal((await quietly(() => mcpCommand(["answer"], options))).code, 0);
  assert.equal(shares, 1);
});

test("connect re-registers the pit with the newly authenticated operator", async () => {
  const creds = { token: "new-account" };
  let called = false;
  const result = await quietly(() => mcpCommand(["connect"], {
    credentials: null,
    login: async () => creds,
    ensureSession: async (actual, options) => {
      assert.equal(actual, creds); assert.deepEqual(options, { restart: true }); called = true;
    },
  }));
  assert.equal(result.code, 0); assert.equal(called, true);
});

test("connect cannot claim success without credentials", async () => {
  const result = await quietly(() => mcpCommand(["connect"], { credentials: null, login: async () => ({}) }));
  assert.equal(result.code, 1);
  assert.match(result.lines.join("\n"), /without storing/);
});

test("an explicitly selected session never starts an unrelated mirror", async () => {
  const result = await quietly(() => mcpCommand(["answer", "--session", "chosen-session"], {
    credentials: { token: "mck_test" },
    ensureSession: async () => { throw new Error("must not create another session"); },
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).session_id, "chosen-session");
      return json({ id: "share", endpoint: "https://example.test/share", expires_at: 1 });
    },
  }));
  assert.equal(result.code, 0);
});

test("disabled mirroring refuses local shares before authentication but still permits login", async () => {
  let logins = 0;
  const options = {
    sharingDisabled: true,
    credentials: null,
    login: async () => { logins++; return { token: "mck_test" }; },
    ensureSession: async () => { throw new Error("must not mirror"); },
    fetchImpl: async () => { throw new Error("must not share"); },
  };
  const refused = await quietly(() => mcpCommand(["answer"], options));
  assert.equal(refused.code, 1);
  assert.match(refused.lines.join("\n"), /MOSHCODE_NO_MIRROR/);
  assert.equal(logins, 0);
  assert.equal((await quietly(() => mcpCommand(["connect"], options))).code, 0);
  assert.equal(logins, 1);
});

test("default share output explains read-only permissions and how to enable answers", async () => {
  const result = await quietly(() => mcpCommand(["answer"], {
    sessionId: "live", credentials: { token: "mck_test" },
    fetchImpl: async () => json({ id: "share", endpoint: "https://example.test/share", expires_at: 1, scopes: ["sessions:read"] }),
  }));
  assert.equal(result.code, 0);
  assert.match(result.lines.join("\n"), /permissions: sessions:read/);
  assert.match(result.lines.join("\n"), /read-only; to allow answers/);
});
