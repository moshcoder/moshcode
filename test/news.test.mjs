// `moshcode news` — argument translation, the three feed dialects, and the
// things a reader must never get wrong: opening a link a feed talked it into,
// letting one dead publisher take the whole listing down, and rendering an
// escaped anchor tag as if it were the headline.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NEWS_VERB_NAMES, ago, buildOpml, collectNews, decodeEntities, findFeed,
  listOf, loadFeeds, loadListFeeds, looksLikeOpml, matchFeeds, newsArgs,
  newsCommand, newsUsage, opmlFile, parseFeed, parseFeedList, parseKeywords,
  parseListDocument, parseOpml, readingList, renderFeeds, renderHeadlines,
  resolveVerb, safeUrl, saveFeeds, searchFeeds, slugify, subscribedLists,
  tagWithList, withFeed,
} from "../src/news.mjs";
import { DEFAULT_FEEDS, isDeadEndLink, resolveBundle, unwrapRedirect } from "../src/news-sources.mjs";
import { NEWS_VERBS } from "../src/cli-schema.mjs";

// --- fixtures ----------------------------------------------------------------

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example Wire</title>
  <link>https://example.com</link>
  <item>
    <title>First story</title>
    <link>https://example.com/1</link>
    <pubDate>Tue, 11 Aug 2026 12:00:00 GMT</pubDate>
    <description><![CDATA[<p>A <b>summary</b> &amp; more</p>]]></description>
  </item>
  <item>
    <title>Second story</title>
    <link>https://example.com/2</link>
    <pubDate>Mon, 10 Aug 2026 12:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Daily</title>
  <link rel="self" href="https://atom.example/feed"/>
  <link rel="alternate" href="https://atom.example"/>
  <entry>
    <title>Atom story</title>
    <link rel="self" href="https://atom.example/feed/1"/>
    <link rel="alternate" href="https://atom.example/1"/>
    <updated>2026-08-11T09:00:00Z</updated>
    <summary>An atom summary</summary>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>RDF Weekly</title></channel>
  <item rdf:about="https://rdf.example/1">
    <title>RDF story</title>
    <link>https://rdf.example/1</link>
    <dc:date>2026-08-09T00:00:00Z</dc:date>
  </item>
</rdf:RDF>`;

const OPML = `<?xml version="1.0"?>
<opml version="2.0">
  <head><title>subs</title></head>
  <body>
    <outline text="Loose Feed" xmlUrl="https://loose.example/rss"/>
    <outline text="Tech">
      <outline text="Ars Technica" xmlUrl="https://arst.example/rss" htmlUrl="https://arst.example"/>
      <outline text="Dupe" xmlUrl="https://arst.example/rss"/>
    </outline>
    <outline text="Empty Folder"/>
  </body>
</opml>`;

/** A fetch stand-in that answers from a url → body map. */
function fakeFetch(routes) {
  return async (url) => {
    const body = routes[url];
    if (body === undefined) return { ok: false, status: 404, statusText: "Not Found", text: async () => "" };
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, text: async () => body };
  };
}

/** A throwaway $HOME so the real ~/.moshcode is never touched. */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-news-"));
  return { env: { MOSHCODE_NEWS_OPML: path.join(dir, "news.opml") }, dir };
}

/** Collect a command's output the way cryptoCommand's tests do. */
function sink() {
  const lines = [];
  const errors = [];
  return {
    lines, errors,
    out: (s) => lines.push(String(s)),
    fail: (s) => errors.push(String(s)),
    text: () => lines.join("\n"),
    errorText: () => errors.join("\n"),
  };
}

// --- verbs and arguments -----------------------------------------------------

test("every verb the schema documents is one the parser resolves", () => {
  // The schema drives help and completion; the parser drives behaviour. A verb
  // in one and not the other is a command that completes and then fails.
  assert.deepEqual(NEWS_VERBS.map(({ name }) => name).sort(), [...NEWS_VERB_NAMES].sort());
  for (const { name } of NEWS_VERBS) assert.equal(resolveVerb(name), name, `${name} does not resolve`);
});

test("no arguments is the headline list, not usage", () => {
  // Unlike crypto, a bare `/news` has an obvious answer, and printing usage
  // instead would make the common case the one that needs a manual.
  const request = newsArgs([]);
  assert.equal(request.verb, "headlines");
  assert.equal(request.target, null);
  assert.match(newsUsage(), /usage: moshcode news/);
});

test("`latest` says the default out loud and takes nothing", () => {
  assert.equal(newsArgs(["latest"]).verb, "headlines");
  assert.equal(newsArgs(["headlines"]).verb, "headlines");
  assert.match(newsArgs(["latest", "tariffs"]).error, /takes no arguments/);
});

test("a bare word is a search, a bare URL is a feed to read", () => {
  assert.deepEqual(
    { verb: newsArgs(["tariffs"]).verb, query: newsArgs(["tariffs"]).query },
    { verb: "search", query: "tariffs" },
  );
  // Several words are one phrase, not a verb plus arguments.
  assert.equal(newsArgs(["openai", "earnings"]).query, "openai earnings");
  const url = newsArgs(["https://example.com/feed.xml"]);
  assert.equal(url.verb, "headlines");
  assert.equal(url.oneOff, true);
  assert.equal(url.target, "https://example.com/feed.xml");
});

test("search flags are flags, not part of the phrase", () => {
  const request = newsArgs(["fed", "rates", "--limit", "5", "--json"]);
  assert.equal(request.query, "fed rates");
  assert.equal(request.limit, 5);
  assert.equal(request.json, true);
});

test("flags that need a value say so instead of silently defaulting", () => {
  assert.match(newsArgs(["--limit"]).error, /--limit needs a number/);
  assert.match(newsArgs(["--limit", "zero"]).error, /whole number/);
  assert.match(newsArgs(["--limit", "0"]).error, /whole number/);
  assert.match(newsArgs(["--feed"]).error, /--feed needs a feed name/);
  assert.match(newsArgs(["--timeout", "999"]).error, /1-120 seconds/);
  assert.match(newsArgs(["--nope"]).error, /unknown flag --nope/);
});

test("--limit is capped rather than trusted", () => {
  assert.equal(newsArgs(["--limit", "100000"]).limit, 200);
});

test("open takes a headline number and nothing else", () => {
  assert.equal(newsArgs(["open", "3"]).index, 3);
  assert.match(newsArgs(["open"]).error, /usage: moshcode news open/);
  assert.match(newsArgs(["open", "x"]).error, /headline number/);
  assert.match(newsArgs(["open", "0"]).error, /headline number/);
});

test("add takes exactly one target", () => {
  assert.equal(newsArgs(["add", "journalists"]).target, "journalists");
  assert.match(newsArgs(["add"]).error, /usage: moshcode news add/);
  assert.match(newsArgs(["add", "a", "b"]).error, /one URL, list, or number at a time/);
});

// --- URLs --------------------------------------------------------------------

test("only http(s) survives — a feed cannot talk the reader into file: or data:", () => {
  assert.equal(safeUrl("https://example.com/x"), "https://example.com/x");
  assert.equal(safeUrl("http://example.com/x"), "http://example.com/x");
  assert.equal(safeUrl("file:///etc/passwd"), null);
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("data:text/html,<script>"), null);
  assert.equal(safeUrl("not a url"), null);
  assert.equal(safeUrl(""), null);
});

test("redirect wrappers are unwrapped to the publisher, never followed", () => {
  // This is why the search queries Bing as well as Google: Bing's links carry
  // the real article, Google's are interstitials.
  assert.equal(
    unwrapRedirect("http://www.bing.com/news/apiclick.aspx?ref=FexRss&url=https%3a%2f%2fexample.com%2fa&c=1"),
    "https://example.com/a",
  );
  // Nothing to unwrap, and a non-http inner value, both come back untouched.
  assert.equal(unwrapRedirect("https://example.com/plain"), "https://example.com/plain");
  assert.equal(unwrapRedirect("https://x.example/?url=javascript%3Aalert(1)"), "https://x.example/?url=javascript%3Aalert(1)");
  assert.equal(unwrapRedirect("nonsense"), "nonsense");
});

// --- entities and markup -----------------------------------------------------

test("entities decode, and a hostile one is left as text rather than expanded", () => {
  assert.equal(decodeEntities("AT&amp;T &lt;b&gt; &#39;q&#39; &#x27;r&#x27;"), "AT&T <b> 'q' 'r'");
  // No DOCTYPE entity is ever resolved — that is the whole XXE class, gone.
  assert.equal(decodeEntities("&xxe;"), "&xxe;");
  assert.equal(decodeEntities("&#xD800;"), "&#xD800;"); // lone surrogate
  assert.equal(decodeEntities("&#99999999;"), "&#99999999;");
});

test("an escaped anchor is stripped, not decoded back into the headline", () => {
  // Google News escapes its HTML, so stripping before decoding leaves markup
  // on screen. The doubled `&amp;nbsp;` is why one round is not enough.
  const feed = `<rss><channel><item>
    <title>Real headline</title><link>https://e.example/1</link>
    <description>&lt;a href="https://e.example/1"&gt;Real headline&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font&gt;Publisher&lt;/font&gt;</description>
  </item></channel></rss>`;
  const { items } = parseFeed(feed);
  assert.equal(items[0].summary, "Real headline Publisher");
  assert.doesNotMatch(items[0].summary, /</);
  assert.doesNotMatch(items[0].summary, /&nbsp;/);
});

// --- the three dialects ------------------------------------------------------

test("RSS 2.0 parses, CDATA and all", () => {
  const feed = parseFeed(RSS, { url: "https://example.com/rss" });
  assert.equal(feed.title, "Example Wire");
  assert.equal(feed.items.length, 2);
  assert.equal(feed.items[0].title, "First story");
  assert.equal(feed.items[0].link, "https://example.com/1");
  assert.equal(feed.items[0].summary, "A summary & more");
  assert.equal(feed.items[0].date, Date.parse("Tue, 11 Aug 2026 12:00:00 GMT"));
});

test("Atom parses, and rel=self is never mistaken for the article", () => {
  const feed = parseFeed(ATOM, { url: "https://atom.example/feed" });
  assert.equal(feed.title, "Atom Daily");
  // Normalized through URL, so a bare origin keeps its root slash.
  assert.equal(feed.site, "https://atom.example/");
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].link, "https://atom.example/1");
  assert.equal(feed.items[0].date, Date.parse("2026-08-11T09:00:00Z"));
});

test("RDF parses, dc:date included", () => {
  const feed = parseFeed(RDF, { url: "https://rdf.example/rss" });
  assert.equal(feed.title, "RDF Weekly");
  assert.equal(feed.items[0].link, "https://rdf.example/1");
  assert.equal(feed.items[0].date, Date.parse("2026-08-09T00:00:00Z"));
});

test("a permalink guid is a link, and a non-permalink guid is not", () => {
  const permalink = parseFeed(`<rss><channel><item><title>T</title>
    <guid isPermaLink="true">https://g.example/1</guid></item></channel></rss>`);
  assert.equal(permalink.items[0].link, "https://g.example/1");
  const opaque = parseFeed(`<rss><channel><item><title>T</title>
    <guid isPermaLink="false">tag:g.example,2026:1</guid></item></channel></rss>`);
  assert.equal(opaque.items[0].link, null);
});

test("the channel title is not stolen from the first entry", () => {
  const feed = parseFeed(`<rss><channel><item><title>Entry title</title>
    <link>https://e.example/1</link></item></channel></rss>`, { url: "https://e.example/rss" });
  assert.equal(feed.title, "e.example");
});

test("comments and DOCTYPE are stripped before anything is read", () => {
  const feed = parseFeed(`<?xml version="1.0"?>
    <!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
    <rss><channel><title>Safe</title>
    <!-- <item><title>Ghost</title></item> -->
    <item><title>Real</title><link>https://s.example/1</link></item>
    </channel></rss>`);
  assert.equal(feed.title, "Safe");
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].title, "Real");
});

test("an entry with neither a title nor a link is dropped", () => {
  const feed = parseFeed(`<rss><channel><item><pubDate>Tue, 11 Aug 2026 12:00:00 GMT</pubDate></item></channel></rss>`);
  assert.equal(feed.items.length, 0);
});

// --- OPML --------------------------------------------------------------------

test("OPML folders become categories, and a repeated feed is imported once", () => {
  const feeds = parseOpml(OPML);
  assert.deepEqual(feeds.map((f) => [f.name, f.category]), [
    ["loose-feed", ""],
    ["ars-technica", "Tech"],
  ]);
  assert.equal(feeds[1].url, "https://arst.example/rss");
  assert.equal(feeds[1].site, "https://arst.example/");
});

test("an OPML outline pointing somewhere unopenable is skipped", () => {
  const feeds = parseOpml(`<opml><body>
    <outline text="Bad" xmlUrl="file:///etc/passwd"/>
    <outline text="Good" xmlUrl="https://good.example/rss"/>
  </body></opml>`);
  assert.deepEqual(feeds.map((f) => f.name), ["good"]);
});

test("OPML survives a round trip, categories included", () => {
  const feeds = parseOpml(OPML);
  const again = parseOpml(buildOpml(feeds));
  assert.deepEqual(again.map((f) => [f.name, f.url, f.category]), feeds.map((f) => [f.name, f.url, f.category]));
});

test("a title with XML metacharacters cannot break the file it is written to", () => {
  const written = buildOpml([{ name: "x", title: 'A & B <"C">', url: "https://x.example/rss", site: "", category: "" }]);
  assert.match(written, /A &amp; B &lt;&quot;C&quot;&gt;/);
  assert.deepEqual(parseOpml(written).map((f) => f.title), ['A & B <"C">']);
});

test("an OPML document is told apart from a feed", () => {
  assert.equal(looksLikeOpml(OPML), true);
  assert.equal(looksLikeOpml(RSS), false);
  assert.equal(looksLikeOpml(ATOM), false);
});

test("slugs are typeable, and a name collision is suffixed rather than overwritten", () => {
  assert.equal(slugify("Ars Technica — All content"), "ars-technica-all-content");
  assert.equal(slugify("!!!"), "");
  const first = withFeed([], { name: "news", url: "https://a.example/rss" });
  const second = withFeed(first.feeds, { name: "news", url: "https://b.example/rss" });
  assert.deepEqual(second.feeds.map((f) => f.name), ["news", "news-2"]);
  // The same URL twice is the same subscription, whatever it calls itself.
  const third = withFeed(second.feeds, { name: "other", url: "https://a.example/rss" });
  assert.equal(third.existed, true);
  assert.equal(third.feeds.length, 2);
});

test("a feed is findable by name, url, or title", () => {
  const feeds = parseOpml(OPML);
  assert.equal(findFeed(feeds, "ars-technica")?.url, "https://arst.example/rss");
  assert.equal(findFeed(feeds, "https://arst.example/rss")?.name, "ars-technica");
  assert.equal(findFeed(feeds, "Ars Technica")?.name, "ars-technica");
  assert.equal(findFeed(feeds, "nope"), null);
});

// --- the subscription store --------------------------------------------------

test("the store round-trips, and an unreadable file reads as no subscriptions", () => {
  const { env } = sandbox();
  assert.deepEqual(loadFeeds(env), []);
  saveFeeds(parseOpml(OPML), env);
  assert.deepEqual(loadFeeds(env).map((f) => f.name), ["loose-feed", "ars-technica"]);
  // A hand-edited file with a stray tag must not take the command down.
  fs.writeFileSync(env.MOSHCODE_NEWS_OPML, "<opml><body><outline");
  assert.deepEqual(loadFeeds(env), []);
});

test("the subscription file is owner-only — it is a reading history", () => {
  const { env } = sandbox();
  saveFeeds(parseOpml(OPML), env);
  assert.equal(fs.statSync(env.MOSHCODE_NEWS_OPML).mode & 0o777, 0o600);
});

test("with nothing subscribed the defaults stand in, and say that they are", () => {
  const { env } = sandbox();
  const empty = readingList(env);
  assert.equal(empty.usingDefaults, true);
  assert.equal(empty.feeds.length, DEFAULT_FEEDS.length);
  saveFeeds([{ name: "mine", title: "Mine", url: "https://mine.example/rss", site: "", category: "" }], env);
  const own = readingList(env);
  assert.equal(own.usingDefaults, false);
  assert.deepEqual(own.feeds.map((f) => f.name), ["mine"]);
});

test("MOSHCODE_NEWS_OPML redirects the store away from ~/.moshcode", () => {
  const { env } = sandbox();
  assert.equal(opmlFile(env), env.MOSHCODE_NEWS_OPML);
  assert.match(opmlFile({}), /\.moshcode[/\\]news\.opml$/);
});

test("every default feed is a distinct, openable http(s) URL", () => {
  const urls = new Set();
  for (const feed of DEFAULT_FEEDS) {
    assert.ok(safeUrl(feed.url), `${feed.name} is not an http(s) URL`);
    assert.ok(feed.name && feed.title, `${feed.name} is missing a name or title`);
    assert.equal(urls.has(feed.url), false, `${feed.name} duplicates another default`);
    urls.add(feed.url);
  }
});

test("bundles resolve by name and nothing else", () => {
  assert.equal(resolveBundle("journalists").url.startsWith("https://"), true);
  assert.equal(resolveBundle("JOURNALISTS").name, "journalists");
  assert.equal(resolveBundle("nope"), null);
});

// --- merging -----------------------------------------------------------------

test("feeds merge newest-first, deduped on the unwrapped link", () => {
  const feeds = [
    { name: "wire", url: "https://a.example/rss" },
    { name: "aggregator", url: "https://b.example/rss" },
  ];
  const aggregated = `<rss><channel><title>Agg</title><item>
    <title>First story</title>
    <link>https://agg.example/click?url=https%3a%2f%2fexample.com%2f1</link>
    <pubDate>Tue, 11 Aug 2026 12:00:00 GMT</pubDate>
  </item></channel></rss>`;
  return collectNews(feeds, {
    fetchImpl: fakeFetch({ "https://a.example/rss": RSS, "https://b.example/rss": aggregated }),
  }).then(({ items, failures }) => {
    assert.deepEqual(failures, []);
    // The aggregator's copy unwraps to https://example.com/1, which the wire
    // already supplied — one story, not two.
    assert.deepEqual(items.map((i) => i.title), ["First story", "Second story"]);
    assert.equal(items[0].link, "https://example.com/1");
    assert.ok(items[0].date > items[1].date);
  });
});

test("one dead publisher is reported, not fatal", async () => {
  const { items, failures } = await collectNews([
    { name: "up", url: "https://a.example/rss" },
    { name: "down", url: "https://gone.example/rss" },
  ], { fetchImpl: fakeFetch({ "https://a.example/rss": RSS }) });
  assert.equal(items.length, 2);
  assert.deepEqual(failures.map((f) => f.name), ["down"]);
  assert.match(failures[0].error, /404/);
});

test("undated entries sort last rather than claiming to be the newest", async () => {
  const undated = `<rss><channel><title>U</title>
    <item><title>No date</title><link>https://u.example/1</link></item></channel></rss>`;
  const { items } = await collectNews([
    { name: "dated", url: "https://a.example/rss" },
    { name: "undated", url: "https://u.example/rss" },
  ], { fetchImpl: fakeFetch({ "https://a.example/rss": RSS, "https://u.example/rss": undated }) });
  assert.equal(items.at(-1).title, "No date");
});

test("a search reads Bing only — Google's results are not openable", () => {
  // Google News was the other half of this pairing until its item links were
  // measured: no publisher URL in any header, in the base64 token, or in the
  // page, and its internal resolver 429s on the first call. Every result it
  // returned was dropped by collectNews anyway, so it is no longer fetched.
  const feeds = searchFeeds("bitcoin etf");
  assert.deepEqual(feeds.map((f) => f.name), ["bing"]);
  assert.match(feeds[0].url, /bing\.com\/news\/search\?q=bitcoin%20etf&format=RSS/);
  assert.equal(feeds.some((f) => f.url.includes("news.google.com")), false);
});

test("a headline whose only link is a Google interstitial is dropped", async () => {
  const withDeadEnds = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Aggregated</title>
  <item><title>Unopenable</title><link>https://news.google.com/rss/articles/CBMiabc?oc=5</link></item>
  <item><title>Readable</title><link>https://publisher.example/story</link></item>
</channel></rss>`;
  const { items } = await collectNews(
    [{ name: "agg", title: "Aggregated", url: "https://agg.example/rss" }],
    { fetchImpl: fakeFetch({ "https://agg.example/rss": withDeadEnds }) },
  );
  assert.deepEqual(items.map((i) => i.title), ["Readable"]);
});

test("only the interstitial is a dead end, not google news itself", () => {
  assert.equal(isDeadEndLink("https://news.google.com/rss/articles/CBMiabc?oc=5"), true);
  assert.equal(isDeadEndLink("https://news.google.com/rss?hl=en-US"), false);
  assert.equal(isDeadEndLink("https://publisher.example/story"), false);
  assert.equal(isDeadEndLink("not a url"), false);
});

// --- rendering ---------------------------------------------------------------

test("relative times read the way a person says them", () => {
  const now = Date.parse("2026-08-11T12:00:00Z");
  assert.equal(ago(now - 30_000, now), "30s ago");
  assert.equal(ago(now - 20 * 60_000, now), "20m ago");
  assert.equal(ago(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(ago(now - 3 * 86_400_000, now), "3d ago");
  assert.equal(ago(now - 21 * 86_400_000, now), "3w ago");
  assert.equal(ago(null, now), "");
  // A feed whose clock is ahead does not get to print "-2h ago".
  assert.equal(ago(now + 7_200_000, now), "just now");
});

test("headlines are numbered from one and say how to open one", () => {
  const now = Date.parse("2026-08-11T12:00:00Z");
  const items = [
    { title: "First story", feed: "wire", date: now - 3 * 3_600_000 },
    { title: "Second story", feed: "wire", date: now - 5 * 3_600_000 },
  ];
  const frame = renderHeadlines(items, { columns: 80, limit: 20, now });
  assert.match(frame, /1\. First story/);
  assert.match(frame, /2\. Second story/);
  assert.match(frame, /3h ago/);
  assert.match(frame, /\/news open <n>/);
});

test("a listing whose feeds all failed says so instead of showing an empty page", () => {
  const frame = renderHeadlines([], { failures: [{ name: "down", error: "timed out" }], columns: 80 });
  assert.match(frame, /nothing came back/);
  assert.match(frame, /down — timed out/);
});

test("the feed list distinguishes defaults from a real subscription", () => {
  assert.match(renderFeeds(DEFAULT_FEEDS, { usingDefaults: true }), /default feeds · nothing subscribed yet/);
  assert.match(renderFeeds([{ name: "mine", title: "Mine", url: "https://m.example/rss", category: "" }], { file: "/tmp/x.opml" }), /1 feed · \/tmp\/x\.opml/);
  assert.match(renderFeeds([]), /no feeds yet/);
});

// --- the command, end to end -------------------------------------------------

test("headlines come from the subscription file when there is one", async () => {
  const { env } = sandbox();
  saveFeeds([{ name: "wire", title: "Example Wire", url: "https://a.example/rss", site: "", category: "" }], env);
  const io = sink();
  const code = await newsCommand([], {
    ...io, env, fetchImpl: fakeFetch({ "https://a.example/rss": RSS }),
    now: Date.parse("2026-08-11T13:00:00Z"), columns: 80,
  });
  assert.equal(code, 0);
  assert.match(io.text(), /First story/);
  assert.match(io.text(), /Second story/);
});

test("a total outage exits non-zero — a script must not read it as 'no news'", async () => {
  const { env } = sandbox();
  saveFeeds([{ name: "down", title: "Down", url: "https://gone.example/rss", site: "", category: "" }], env);
  const io = sink();
  const code = await newsCommand([], { ...io, env, fetchImpl: fakeFetch({}) });
  assert.equal(code, 1);
});

test("--json is the same data, and it feeds `open <n>`", async () => {
  const { env } = sandbox();
  saveFeeds([{ name: "wire", title: "Example Wire", url: "https://a.example/rss", site: "", category: "" }], env);
  const io = sink();
  await newsCommand(["--json", "--limit", "1"], { ...io, env, fetchImpl: fakeFetch({ "https://a.example/rss": RSS }) });
  const parsed = JSON.parse(io.text());
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].link, "https://example.com/1");

  const opened = [];
  const io2 = sink();
  const code = await newsCommand(["open", "1"], { ...io2, env, openUrl: (u) => { opened.push(u); return true; } });
  assert.equal(code, 0);
  assert.deepEqual(opened, ["https://example.com/1"]);
});

test("`open` past the end of the listing names the range instead of throwing", async () => {
  const { env } = sandbox();
  saveFeeds([{ name: "wire", title: "Example Wire", url: "https://a.example/rss", site: "", category: "" }], env);
  const io = sink();
  await newsCommand(["--limit", "1"], { ...io, env, fetchImpl: fakeFetch({ "https://a.example/rss": RSS }) });
  const io2 = sink();
  const code = await newsCommand(["open", "9"], { ...io2, env });
  assert.equal(code, 1);
  assert.match(io2.errorText(), /no headline 9/);
});

test("`open` before any listing says to list first", async () => {
  const { env } = sandbox();
  const io = sink();
  const code = await newsCommand(["open", "1"], { ...io, env });
  assert.equal(code, 1);
  assert.match(io.errorText(), /run `\/news` first/);
});

test("--feed narrows to one, and an unknown name lists what there is", async () => {
  const { env } = sandbox();
  saveFeeds(parseOpml(OPML), env);
  const io = sink();
  const code = await newsCommand(["--feed", "nope"], { ...io, env, fetchImpl: fakeFetch({}) });
  assert.equal(code, 1);
  assert.match(io.errorText(), /no feed named "nope"/);
  assert.match(io.errorText(), /loose-feed/);
});

test("`add` on a feed subscribes to it, and again is a no-op", async () => {
  const { env } = sandbox();
  const fetchImpl = fakeFetch({ "https://a.example/rss": RSS });
  const io = sink();
  const code = await newsCommand(["add", "https://a.example/rss"], { ...io, env, fetchImpl });
  assert.equal(code, 0);
  assert.deepEqual(loadFeeds(env).map((f) => [f.name, f.url]), [["example-wire", "https://a.example/rss"]]);

  const io2 = sink();
  await newsCommand(["add", "https://a.example/rss"], { ...io2, env, fetchImpl });
  assert.match(io2.text(), /already subscribed/);
  assert.equal(loadFeeds(env).length, 1);
});

test("`add` on an OPML document imports the whole list", async () => {
  const { env } = sandbox();
  const io = sink();
  const code = await newsCommand(["add", "https://subs.example/list.opml"], {
    ...io, env, fetchImpl: fakeFetch({ "https://subs.example/list.opml": OPML }),
  });
  assert.equal(code, 0);
  assert.deepEqual(loadFeeds(env).map((f) => f.name), ["loose-feed", "ars-technica"]);
  assert.match(io.text(), /subscribed to 2 feeds/);
});

test("`add` on a local OPML file works — the file is read, not subscribed to", async () => {
  const { env, dir } = sandbox();
  const file = path.join(dir, "subs.opml");
  fs.writeFileSync(file, OPML);
  const io = sink();
  assert.equal(await newsCommand(["add", file], { ...io, env }), 0);
  assert.deepEqual(loadFeeds(env).map((f) => f.name), ["loose-feed", "ars-technica"]);
});

test("`add` refuses a local file that is a feed — a path cannot refresh", async () => {
  const { env, dir } = sandbox();
  const file = path.join(dir, "feed.xml");
  fs.writeFileSync(file, RSS);
  const io = sink();
  assert.equal(await newsCommand(["add", file], { ...io, env }), 1);
  assert.match(io.errorText(), /subscribe to it by URL/);
  assert.deepEqual(loadFeeds(env), []);
});

test("`add` on a bundle name fetches that bundle's list", async () => {
  const { env } = sandbox();
  const bundle = resolveBundle("journalists");
  const io = sink();
  const code = await newsCommand(["add", "journalists"], {
    ...io, env, fetchImpl: fakeFetch({ [bundle.url]: OPML }),
  });
  assert.equal(code, 0);
  assert.deepEqual(loadFeeds(env).map((f) => f.name), ["loose-feed", "ars-technica"]);
});

test("`rm` unsubscribes, and an unknown name lists what there is", async () => {
  const { env } = sandbox();
  saveFeeds(parseOpml(OPML), env);
  const io = sink();
  assert.equal(await newsCommand(["rm", "ars-technica"], { ...io, env }), 0);
  assert.deepEqual(loadFeeds(env).map((f) => f.name), ["loose-feed"]);
  const io2 = sink();
  assert.equal(await newsCommand(["rm", "ars-technica"], { ...io2, env }), 1);
  assert.match(io2.errorText(), /no feed named/);
});

test("`export` prints OPML another reader can import", async () => {
  const { env } = sandbox();
  saveFeeds(parseOpml(OPML), env);
  const io = sink();
  assert.equal(await newsCommand(["export"], { ...io, env }), 0);
  assert.match(io.text(), /^<\?xml version="1\.0"/);
  assert.deepEqual(parseOpml(io.text()).map((f) => f.name), ["loose-feed", "ars-technica"]);
});

test("`sources` names the defaults and the bundles without fetching anything", async () => {
  const io = sink();
  const code = await newsCommand(["sources"], {
    ...io, env: sandbox().env,
    fetchImpl: () => { throw new Error("sources must not hit the network"); },
  });
  assert.equal(code, 0);
  assert.match(io.text(), /journalists/);
  assert.match(io.text(), /ars-technica/);
});

test("a one-off URL is read without being subscribed to", async () => {
  const { env } = sandbox();
  const io = sink();
  const code = await newsCommand(["https://a.example/rss"], {
    ...io, env, fetchImpl: fakeFetch({ "https://a.example/rss": RSS }), columns: 80,
  });
  assert.equal(code, 0);
  assert.match(io.text(), /First story/);
  assert.deepEqual(loadFeeds(env), []);
});

// --- published lists ---------------------------------------------------------

test("a plain-text list is one feed URL per line, comments and blanks ignored", () => {
  const feeds = parseFeedList([
    "# Kagi Small Web",
    "",
    "https://a.example/feed.xml",
    "  https://b.example/rss  ",
    "https://a.example/feed.xml",
    "not-a-url",
  ].join("\n"));
  assert.deepEqual(feeds.map((f) => f.url), ["https://a.example/feed.xml", "https://b.example/rss"]);
  assert.equal(feeds[0].title, "a.example");
});

test("a list document is parsed as whichever shape it is", () => {
  assert.equal(parseListDocument(OPML, "opml").length, 2);
  assert.equal(parseListDocument("https://a.example/rss", "text").length, 1);
  // No format declared: OPML announces itself, everything else is a URL list.
  assert.equal(parseListDocument(OPML).length, 2);
  assert.equal(parseListDocument("https://a.example/rss").length, 1);
});

test("keywords are comma-separated, so a feed title with a space survives", () => {
  assert.deepEqual(parseKeywords("ai, crypto ,Rust"), ["ai", "crypto", "rust"]);
  assert.deepEqual(parseKeywords("hacker news"), ["hacker news"]);
  assert.deepEqual(parseKeywords("  , ,"), []);
});

test("a feed matches when any keyword is in its title, url or folder", () => {
  const feeds = [
    { title: "Rust Blog", url: "https://blog.rust-lang.org/feed.xml", category: "" },
    { title: "Cooking", url: "https://food.example/rss", category: "recipes" },
    { title: "Nothing", url: "https://x.example/rss", category: "" },
  ];
  assert.deepEqual(matchFeeds(feeds, ["rust"]).map((f) => f.title), ["Rust Blog"]);
  assert.deepEqual(matchFeeds(feeds, ["recipes"]).map((f) => f.title), ["Cooking"]);
  assert.deepEqual(matchFeeds(feeds, ["rust", "recipes"]).length, 2);
  assert.deepEqual(matchFeeds(feeds, []), []);
});

test("a keyword matches the start of a word, so `rust` is not `trust`", () => {
  // Searching 32k feeds for `rust` used to return Trust Machines, Trustnodes,
  // frustrat.com and popthruster.com ahead of anything about Rust.
  const feeds = [
    { title: "Trust Machines", url: "https://www.trustmachines.co/blog", category: "" },
    { title: "frustrat.com", url: "https://frustrat.com/rss/", category: "" },
    { title: "popthruster.com", url: "https://popthruster.com/feed/", category: "" },
    { title: "rustgeek.me", url: "https://rustgeek.me/feed/", category: "" },
    { title: "rust.christina-quast.de", url: "https://rust.christina-quast.de/index.xml", category: "" },
  ];
  assert.deepEqual(
    matchFeeds(feeds, ["rust"]).map((f) => f.title),
    ["rustgeek.me", "rust.christina-quast.de"],
  );
  // A multi-word keyword cannot be a token, so it still matches as a substring.
  assert.deepEqual(matchFeeds([{ title: "Hacker News", url: "https://hnrss.org/frontpage", category: "" }],
    ["hacker news"]).length, 1);
});

test("provenance rides in the OPML folder and survives a round trip", () => {
  const tagged = tagWithList([
    { name: "a", title: "A", url: "https://a.example/rss", site: "", category: "" },
    { name: "b", title: "B", url: "https://b.example/rss", site: "", category: "tech" },
  ], "profullstack");
  assert.deepEqual(tagged.map((f) => f.category), ["profullstack", "profullstack/tech"]);

  // Through OPML and back, the list is still readable off the folder.
  const reparsed = parseOpml(buildOpml(tagged));
  assert.deepEqual(reparsed.map(listOf), ["profullstack", "profullstack"]);
  assert.equal(subscribedLists(reparsed).get("profullstack"), 2);
});

test("a folder that merely shares a name with nothing in the catalogue is not a list", () => {
  assert.equal(listOf({ category: "tech" }), "");
  assert.equal(listOf({ category: "" }), "");
  assert.equal(listOf({ category: "smallweb" }), "smallweb");
});

test("find and lists parse their arguments", () => {
  assert.deepEqual(newsArgs(["find", "ai,crypto"]).keywords, ["ai", "crypto"]);
  assert.deepEqual(newsArgs(["search", "ai"]).verb, "search"); // still headlines
  assert.match(newsArgs(["find"]).error, /usage: moshcode news find/);
  assert.equal(newsArgs(["lists"]).verb, "lists");
  assert.equal(newsArgs(["bundles"]).verb, "lists");
});

test("add takes a result number from the last find", () => {
  assert.equal(newsArgs(["add", "3"]).index, 3);
  assert.equal(newsArgs(["add", "#3"]).index, 3);
  assert.equal(newsArgs(["add", "https://a.example/rss"]).index, undefined);
  assert.equal(newsArgs(["add", "https://a.example/rss"]).target, "https://a.example/rss");
});

test("find searches the published lists and numbers what it found", async () => {
  const { env } = sandbox();
  const io = sink();
  const code = await newsCommand(["find", "example"], {
    ...io, env,
    fetchImpl: fakeFetch({
      "https://profullstack.com/feeds.opml": OPML,
      "https://raw.githubusercontent.com/ralyodio/smallweb/refs/heads/main/smallweb.txt":
        "https://example.com/blog/rss.xml\nhttps://unrelated.test/rss\n",
    }),
  });
  assert.equal(code, 0);
  assert.match(io.text(), /example\.com\/blog\/rss\.xml/);
  assert.doesNotMatch(io.text(), /unrelated\.test/);
});

test("add <n> subscribes to what find numbered, and only what it showed", async () => {
  const { env } = sandbox();
  const fetchImpl = fakeFetch({
    "https://raw.githubusercontent.com/ralyodio/smallweb/refs/heads/main/smallweb.txt":
      "https://example.com/feed.xml\n",
    "https://example.com/feed.xml": RSS,
  });
  await newsCommand(["find", "example.com"], { ...sink(), env, fetchImpl });

  const io = sink();
  const code = await newsCommand(["add", "1"], { ...io, env, fetchImpl });
  assert.equal(code, 0);
  assert.deepEqual(loadFeeds(env).map((f) => f.url), ["https://example.com/feed.xml"]);

  const missing = sink();
  assert.equal(await newsCommand(["add", "9"], { ...missing, env, fetchImpl }), 1);
  assert.match(missing.errorText(), /no result 9/);
});

test("a search-only list refuses to be subscribed to wholesale", async () => {
  const io = sink();
  const code = await newsCommand(["add", "smallweb"], {
    ...io, env: sandbox().env,
    fetchImpl: () => { throw new Error("must not fetch a list it is going to refuse"); },
  });
  assert.equal(code, 1);
  assert.match(io.errorText(), /too large to subscribe to wholesale/);
});

test("a list is added and removed as one unit", async () => {
  const { env } = sandbox();
  const fetchImpl = fakeFetch({ "https://profullstack.com/feeds.opml": OPML });

  const added = sink();
  assert.equal(await newsCommand(["add", "profullstack"], { ...added, env, fetchImpl }), 0);
  const feeds = loadFeeds(env);
  assert.equal(feeds.length, 2);
  assert.deepEqual([...new Set(feeds.map(listOf))], ["profullstack"]);

  const listed = sink();
  await newsCommand(["lists"], { ...listed, env, fetchImpl });
  assert.match(listed.text(), /profullstack/);

  const removed = sink();
  assert.equal(await newsCommand(["rm", "profullstack"], { ...removed, env, fetchImpl }), 0);
  assert.match(removed.text(), /2 feeds/);
  assert.deepEqual(loadFeeds(env), []);
});

test("removing a list you have no feeds from is an error, not a silent success", async () => {
  const io = sink();
  const code = await newsCommand(["rm", "profullstack"], { ...io, env: sandbox().env });
  assert.equal(code, 1);
  assert.match(io.errorText(), /no feeds from/);
});

test("a cached list is not refetched", async () => {
  const { env } = sandbox();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    return { ok: true, status: 200, text: async () => "https://a.example/rss\n" };
  };
  const list = { name: "smallweb", url: "https://x.test/list.txt", format: "text" };
  const first = await loadListFeeds(list, { fetchImpl, env });
  const second = await loadListFeeds(list, { fetchImpl, env });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  assert.deepEqual(second.feeds.map((f) => f.url), ["https://a.example/rss"]);
});

test("a stale cache is served when the list cannot be fetched", async () => {
  const { env } = sandbox();
  const list = { name: "smallweb", url: "https://x.test/list.txt", format: "text" };
  await loadListFeeds(list, { fetchImpl: fakeFetch({ "https://x.test/list.txt": "https://a.example/rss\n" }), env });
  const offline = await loadListFeeds(list, {
    fetchImpl: fakeFetch({}), env, refresh: true,
  });
  assert.equal(offline.ok, true);
  assert.equal(offline.stale, true);
  assert.deepEqual(offline.feeds.map((f) => f.url), ["https://a.example/rss"]);
});
