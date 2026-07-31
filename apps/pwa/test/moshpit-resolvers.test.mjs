// The resolver list is rendered on /pit/dns for strangers to copy into their
// network settings, so a malformed entry has to disappear rather than be shown
// as an instruction.
import assert from "node:assert/strict";
import test from "node:test";

import { isIpAddress, parseResolvers, resolverConfig } from "../src/lib/moshpit-resolvers.mjs";

test("resolvers parse with or without a name", () => {
  assert.deepEqual(parseResolvers("dns1.pit.moshcode.sh=203.0.113.7, 203.0.113.8"), [
    { name: "dns1.pit.moshcode.sh", address: "203.0.113.7" },
    { name: null, address: "203.0.113.8" },
  ]);
});

test("anything that is not an address is dropped, not printed", () => {
  assert.deepEqual(parseResolvers("dns1=not-an-address, 203.0.113.999, =, 203.0.113.7"), [
    { name: null, address: "203.0.113.7" },
  ]);
  assert.deepEqual(parseResolvers(""), []);
  assert.deepEqual(parseResolvers(undefined), []);
});

test("IPv6 resolvers are accepted", () => {
  assert.deepEqual(parseResolvers("dns1=2606:4700::1111"), [{ name: "dns1", address: "2606:4700::1111" }]);
  assert.equal(isIpAddress("::1"), true);
  assert.equal(isIpAddress("2606:4700:::1111"), false);
  assert.equal(isIpAddress("hello"), false);
});

test("an unconfigured deployment says nothing is published rather than guessing", () => {
  const config = resolverConfig({});
  assert.equal(config.published, false);
  assert.deepEqual(config.resolvers, []);
  assert.equal(config.doh, null);
});

test("the DoH endpoint has to be an https URL to be advertised", () => {
  const url = "https://dns.pit.moshcode.sh/dns-query";
  assert.equal(resolverConfig({ MOSHPIT_DOH_URL: url }).doh, url);
  // Plain HTTP would be advertised inside a browser's "secure DNS" setting.
  assert.equal(resolverConfig({ MOSHPIT_DOH_URL: "http://dns.pit.moshcode.sh/dns-query" }).doh, null);
  assert.equal(resolverConfig({ MOSHPIT_DOH_URL: "dns.pit.moshcode.sh" }).doh, null);
});

test("a configured deployment is published", () => {
  const config = resolverConfig({ MOSHPIT_DNS_RESOLVERS: "dns1.pit.moshcode.sh=203.0.113.7" });
  assert.equal(config.published, true);
  assert.equal(config.resolvers[0].address, "203.0.113.7");
});
