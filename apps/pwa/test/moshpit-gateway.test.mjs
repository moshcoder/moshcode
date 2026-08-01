// What a Moshpit name is allowed to point at.
//
// The target is typed in by whoever holds the name, and this server fetches it
// from inside whatever network it runs in. That makes every one of these an
// SSRF test: the failure is not "the page looks wrong", it is "the gateway
// returned our cloud credentials to the person who asked for them".
import assert from "node:assert/strict";
import test from "node:test";

import {
  blockedReason, checkTarget, forwardableHeaders, normalizeTarget, originUrl, parseTarget, urlHost,
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
  assert.deepEqual(result, {
    ok: true,
    host: "example.com",
    port: 8080,
    origin: "http://example.com:8080",
    addresses: ["93.184.216.34"],
  });
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

/* --------------------------------------------------------- what may be stored */

test("an IPv6 target survives the round trip into a fetchable URL", async () => {
  // The bug this pins: `http://2606:4700::1111:80/` is not a URL. Unbracketed,
  // the address's own colons are indistinguishable from the port separator, so
  // fetch rejected it and every IPv6 name 504'd with "could not be reached".
  const stored = normalizeTarget("2606:4700:4700::1111");
  assert.equal(stored.target, "2606:4700:4700::1111");

  const result = await checkTarget(stored.target);
  assert.equal(result.ok, true);
  assert.equal(result.origin, "http://[2606:4700:4700::1111]:80");
  assert.doesNotThrow(() => new URL(`${result.origin}/`));
  assert.equal(urlHost("203.0.114.9"), "203.0.114.9");
  assert.equal(originUrl({ host: "box.example.com", port: 8080 }), "http://box.example.com:8080");
});

test("IPv4 literals are refused, and the message says what to use instead", () => {
  const result = normalizeTarget("203.0.114.9");
  assert.equal(result.ok, false);
  assert.match(result.error, /IPv6/);
});

test("empty is not an error — a name may wait to be pointed", () => {
  for (const empty of ["", "   ", null, undefined]) {
    assert.deepEqual(normalizeTarget(empty), { ok: true, target: null });
  }
});

test("a port forces brackets, and only then", () => {
  assert.equal(normalizeTarget("2606:4700::1111").target, "2606:4700::1111");
  assert.equal(normalizeTarget("[2606:4700::1111]:8080").target, "[2606:4700::1111]:8080");
  assert.equal(normalizeTarget("http://[2606:4700::1111]:8080/").target, "[2606:4700::1111]:8080");
});

test("hostnames stay allowed, lowercased, scheme stripped", () => {
  assert.equal(normalizeTarget("https://Box.Example.COM/").target, "box.example.com");
  assert.equal(normalizeTarget("box.example.com:8443").target, "box.example.com:8443");
  assert.equal(normalizeTarget("not a hostname").ok, false);
  // A bare label has no dot, so it cannot be a public name.
  assert.equal(normalizeTarget("localhost").ok, false);
});

test("an unroutable IPv6 address is refused at the form, not at fetch time", () => {
  // Storing it would mint a name that looks live and 502s for every visitor.
  for (const addr of ["::1", "fe80::1", "fd00::1", "ff02::1"]) {
    assert.equal(normalizeTarget(addr).ok, false, addr);
  }
});
