// The vendored profullstack feed list, against the published one.
//
// src/profullstack-feeds.opml is a copy of what profullstack.com/feeds.opml
// serves. It is a copy on purpose: defaultFeeds() is synchronous, so a fresh
// install cannot fetch the list before it shows anything. The cost of that
// choice is drift, and the point of this file is to make drift loud.
//
// Everything that can be checked without a network runs always — that the file
// is there, that it parses, that the small matcher in news-sources.mjs agrees
// with the real parseOpml, and that its private slug() still matches
// slugify(). Those are the failures a refactor actually causes.
//
// The one check that needs the network — vendored copy against the live URL —
// is opt-in, because a suite that fails when profullstack.com is briefly down
// is a suite people learn to ignore. Run it deliberately:
//
//   MOSHCODE_CHECK_FEED_DRIFT=1 node --test test/profullstack-feeds.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_FEEDS } from "../src/news-sources.mjs";
import { parseOpml, slugify } from "../src/news.mjs";

const OPML = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "profullstack-feeds.opml");
const LIVE = "https://profullstack.com/feeds.opml";

const vendored = fs.readFileSync(OPML, "utf8");
const mine = DEFAULT_FEEDS.filter((f) => f.category === "profullstack");

test("the vendored OPML ships and is read", () => {
  // `files` in package.json includes `src`, so this travels with the package.
  // If it ever stops, profullstackFeeds() degrades to [] rather than throwing —
  // which is the right runtime behaviour and exactly why it needs asserting
  // here instead: silence is the failure mode.
  assert.ok(vendored.includes("<opml"), "not an OPML document");
  assert.ok(mine.length > 0, "no profullstack feeds in the defaults");
});

test("every feed in the file is a default, and nothing else is", () => {
  // parseOpml is the real parser; news-sources.mjs cannot import it without a
  // cycle, so it has a small matcher of its own. This is the assertion that the
  // shortcut did not change the answer.
  const parsed = parseOpml(vendored);
  assert.deepEqual(
    mine.map((f) => f.url).sort(),
    parsed.map((f) => f.url).sort(),
  );
  assert.deepEqual(
    mine.map((f) => f.title).sort(),
    parsed.map((f) => f.title).sort(),
  );
});

test("the private slug() still agrees with slugify()", () => {
  // news-sources.mjs copies slugify() rather than importing it, for the same
  // cycle reason. A feed named differently by the two would be reachable as
  // `--feed <name>` under one name and listed under another.
  for (const feed of mine) assert.equal(feed.name, slugify(feed.title), feed.title);
});

test("the feeds are usable — https, unique, and pointed at a site", () => {
  const urls = mine.map((f) => f.url);
  assert.equal(new Set(urls).size, urls.length, "duplicate feed URL");
  for (const feed of mine) {
    assert.match(feed.url, /^https:\/\//, `${feed.title} is not https`);
    assert.ok(feed.title.trim(), "a feed with no title");
    assert.match(feed.site, /^https:\/\//, `${feed.title} has no site`);
  }
});

test("vendored copy matches profullstack.com/feeds.opml", {
  skip: process.env.MOSHCODE_CHECK_FEED_DRIFT === "1"
    ? false
    : "set MOSHCODE_CHECK_FEED_DRIFT=1 to check against the live file",
}, async () => {
  const res = await fetch(LIVE);
  assert.equal(res.ok, true, `${LIVE} answered ${res.status}`);
  const live = parseOpml(await res.text());

  // Compared by what a reader would act on, not byte for byte: the published
  // file carries a dateCreated that changes without any feed changing.
  assert.deepEqual(
    mine.map((f) => f.url).sort(),
    live.map((f) => f.url).sort(),
    `vendored list is stale — refresh with:\n  curl -sL ${LIVE} -o src/profullstack-feeds.opml`,
  );
});
