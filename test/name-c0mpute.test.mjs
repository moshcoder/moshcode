// `moshcode name c0mpute` — one registry write, validated before it is sent.
import assert from "node:assert/strict";
import test from "node:test";

import { nameC0mputeCommand, normalizeSiteId } from "../src/name-c0mpute.mjs";
import { nameCommand } from "../src/name-link.mjs";

const SITE = "0123456789abcdef0123";

function capture() {
  const lines = { out: [], err: [] };
  return { lines, out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) };
}

function fakeRegistry(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      status: reply.status ?? 200,
      ok: (reply.status ?? 200) < 300,
      json: async () => reply.body,
    };
  };
  return { calls, fetchImpl };
}

test("site ids are accepted in the forms c0mpute prints", () => {
  assert.equal(normalizeSiteId(SITE), SITE);
  assert.equal(normalizeSiteId(`site=${SITE}`), SITE);
  assert.equal(normalizeSiteId(`http://1.2.3.4:7777/s/${SITE}/`), SITE);
  assert.equal(normalizeSiteId("off"), "");
  assert.equal(normalizeSiteId("xyz"), null);
});

test("sets the site with one authenticated PUT", async () => {
  const io = capture();
  const reg = fakeRegistry({ body: { c0mpute: SITE, edge: "edge.moshcode.sh", served: true } });
  const code = await nameC0mputeCommand(["blue.eggs", SITE], { ...io, token: "k", fetchImpl: reg.fetchImpl });
  assert.equal(code, 0, io.lines.err.join("\n"));
  assert.equal(reg.calls.length, 1);
  assert.equal(reg.calls[0].url, "https://pit.moshcode.sh/api/moshpit/tlds/eggs/names/c0mpute");
  assert.equal(reg.calls[0].init.method, "PUT");
  assert.equal(reg.calls[0].init.headers.authorization, "Bearer k");
  assert.deepEqual(reg.calls[0].body, { label: "blue", site: SITE });
  assert.match(io.lines.out.join("\n"), /https:\/\/blue\.eggs\//);
});

test("says so when the registry has no edge yet", async () => {
  const io = capture();
  const reg = fakeRegistry({ body: { c0mpute: SITE, edge: null, served: false } });
  assert.equal(await nameC0mputeCommand(["blue.eggs", SITE], { ...io, token: "k", fetchImpl: reg.fetchImpl }), 0);
  assert.match(io.lines.out.join("\n"), /no c0mpute edge configured/);
});

test("off clears it", async () => {
  const io = capture();
  const reg = fakeRegistry({ body: { c0mpute: null, edge: "edge.moshcode.sh", served: false } });
  assert.equal(await nameC0mputeCommand(["blue.eggs", "off"], { ...io, token: "k", fetchImpl: reg.fetchImpl }), 0);
  assert.equal(reg.calls[0].body.site, "");
  assert.match(io.lines.out.join("\n"), /no longer points/);
});

test("refuses bad input without calling the registry", async () => {
  for (const argv of [["blue", SITE], ["blue.eggs", "nothex"], ["blue.eggs"], []]) {
    const io = capture();
    const reg = fakeRegistry({ body: {} });
    assert.equal(await nameC0mputeCommand(argv, { ...io, token: "k", fetchImpl: reg.fetchImpl }), 1, argv.join(" "));
    assert.equal(reg.calls.length, 0);
  }
});

test("needs credentials, and passes the registry's refusal through", async () => {
  let io = capture();
  assert.equal(await nameC0mputeCommand(["blue.eggs", SITE], { ...io, token: "", fetchImpl: async () => { throw new Error("no"); } }), 1);
  assert.match(io.lines.err.join("\n"), /moshcode login/);

  io = capture();
  const reg = fakeRegistry({ status: 400, body: { error: "you do not own blue.eggs" } });
  assert.equal(await nameC0mputeCommand(["blue.eggs", SITE], { ...io, token: "k", fetchImpl: reg.fetchImpl }), 1);
  assert.match(io.lines.err.join("\n"), /you do not own/);
});

test("`moshcode name c0mpute` dispatches here, and --json is machine-readable", async () => {
  const io = capture();
  const reg = fakeRegistry({ body: { c0mpute: SITE, edge: "edge.moshcode.sh", served: true } });
  const code = await nameCommand(["c0mpute", "blue.eggs", SITE, "--json"], { ...io, token: "k", fetchImpl: reg.fetchImpl });
  assert.equal(code, 0, io.lines.err.join("\n"));
  assert.deepEqual(JSON.parse(io.lines.out[0]), { name: "blue.eggs", c0mpute: SITE, edge: "edge.moshcode.sh", served: true });
});
