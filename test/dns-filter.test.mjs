/**
 * The policy half of `dns filter`: parsing lists, matching names, and the two
 * rules that decide what a resolver in the path of every lookup will refuse.
 *
 * The failure this file exists to prevent is a filter that blocks something
 * nobody can explain. Every case below is either "this must be blocked" or
 * "this must never be", and the second kind outnumbers the first on purpose.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_CATEGORIES,
  FILTER_CATALOG,
  createFilter,
  matchSuffix,
  normaliseConfig,
  normaliseName,
  openFilter,
  parseList,
  readCachedList,
  readConfig,
  updateList,
  writeConfig,
} from "../src/dns-filter.mjs";

const tempDir = async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moshcode-filter-"));
  // Retried: a handle's stats write is fire-and-forget, so a directory can
  // gain a file between the read and the rmdir.
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  return dir;
};

/* ------------------------------------------------------------------ parsing */

test("a hosts file yields the names, not the addresses they are pointed at", () => {
  const names = parseList([
    "# Title: somebody's list",
    "0.0.0.0 ads.example.com",
    "127.0.0.1 tracker.example.net # inline comment",
    "0.0.0.0 a.example.org b.example.org",
    "",
  ].join("\n"));
  assert.deepEqual(names, ["ads.example.com", "tracker.example.net", "a.example.org", "b.example.org"]);
});

test("a plain domain list needs no sinkhole column", () => {
  assert.deepEqual(parseList("phish.example.com\nPHISH2.Example.com.\n"), ["phish.example.com", "phish2.example.com"]);
});

test("adblock syntax is read, and its options are not guessed at", () => {
  assert.deepEqual(parseList("||tracker.example^\n||other.example$third-party\n"), ["tracker.example"]);
});

test("the names a machine calls itself never enter a blocklist", () => {
  const names = parseList([
    "127.0.0.1 localhost",
    "::1 ip6-localhost ip6-loopback",
    "255.255.255.255 broadcasthost",
    "0.0.0.0 0.0.0.0",
  ].join("\n"));
  assert.deepEqual(names, []);
});

test("a bare label is dropped — one bad line must not block a whole TLD", () => {
  assert.deepEqual(parseList("0.0.0.0 com\ncom\n0.0.0.0 real.example\n"), ["real.example"]);
});

test("somebody's real /etc/hosts entry is not a blocklist entry", () => {
  // The first field is a routable address, so the line is a mapping this
  // machine uses, not a name a list is killing.
  assert.deepEqual(parseList("192.168.1.10 nas.local.example\n"), []);
});

test("a duplicated name appears once", () => {
  assert.deepEqual(parseList("0.0.0.0 a.example\n0.0.0.0 a.example\n"), ["a.example"]);
});

/* ----------------------------------------------------------------- matching */

test("blocking a name blocks everything under it", () => {
  const set = new Set(["doubleclick.net"]);
  assert.equal(matchSuffix("stats.g.doubleclick.net", set), "doubleclick.net");
  assert.equal(matchSuffix("doubleclick.net", set), "doubleclick.net");
});

test("a suffix that is not a label boundary does not match", () => {
  // The bug this pins: `endsWith` would block `notdoubleclick.net`.
  assert.equal(matchSuffix("notdoubleclick.net", new Set(["doubleclick.net"])), null);
  assert.equal(matchSuffix("example.com", new Set(["ample.com"])), null);
});

test("a hand-typed bare label can take out a whole Moshpit ending", () => {
  assert.equal(matchSuffix("scrambled.eggs", new Set(["eggs"])), "eggs");
});

test("names compare the same however they are written", () => {
  assert.equal(matchSuffix("ADS.Example.COM.", new Set(["ads.example.com"])), "ads.example.com");
  assert.equal(normaliseName("  Ads.Example.com. "), "ads.example.com");
  assert.equal(normaliseName("not a name"), null);
  assert.equal(normaliseName(""), null);
});

/* ---------------------------------------------------------------- deciding */

const lists = (entries) => new Map(Object.entries(entries).map(([id, names]) => [id, new Set(names)]));

test("an allow rule beats every list, and the lists still say so", () => {
  const filter = createFilter({
    lists: lists({ ads: ["ads.example.com"] }),
    allow: ["ads.example.com"],
  });
  assert.equal(filter.decide("ads.example.com"), null);
  assert.equal(filter.decide("beacon.ads.example.com"), null, "the allow covers what is under it too");
});

test("an allow on a parent rescues a child a list blocks", () => {
  const filter = createFilter({ lists: lists({ ads: ["cdn.example.com"] }), allow: ["example.com"] });
  assert.equal(filter.decide("cdn.example.com"), null);
});

test("a custom block is reported as custom, not as whichever list also has it", () => {
  const filter = createFilter({ lists: lists({ ads: ["ads.example.com"] }), block: ["ads.example.com"] });
  assert.deepEqual(filter.decide("ads.example.com"), { list: "custom", rule: "ads.example.com", mode: "nxdomain" });
});

test("the category reported is the first list carrying the name, in order", () => {
  const filter = createFilter({ lists: lists({ ads: ["x.example"], malware: ["x.example"] }) });
  assert.equal(filter.decide("x.example").list, "ads");
});

test("a filter that is off blocks nothing and still counts queries", () => {
  const filter = createFilter({ enabled: false, lists: lists({ ads: ["ads.example.com"] }) });
  assert.equal(filter.decide("ads.example.com"), null);
  assert.equal(filter.stats().queries, 1);
  assert.equal(filter.stats().blocked, 0);
});

test("counters and the recent tail follow what was blocked", () => {
  const filter = createFilter({ lists: lists({ ads: ["ads.example.com"], mining: ["coin.example"] }) });
  filter.decide("ads.example.com");
  filter.decide("deep.ads.example.com");
  filter.decide("coin.example");
  filter.decide("fine.example");
  const stats = filter.stats();
  assert.equal(stats.queries, 4);
  assert.equal(stats.blocked, 3);
  assert.deepEqual(stats.byList, { ads: 2, mining: 1 });
  assert.equal(stats.recent[0].name, "coin.example");
  assert.ok(stats.recent.length <= 20);
});

test("the mode travels with the verdict, so the bridge needs no second lookup", () => {
  const filter = createFilter({ mode: "zero", lists: lists({ ads: ["ads.example.com"] }) });
  assert.equal(filter.decide("ads.example.com").mode, "zero");
});

/* ------------------------------------------------------------------ config */

test("an unknown category is dropped rather than carried into the bridge", () => {
  const config = normaliseConfig({ enabled: true, categories: ["ads", "not-a-list"], mode: "sideways" });
  assert.deepEqual(config.categories, ["ads"]);
  assert.equal(config.mode, "nxdomain", "an unknown mode falls back rather than failing closed on every name");
});

test("no config file at all means filtering is off, not an error", async (t) => {
  const dir = await tempDir(t);
  const config = await readConfig(dir);
  assert.equal(config.enabled, false);
  assert.deepEqual(config.categories, DEFAULT_CATEGORIES);
});

test("a corrupt config is reported — reverting to off in silence hides it", async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(path.join(dir, "filter.json"), "{ not json");
  await assert.rejects(() => readConfig(dir), /not readable as JSON/);
});

/* ------------------------------------------------------------------ update */

const fakeFetch = (body, { ok = true, status = 200 } = {}) => async () => ({
  ok, status, text: async () => body,
});

test("update writes the parsed names and reports the count", async (t) => {
  const dir = await tempDir(t);
  const result = await updateList(dir, "ads", { fetchImpl: fakeFetch("0.0.0.0 ads.example.com\n0.0.0.0 b.example\n") });
  assert.equal(result.count, 2);
  const set = await readCachedList(dir, "ads");
  assert.ok(set.has("ads.example.com"));
});

test("a source that parses to nothing leaves the good cache alone", async (t) => {
  const dir = await tempDir(t);
  await updateList(dir, "ads", { fetchImpl: fakeFetch("0.0.0.0 ads.example.com\n") });
  await assert.rejects(
    () => updateList(dir, "ads", { fetchImpl: fakeFetch("<html>we moved</html>") }),
    /parsed to nothing/,
  );
  const set = await readCachedList(dir, "ads");
  assert.ok(set.has("ads.example.com"), "the previous list must survive a bad fetch");
});

test("an HTTP error is named rather than cached", async (t) => {
  const dir = await tempDir(t);
  await assert.rejects(() => updateList(dir, "ads", { fetchImpl: fakeFetch("", { ok: false, status: 503 }) }), /503/);
  assert.equal(await readCachedList(dir, "ads"), null);
});

test("every catalogue entry has the fields the CLI prints", () => {
  for (const entry of FILTER_CATALOG) {
    assert.ok(entry.id && entry.title && entry.url && entry.note, `${entry.id} is incomplete`);
    assert.match(entry.url, /^https:\/\//, `${entry.id} must be fetched over TLS`);
  }
});

/* -------------------------------------------------------------- the handle */

test("a handle serves the cached lists its config names", async (t) => {
  const dir = await tempDir(t);
  await updateList(dir, "ads", { fetchImpl: fakeFetch("0.0.0.0 ads.example.com\n") });
  await writeConfig(dir, { enabled: true, categories: ["ads"] });
  const handle = await openFilter({ dir });
  assert.equal(handle.decide("beacon.ads.example.com").list, "ads");
  assert.equal(handle.decide("example.com"), null);
});

test("a category with no cached list simply blocks nothing", async (t) => {
  const dir = await tempDir(t);
  await writeConfig(dir, { enabled: true, categories: ["ads", "malware"] });
  const handle = await openFilter({ dir });
  assert.equal(handle.decide("anything.example"), null);
  assert.deepEqual(handle.sizes(), {});
});

test("editing the config reaches a running bridge without a restart", async (t) => {
  const dir = await tempDir(t);
  await updateList(dir, "ads", { fetchImpl: fakeFetch("0.0.0.0 ads.example.com\n") });
  await writeConfig(dir, { enabled: true, categories: ["ads"] });

  let clock = 1_000_000;
  const handle = await openFilter({ dir, reloadMs: 5000, now: () => clock });
  assert.ok(handle.decide("ads.example.com"), "blocked to begin with");

  // What `moshcode dns filter allow ads.example.com` does.
  await writeConfig(dir, { enabled: true, categories: ["ads"], allow: ["ads.example.com"] });

  clock += 1000;
  handle.decide("ads.example.com"); // inside the window: the old policy still applies
  clock += 10_000;
  handle.decide("unrelated.example"); // past it: this query triggers the re-read
  await handle.reload();
  assert.equal(handle.decide("ads.example.com"), null, "the allow rule must be live");
});

test("counters survive a reload", async (t) => {
  const dir = await tempDir(t);
  await updateList(dir, "ads", { fetchImpl: fakeFetch("0.0.0.0 ads.example.com\n") });
  await writeConfig(dir, { enabled: true, categories: ["ads"] });
  const handle = await openFilter({ dir });
  handle.decide("ads.example.com");
  await handle.reload();
  assert.equal(handle.stats().blocked, 1);
});
