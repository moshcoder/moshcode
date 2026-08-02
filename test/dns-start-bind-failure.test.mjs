// What `dns start` does when the resolver's own port is not available.
//
// The command already knows how to explain a bind it could not make: 25 lines
// above the resolver bind, the optional parking HTTP server is created inside a
// try/catch that turns EACCES and EADDRINUSE into a sentence and carries on.
// The resolver bind underneath it had no catch at all, so the same two error
// codes — on the port that is the entire point of the command — came out as a
// raw node:dgram stack trace from an unhandled rejection, because bin/moshcode
// calls main() without a top-level catch.
//
// The resolver failing IS fatal, unlike the parking server, so the fix is not
// "carry on" — it is the shape serve.mjs already uses for a step it cannot
// complete: say what failed, say what to do about it, return 1.
//
// The leak is the same bug. The parking server is created FIRST, so it is
// listening when the resolver bind fails. While the crash took the process
// down that was invisible; the moment the command returns instead of crashing,
// an unclosed listener holds the event loop open and `dns start` hangs on a
// busy port rather than exiting. Handling the error and closing the parking
// server are one change, and test 2 pins the half that has no output to check.
import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import net from "node:net";

import { createServer, dnsCommand } from "../src/dns.mjs";

// Nothing here may touch the network. A registry that cannot connect is enough:
// `dns start` already wraps its TLD fetch in .catch(() => []).
const DEAD_REGISTRY = "http://127.0.0.1:1";

/** Hold a UDP port so the resolver's bind is guaranteed to fail. */
function holdUdp() {
  const socket = dgram.createSocket({ type: "udp4" });
  return new Promise((resolve) => {
    socket.bind(0, "127.0.0.1", () => resolve({
      port: socket.address().port,
      release: () => new Promise((done) => socket.close(done)),
    }));
  });
}

/** Can a TCP listener still take this port, i.e. did the parking server let go? */
function tcpPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

// UDP and TCP are separate port namespaces, so one number can be busy for the
// resolver and free for the parking server at the same moment. That is what
// makes this deterministic: the parking server binds, the resolver does not,
// and no second port has to be guessed.
async function startOnBusyPort(port, extra = []) {
  const lines = [];
  const code = await dnsCommand(
    ["start", "--port", String(port), "--parking-port", String(port), "--registry", DEAD_REGISTRY, ...extra],
    (line) => lines.push(line),
  );
  return { code, out: lines.join("\n") };
}

/* ------------------------------------------ the resolver port is unavailable */

test("dns start explains an unavailable resolver port instead of crashing", async () => {
  const held = await holdUdp();
  try {
    const { code, out } = await startOnBusyPort(held.port);

    assert.equal(code, 1, "an unusable resolver port is a failed command, not a crash");
    assert.match(out, /resolver could not start/);
    assert.match(out, new RegExp(`port ${held.port} is already in use`));
    // The point of the change: an operator gets a sentence, not Node's internals.
    assert.doesNotMatch(out, /node:dgram|at process\.processTicksAndRejections/);
    // And it must not claim the thing it failed to do.
    assert.doesNotMatch(out, /moshpit resolver on/);
  } finally {
    await held.release();
  }
});

test("dns start closes the parking server it opened before the resolver failed", async () => {
  const held = await holdUdp();
  try {
    const { code, out } = await startOnBusyPort(held.port);
    assert.equal(code, 1);
    // Proof the parking server really did bind: the command reports it when it
    // could not ("! parked names will not serve over HTTP"), and does not here.
    // It cannot announce the port it took, because that line is printed after a
    // successful resolver bind — which is the whole reason the leak was silent.
    assert.doesNotMatch(out, /parked names will not serve over HTTP/);
    assert.equal(
      await tcpPortFree(held.port),
      true,
      "the parking listener outlived the command and would hold the process open",
    );
  } finally {
    await held.release();
  }
});

/* ------------------------------------------------------------------ controls */

test("createServer itself still rejects a bind it cannot make", async () => {
  // The handling belongs to the command, not to the factory. Callers that want
  // to know a bind failed — including the two tests above — still find out.
  const held = await holdUdp();
  try {
    await assert.rejects(
      () => createServer({ port: held.port, host: "127.0.0.1" }),
      (err) => err.code === "EADDRINUSE",
    );
  } finally {
    await held.release();
  }
});

test("dns start still rejects a malformed --port before binding anything", async () => {
  const lines = [];
  const code = await dnsCommand(
    ["start", "--port", "http", "--registry", DEAD_REGISTRY],
    (line) => lines.push(line),
  );
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /--port needs a decimal integer from 1 to 65535, got "http"/);
});

test("dns start still rejects a malformed --parking-port before binding anything", async () => {
  const lines = [];
  const code = await dnsCommand(
    ["start", "--parking-port", "-1", "--registry", DEAD_REGISTRY],
    (line) => lines.push(line),
  );
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /--parking-port needs a decimal integer from 1 to 65535, got "-1"/);
});
