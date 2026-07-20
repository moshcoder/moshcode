import assert from "node:assert/strict";
import test from "node:test";

import { parseMcp } from "../src/integrations.mjs";

test("parseMcp rejects another flag where a flag value is required", () => {
  assert.deepEqual(parseMcp(["add", "--name", "--transport", "http", "server", "https://example.com/mcp"]), {
    error: "--name requires a value",
  });
  assert.deepEqual(parseMcp(["add", "server", "--header", "--transport", "https://example.com/mcp"]), {
    error: "--header requires a value",
  });
});

test("parseMcp still accepts valid flag values", () => {
  assert.deepEqual(parseMcp(["add", "--name", "demo", "--transport", "http", "https://example.com/mcp"]), {
    spec: {
      name: "demo",
      target: "https://example.com/mcp",
      args: [],
      transport: "http",
      env: [],
      headers: [],
    },
  });
});
