/**
 * Trusting names as they resolve, instead of one command per name.
 *
 * `dns trust <name>` works and does not scale: someone browsing Moshpit meets a
 * certificate error on every site they have not personally thought about, which
 * is indistinguishable from the namespace being broken.
 *
 * The registry pin is what makes doing it automatically defensible rather than
 * reckless — nothing is trusted on sight, only a key the registry already
 * published for that name. These tests are about the three ways the automation
 * itself could go wrong, none of which are about cryptography:
 *
 *   - blocking a DNS answer on certificate work
 *   - asking about a name once per query rather than once
 *   - retrying a name that will never succeed, forever, one line per lookup
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createAutoTrust } from "../src/trust.mjs";

/** An auto-truster over a fake `trustName`, recording what it was asked. */
function harness({ refuse = [], fail = [] } = {}) {
  const asked = [];
  const out = [];
  const auto = createAutoTrust({
    out: (l) => out.push(l),
    trust: async (name, say) => {
      asked.push(name);
      if (refuse.includes(name)) {
        say(`REFUSED — the served key is not among the pins the registry publishes`);
        return 1;
      }
      if (fail.includes(name)) {
        say("could not reach the registry to check the pin — ECONNREFUSED");
        return 1;
      }
      return 0;
    },
  });
  return { auto, asked, out };
}

test("a name is asked about once, however many times it is looked up", async () => {
  // A browser sends A and AAAA together and retries. "On resolve" is a firehose,
  // and one certificate fetch per query would be a self-inflicted outage.
  const h = harness();
  for (let i = 0; i < 5; i++) {
    for (const name of ["seo.rank", "chovy.hacker"]) h.auto.consider(name);
  }
  await h.auto.idle();

  assert.deepEqual(h.asked, ["seo.rank", "chovy.hacker"]);
  assert.equal(h.asked.length, 2, "10 lookups, 2 certificate fetches");
});

test("consider() returns before any of the work happens", async () => {
  // It is called from a UDP handler that owes a client a reply.
  const h = harness();
  const accepted = h.auto.consider("seo.rank");
  assert.equal(accepted, true);
  assert.deepEqual(h.asked, [], "nothing has run yet — the caller is already free");
  await h.auto.idle();
  assert.deepEqual(h.asked, ["seo.rank"]);
});

test("a refused name is never asked about again", async () => {
  // Otherwise every lookup of a name whose pin does not match writes a log line
  // and fails, forever.
  const h = harness({ refuse: ["evil.rank"] });
  h.auto.consider("evil.rank");
  await h.auto.idle();
  assert.deepEqual(h.asked, ["evil.rank"]);

  h.auto.consider("evil.rank");
  await h.auto.idle();
  assert.equal(h.asked.length, 1, "still one attempt");
});

test("a refusal is reported, because it is the one outcome worth seeing", async () => {
  const h = harness({ refuse: ["evil.rank"] });
  h.auto.consider("evil.rank");
  await h.auto.idle();
  assert.match(h.out.join("\n"), /evil\.rank/);
  assert.match(h.out.join("\n"), /REFUSED/);
});

test("a registry outage is not narrated per name", async () => {
  // If the registry is down, every name fails. Saying so once per name turns
  // the query log into the outage.
  const h = harness({ fail: ["a.rank", "b.rank", "c.rank"] });
  for (const n of ["a.rank", "b.rank", "c.rank"]) h.auto.consider(n);
  await h.auto.idle();
  assert.equal(h.out.length, 0, "nothing printed for a transport failure");
});

test("a success says so once", async () => {
  const h = harness();
  h.auto.consider("seo.rank");
  await h.auto.idle();
  assert.deepEqual(h.out, ["  trusted seo.rank"]);
});

test("an empty name is ignored rather than queued", async () => {
  const h = harness();
  assert.equal(h.auto.consider(""), false);
  assert.equal(h.auto.consider(null), false);
  await h.auto.idle();
  assert.deepEqual(h.asked, []);
});

test("a thrown trust attempt does not take the resolver down", async () => {
  // This runs detached from the query handler, so an unhandled rejection here
  // is a process exit on a box whose whole job is to stay up.
  const out = [];
  const auto = createAutoTrust({
    out: (l) => out.push(l),
    trust: async () => { throw new Error("boom"); },
  });
  auto.consider("seo.rank");
  await auto.idle();
  assert.equal(out.length, 0);
});

test("names queued while one is in flight are all still handled", async () => {
  // The drain loop is single-flight; anything arriving mid-drain has to be
  // picked up rather than dropped on the floor.
  const asked = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const auto = createAutoTrust({
    trust: async (name) => {
      asked.push(name);
      if (name === "first.rank") await gate;
      return 0;
    },
  });

  auto.consider("first.rank");
  await Promise.resolve();
  auto.consider("second.rank");
  auto.consider("third.rank");
  release();
  await auto.idle();

  assert.deepEqual(asked.sort(), ["first.rank", "second.rank", "third.rank"]);
});
