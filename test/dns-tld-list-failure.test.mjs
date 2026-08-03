/**
 * What `dns start` says when it could not read the list of endings.
 *
 * This was the quietest way to switch the whole namespace off. `isOurs()` gates
 * every answer on the ending set, so an empty one makes the bridge say "not
 * mine" to every name — and with upstreams configured, "not mine" means forward
 * to the clearnet, which denies the entire Moshpit namespace by definition.
 *
 * The result is a machine where `dig` answers promptly, google.com resolves,
 * `resolvectl` looks right, `systemctl status` is green, and every Moshpit name
 * is NXDOMAIN. Nothing in any log said the list had not loaded, because the
 * fetch was wrapped in `.catch(() => [])` and the empty array is also what a
 * registry with no endings would legitimately return.
 *
 * The line immediately below it has always warned about missing upstreams. What
 * we answer for is worth at least as much as what we forward to.
 *
 * Every test drives the failure through a held port, so the command prints its
 * diagnosis and then returns rather than binding and serving forever.
 */
import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";

import { dnsCommand } from "../src/dns.mjs";

const DEAD_REGISTRY = "http://127.0.0.1:1";

/** Hold a UDP port so the resolver bind fails and `start` returns. */
function holdUdp() {
  const socket = dgram.createSocket({ type: "udp4" });
  return new Promise((resolve) => {
    socket.bind(0, "127.0.0.1", () => resolve({
      port: socket.address().port,
      release: () => new Promise((done) => socket.close(done)),
    }));
  });
}

/** Run `dns start` with an injected ending list, on a port that cannot bind. */
async function start(port, tlds) {
  const lines = [];
  const code = await dnsCommand(
    ["start", "--port", String(port), "--parking-port", String(port), "--registry", DEAD_REGISTRY],
    (line) => lines.push(line),
    { tlds },
  );
  return { code, out: lines.join("\n") };
}

test("a TLD list that could not be fetched is reported, with the cost named", async () => {
  const held = await holdUdp();
  try {
    const { out } = await start(held.port, async () => {
      throw new Error("registry unreachable");
    });

    assert.match(out, /could not read the ending list/);
    assert.match(out, /registry unreachable/, "the reason belongs in the message, not just the fact");
    // The consequence is the part an operator can act on. "no endings loaded"
    // reads as a detail; this is the namespace being off.
    assert.match(out, /every Moshpit name will be forwarded to the clearnet/);
  } finally {
    await held.release();
  }
});

test("an empty TLD list is reported too, not just a thrown one", async () => {
  // A registry that answers with nothing is indistinguishable in effect from one
  // that does not answer, and it was the case the old `.catch(() => [])` could
  // never have caught: no error was ever thrown.
  const held = await holdUdp();
  try {
    const { out } = await start(held.port, async () => []);
    assert.match(out, /could not read the ending list/);
  } finally {
    await held.release();
  }
});

test("a TLD list that loaded says so, so the quiet case is not the same as the broken one", async () => {
  const held = await holdUdp();
  try {
    const { out } = await start(held.port, async () => ["eggs", "hacker", "rank"]);

    assert.match(out, /answering for 3 endings/);
    assert.doesNotMatch(out, /could not read the ending list/);
    assert.doesNotMatch(out, /forwarded to the clearnet/);
  } finally {
    await held.release();
  }
});

test("the ending list is taken from deps, the way `enable` already takes it", async () => {
  // `start` reached past the injected dependency to the module-level function,
  // which is why this whole branch had never been exercised by a test.
  const held = await holdUdp();
  let asked = 0;
  try {
    await start(held.port, async () => {
      asked += 1;
      return ["eggs"];
    });
    assert.equal(asked, 1, "the injected fetcher is the one that ran");
  } finally {
    await held.release();
  }
});
