/**
 * `moshcode dns filter` as a person meets it.
 *
 * The thing worth testing here is not that the flags parse. It is that the
 * command refuses to imply a machine is protected when it is not: filtering
 * written to a file with no bridge in the query path filters nothing, and a
 * category switched on with no list ever fetched blocks nothing. Both states
 * have to be said out loud, because both look like success.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { filterCommand } from "../src/dns-filter-cli.mjs";
import { readConfig, updateList } from "../src/dns-filter.mjs";

const tempDir = async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moshcode-filter-cli-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

/** A bridge that is there and forwarding, unless a test says otherwise. */
const bridge = (found = { kind: "ours", pid: 42, answering: true, forwards: true, moshpit: true }) =>
  async () => found;

const noBridge = bridge({ kind: "none", pid: null, answering: false, forwards: false, moshpit: false });

const fakeFetch = (body) => async () => ({ ok: true, status: 200, text: async () => body });

async function run(args, dir, extra = {}) {
  const lines = [];
  const code = await filterCommand(args, (line) => lines.push(String(line)), {
    dir,
    presence: bridge(),
    recorded: async () => ({ running: true, pid: 42, stale: false }),
    ...extra,
  });
  return { code, text: lines.join("\n") };
}

/* --------------------------------------------------------------- the verbs */

test("with nothing configured, status says off and points at the config", async (t) => {
  const dir = await tempDir(t);
  const { code, text } = await run([], dir);
  assert.equal(code, 0);
  assert.match(text, /^filter {4}off/m);
  assert.match(text, /filter\.json/);
});

test("`on` writes the default categories and names the ones never fetched", async (t) => {
  const dir = await tempDir(t);
  const { code, text } = await run(["on"], dir);
  assert.equal(code, 0);
  assert.match(text, /filtering on — ads, malware, phishing, mining/);
  // The state that would otherwise read as protection.
  assert.match(text, /never been fetched/);
  assert.match(text, /moshcode dns filter update/);
  const config = await readConfig(dir);
  assert.equal(config.enabled, true);
});

test("`on` with no bridge answering says nothing is being filtered", async (t) => {
  const dir = await tempDir(t);
  const { text } = await run(["on"], dir, { presence: noBridge });
  assert.match(text, /no bridge is answering/);
  assert.match(text, /nothing is filtered until one does/);
  // And it must not offer to fix that for you.
  assert.match(text, /sudo moshcode dns enable/);
});

test("`on` never enables DNS itself — it only writes a file", async (t) => {
  const dir = await tempDir(t);
  let asked = false;
  await run(["on"], dir, { presence: async () => { asked = true; return { kind: "none", answering: false }; } });
  assert.ok(asked, "it may look at the bridge");
  assert.deepEqual(
    (await fs.readdir(dir)).sort(),
    ["filter.json"],
    "nothing outside its own directory is touched",
  );
});

test("`off` keeps the lists and the rules", async (t) => {
  const dir = await tempDir(t);
  await run(["on"], dir);
  await run(["block", "tracker.example"], dir);
  const { text } = await run(["off"], dir);
  assert.match(text, /filtering off/);
  const config = await readConfig(dir);
  assert.equal(config.enabled, false);
  assert.deepEqual(config.block, ["tracker.example"]);
  assert.deepEqual(config.categories, ["ads", "malware", "phishing", "mining"]);
});

test("an unknown mode or list is refused rather than half-applied", async (t) => {
  const dir = await tempDir(t);
  assert.equal((await run(["on", "--mode", "sideways"], dir)).code, 1);
  assert.equal((await run(["on", "--lists", "ads,nope"], dir)).code, 1);
  assert.equal((await readConfig(dir)).enabled, false, "nothing was written");
});

test("`--lists` chooses the categories, and `add`/`remove` move them after", async (t) => {
  const dir = await tempDir(t);
  await run(["on", "--lists", "ads,malware"], dir);
  assert.deepEqual((await readConfig(dir)).categories, ["ads", "malware"]);
  await run(["add", "adult"], dir);
  assert.deepEqual((await readConfig(dir)).categories, ["ads", "malware", "adult"]);
  const { text } = await run(["remove", "malware"], dir);
  assert.match(text, /lists: ads, adult/);
});

test("block and allow take a name and everything under it, and can be undone", async (t) => {
  const dir = await tempDir(t);
  await run(["block", "Tracker.Example.COM."], dir);
  assert.deepEqual((await readConfig(dir)).block, ["tracker.example.com"], "stored the way names compare");
  await run(["allow", "ads.example.com"], dir);
  assert.deepEqual((await readConfig(dir)).allow, ["ads.example.com"]);
  await run(["unblock", "tracker.example.com"], dir);
  assert.deepEqual((await readConfig(dir)).block, []);
  await run(["unallow", "ads.example.com"], dir);
  assert.deepEqual((await readConfig(dir)).allow, []);
});

test("a rule added while filtering is off says when it will apply", async (t) => {
  const dir = await tempDir(t);
  const { text } = await run(["block", "tracker.example"], dir);
  assert.match(text, /filtering is off/);
});

test("something that is not a name is refused", async (t) => {
  const dir = await tempDir(t);
  const { code, text } = await run(["block", "not a name"], dir);
  assert.equal(code, 1);
  assert.match(text, /is not a name/);
});

/* ---------------------------------------------------------------- update */

test("update fetches the categories that are on and counts what it got", async (t) => {
  const dir = await tempDir(t);
  await run(["on", "--lists", "ads"], dir);
  const { code, text } = await run(["update"], dir, { fetchImpl: fakeFetch("0.0.0.0 ads.example.com\n0.0.0.0 b.example\n") });
  assert.equal(code, 0);
  assert.match(text, /ok ads\s+2 names/);
});

test("one dead source does not stop the others, and the cache survives it", async (t) => {
  const dir = await tempDir(t);
  await run(["on", "--lists", "ads,malware"], dir);
  await run(["update", "ads"], dir, { fetchImpl: fakeFetch("0.0.0.0 ads.example.com\n") });

  const fetchImpl = async (url) => (url.includes("urlhaus")
    ? { ok: false, status: 500, text: async () => "" }
    : { ok: true, status: 200, text: async () => "0.0.0.0 ads2.example.com\n" });
  const { code, text } = await run(["update"], dir, { fetchImpl });
  assert.equal(code, 0, "a partial refresh is not a failed command");
  assert.match(text, /ok ads/);
  assert.match(text, /!\s+malware/);
  assert.match(text, /1 list did not refresh/);
});

test("update refuses a category that is not in the catalogue", async (t) => {
  const dir = await tempDir(t);
  const { code, text } = await run(["update", "nope"], dir);
  assert.equal(code, 1);
  assert.match(text, /no such list/);
});

/* ------------------------------------------------------------------ test */

test("`test` explains which rule blocks a name, and how to keep it working", async (t) => {
  const dir = await tempDir(t);
  await run(["on", "--lists", "ads"], dir);
  await updateList(dir, "ads", { fetchImpl: fakeFetch("0.0.0.0 ads.example.com\n") });
  const { text } = await run(["test", "beacon.ads.example.com"], dir);
  assert.match(text, /blocked by ads \(rule `ads\.example\.com`\)/);
  assert.match(text, /filter allow beacon\.ads\.example\.com/);
});

test("`test` says when a name is only in a category that is switched off", async (t) => {
  const dir = await tempDir(t);
  await run(["on", "--lists", "malware"], dir);
  await updateList(dir, "adult", { fetchImpl: fakeFetch("0.0.0.0 grown.example\n") });
  const { text } = await run(["test", "grown.example"], dir);
  assert.match(text, /not blocked/);
  assert.match(text, /adult, which is not switched on/);
});

test("`test` reports an allow rule as the reason, not as absence", async (t) => {
  const dir = await tempDir(t);
  await run(["on", "--lists", "ads"], dir);
  await updateList(dir, "ads", { fetchImpl: fakeFetch("0.0.0.0 ads.example.com\n") });
  await run(["allow", "ads.example.com"], dir);
  const { text } = await run(["test", "ads.example.com"], dir);
  assert.match(text, /allowed by your rule/);
});

test("`test --json` is a document a script can read", async (t) => {
  const dir = await tempDir(t);
  await run(["on", "--lists", "ads"], dir);
  await updateList(dir, "ads", { fetchImpl: fakeFetch("0.0.0.0 ads.example.com\n") });
  const { text } = await run(["test", "ads.example.com", "--json"], dir);
  const doc = JSON.parse(text);
  assert.equal(doc.blocked, true);
  assert.equal(doc.hits[0].list, "ads");
});

/* ---------------------------------------------------------------- status */

test("status reports the counters the bridge left behind", async (t) => {
  const dir = await tempDir(t);
  await run(["on", "--lists", "ads"], dir);
  await updateList(dir, "ads", { fetchImpl: fakeFetch("0.0.0.0 ads.example.com\n") });
  await fs.writeFile(path.join(dir, "stats.json"), JSON.stringify({
    at: "2026-08-28T10:00:00.000Z", queries: 1000, blocked: 250, byList: { ads: 250 }, recent: [{ name: "ads.example.com" }],
  }));
  const { text } = await run([], dir);
  assert.match(text, /filter {4}on/);
  assert.match(text, /250 of 1,000 queries \(25\.0%\)/);
  assert.match(text, /recent {4}ads\.example\.com/);
});

test("status with filtering on and no bridge is explicit about it", async (t) => {
  const dir = await tempDir(t);
  await run(["on", "--lists", "ads"], dir);
  const { text } = await run([], dir, { presence: noBridge });
  assert.match(text, /nothing is being filtered/);
});

test("status --json carries the bridge verdict for a script to act on", async (t) => {
  const dir = await tempDir(t);
  await run(["on", "--lists", "ads"], dir);
  const { text } = await run(["--json"], dir, { presence: noBridge });
  const doc = JSON.parse(text);
  assert.equal(doc.enabled, true);
  assert.equal(doc.bridge.answering, false);
  assert.deepEqual(doc.categories, ["ads"]);
});

test("lists shows the catalogue with what is cached", async (t) => {
  const dir = await tempDir(t);
  await run(["on", "--lists", "ads"], dir);
  await updateList(dir, "ads", { fetchImpl: fakeFetch("0.0.0.0 ads.example.com\n") });
  const { text } = await run(["lists"], dir);
  assert.match(text, /on\s+ads\s+Ads and trackers\s+cached/);
  assert.match(text, /off\s+adult/);
  assert.match(text, /not fetched/);
});

test("an unknown verb prints the usage rather than doing something else", async (t) => {
  const dir = await tempDir(t);
  const { code, text } = await run(["destroy"], dir);
  assert.equal(code, 1);
  assert.match(text, /unknown: moshcode dns filter destroy/);
});

test("a corrupt config stops every verb with the path to fix", async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(path.join(dir, "filter.json"), "{ nope");
  const { code, text } = await run(["on"], dir);
  assert.equal(code, 1);
  assert.match(text, /not readable as JSON/);
});
