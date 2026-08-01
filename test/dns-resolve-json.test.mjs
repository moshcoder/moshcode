import assert from "node:assert/strict";
import test from "node:test";

import { dnsCommand } from "../src/dns.mjs";

const REGISTRY = "https://pit.example.test";
const realFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

function registryResponse(body) {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => body,
  });
}

async function run(name, extra = []) {
  return runArgs(["resolve", name, "--registry", REGISTRY, "--json", ...extra]);
}

async function runArgs(args) {
  const output = [];
  const code = await dnsCommand(args, (line) => output.push(String(line)));
  assert.equal(output.length, 1, `expected one JSON document, got ${JSON.stringify(output)}`);
  return { code, value: JSON.parse(output[0]), raw: output[0] };
}

test("JSON describes a live name with a stable shape", async () => {
  registryResponse({ name_registered: true, target: "203.0.113.7" });
  const { code, value } = await run("live.eggs");
  assert.equal(code, 0);
  assert.deepEqual(value, {
    name: "live.eggs",
    status: "live",
    target: "203.0.113.7",
    pitUrl: null,
  });
});

test("JSON gives a parked name its Pit URL", async () => {
  registryResponse({ name_registered: true, target: null });
  const { code, value } = await run("parked.eggs");
  assert.equal(code, 0);
  assert.deepEqual(value, {
    name: "parked.eggs",
    status: "parked",
    target: null,
    pitUrl: `${REGISTRY}/n/parked.eggs`,
  });
});

test("JSON and value-bearing flags may appear before the name", async () => {
  registryResponse({ name_registered: true, target: "203.0.113.9" });
  const { code, value } = await runArgs([
    "resolve",
    "--registry",
    REGISTRY,
    "--json",
    "ordered.eggs",
  ]);
  assert.equal(code, 0);
  assert.equal(value.name, "ordered.eggs");
  assert.equal(value.status, "live");
  assert.equal(value.target, "203.0.113.9");
});

test("JSON preserves failure statuses and exit codes", async (t) => {
  await t.test("unreachable registry", async () => {
    globalThis.fetch = async () => { throw new Error("offline"); };
    const { code, value } = await run("lost.eggs");
    assert.equal(code, 1);
    assert.deepEqual(value, {
      name: "lost.eggs",
      status: "unreachable",
      target: null,
      pitUrl: null,
    });
  });

  await t.test("invalid Moshpit name", async () => {
    globalThis.fetch = async () => { throw new Error("must not fetch"); };
    const { code, value } = await run("three.part.name");
    assert.equal(code, 1);
    assert.deepEqual(value, {
      name: "three.part.name",
      status: "not-a-name",
      target: null,
      pitUrl: null,
    });
  });
});

test("--open never mixes human messages into JSON stdout", async () => {
  registryResponse({ name_registered: true, target: null });
  const oldSsh = process.env.SSH_CONNECTION;
  const oldDisplay = process.env.DISPLAY;
  const oldWayland = process.env.WAYLAND_DISPLAY;
  process.env.SSH_CONNECTION = "1";
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  try {
    const { code, value, raw } = await run("parked.eggs", ["--open"]);
    assert.equal(code, 0);
    assert.equal(value.status, "parked");
    assert.doesNotMatch(raw, /opening|no browser/i);
  } finally {
    if (oldSsh === undefined) delete process.env.SSH_CONNECTION;
    else process.env.SSH_CONNECTION = oldSsh;
    if (oldDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = oldDisplay;
    if (oldWayland === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = oldWayland;
  }
});
