/**
 * Pointing every live name at the local proxy, so a stock client can verify one.
 *
 * No CA will ever sign for a Moshpit name, so the only way to hand `curl` a
 * certificate it accepts is to terminate TLS locally: moshpit-proxy checks the
 * origin's key against the registry pin and re-signs with a root this machine
 * generated. That was already built, and nothing routed to it — the resolver
 * answered the origin, so the proxy sat on loopback and every name arrived at a
 * stock client as a self-signed certificate no matter what was installed.
 *
 * The mode is dangerous in exactly one direction, and these tests are mostly
 * about that direction: with the proxy there, every name works; with nothing
 * there, every name resolves and then refuses the connection, which reads as
 * "all my sites are down" while `dig` looks perfectly healthy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import dgram from "node:dgram";

import { addressAnswer, dnsCommand, proxyReachable, PROXY_PORT } from "../src/dns.mjs";

/** Hold a UDP port so the bind fails and `start` returns instead of serving. */
function holdUdp() {
  const socket = dgram.createSocket({ type: "udp4" });
  return new Promise((resolve) => {
    socket.bind(0, "127.0.0.1", () => resolve({
      port: socket.address().port,
      release: () => new Promise((done) => socket.close(done)),
    }));
  });
}

/** A registry answering one verdict for any name. */
function registry({ target = "dev.profullstack.com", registered = true, records = [] } = {}) {
  return {
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({
        name_registered: registered,
        target,
        ...(url.includes("records=1") ? { records } : {}),
      }),
    }),
  };
}

const PROXY = { v4: "127.0.0.1", v6: "::1" };

/* --------------------------------------------------------------- the routing */

test("every live name answers the proxy, whatever its target says", async () => {
  // The point of the mode: the origin is the proxy's business, not the
  // client's. A name pointed at a host, an address, or a published record all
  // arrive at the same place.
  for (const target of ["dev.profullstack.com", "203.0.113.7", "https://box.example.com"]) {
    const plan = await addressAnswer("scrambled.eggs", {
      ...registry({ target }), proxyAddress: PROXY,
    });
    assert.equal(plan.kind, "address", target);
    assert.equal(plan.address, "127.0.0.1", target);
    assert.equal(plan.proxied, true);
  }
});

test("the AAAA question gets the proxy's v6 address", async () => {
  const plan = await addressAnswer("scrambled.eggs", {
    ...registry(), proxyAddress: PROXY, wantsV6: true,
  });
  assert.equal(plan.address, "::1");
});

test("a proxy that speaks one family is NODATA for the other, not a fabricated address", async () => {
  // Answering ::1 for a v4-only listener is a connection refused that looks
  // like the site is down.
  const plan = await addressAnswer("scrambled.eggs", {
    ...registry(), proxyAddress: { v4: "127.0.0.1", v6: null }, wantsV6: true,
  });
  assert.equal(plan.kind, "nodata");
  assert.equal(plan.address, null);
  assert.equal(plan.exists, true, "the name is still here — this is NODATA, not NXDOMAIN");
});

/* ------------------------------------------------ what the mode must not swallow */

test("a name nobody holds is still NXDOMAIN with the proxy on", async () => {
  // Without this, every typo on the machine resolves to loopback and the proxy
  // is asked to verify a pin for a name that does not exist.
  const plan = await addressAnswer("scrambled.eggs", {
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
    proxyAddress: PROXY,
  });
  assert.equal(plan.kind, "nxdomain");
  assert.equal(plan.exists, false);
});

test("a parked name still reaches the parking page, not the proxy", async () => {
  // A parked name has no origin and no published pin, so handing it to a proxy
  // whose whole job is to verify one turns "this name is for sale" into a TLS
  // error.
  const plan = await addressAnswer("scrambled.eggs", {
    ...registry({ target: null }), proxyAddress: PROXY, parkingAddress: "198.51.100.9",
  });
  assert.equal(plan.address, "198.51.100.9");
  assert.notEqual(plan.proxied, true);
});

test("without the mode, nothing changes", async () => {
  const plan = await addressAnswer("scrambled.eggs", { ...registry() });
  assert.equal(plan.kind, "chain");
  assert.equal(plan.cname, "dev.profullstack.com");
});

/* ------------------------------------------------------------- the safety gate */

/** A fake connect() that succeeds or fails on demand. */
function connector(reachable) {
  return ({ host }) => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    queueMicrotask(() => socket.emit(reachable.includes(host) ? "connect" : "error", new Error("ECONNREFUSED")));
    return socket;
  };
}

test("reachability is what the gate actually measures", async () => {
  assert.equal(await proxyReachable("127.0.0.1", PROXY_PORT, { connect: connector(["127.0.0.1"]) }), true);
  assert.equal(await proxyReachable("127.0.0.1", PROXY_PORT, { connect: connector([]) }), false);
});

test("a connect that never resolves is unreachable, not a hang", async () => {
  const stalls = () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    return socket; // never emits
  };
  assert.equal(await proxyReachable("127.0.0.1", PROXY_PORT, { connect: stalls, timeoutMs: 50 }), false);
});

test("--proxy with nothing listening refuses to start", async () => {
  // The whole reason this gate exists. Starting anyway would point every live
  // name on the machine at a closed port.
  const lines = [];
  const code = await dnsCommand(["start", "--proxy", "--port", "15971"], (l) => lines.push(l), {
    tlds: async () => ["eggs"],
    proxyReachableImpl: async () => false,
  });

  assert.equal(code, 1);
  const text = lines.join("\n");
  assert.match(text, /nothing is listening on/);
  assert.match(text, /break all of them at once/, "the cost is named, not just the fact");
  assert.doesNotMatch(text, /moshpit resolver on/, "and it must not claim to have started");
});

test("--proxy names the address it will send everything to", async () => {
  const held = await holdUdp();
  try {
    const lines = [];
    const seen = [];
    await dnsCommand(["start", "--proxy", "--port", String(held.port)], (l) => lines.push(l), {
      tlds: async () => ["eggs"],
      proxyReachableImpl: async (host) => {
        seen.push(host);
        return host === "127.0.0.1";
      },
    });

    assert.deepEqual(seen, ["127.0.0.1", "::1"], "both families are probed before either is used");
    assert.match(lines.join("\n"), /proxying every live name to 127\.0\.0\.1:443/);
  } finally {
    await held.release();
  }
});

test("an explicit --proxy host is the only one probed", async () => {
  const held = await holdUdp();
  try {
    const seen = [];
    await dnsCommand(["start", "--proxy", "10.0.0.5", "--port", String(held.port)], () => {}, {
      tlds: async () => ["eggs"],
      proxyReachableImpl: async (host) => {
        seen.push(host);
        return true;
      },
    });
    assert.deepEqual(seen, ["10.0.0.5"]);
  } finally {
    await held.release();
  }
});

test("--proxy with a host name refuses instead of NODATA'ing every live name", async () => {
  // A name like `localhost` passes the reachability probe (connect resolves it)
  // but cannot go in an A/AAAA answer, so the mode would announce success and
  // then answer every live name with nothing — the outage the gate exists for.
  // Hold the resolver port so that even without the fix `start` cannot bind and
  // sit on the loop — the assertion is about the refusal, not the bind.
  const held = await holdUdp();
  try {
    const lines = [];
    let probed = false;
    const code = await dnsCommand(["start", "--proxy", "localhost", "--port", String(held.port)], (l) => lines.push(l), {
      tlds: async () => ["eggs"],
      proxyReachableImpl: async () => { probed = true; return true; },
    });

    assert.equal(code, 1);
    assert.equal(probed, false, "a host name is rejected before anything is probed");
    const text = lines.join("\n");
    assert.match(text, /needs an IP address/);
    assert.doesNotMatch(text, /proxying every live name/, "it must not claim to have started proxying");
  } finally {
    await held.release();
  }
});
