// What the resolver does when its own socket fails after it is already serving.
//
// `dns start` is not a request that finishes. It binds, prints where it is
// listening, and then holds the process open until Ctrl-C, which makes staying
// up its entire job. The bind-time rejector used to be left attached to the
// socket after a successful bind, so it was still the socket's only 'error'
// listener while the resolver ran: the first post-bind error called reject() on
// a promise that had already resolved (nothing happened, and nothing was
// logged, even though onQuery narrates every ordinary lookup), and the second
// arrived with no listener left and killed the process.
//
// The sibling parking server drops its rejector in the listen callback
// (parking-http.mjs) and always has. These tests pin the same discipline here,
// plus the durable handler the daemon needs on top of it: removing the rejector
// alone would only promote the *first* error to the fatal one.
import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";

import { createServer, encodeName, TYPE_A } from "../src/dns.mjs";

// createServer keeps its socket to itself, which is right — nothing outside
// needs it. Capturing it here is the only way to make the socket fail on
// purpose rather than waiting for the network to do it.
function captureSocket() {
  const made = [];
  const real = dgram.createSocket.bind(dgram);
  dgram.createSocket = (...args) => {
    const socket = real(...args);
    made.push(socket);
    return socket;
  };
  return {
    take: () => made[made.length - 1],
    restore: () => { dgram.createSocket = real; },
  };
}

function query(name, { id = 0x1234, type = TYPE_A } = {}) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(0x0100, 2);
  head.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([head, encodeName(name), tail]);
}

function ask(server, name) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket("udp4");
    client.once("message", (msg) => { client.close(); resolve(msg); });
    client.once("error", (err) => { client.close(); reject(err); });
    client.send(query(name), server.port, "127.0.0.1");
  });
}

/* ------------------------------------------------- errors after a good bind */

test("a socket error after bind is reported instead of vanishing", async (t) => {
  const cap = captureSocket();
  t.after(() => cap.restore());
  const seen = [];
  const server = await createServer({
    port: 0,
    host: "127.0.0.1",
    onError: (err) => seen.push(err),
  });
  const socket = cap.take();
  t.after(() => server.close());

  socket.emit("error", new Error("ENETDOWN"));

  assert.equal(seen.length, 1, "the resolver was told its socket failed");
  assert.equal(seen[0].message, "ENETDOWN");
});

test("a second socket error after bind is still handled, not fatal", async (t) => {
  const cap = captureSocket();
  t.after(() => cap.restore());
  const seen = [];
  const server = await createServer({
    port: 0,
    host: "127.0.0.1",
    onError: (err) => seen.push(err),
  });
  const socket = cap.take();
  t.after(() => server.close());

  socket.emit("error", new Error("first"));
  socket.emit("error", new Error("second"));

  // With no listener the second emit throws out of .emit() and, in a running
  // daemon, ends the process. Reaching this line at all is the assertion.
  assert.deepEqual(seen.map((e) => e.message), ["first", "second"]);
  assert.ok(socket.listenerCount("error") > 0, "the resolver keeps an error listener while it serves");
});

test("the resolver's error listener is durable, not spent on the first error", async (t) => {
  const cap = captureSocket();
  t.after(() => cap.restore());
  const server = await createServer({ port: 0, host: "127.0.0.1", onError: () => {} });
  const socket = cap.take();
  t.after(() => server.close());

  // Counting listeners before the first error cannot tell the two states
  // apart: a leftover `once` rejector is also exactly one listener. What
  // separates them is what survives firing — a rejector is consumed and leaves
  // the socket bare, which is what made the *second* error fatal.
  assert.equal(socket.listenerCount("error"), 1, "exactly one handler while serving");
  socket.emit("error", new Error("ENETDOWN"));
  assert.equal(socket.listenerCount("error"), 1, "and still one after it fires");
});

test("a socket error does not stop the resolver answering", async (t) => {
  const cap = captureSocket();
  t.after(() => cap.restore());
  const server = await createServer({
    port: 0,
    host: "127.0.0.1",
    tldSet: new Set(["eggs"]),
    fetchImpl: async () => ({ ok: true, json: async () => ({ name_registered: true, target: "203.0.113.7" }) }),
    onError: () => {},
  });
  const socket = cap.take();
  t.after(() => server.close());

  socket.emit("error", new Error("ENETDOWN"));

  const reply = await ask(server, "blue.eggs");
  assert.deepEqual([...reply.subarray(reply.length - 4)], [203, 0, 113, 7], "still serving after the error");
});

/* ------------------------------------- the bind failure itself is unchanged */

test("a bind failure still rejects", async (t) => {
  const squatter = dgram.createSocket("udp4");
  await new Promise((done) => squatter.bind(0, "127.0.0.1", done));
  const taken = squatter.address().port;
  t.after(() => new Promise((done) => squatter.close(done)));

  await assert.rejects(
    () => createServer({ port: taken, host: "127.0.0.1", onError: () => {} }),
    (err) => err instanceof Error,
    "the port being in use is still reported to the caller",
  );
});

test("onError is optional", async (t) => {
  const cap = captureSocket();
  t.after(() => cap.restore());
  const server = await createServer({ port: 0, host: "127.0.0.1" });
  const socket = cap.take();
  t.after(() => server.close());

  // No onError passed: the default must still absorb the error rather than
  // leaving the socket bare.
  socket.emit("error", new Error("ENETDOWN"));
  assert.ok(true, "survived without an onError of its own");
});
