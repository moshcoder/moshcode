// Which addresses the bridge will answer on.
//
// It forwarded to IPv6 upstreams from the start but only ever listened on
// IPv4, which is a strange shape for a namespace whose targets must be IPv6:
// the resolver for a v6-only network could not itself be reached over v6.
// Irrelevant on loopback, disqualifying for anything hosted.
import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";

import { createServer, encodeName, TYPE_A, TYPE_AAAA } from "../src/dns.mjs";

function query(name, type = TYPE_AAAA) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0x1234, 0);
  head.writeUInt16BE(0x0100, 2);
  head.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([head, encodeName(name), tail]);
}

const okJson = (body) => async () => ({ ok: true, json: async () => body });
const answers = (b) => b.readUInt16BE(6);

/** Ask over a specific family, so we are testing the transport not the answer. */
async function ask(family, address, port, name, type = TYPE_AAAA) {
  const client = dgram.createSocket(family);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply over ${family}`)), 5000);
      client.once("message", (m) => { clearTimeout(timer); resolve(m); });
      client.send(query(name, type), port, address);
    });
  } finally {
    client.close();
  }
}

const live = okJson({ name_registered: true, target: "2606:4700:4700::1111" });

test("binding :: answers both families from one socket", async (t) => {
  const server = await createServer({ port: 0, host: "::", fetchImpl: live });
  t.after(() => server.close());

  // The v4 client is the one that breaks without ipv6Only:false — a plain v6
  // bind is v6-only and IPv4 clients get silence rather than an error.
  const overV4 = await ask("udp4", "127.0.0.1", server.port, "blue.eggs");
  assert.equal(answers(overV4), 1, "IPv4 client answered");
  assert.deepEqual([...overV4.subarray(overV4.length - 16).subarray(0, 4)], [0x26, 0x06, 0x47, 0x00]);

  const overV6 = await ask("udp6", "::1", server.port, "blue.eggs");
  assert.equal(answers(overV6), 1, "IPv6 client answered");
  assert.deepEqual([...overV6.subarray(overV6.length - 16).subarray(0, 4)], [0x26, 0x06, 0x47, 0x00]);
});

test("the default bind is unchanged — loopback IPv4, as before", async (t) => {
  // A machine that upgrades must not start answering on addresses it did not
  // answer on yesterday. Serving anything wider is a deliberate act.
  const server = await createServer({ port: 0, fetchImpl: live });
  t.after(() => server.close());
  assert.equal(server.address, "127.0.0.1");

  const reply = await ask("udp4", "127.0.0.1", server.port, "blue.eggs");
  assert.equal(answers(reply), 1);
});

test("an explicit IPv6 loopback bind works on its own", async (t) => {
  const server = await createServer({ port: 0, host: "::1", fetchImpl: live });
  t.after(() => server.close());
  const reply = await ask("udp6", "::1", server.port, "blue.eggs");
  assert.equal(answers(reply), 1);
});

test("an A query still answers over either family", async (t) => {
  const server = await createServer({
    port: 0,
    host: "::",
    fetchImpl: okJson({ name_registered: true, target: "203.0.113.7" }),
  });
  t.after(() => server.close());

  for (const [family, address] of [["udp4", "127.0.0.1"], ["udp6", "::1"]]) {
    const reply = await ask(family, address, server.port, "blue.eggs", TYPE_A);
    assert.deepEqual([...reply.subarray(reply.length - 4)], [203, 0, 113, 7], family);
  }
});
