// The feed a name publishes: what is accepted into the field, what comes back
// out of an RSS or Atom document, and what the fetcher refuses to go and get.
//
// No database and no express here — everything under test is a pure function
// or takes its fetch injected, which is the whole reason the parsing and the
// fetching live apart from the route.
import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchFeed,
  formatDuration,
  inferKind,
  loadFeed,
  clearFeedCache,
  normalizeFeedKind,
  normalizeFeedUrl,
  parseFeed,
  safeUrl,
} from "../src/lib/feed.mjs";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Scrambled</title>
  <link>https://scrambled.example</link>
  <description>Notes on eggs.</description>
  <item>
    <title>Soft boiled</title>
    <link>https://scrambled.example/soft</link>
    <pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate>
    <description><![CDATA[<p>Six minutes, <b>no more</b>.</p>]]></description>
  </item>
  <item>
    <title>Hard boiled</title>
    <link>/hard</link>
    <pubDate>Mon, 11 Aug 2026 09:00:00 GMT</pubDate>
    <description>Ten.</description>
  </item>
</channel></rss>`;

const PODCAST = `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
  <title>The Pit</title>
  <itunes:author>Moshcode</itunes:author>
  <itunes:image href="https://cdn.example/cover.jpg"/>
  <description>A show.</description>
  <item>
    <title>Episode one</title>
    <link>https://pit.example/1</link>
    <pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate>
    <itunes:duration>1:04:37</itunes:duration>
    <enclosure url="https://cdn.example/1.mp3" type="audio/mpeg" length="52428800"/>
  </item>
  <item>
    <title>Episode two</title>
    <enclosure url="https://cdn.example/2.mp3" type="audio/mpeg" length="1048576"/>
  </item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atomic</title>
  <link rel="self" href="https://atom.example/feed.xml"/>
  <link rel="alternate" href="https://atom.example/"/>
  <subtitle>Short posts.</subtitle>
  <entry>
    <title>First</title>
    <link rel="alternate" href="https://atom.example/first"/>
    <link rel="replies" href="https://atom.example/first/replies"/>
    <published>2026-08-12T09:00:00Z</published>
    <summary>A summary.</summary>
  </entry>
</feed>`;

/* ---- what an owner may type into the field ---- */

test("feed: a bare host gets https, and the stored form is canonical", () => {
  assert.equal(normalizeFeedUrl("example.com/feed.xml").feed, "https://example.com/feed.xml");
  assert.equal(normalizeFeedUrl("  https://example.com/rss  ").feed, "https://example.com/rss");
  // feed:// is what a browser hands you off a subscribe button.
  assert.equal(normalizeFeedUrl("feed://example.com/rss").feed, "https://example.com/rss");
});

test("feed: empty clears it rather than failing", () => {
  assert.deepEqual(normalizeFeedUrl(""), { ok: true, feed: null });
  assert.deepEqual(normalizeFeedUrl(null), { ok: true, feed: null });
});

test("feed: only http(s), and only the public internet", () => {
  assert.equal(normalizeFeedUrl("javascript:alert(1)").ok, false);
  assert.equal(normalizeFeedUrl("file:///etc/passwd").ok, false);
  assert.equal(normalizeFeedUrl("data:text/xml,<rss/>").ok, false);
  // The addresses that make an SSRF worth attempting.
  assert.equal(normalizeFeedUrl("http://127.0.0.1/feed").ok, false);
  assert.equal(normalizeFeedUrl("http://169.254.169.254/latest/meta-data/").ok, false);
  assert.equal(normalizeFeedUrl("http://10.1.2.3/feed").ok, false);
  assert.equal(normalizeFeedUrl("http://[::1]/feed").ok, false);
});

test("feed: the layout is auto, blog or podcast and nothing else", () => {
  assert.deepEqual(normalizeFeedKind(""), { ok: true, kind: null });
  assert.deepEqual(normalizeFeedKind("auto"), { ok: true, kind: null });
  assert.deepEqual(normalizeFeedKind("PODCAST"), { ok: true, kind: "podcast" });
  assert.equal(normalizeFeedKind("newsletter").ok, false);
});

/* ---- turning somebody else's XML into values ---- */

test("feed: RSS parses to a channel and dated, linked items", () => {
  const feed = parseFeed(RSS, { url: "https://scrambled.example/feed.xml" });
  assert.equal(feed.title, "Scrambled");
  assert.equal(feed.site, "https://scrambled.example/");
  assert.equal(feed.description, "Notes on eggs.");
  assert.equal(feed.items.length, 2);

  const [first, second] = feed.items;
  assert.equal(first.title, "Soft boiled");
  assert.equal(first.link, "https://scrambled.example/soft");
  assert.equal(first.date, Date.parse("Tue, 12 Aug 2026 09:00:00 GMT"));
  // CDATA carried markup; what comes out is text, with the gap the stripped
  // `</b>` left in front of the full stop closed up.
  assert.equal(first.summary, "Six minutes, no more.");
  // A relative link resolves against the feed it came from.
  assert.equal(second.link, "https://scrambled.example/hard");
});

test("feed: Atom parses, and rel=self/replies are not the entry's link", () => {
  const feed = parseFeed(ATOM, { url: "https://atom.example/feed.xml" });
  assert.equal(feed.title, "Atomic");
  assert.equal(feed.description, "Short posts.");
  assert.equal(feed.items[0].link, "https://atom.example/first");
});

test("feed: a podcast carries cover art, enclosures and a duration", () => {
  const feed = parseFeed(PODCAST, { url: "https://pit.example/feed.xml" });
  assert.equal(feed.kind, "podcast");
  assert.equal(feed.image, "https://cdn.example/cover.jpg");
  assert.equal(feed.author, "Moshcode");
  assert.deepEqual(feed.items[0].audio, {
    url: "https://cdn.example/1.mp3", type: "audio/mpeg", bytes: 52428800, video: false,
  });
  assert.equal(feed.items[0].duration, "1:04:37");
});

test("feed: an entry with a title and no link is still an entry", () => {
  const feed = parseFeed(`<rss><channel><title>T</title>
    <item><title>A note</title><description>no permalink</description></item>
  </channel></rss>`, { url: "https://example.com/f" });
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].link, null);
});

test("feed: a DOCTYPE entity is never expanded", () => {
  const hostile = `<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<rss><channel><title>&xxe;</title><item><title>hi</title><link>https://e.com/1</link></item></channel></rss>`;
  const feed = parseFeed(hostile, { url: "https://e.com/f" });
  // The DOCTYPE is stripped and &xxe; is not in the table, so it survives as
  // the literal text it was — never as the contents of a file.
  assert.ok(!feed.title.includes("root:"));
  assert.equal(feed.items.length, 1);
});

test("feed: a javascript: link never becomes a link", () => {
  const feed = parseFeed(`<rss><channel><title>T</title>
    <item><title>x</title><link>javascript:alert(1)</link></item>
    <item><title>y</title><enclosure url="javascript:alert(2)" type="audio/mpeg"/></item>
  </channel></rss>`, { url: "https://e.com/f" });
  assert.equal(feed.items[0].link, null);
  assert.equal(feed.items[1].audio, null);
  assert.equal(safeUrl("javascript:alert(1)"), null);
});

test("feed: a cover image enclosure does not make a blog a podcast", () => {
  const feed = parseFeed(`<rss><channel><title>T</title>
    <item><title>a</title><link>https://e.com/a</link><enclosure url="https://e.com/a.png" type="image/png"/></item>
    <item><title>b</title><link>https://e.com/b</link></item>
    <item><title>c</title><link>https://e.com/c</link></item>
  </channel></rss>`, { url: "https://e.com/f" });
  assert.equal(feed.kind, "blog");
  assert.equal(feed.items[0].audio, null);
});

test("feed: a blog with one recording is still a blog; a show with a text post is still a show", () => {
  const audio = { url: "https://e.com/a.mp3", type: "audio/mpeg" };
  assert.equal(inferKind([{ audio }, {}, {}, {}, {}, {}, {}, {}, {}, {}]), "blog");
  assert.equal(inferKind([{ audio }, { audio }, { audio }, {}]), "podcast");
  assert.equal(inferKind([]), "blog");
});

test("feed: durations arrive as seconds or as clocks and leave as one form", () => {
  assert.equal(formatDuration("3877"), "1:04:37");
  assert.equal(formatDuration("1:04:37"), "1:04:37");
  assert.equal(formatDuration("64:37"), "1:04:37");
  assert.equal(formatDuration("605"), "10:05");
  assert.equal(formatDuration("banana"), "");
  assert.equal(formatDuration(""), "");
});

/* ---- going and getting it ---- */

/** A fetch that answers one canned response and records what it was asked for. */
function stubFetch(responses) {
  const calls = [];
  return Object.assign(async (url) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error("no response queued");
    if (next.throws) throw Object.assign(new Error("boom"), { name: next.throws });
    return new Response(next.body ?? "", {
      status: next.status ?? 200,
      headers: next.headers ?? { "content-type": "application/xml" },
    });
  }, { calls });
}

const publicHost = async () => ({ ok: true, host: "example.com", port: 443, addresses: ["93.184.216.34"] });

test("feed: a fetched feed comes back parsed", async () => {
  const fetchImpl = stubFetch([{ body: RSS }]);
  const result = await fetchFeed("https://scrambled.example/feed.xml", { fetchImpl, check: publicHost });
  assert.equal(result.ok, true);
  assert.equal(result.feed.title, "Scrambled");
  assert.equal(result.feed.items.length, 2);
});

test("feed: a host that resolves somewhere private is never fetched", async () => {
  const fetchImpl = stubFetch([{ body: RSS }]);
  const check = async () => ({ ok: false, error: "target resolves to private" });
  const result = await fetchFeed("https://internal.example/feed.xml", { fetchImpl, check });
  assert.equal(result.ok, false);
  assert.match(result.error, /public internet/);
  assert.equal(fetchImpl.calls.length, 0, "nothing was requested");
});

test("feed: every redirect hop is checked, not just the first", async () => {
  const fetchImpl = stubFetch([
    { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } },
    { body: RSS },
  ]);
  let hop = 0;
  const check = async (host) => {
    hop++;
    return host === "169.254.169.254"
      ? { ok: false, error: "target is link-local — cloud metadata lives here" }
      : { ok: true, host, port: 443, addresses: ["93.184.216.34"] };
  };
  const result = await fetchFeed("https://scrambled.example/feed.xml", { fetchImpl, check });
  assert.equal(result.ok, false);
  assert.match(result.error, /link-local/);
  assert.equal(hop, 2, "the redirect target was checked too");
  assert.equal(fetchImpl.calls.length, 1, "the metadata service was never requested");
});

test("feed: a redirect loop gives up rather than spinning", async () => {
  const responses = Array.from({ length: 12 }, () => ({
    status: 301, headers: { location: "https://scrambled.example/feed.xml" },
  }));
  const result = await fetchFeed("https://scrambled.example/feed.xml", {
    fetchImpl: stubFetch(responses), check: publicHost,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /redirects too many times/);
});

test("feed: a page that is not a feed is refused, and says so", async () => {
  const result = await fetchFeed("https://example.com/", {
    fetchImpl: stubFetch([{ body: "<html><body>hello</body></html>" }]), check: publicHost,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /RSS or Atom/);
});

test("feed: an error status is reported with the status", async () => {
  const result = await fetchFeed("https://example.com/feed.xml", {
    fetchImpl: stubFetch([{ status: 404, body: "nope" }]), check: publicHost,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /404/);
});

test("feed: a timeout is named as one", async () => {
  const result = await fetchFeed("https://example.com/feed.xml", {
    fetchImpl: stubFetch([{ throws: "TimeoutError" }]), check: publicHost,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not answer in time/);
});

test("feed: a body past the cap is truncated to whole items, not failed", async () => {
  // Two good items, then a megabyte of a third that never closes.
  const long = RSS.replace("</channel>", `<item><title>${"x".repeat(400_000)}</title></item></channel>`);
  const result = await fetchFeed("https://scrambled.example/feed.xml", {
    fetchImpl: stubFetch([{ body: long }]), check: publicHost, maxBytes: 2000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.feed.truncated, true);
  assert.equal(result.feed.items.length, 2, "the cut item is simply not an item");
});

/* ---- the cache in front of it ---- */

test("feed: a fresh feed is served from memory rather than refetched", async () => {
  clearFeedCache();
  const fetchImpl = stubFetch([{ body: RSS }]);
  const opts = { fetchImpl, check: publicHost };
  const first = await loadFeed("https://cache.example/feed.xml", opts);
  const second = await loadFeed("https://cache.example/feed.xml", opts);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(fetchImpl.calls.length, 1, "the origin was asked once");
});

test("feed: a stale copy beats an error page when the origin stops answering", async () => {
  clearFeedCache();
  const at = 1_700_000_000_000;
  const fetchImpl = stubFetch([{ body: RSS }, { status: 500, body: "" }]);
  const opts = { fetchImpl, check: publicHost };
  await loadFeed("https://stale.example/feed.xml", { ...opts, now: at });
  // Past the TTL, so it tries again — and the origin is down.
  const later = await loadFeed("https://stale.example/feed.xml", { ...opts, now: at + 10 * 60 * 1000 });
  assert.equal(later.ok, true);
  assert.equal(later.stale, true);
  assert.equal(later.feed.title, "Scrambled");
});

test("feed: past the stale window the failure is the answer", async () => {
  clearFeedCache();
  const at = 1_700_000_000_000;
  const fetchImpl = stubFetch([{ body: RSS }, { status: 500, body: "" }]);
  const opts = { fetchImpl, check: publicHost };
  await loadFeed("https://gone.example/feed.xml", { ...opts, now: at });
  const later = await loadFeed("https://gone.example/feed.xml", { ...opts, now: at + 48 * 60 * 60 * 1000 });
  assert.equal(later.ok, false);
});
