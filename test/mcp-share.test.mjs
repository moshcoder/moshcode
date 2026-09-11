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
  assert.deepEqual(parseMcp(["answer", "--ttl", "8h", "--scope", "session:read,session:write", "--json"]), {
    remote: {
      action: "share",
      ttl: "8h",
      scope: "session:read,session:write",
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
  const result = await quietly(() => mcpCommand(["answer", "--ttl", "8h", "--scope", "session:read,session:write"], {
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
    scope: "session:read session:write",
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
