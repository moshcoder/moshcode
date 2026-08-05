/**
 * Names under a name, and the wildcard that covers them.
 *
 * The namespace used to be exactly one level deep, so `www.chovy.hacker` was
 * not a name at all and never cost a lookup. It is one now: the registry holds
 * third-level names, and an owner can publish `*.chovy.hacker` to cover every
 * name under theirs at once.
 *
 * Two things here are easy to get wrong and expensive when wrong. A sub-name
 * that nobody holds must be NXDOMAIN rather than parked — parking exists to
 * say a name is for sale, and a name under someone else's name is not for sale,
 * so parking it would advertise the owner's subdomains to a stranger. And the
 * wildcard fallback must not fire for a name that already is the wildcard, or
 * every miss costs the registry two round trips instead of one.
 *
 * The last test is moshcode's alone: the vendored bridge also has proxy mode,
 * which the published package does not, and a third-level name has to reach it
 * like any other live name.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { addressAnswer, resolveName } from "../src/dns.mjs";

/**
 * A registry that answers per name, and records what it was asked.
 *
 * Keyed by the name as the bridge asks for it, so a wildcard entry is written
 * `*.chovy.hacker` — which is exactly how the fallback asks for it.
 */
function registry(byName = {}) {
  const asked = [];
  return {
    asked,
    fetchImpl: async (url) => {
      const name = decodeURIComponent(new URL(url).searchParams.get("name"));
      asked.push(name);
      const body = byName[name];
      return {
        ok: true,
        json: async () => (body
          // `name_registered: false` is how the registry says it does not hold
          // a name — the shape a miss takes, not an error.
          ? { name_registered: true, ...body }
          : { name_registered: false, target: null }),
      };
    },
  };
}

test("a third-level name the registry holds resolves on the first ask", async () => {
  const reg = registry({ "www.chovy.hacker": { target: "203.0.113.7" } });
  const r = await resolveName("www.chovy.hacker", { fetchImpl: reg.fetchImpl });

  assert.equal(r.status, "live");
  assert.equal(r.target, "203.0.113.7");
  assert.deepEqual(reg.asked, ["www.chovy.hacker"], "a name it holds must not also cost a wildcard ask");
});

test("a third-level name nobody holds falls back to the owner's wildcard", async () => {
  const reg = registry({ "*.chovy.hacker": { target: "203.0.113.9" } });
  const r = await resolveName("www.chovy.hacker", { fetchImpl: reg.fetchImpl });

  assert.equal(r.status, "live");
  assert.equal(r.target, "203.0.113.9");
  assert.deepEqual(reg.asked, ["www.chovy.hacker", "*.chovy.hacker"]);
});

test("a sub-name missing everywhere is NXDOMAIN, not parked", async () => {
  // The one that matters. Parking a name under someone else's name would put a
  // for-sale page on every subdomain a stranger cares to guess.
  const reg = registry({});
  const r = await resolveName("www.chovy.hacker", { fetchImpl: reg.fetchImpl });

  assert.equal(r.status, "nxdomain");
  assert.equal(r.target, null);
});

test("the wildcard itself does not ask twice", async () => {
  const reg = registry({});
  const r = await resolveName("*.chovy.hacker", { fetchImpl: reg.fetchImpl });

  assert.equal(r.status, "nxdomain");
  assert.deepEqual(reg.asked, ["*.chovy.hacker"], "a wildcard that missed has no wildcard to fall back to");
});

test("a bare name that nobody holds is still parked, not NXDOMAIN", async () => {
  // The rule above must not leak into two-label names: a name waiting to be
  // pointed is the whole reason parking exists.
  const reg = registry({});
  const r = await resolveName("california.oranges", { fetchImpl: reg.fetchImpl });

  assert.equal(r.status, "parked");
  assert.equal(r.registered, false);
});

test("a sub-name under a wildcard with no target does not reach the parking page", async () => {
  // "Parked" on a third-level name means the wildcard exists but points
  // nowhere. There is nothing for sale here, so what the owner published is the
  // answer rather than the for-sale page.
  const reg = registry({
    "*.chovy.hacker": {
      target: null,
      records: [{ type: "A", value: "203.0.113.4", ttl: 300, priority: null }],
    },
  });
  const plan = await addressAnswer("www.chovy.hacker", {
    fetchImpl: reg.fetchImpl,
    parkingAddress: "198.51.100.9",
  });

  assert.equal(plan.exists, true);
  assert.notEqual(plan.address, "198.51.100.9", "a name under a name is not for sale");
  assert.equal(plan.kind, "records");
  assert.deepEqual(plan.records.map((r) => r.value), ["203.0.113.4"]);
});

test("a bare parked name still reaches the parking page", async () => {
  const reg = registry({ "california.oranges": { target: null } });
  const plan = await addressAnswer("california.oranges", {
    fetchImpl: reg.fetchImpl,
    parkingAddress: "198.51.100.9",
  });

  assert.equal(plan.address, "198.51.100.9");
});

test("a live third-level name answers the proxy like any other", async () => {
  // moshcode's own addition. A subdomain needs a verifiable certificate exactly
  // as much as the name above it, so proxy mode must not skip it.
  const reg = registry({ "*.chovy.hacker": { target: "203.0.113.9" } });
  const plan = await addressAnswer("www.chovy.hacker", {
    fetchImpl: reg.fetchImpl,
    proxyAddress: { v4: "127.0.0.1", v6: "::1" },
  });

  assert.equal(plan.address, "127.0.0.1");
  assert.equal(plan.proxied, true);
});

test("a sub-name nobody holds is NXDOMAIN even with the proxy on", async () => {
  // Proxy mode answers every live name, and this one is not live. Pointing it
  // at the proxy would turn a name that does not exist into a TLS error.
  const reg = registry({});
  const plan = await addressAnswer("www.chovy.hacker", {
    fetchImpl: reg.fetchImpl,
    proxyAddress: { v4: "127.0.0.1", v6: "::1" },
  });

  assert.equal(plan.exists, false);
  assert.equal(plan.kind, "nxdomain");
});
