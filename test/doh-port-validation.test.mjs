// `doh --port` used to be a bare Number(), which disagreed with the DNS
// bridge's own port parser in both directions:
//
//   moshcode doh --port abc     -> NaN reached listen(), raw ERR_SOCKET_BAD_PORT stack
//   moshcode doh --port 99999   -> same, out of range
//   moshcode doh --port         -> same, no value at all
//   moshcode doh --port 0       -> bound a RANDOM ephemeral port and reported it,
//                                  so the proxy pointed at 8053 talks to nothing
//   moshcode doh --port 1e3     -> bound 1000, a form `dns install --port` refuses
//
// The last two are the ones worth a test on their own: they are silent. A
// resolver that starts on a port nobody asked for looks like it worked.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseDohPort, DEFAULT_DOH_PORT } from "../src/doh-server.mjs";
import { parseDnsPort } from "../src/dns.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

const runDoh = (args) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, "doh", ...args], { timeout: 20_000 }, (error, stdout, stderr) => {
    resolve({ code: error?.code ?? 0, stdout, stderr });
  });
});

test("doh --port refuses everything the DNS bridge refuses", () => {
  for (const value of ["", "abc", "0", "1.5", "1e3", "-1", "65536", " ", "9007199254740992"]) {
    assert.equal(parseDohPort(["--port", value]).ok, false, `should refuse ${JSON.stringify(value)}`);
    // The two parsers have to agree, or the same string means different
    // things to `dns` and to `doh`.
    assert.equal(parseDnsPort(value), null);
  }
  assert.equal(parseDohPort(["--port"]).ok, false);
});

test("doh --port takes a real port, and its absence is the default", () => {
  assert.deepEqual(parseDohPort(["--port", "8053"]), { ok: true, port: 8053 });
  assert.deepEqual(parseDohPort(["--port", " 443 "]), { ok: true, port: 443 });
  assert.deepEqual(parseDohPort(["--port", "65535"]), { ok: true, port: 65535 });
  assert.deepEqual(parseDohPort([]), { ok: true, port: DEFAULT_DOH_PORT });
  assert.deepEqual(parseDohPort(["--no-guards"]), { ok: true, port: DEFAULT_DOH_PORT });
  // The flag is read positionally, so an unrelated flag must not be eaten as
  // its value.
  assert.equal(parseDohPort(["--port", "--no-guards"]).ok, false);
});

test("doh --port reports a bad port instead of crashing on it", async () => {
  for (const value of ["abc", "99999", "-1"]) {
    const { code, stdout, stderr } = await runDoh(["--port", value]);

    assert.equal(code, 1, `exit code for ${value}`);
    assert.match(stderr, /--port needs a decimal integer from 1 to 65535/);
    assert.match(stderr, new RegExp(`got "${value}"`));
    // The whole point: a message, not a node internal.
    assert.doesNotMatch(stderr + stdout, /ERR_SOCKET_BAD_PORT|node:net/);
  }
});

test("doh --port 0 is refused rather than binding a random port", async () => {
  const { code, stdout, stderr } = await runDoh(["--port", "0"]);

  assert.equal(code, 1);
  assert.match(stderr, /--port needs a decimal integer from 1 to 65535, got "0"/);
  // Before the fix this printed a live URL on whatever ephemeral port the
  // kernel handed out.
  assert.doesNotMatch(stdout, /DoH resolver on/);
});

test("doh --port 1e3 is refused rather than binding 1000", async () => {
  const { code, stdout, stderr } = await runDoh(["--port", "1e3"]);

  assert.equal(code, 1);
  assert.match(stderr, /--port needs a decimal integer from 1 to 65535, got "1e3"/);
  assert.doesNotMatch(stdout, /DoH resolver on/);
});
