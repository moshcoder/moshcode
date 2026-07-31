// What a Moshpit name is allowed to point at.
//
// The target is typed in by whoever holds the name, and this server fetches it
// from inside whatever network it runs in. That makes every one of these an
// SSRF test: the failure is not "the page looks wrong", it is "the gateway
// returned our cloud credentials to the person who asked for them".
import assert from "node:assert/strict";
import test from "node:test";

import {
  blockedReason, checkTarget, forwardableHeaders, parseTarget,
} from "../src/lib/moshpit-gateway.mjs";

test("addresses that must never be fetched", () => {
  const blocked = {
    "127.0.0.1": /loopback/,
    "127.1.2.3": /loopback/,
    "0.0.0.0": /this host/,
    "10.1.2.3": /private/,
    "172.16.5.5": /private/,
    "172.31.255.255": /private/,
    "192.168.1.1": /private/,
    "169.254.169.254": /link-local/,   // the one that hands out cloud credentials
    "100.64.0.1": /carrier-grade NAT/,
    "224.0.0.1": /multicast/,
    "240.0.0.1": /reserved/,
    "::1": /loopback/,
    "fe80::1": /link-local/,
    "fc00::1": /unique local/,
    "ff02::1": /multicast/,
    "::ffff:127.0.0.1": /loopback/,    // IPv4-mapped, or every v4 rule is skippable
    "::ffff:169.254.169.254": /link-local/,
  };
  for (const [ip, why] of Object.entries(blocked)) {
    assert.match(blockedReason(ip) || "", why, ip);
  }
});

test("ordinary public addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"]) {
    assert.equal(blockedReason(ip), null, ip);
  }
});

test("172.32 is public even though 172.16/12 is not", () => {
  // The /12 boundary is the classic off-by-one in a hand-written deny list.
  assert.equal(blockedReason("172.15.255.255"), null);
  assert.match(blockedReason("172.16.0.0"), /private/);
  assert.match(blockedReason("172.31.255.255"), /private/);
  assert.equal(blockedReason("172.32.0.0"), null);
});

test("anything that is not an address is refused, not assumed routable", () => {
  for (const junk of ["", "not-an-ip", "999.1.1.1", "1.2.3", null, undefined]) {
    assert.ok(blockedReason(junk), JSON.stringify(junk));
  }
});

test("targets parse in the shapes people type", () => {
  assert.deepEqual(parseTarget("203.0.113.7"), { host: "203.0.113.7", port: 80 });
  assert.deepEqual(parseTarget("203.0.113.7:8080"), { host: "203.0.113.7", port: 8080 });
  assert.deepEqual(parseTarget("http://example.com"), { host: "example.com", port: 80 });
  assert.deepEqual(parseTarget("https://example.com:3000/"), { host: "example.com", port: 3000 });
  assert.deepEqual(parseTarget("[2606:4700::1111]:8080"), { host: "2606:4700::1111", port: 8080 });
  assert.deepEqual(parseTarget("2606:4700::1111"), { host: "2606:4700::1111", port: 80 });
  assert.equal(parseTarget("  "), null);
  assert.equal(parseTarget("example.com:99999"), null, "not a port");
});

test("a literal private address is refused before any lookup", async () => {
  const never = () => { throw new Error("should not resolve a literal"); };
  const result = await checkTarget("169.254.169.254", { resolve: never });
  assert.equal(result.ok, false);
  assert.match(result.error, /link-local/);
});

test("a hostname is judged on what it resolves to, not how it looks", async () => {
  // `internal.example.com` is a perfectly public-looking name. Checking the
  // string instead of the answer is how this class of bug survives review.
  const resolve = async () => [{ address: "10.0.0.5" }];
  const result = await checkTarget("innocent.example.com", { resolve });
  assert.equal(result.ok, false);
  assert.match(result.error, /resolves to private/);
});

test("one bad address among good ones fails the whole target", async () => {
  const resolve = async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }];
  const result = await checkTarget("split.example.com", { resolve });
  assert.equal(result.ok, false, "a public A record does not make the others safe");
});

test("a public hostname passes and reports where it went", async () => {
  const resolve = async () => [{ address: "93.184.216.34" }];
  const result = await checkTarget("example.com:8080", { resolve });
  assert.deepEqual(result, { ok: true, host: "example.com", port: 8080, addresses: ["93.184.216.34"] });
});

test("a name that does not resolve is refused", async () => {
  const result = await checkTarget("nx.example.com", { resolve: async () => { throw new Error("NXDOMAIN"); } });
  assert.equal(result.ok, false);
  assert.match(result.error, /does not resolve/);
});

test("credentials are never forwarded to an origin", () => {
  const headers = forwardableHeaders({
    cookie: "mc_sess=secret",
    authorization: "Bearer secret",
    "x-forwarded-for": "203.0.113.9",
    accept: "text/html",
    "user-agent": "curl/8",
  }, "blue.eggs");

  // The visitor's session on app.moshcode.sh has nothing to do with the origin,
  // and forwarding it hands a name's owner their visitors' credentials.
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["x-forwarded-for"], undefined);

  assert.equal(headers.accept, "text/html");
  assert.equal(headers["user-agent"], "curl/8");
  // The origin virtual-hosts on the name; the TCP connection only knows an IP.
  assert.equal(headers.host, "blue.eggs");
  assert.equal(headers["x-moshpit-name"], "blue.eggs");
});
