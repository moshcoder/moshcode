/**
 * What `/save` carries, and — more importantly — what it must never carry.
 *
 * `~/.moshcode` is not only the settings directory: it is also where moshcode
 * installs itself, where the account token lives, where the herd keeps full
 * screen captures of every session, and where the DNS filter records the last
 * domains this machine was blocked from reaching. The allowlist is the only
 * thing standing between "sync my settings" and "upload my history and my
 * credentials", which is why it is an allowlist and why these tests are about
 * the denials rather than the inclusions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  NEVER_SYNCED,
  NEVER_SYNCED_PREFIXES,
  NEVER_SYNCED_SUFFIXES,
  SYNCED_FILES,
  collectSnapshot,
  isSyncable,
} from "../src/settings-sync.mjs";

test("everything on the allowlist is syncable, and nothing else is", () => {
  for (const entry of SYNCED_FILES) {
    assert.equal(isSyncable(entry.path), true, `${entry.path} is listed but refused`);
  }
  assert.equal(isSyncable("aliases.json.bak"), false);
  assert.equal(isSyncable("../../.ssh/authorized_keys"), false);
  assert.equal(isSyncable(""), false);
  assert.equal(isSyncable(null), false);
});

test("no path is both allowed and denied", () => {
  // A future edit that adds a convenient-looking entry to SYNCED_FILES without
  // noticing it is already denied would produce a file that is listed, never
  // sent, and never explained.
  for (const entry of SYNCED_FILES) {
    assert.ok(!NEVER_SYNCED.includes(entry.path), `${entry.path} is on both lists`);
    for (const prefix of NEVER_SYNCED_PREFIXES) {
      assert.ok(!entry.path.startsWith(prefix), `${entry.path} is denied by prefix ${prefix}`);
    }
    for (const suffix of NEVER_SYNCED_SUFFIXES) {
      assert.ok(!entry.path.endsWith(suffix), `${entry.path} is denied by suffix ${suffix}`);
    }
  }
});

test("the credential this feature authenticates with never syncs", () => {
  assert.equal(isSyncable("credentials.json"), false);
});

test("every named never-synced file is refused", () => {
  for (const name of NEVER_SYNCED) {
    assert.equal(isSyncable(name), false, `${name} is named as never-synced but allowed`);
  }
});

test("a directory rule actually excludes what is under it", () => {
  // NEVER_SYNCED is an exact-string match, so a directory named there would be
  // inert. These paths are only refused if the prefix list is doing its job.
  assert.equal(isSyncable("herd/tasks/mosh-1.jsonl"), false, "task ledgers carry prompt text");
  assert.equal(isSyncable("herd/tasks/seq"), false);
  assert.equal(isSyncable("herd/status/claude.json"), false);
  assert.equal(isSyncable("herd/remote/desktop.json"), false);
  assert.equal(isSyncable("lists/kagi-smallweb.json"), false);
  assert.equal(isSyncable("dns-filter/lists/ads.txt"), false, "megabytes, and self-renewing");
  assert.equal(isSyncable("pkg/bin/moshcode.mjs"), false, "the program is not a setting");
});

test("the pty substrate is excluded by extension, as the header always claimed", () => {
  // This was documented from the first version and enforced by nothing.
  assert.equal(isSyncable("herd/mosh-1.transcript"), false, "a full screen capture of a session");
  assert.equal(isSyncable("herd/mosh-1.stdin"), false);
  assert.equal(isSyncable("herd/mosh-1.pid"), false);
  assert.equal(isSyncable("herd/mosh-1.exit"), false);
  assert.equal(isSyncable("herd/agent.sock"), false);
  assert.equal(isSyncable("moshpit-dns.log"), false);
});

test("the dns filter's policy syncs and its statistics do not", () => {
  // The two live side by side and one of them is browsing history.
  assert.equal(isSyncable("dns-filter/filter.json"), true, "categories and your own lists are a decision");
  assert.equal(isSyncable("dns-filter/stats.json"), false, "recent[] is the last domains you were blocked from");
});

test("a work ledger is not a preference", () => {
  assert.equal(isSyncable("timers.json"), false, "two machines appending hours would lose entries");
});

test("listing caches stay on the machine that made them", () => {
  assert.equal(isSyncable("news-last.json"), false);
  assert.equal(isSyncable("news-found.json"), false);
});

test("the file most likely to outgrow the cap is collected last", () => {
  // The total cap is spent in allowlist order, so a big file placed early
  // silently pushes the small ones out of the snapshot rather than being
  // skipped itself.
  assert.equal(SYNCED_FILES.at(-1).path, "business.json");
});

test("the new settings are actually picked up from disk", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "moshcode-allowlist-"));
  const moshcode = path.join(dir, ".moshcode");
  fs.mkdirSync(path.join(moshcode, "herd"), { recursive: true });
  fs.mkdirSync(path.join(moshcode, "dns-filter"), { recursive: true });

  fs.writeFileSync(path.join(moshcode, "aliases.json"), JSON.stringify({ gs: "git status" }));
  fs.writeFileSync(path.join(moshcode, "herd", "config.json"), JSON.stringify({ notify: { enabled: true } }));
  fs.writeFileSync(path.join(moshcode, "pricing.json"), JSON.stringify({ "claude-opus-5": { input: 1 } }));
  fs.writeFileSync(path.join(moshcode, "dns-filter", "filter.json"), JSON.stringify({ enabled: true, block: ["x.test"] }));
  fs.writeFileSync(path.join(moshcode, "business.json"), JSON.stringify({ clients: [{ name: "acme" }] }));

  // The two that must not come along, sitting right next to ones that do.
  fs.writeFileSync(path.join(moshcode, "credentials.json"), JSON.stringify({ token: "mck_secret" }));
  fs.writeFileSync(path.join(moshcode, "dns-filter", "stats.json"), JSON.stringify({ recent: ["private.test"] }));
  fs.writeFileSync(path.join(moshcode, "timers.json"), JSON.stringify({ entries: [] }));

  const { snapshot, included } = collectSnapshot({ home: dir, hostname: "test", version: "0.0.0", installed: {} });
  const carried = included.map((f) => f.path);

  assert.ok(carried.includes("herd/config.json"));
  assert.ok(carried.includes("pricing.json"));
  assert.ok(carried.includes("dns-filter/filter.json"));
  assert.ok(carried.includes("business.json"));

  const serialised = JSON.stringify(snapshot);
  assert.ok(!serialised.includes("mck_secret"), "the account token must never reach a snapshot");
  assert.ok(!serialised.includes("private.test"), "nor must a blocked-domain list");
  assert.ok(!carried.includes("timers.json"));

  fs.rmSync(dir, { recursive: true, force: true });
});
