// Reading the whole ending list, not the first page of it.
//
// fetchTlds took the first response and stopped. The registry answers 200 rows
// by default and reports `total`, but 200 rows look exactly like a complete
// list of 200 — so `.eggs`, which sits past that line, was silently missing
// from the config `dns install` writes. The name then failed to resolve, which
// looks like a DNS problem three layers from the cause.
import assert from "node:assert/strict";
import test from "node:test";

import { fetchTlds } from "../src/dns.mjs";

const REGISTRY = "https://pit.example.test";

/** A registry holding `count` endings, served `pageSize` at a time. */
function pagedRegistry(count, { pageSize = 1000, reportTotal = true } = {}) {
  const all = Array.from({ length: count }, (_, i) => `tld${String(i).padStart(4, "0")}`);
  const calls = [];
  const fetchImpl = async (url) => {
    const q = new URL(String(url)).searchParams;
    const limit = Math.min(pageSize, Number(q.get("limit")) || pageSize);
    const offset = Number(q.get("offset")) || 0;
    calls.push({ limit, offset });
    const rows = all.slice(offset, offset + limit).map((tld) => ({ tld }));
    return { ok: true, json: async () => (reportTotal ? { total: count, tlds: rows } : { tlds: rows }) };
  };
  return { all, calls, fetchImpl };
}

test("an ending past the first page is still found", async () => {
  // The exact shape of the bug: 1500 endings, the interesting one at the end.
  const { fetchImpl } = pagedRegistry(1500);
  const tlds = await fetchTlds({ registryBase: REGISTRY, fetchImpl });

  assert.equal(tlds.length, 1500);
  assert.ok(tlds.includes("tld1499"), "the last ending must not be truncated away");
});

test("a list that fits in one page costs one request", async () => {
  const { calls, fetchImpl } = pagedRegistry(12);
  const tlds = await fetchTlds({ registryBase: REGISTRY, fetchImpl });

  assert.equal(tlds.length, 12);
  assert.equal(calls.length, 1, "no needless second page");
});

test("paging walks forward rather than re-reading page one", async () => {
  const { calls, fetchImpl } = pagedRegistry(2500);
  await fetchTlds({ registryBase: REGISTRY, fetchImpl });

  assert.deepEqual(calls.map((c) => c.offset), [0, 1000, 2000]);
});

test("results come back lowercased, deduped by sort, and usable", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ total: 2, tlds: [{ tld: "EGGS" }, "Chicken"] }),
  });
  assert.deepEqual(await fetchTlds({ registryBase: REGISTRY, fetchImpl }), ["chicken", "eggs"]);
});

test("a registry that reports no total is read once, not walked off the end", async () => {
  // An older registry with no pager: take what it gave rather than looping.
  const { calls, fetchImpl } = pagedRegistry(300, { pageSize: 200, reportTotal: false });
  const tlds = await fetchTlds({ registryBase: REGISTRY, fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(tlds.length, 200);
});

test("a total that overstates the rows on hand still terminates", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    // Claims 10000 rows, hands back none after the first page.
    return {
      ok: true,
      json: async () => ({ total: 10_000, tlds: calls === 1 ? [{ tld: "eggs" }] : [] }),
    };
  };
  const tlds = await fetchTlds({ registryBase: REGISTRY, fetchImpl });

  assert.deepEqual(tlds, ["eggs"]);
  assert.ok(calls <= 3, `an empty page must end it, took ${calls} requests`);
});

test("a failing page is an error, not a silently short list", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(
    () => fetchTlds({ registryBase: REGISTRY, fetchImpl }),
    /registry returned 503/,
  );
});
