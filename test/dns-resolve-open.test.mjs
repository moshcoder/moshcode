// What `moshcode dns resolve` tells a person about a parked name.
//
// The A record for a parked name points at the parking host, and that host
// routes by Host header — so the name never reaches a page over plain HTTP.
// Printing the IP was therefore an answer that goes nowhere. The Pit has a real
// page for the name, and a person (unlike a resolver) can just be handed it.
import assert from "node:assert/strict";
import test from "node:test";

import { dnsCommand, pitNameUrl } from "../src/dns.mjs";

const REGISTRY = "https://pit.example.test";

/** Registry stub: `registered` names exist, `targets` say where they point. */
function registrySays({ targets = {}, registered = [] } = {}) {
  globalThis.fetch = async (url) => {
    const name = new URL(String(url)).searchParams.get("name") || "";
    const known = registered.includes(name) || name in targets;
    return {
      ok: true,
      json: async () => ({ name_registered: known, target: targets[name] ?? null }),
    };
  };
}

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

/** Run the CLI and collect what it printed. */
async function run(args) {
  const lines = [];
  const code = await dnsCommand(args, (l) => lines.push(String(l)));
  return { code, out: lines.join("\n") };
}

test("pitNameUrl points at the registry's page for the name", () => {
  assert.equal(pitNameUrl("scrambled.eggs", REGISTRY), `${REGISTRY}/n/scrambled.eggs`);
  // A trailing slash on the base must not double up.
  assert.equal(pitNameUrl("scrambled.eggs", `${REGISTRY}/`), `${REGISTRY}/n/scrambled.eggs`);
});

test("a parked name resolves to its Pit page, not a dead IP", async () => {
  registrySays({ registered: ["scrambled.eggs"] });

  const { code, out } = await run(["resolve", "scrambled.eggs", "--registry", REGISTRY]);

  assert.equal(code, 0);
  assert.match(out, /scrambled\.eggs → https:\/\/pit\.example\.test\/n\/scrambled\.eggs/);
  assert.match(out, /\[parked/);
  // The old output printed the parking host's IP, which answers for nobody.
  assert.doesNotMatch(out, /\d+\.\d+\.\d+\.\d+/);
});

test("a live name still reports its target, untouched", async () => {
  registrySays({ targets: { "mosh.eggs": "203.0.113.7" } });

  const { code, out } = await run(["resolve", "mosh.eggs", "--registry", REGISTRY]);

  assert.equal(code, 0);
  assert.match(out, /mosh\.eggs → 203\.0\.113\.7/);
  assert.doesNotMatch(out, /\/n\//, "a pointed name has its own home");
});

test("--open says what it is opening", async () => {
  registrySays({ registered: ["scrambled.eggs"] });
  // Force the headless branch so the test never spawns a browser.
  const display = process.env.DISPLAY, wayland = process.env.WAYLAND_DISPLAY;
  const ssh = process.env.SSH_CONNECTION;
  delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
  process.env.SSH_CONNECTION = "1";
  try {
    const { out } = await run(["resolve", "scrambled.eggs", "--registry", REGISTRY, "--open"]);
    assert.match(out, /no browser to open here/);
    assert.match(out, /https:\/\/pit\.example\.test\/n\/scrambled\.eggs/, "the URL is still printed");
  } finally {
    if (display) process.env.DISPLAY = display;
    if (wayland) process.env.WAYLAND_DISPLAY = wayland;
    if (ssh) process.env.SSH_CONNECTION = ssh; else delete process.env.SSH_CONNECTION;
  }
});

test("without --open nothing is opened", async () => {
  registrySays({ registered: ["scrambled.eggs"] });

  const { out } = await run(["resolve", "scrambled.eggs", "--registry", REGISTRY]);

  // `resolve` is what scripts call; a browser must not be launched out of it.
  assert.doesNotMatch(out, /opening/);
});

test("--open on a name that is not parked opens nothing", async () => {
  registrySays({ targets: { "mosh.eggs": "203.0.113.7" } });

  const { out } = await run(["resolve", "mosh.eggs", "--registry", REGISTRY, "--open"]);

  assert.doesNotMatch(out, /opening|no browser/);
});
