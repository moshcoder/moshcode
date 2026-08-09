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
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { execFileSync } from "node:child_process";

import {
  PROXY_PORT, PROXY_ROOT_CN, addressAnswer, dnsCommand, findLocalProxy, proxyReachable, proxyServes,
} from "../src/dns.mjs";

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

/* ------------------------------------------------------------ certificates -*/

/**
 * A leaf issued by a root named `cn`, the way moshpit-proxy issues one per name.
 *
 * Real openssl rather than a fixture: the whole decision reads
 * `getPeerCertificate().issuer.CN` off a completed handshake, and a hand-built
 * object would prove only that the test sets the field the code looks at.
 */
function chain(leafName, issuerCn) {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "proxy-mode-"));
  const p = (f) => path.join(dir, f);
  const quiet = { stdio: "ignore" };

  execFileSync("openssl", [
    "req", "-x509", "-nodes", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-keyout", p("ca.key"), "-out", p("ca.crt"), "-days", "1",
    "-subj", `/CN=${issuerCn}`, "-addext", "basicConstraints=critical,CA:TRUE",
  ], quiet);

  execFileSync("openssl", [
    "req", "-new", "-nodes", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-keyout", p("leaf.key"), "-out", p("leaf.csr"), "-subj", `/CN=${leafName}`,
  ], quiet);

  fsSync.writeFileSync(p("ext.cnf"), `subjectAltName=DNS:${leafName}\nbasicConstraints=critical,CA:FALSE\n`);
  execFileSync("openssl", [
    "x509", "-req", "-in", p("leaf.csr"), "-CA", p("ca.crt"), "-CAkey", p("ca.key"),
    "-CAcreateserial", "-out", p("leaf.crt"), "-days", "1", "-extfile", p("ext.cnf"),
  ], quiet);

  return { cert: fsSync.readFileSync(p("leaf.crt")), key: fsSync.readFileSync(p("leaf.key")), dir };
}

/** A self-signed certificate: an origin's own, which is what nginx serves. */
function selfSigned(name) {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "origin-"));
  const p = (f) => path.join(dir, f);
  execFileSync("openssl", [
    "req", "-x509", "-nodes", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-keyout", p("k.pem"), "-out", p("c.pem"), "-days", "1",
    "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`,
    "-addext", "basicConstraints=critical,CA:FALSE",
  ], { stdio: "ignore" });
  return { cert: fsSync.readFileSync(p("c.pem")), key: fsSync.readFileSync(p("k.pem")) };
}

/** A TLS server on an ephemeral loopback port, closed when the test ends. */
async function serve(t, { cert, key }) {
  const server = tls.createServer({ cert, key }, (socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

/* ------------------------------------------------------------------ probe --*/

test("the proxy is recognised by who issued the certificate it serves", async (t) => {
  const port = await serve(t, chain("chovy.hacker", PROXY_ROOT_CN));
  const result = await proxyServes("127.0.0.1", "chovy.hacker", { port });
  assert.equal(result.ok, true);
  assert.equal(result.issuer, PROXY_ROOT_CN);
});

test("nginx on an origin is refused, however reachable it is", async (t) => {
  // The case that makes a bare connect probe unsafe. This server answers, and
  // answering is exactly what would have turned proxy mode on and pointed every
  // name on the machine at a web server that knows nothing about them.
  const port = await serve(t, selfSigned("chovy.hacker"));
  const result = await proxyServes("127.0.0.1", "chovy.hacker", { port });
  assert.equal(result.ok, false);
  assert.match(result.why, /something other than the proxy owns/);
  assert.equal(result.issuer, "chovy.hacker", "the origin's certificate is its own issuer");
});

test("nothing listening is a refusal, not a crash", async () => {
  // Port 1 on loopback: reserved, never bound.
  const result = await proxyServes("127.0.0.1", "chovy.hacker", { port: 1, timeoutMs: 1500 });
  assert.equal(result.ok, false);
  assert.ok(result.why);
  assert.equal(result.issuer, undefined, "a connection that never completed has no issuer to report");
});

test("findLocalProxy reports the family it actually found, not both", async (t) => {
  const port = await serve(t, chain("chovy.hacker", PROXY_ROOT_CN));
  const found = await findLocalProxy("chovy.hacker", { candidates: ["127.0.0.1"], port });
  assert.equal(found.found, true);
  assert.equal(found.address.v4, "127.0.0.1");
  // Answering ::1 for a v4-only listener is a refused connection that reads as
  // the site being down.
  assert.equal(found.address.v6, null);
});

test("findLocalProxy keeps the informative refusal, not the boring one", async (t) => {
  const port = await serve(t, selfSigned("chovy.hacker"));
  const found = await findLocalProxy("chovy.hacker", { candidates: ["127.0.0.1"], port });
  assert.equal(found.found, false);
  // "something else owns 443" is worth printing; ECONNREFUSED just means no
  // proxy is installed and has its own, softer message.
  assert.match(found.why, /something other than the proxy owns/);
});

/* ------------------------------------------------------------ dns enable ---*/

function enableDeps(extra = {}) {
  return {
    tlds: async () => ["hacker"],
    safety: async () => ({ safe: true, upstreams: ["1.1.1.1"], why: "no bridge is running yet" }),
    preflight: async () => ({ ok: true, blockers: [], conflicts: [], holder: null }),
    verify: async () => ({ ok: true, checks: [] }),
    bridgeStatus: async () => ({ running: false, pid: null, stale: false }),
    stopBridge: async () => ({ stopped: true, reason: null }),
    dropins: async () => [],
    readManifest: async () => null,
    manifestFile: path.join(os.tmpdir(), "moshcode-proxy-mode-manifest.json"),
    uid: 0,
    ...extra,
  };
}

test("a proxy that is really there is switched on, without being asked", async () => {
  // The whole point. Everything else was already built — the proxy checks
  // origins against registry pins, `dns enable` installs the root it signs with
  // — and none of it was on the path, because nothing ever turned this on.
  const lines = [];
  let startedWith = null;
  await dnsCommand(["enable"], (l) => lines.push(String(l)), enableDeps({
    findLocalProxyImpl: async () => ({ found: true, why: null, address: { v4: "127.0.0.1", v6: "::1" } }),
    startBridge: async (opts) => { startedWith = opts; return { started: true, pid: 1, alreadyRunning: false }; },
  }));

  assert.equal(startedWith.proxy, "127.0.0.1");
  assert.match(lines.join("\n"), /pinned-TLS proxy on 127\.0\.0\.1, ::1:443/);
});

test("no proxy means names answer their origin, and it says why that is not enough", async () => {
  const lines = [];
  let startedWith = null;
  await dnsCommand(["enable"], (l) => lines.push(String(l)), enableDeps({
    findLocalProxyImpl: async () => ({ found: false, why: null, address: { v4: null, v6: null } }),
    startBridge: async (opts) => { startedWith = opts; return { started: true, pid: 1, alreadyRunning: false }; },
  }));

  // Refusing is the safe direction: proxy mode with nothing behind it resolves
  // every Moshpit name and then refuses every connection.
  assert.equal(startedWith.proxy, null);
  assert.match(lines.join("\n"), /no pinned-TLS proxy on this machine/);
});

test("something else on 443 is named, rather than being quietly treated as the proxy", async () => {
  const lines = [];
  let startedWith = null;
  await dnsCommand(["enable"], (l) => lines.push(String(l)), enableDeps({
    findLocalProxyImpl: async () => ({
      found: false,
      why: 'something other than the proxy owns 127.0.0.1:443 — it served a certificate issued by "chovy.hacker"',
      address: { v4: null, v6: null },
    }),
    startBridge: async (opts) => { startedWith = opts; return { started: true, pid: 1, alreadyRunning: false }; },
  }));

  assert.equal(startedWith.proxy, null);
  const said = lines.join("\n");
  assert.match(said, /something other than the proxy owns/);
  assert.match(said, /proxy mode stays off/);
});

test("--no-proxy skips the probe entirely", async () => {
  const lines = [];
  let probed = false;
  let startedWith = null;
  await dnsCommand(["enable", "--no-proxy"], (l) => lines.push(String(l)), enableDeps({
    findLocalProxyImpl: async () => { probed = true; return { found: true, why: null, address: { v4: "127.0.0.1", v6: null } }; },
    startBridge: async (opts) => { startedWith = opts; return { started: true, pid: 1, alreadyRunning: false }; },
  }));

  assert.equal(probed, false, "the flag means do not look, not look and ignore");
  assert.equal(startedWith.proxy, null);
});

test("a bridge this run did not start is not claimed to be proxying", async () => {
  // `startDaemon` decides "already running" from our pidfile, so a bridge
  // started by systemd or by hand keeps whatever mode it has. Printing
  // "proxying every live name" over it is the exact species of lie this whole
  // change exists to stop telling.
  const lines = [];
  let startedWith = "untouched";
  let probed = false;
  await dnsCommand(["enable"], (l) => lines.push(String(l)), enableDeps({
    preflight: async () => ({
      ok: true, blockers: [], conflicts: [],
      holder: { pid: 4242, command: "bun" }, holderForwards: true,
    }),
    findLocalProxyImpl: async () => { probed = true; return { found: true, why: null, address: { v4: "127.0.0.1", v6: null } }; },
    startBridge: async (opts) => { startedWith = opts; return { started: true, pid: 1, alreadyRunning: false }; },
  }));

  const said = lines.join("\n");
  assert.equal(startedWith, "untouched", "the running bridge is reused, not restarted");
  assert.equal(probed, false, "and not probed, since the answer could not be acted on");
  assert.match(said, /keeps its own/);
  // Announcing a proxy and retracting it two lines later is worse than not
  // looking: the reader has already believed the first line.
  assert.doesNotMatch(said, /every live name will answer there/);
});
