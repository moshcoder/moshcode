import { test } from "node:test";
import assert from "node:assert/strict";
import { keepEndingsFresh } from "../src/dns.mjs";

function clock() {
  const queue = [];
  return {
    schedule: (fn, ms) => { const t = { fn, ms }; queue.push(t); return t; },
    cancel: (t) => { const at = queue.indexOf(t); if (at >= 0) queue.splice(at, 1); },
    async tick() { const t = queue.shift(); assert.ok(t, "something scheduled"); await t.fn(); return t.ms; },
    pending: () => queue.map((t) => t.ms),
  };
}

test("an ending list that failed at start is retried until it loads, then refreshed hourly", async () => {
  const tldSet = new Set();
  const c = clock();
  const said = [];
  let calls = 0;
  const load = async () => {
    calls += 1;
    if (calls < 3) throw new Error("fetch failed");
    return calls === 3 ? ["eggs", "streaming"] : ["ancestry", "eggs", "streaming"];
  };
  const stop = keepEndingsFresh({ tldSet, load, out: (line) => said.push(line), schedule: c.schedule, cancel: c.cancel });
  assert.deepEqual(c.pending(), [5_000]);
  assert.equal(await c.tick(), 5_000);
  assert.deepEqual(c.pending(), [10_000]);
  assert.equal(await c.tick(), 10_000);
  assert.deepEqual([...tldSet], [], "still failing on the second try");
  assert.equal(await c.tick(), 30_000);
  assert.deepEqual([...tldSet], ["eggs", "streaming"], "loaded on the third try");
  assert.ok(said.some((line) => /loaded on retry/.test(line)));
  assert.deepEqual(c.pending(), [3_600_000]);
  await c.tick();
  assert.deepEqual([...tldSet], ["ancestry", "eggs", "streaming"], "a refresh picks up a new ending");
  stop();
  assert.deepEqual(c.pending(), []);
});

test("a failed refresh never empties a good list", async () => {
  const tldSet = new Set(["eggs"]);
  const c = clock();
  keepEndingsFresh({ tldSet, load: async () => { throw new Error("registry down"); }, schedule: c.schedule, cancel: c.cancel });
  assert.deepEqual(c.pending(), [3_600_000]);
  await c.tick();
  assert.deepEqual([...tldSet], ["eggs"]);
  assert.deepEqual(c.pending(), [3_600_000]);
});

test("past the quick retries, an empty list is tried every five minutes", async () => {
  const tldSet = new Set();
  const c = clock();
  keepEndingsFresh({ tldSet, load: async () => [], schedule: c.schedule, cancel: c.cancel });
  const seen = [];
  for (let i = 0; i < 5; i++) seen.push(await c.tick());
  assert.deepEqual(seen, [5_000, 10_000, 30_000, 300_000, 300_000]);
});
