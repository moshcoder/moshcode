// Automatic settings sync.
//
// The thing worth testing here is not that a timer fires — it is that an
// unattended sync can never do something a person would have refused. Every
// test below is a version of that: never --force, never a word when nothing
// happened, never a second tick on top of a running one, and never a push on
// top of an account this machine could not read.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  autoSyncEnabled,
  autoSyncInterval,
  startAutoSync,
  syncOnce,
} from "../src/autosync.mjs";

const CREDS = { api: "https://app.test", token: "mck_test", email: "a@b.c" };

/** A stand-in for loadCommand/saveCommand: answers with one JSON body. */
function verb(body, code = 0) {
  const calls = [];
  const impl = async (argv = [], opts = {}) => {
    calls.push({ argv: [...argv], opts });
    opts.write?.(JSON.stringify(body));
    return code;
  };
  impl.calls = calls;
  return impl;
}

/** Collects the lines a tick decided were worth showing the operator. */
function lines() {
  const out = [];
  const write = (line) => out.push(String(line));
  write.out = out;
  write.text = () => out.join("\n");
  return write;
}

test("a logged-out pit syncs nothing and says nothing", async () => {
  const load = verb({ status: "loaded" });
  const save = verb({ status: "saved" });
  const write = lines();

  const result = await syncOnce({ load, save, creds: null, write });

  assert.equal(result.skipped, "not_logged_in");
  assert.equal(load.calls.length, 0, "must not call /load without a token");
  assert.equal(save.calls.length, 0, "must not call /save without a token");
  assert.deepEqual(write.out, [], "a pit that never logged in is never nagged");
});

test("a tick loads before it saves", async () => {
  const order = [];
  const load = async (argv, opts) => { order.push("load"); opts.write('{"status":"unchanged"}'); return 0; };
  const save = async (argv, opts) => { order.push("save"); opts.write('{"status":"unchanged"}'); return 0; };

  await syncOnce({ load, save, creds: CREDS, write: lines() });

  assert.deepEqual(order, ["load", "save"]);
});

test("neither verb is ever handed --force", async () => {
  const load = verb({ status: "loaded", files: ["aliases.json"], revision: 4 });
  const save = verb({ status: "saved", revision: 5 });

  await syncOnce({ load, save, creds: CREDS, write: lines() });

  for (const call of [...load.calls, ...save.calls]) {
    assert.ok(!call.argv.includes("--force"), `--force leaked into ${JSON.stringify(call.argv)}`);
    assert.ok(call.argv.includes("--json"), "answers are read as data, not prose");
  }
});

test("local edits that /load declined are pushed by the /save that follows", async () => {
  // The heart of it. `/load` refusing is the healthy case — you changed an
  // alias and have not saved it — and the save behind it is what carries it up.
  const load = verb({ status: "local_changes", files: ["aliases.json"], revision: 9 }, 1);
  const save = verb({ status: "saved", revision: 10 });
  const write = lines();

  const result = await syncOnce({ load, save, creds: CREDS, write });

  assert.equal(result.load, "local_changes");
  assert.equal(save.calls.length, 1, "a declined /load must not stop the /save");
  assert.match(write.text(), /revision 10/);
});

test("a tick that changed nothing prints nothing", async () => {
  const load = verb({ status: "unchanged", revision: 7 });
  const save = verb({ status: "unchanged", revision: 7 });
  const write = lines();

  await syncOnce({ load, save, creds: CREDS, write });

  assert.deepEqual(write.out, [], "five minutes of silence beats a line saying nothing happened");
});

test("settings arriving from another machine are announced", async () => {
  const load = verb({ status: "loaded", files: ["aliases.json", "news.opml"], revision: 12, from: "thinkpad" });
  const save = verb({ status: "unchanged", revision: 12 });
  const write = lines();

  await syncOnce({ load, save, creds: CREDS, write });

  const text = write.text();
  assert.match(text, /thinkpad/, "say which machine changed your aliases");
  assert.match(text, /2 files/);
  assert.match(text, /revision 12/);
});

test("one file reads as a file, not 1 files", async () => {
  const load = verb({ status: "loaded", files: ["aliases.json"], revision: 3, from: "desktop" });
  const save = verb({ status: "unchanged" });
  const write = lines();

  await syncOnce({ load, save, creds: CREDS, write });

  assert.match(write.text(), /1 file changed/);
});

test("a conflict is reported once, with both ways out, and never forced", async () => {
  const load = verb({ status: "unchanged", revision: 4 });
  const save = verb({ status: "conflict", revision: 5, mine: 4 }, 1);
  const write = lines();

  const result = await syncOnce({ load, save, creds: CREDS, write });

  assert.equal(result.save, "conflict");
  assert.match(write.text(), /another machine saved first/);
  assert.match(write.text(), /--force/, "name the escape hatch without taking it");
  assert.equal(save.calls.length, 1, "a conflict is a decision, not something to retry");
});

test("rejected credentials stop the tick before it pushes", async () => {
  const load = verb({ status: "expired" }, 1);
  const save = verb({ status: "saved", revision: 2 });
  const write = lines();

  await syncOnce({ load, save, creds: CREDS, write });

  assert.equal(save.calls.length, 0, "never push on top of an account we could not read");
  assert.match(write.text(), /`\/login`/);
});

test("a network failure is silent", async () => {
  const load = verb({ status: "failed", error: "getaddrinfo ENOTFOUND" }, 1);
  const save = verb({ status: "failed", error: "getaddrinfo ENOTFOUND" }, 1);
  const write = lines();

  await syncOnce({ load, save, creds: CREDS, write });

  assert.deepEqual(write.out, [], "a laptop on a train must not narrate every tunnel");
});

test("MOSHCODE_NO_AUTOSYNC turns it off and starts no timer", () => {
  assert.equal(autoSyncEnabled({}), true, "on by default");
  assert.equal(autoSyncEnabled({ MOSHCODE_NO_AUTOSYNC: "1" }), false);

  let started = 0;
  const stop = startAutoSync({
    enabled: false,
    timers: { setInterval: () => { started++; return 1; }, clearInterval: () => {} },
  });

  assert.equal(started, 0);
  assert.equal(typeof stop, "function", "the off switch still returns something safe to call");
  stop();
});

test("the interval defaults to five minutes and floors a silly one", () => {
  assert.equal(autoSyncInterval({}), DEFAULT_INTERVAL_MS);
  assert.equal(autoSyncInterval({ MOSHCODE_AUTOSYNC_MS: "60000" }), 60000);
  assert.equal(autoSyncInterval({ MOSHCODE_AUTOSYNC_MS: "1" }), MIN_INTERVAL_MS, "1ms is a typo, not a request");
  assert.equal(autoSyncInterval({ MOSHCODE_AUTOSYNC_MS: "nonsense" }), DEFAULT_INTERVAL_MS);
  assert.equal(autoSyncInterval({ MOSHCODE_AUTOSYNC_MS: "-5" }), DEFAULT_INTERVAL_MS);
});

test("the timer never holds the pit open, and stops when the pit does", () => {
  let unreffed = false;
  let cleared = null;
  const handle = { unref: () => { unreffed = true; } };

  const stop = startAutoSync({
    creds: CREDS,
    timers: {
      setInterval: () => handle,
      clearInterval: (h) => { cleared = h; },
    },
  });

  assert.equal(unreffed, true, "a pending tick must not delay `/quit`");
  stop();
  assert.equal(cleared, handle);
});

test("ticks are single-flight — a slow sync is skipped, not stacked", async () => {
  let running = 0;
  let peak = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  let tick;
  const stop = startAutoSync({
    creds: CREDS,
    load: async (argv, opts) => {
      running++;
      peak = Math.max(peak, running);
      await gate;
      opts.write('{"status":"unchanged"}');
      running--;
      return 0;
    },
    save: verb({ status: "unchanged" }),
    timers: { setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval: () => {} },
  });

  const first = tick();
  const second = tick();
  release();
  await Promise.all([first, second]);

  assert.equal(peak, 1, "two ticks must never write the same files at once");
  stop();
});

test("a tick that throws does not take the pit down", async () => {
  let tick;
  const stop = startAutoSync({
    creds: CREDS,
    load: async () => { throw new Error("the app fell over"); },
    timers: { setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval: () => {} },
  });

  await assert.doesNotReject(() => tick());
  stop();
});

test("a tick fired after stop() does nothing", async () => {
  const load = verb({ status: "unchanged" });
  let tick;
  const stop = startAutoSync({
    creds: CREDS,
    load,
    save: verb({ status: "unchanged" }),
    timers: { setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval: () => {} },
  });

  stop();
  await tick();

  assert.equal(load.calls.length, 0, "a stopped sync stays stopped even if the timer fires once more");
});
