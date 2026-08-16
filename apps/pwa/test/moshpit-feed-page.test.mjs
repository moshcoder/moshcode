// A name that publishes a feed, end to end: the page /n/ draws for it, which
// of a target and a feed wins, and the two ways an owner sets one.
//
// The router against a throwaway libSQL file, same harness as
// moshpit-records-page.test.mjs. Nothing here reaches the network: the feed
// cache is primed through loadFeed with an injected fetch, so by the time the
// route asks for the feed it is holding a fresh copy and never goes out.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let deps = null;
try { deps = { express: require("express") }; } catch { deps = null; }

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-feed-page-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const BLOG_URL = "https://scrambled.example/feed.xml";
const SHOW_URL = "https://pit.example/feed.xml";
const DEAD_URL = "https://gone.example/feed.xml";

const BLOG = `<rss version="2.0"><channel>
  <title>Scrambled</title>
  <link>https://scrambled.example</link>
  <description>Notes on eggs.</description>
  <item>
    <title>Soft boiled &amp; salted</title>
    <link>https://scrambled.example/soft</link>
    <pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate>
    <description>Six minutes.</description>
  </item>
  <item>
    <title>&lt;script&gt;alert(1)&lt;/script&gt;</title>
    <link>https://scrambled.example/xss</link>
    <description>&lt;img src=x onerror=alert(2)&gt;</description>
  </item>
</channel></rss>`;

const SHOW = `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
  <title>The Pit</title>
  <itunes:image href="https://cdn.example/cover.jpg"/>
  <description>A show about names.</description>
  <item>
    <title>Episode one</title>
    <link>https://pit.example/1</link>
    <pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate>
    <itunes:duration>3877</itunes:duration>
    <enclosure url="https://cdn.example/1.mp3" type="audio/mpeg" length="52428800"/>
  </item>
</channel></rss>`;

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");
  const { loadFeed, clearFeedCache } = await import("../src/lib/feed.mjs");

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);
  const at = 1_700_000_000_000;
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,alias_of,created_at) VALUES ('eggs','u1','a@b.c',null,?)`, [at]);

  const name = (label, { target = null, feed = null, kind = null } = {}) =>
    run(`INSERT INTO moshpit_names (tld,label,user_id,target,feed_url,feed_kind,created_at) VALUES ('eggs',?,'u1',?,?,?,?)`,
      [label, target, feed, kind, at]);

  await name("blog", { feed: BLOG_URL });
  await name("show", { feed: SHOW_URL });
  await name("both", { target: "192.0.2.1", feed: BLOG_URL });
  await name("broken", { feed: DEAD_URL });
  await name("parked");
  await name("settable");

  // Prime the cache so the route never leaves the process.
  clearFeedCache();
  const publicHost = async (host) => ({ ok: true, host, port: 443, addresses: ["93.184.216.34"] });
  const canned = (body) => async () => new Response(body, { headers: { "content-type": "application/xml" } });
  await loadFeed(BLOG_URL, { fetchImpl: canned(BLOG), check: publicHost });
  await loadFeed(SHOW_URL, { fetchImpl: canned(SHOW), check: publicHost });
  // DEAD_URL is left out on purpose: nothing is cached for it, and its fetch
  // fails, which is the "feed will not load" case.

  const app = deps.express();
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.express.json());
  app.use((req, _res, next) => { req.csrfToken = () => "csrf"; req.user = { id: "u1", email: "a@b.c" }; next(); });
  app.use(moshpitRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = async (p) => {
    const res = await fetch(`${base}${p}`);
    return { status: res.status, html: await res.text() };
  };
  const json = async (p, init) => {
    const res = await fetch(`${base}${p}`, init);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const post = async (p, fields) => {
    const res = await fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
    return { status: res.status, location: res.headers.get("location") ?? "" };
  };
  return { server, db, get, json, post, run };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

/** The message a form post redirected back with — `?ok=` or `?err=`, decoded. */
function flash(location) {
  const query = new URLSearchParams(location.slice(location.indexOf("?") + 1));
  return query.get("ok") ?? query.get("err") ?? "";
}

test("feed page: a name with a blog feed is a blog", skip, async () => {
  const { get } = await app();
  const { status, html } = await get("/n/blog.eggs");
  assert.equal(status, 200);
  assert.match(html, /Scrambled/);
  assert.match(html, /Notes on eggs\./);
  assert.match(html, /Soft boiled &amp; salted/);
  assert.match(html, /href="https:\/\/scrambled\.example\/soft"/);
  // The name is on its own page, and the layout says which one it is.
  assert.match(html, /blog\.eggs/);
  // A blog is read elsewhere, so there is no player on it.
  assert.ok(!html.includes("<audio"), "a blog has no players");
});

test("feed page: feed content is escaped, never rendered", skip, async () => {
  const { get } = await app();
  const { html } = await get("/n/blog.eggs");
  assert.ok(!html.includes("<script>alert(1)</script>"), "a title is not markup");
  assert.ok(!html.includes("<img src=x onerror"), "a summary is not markup");
  // The parser decodes the escaped markup and strips it, so what is left of
  // that title is its text — which is then escaped again on the way out.
  assert.match(html, /<h2>alert\(1\)<\/h2>|>alert\(1\)</);
});

test("feed page: a podcast feed gets art, a duration and a player", skip, async () => {
  const { get } = await app();
  const { status, html } = await get("/n/show.eggs");
  assert.equal(status, 200);
  assert.match(html, /The Pit/);
  assert.match(html, /<img class="feed-cover" src="https:\/\/cdn\.example\/cover\.jpg"/);
  assert.match(html, /<audio controls preload="none" src="https:\/\/cdn\.example\/1\.mp3">/);
  // 3877 seconds, said the way a listener reads it.
  assert.match(html, /1:04:37/);
  assert.match(html, /50 MB/);
});

test("feed page: the head describes the site, not the registry", skip, async () => {
  const { get } = await app();
  const { html } = await get("/n/show.eggs");
  assert.match(html, /<meta name="description" content="A show about names\.">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/cdn\.example\/cover\.jpg">/);
  assert.match(html, /<link rel="alternate" type="application\/rss\+xml"/);
  assert.match(html, /<link rel="canonical" href="[^"]*\/n\/show\.eggs">/);
});

test("feed page: ?view=directory is the way back out to the ending", skip, async () => {
  const { get } = await app();
  const { status, html } = await get("/n/blog.eggs?view=directory");
  assert.equal(status, 200);
  assert.ok(!html.includes("Soft boiled"), "the feed is not drawn");
  assert.match(html, /Sites on \.eggs/);
});

test("feed page: a target beats a feed", skip, async () => {
  const { get } = await app();
  // 192.0.2.1 is documentation space, so the gateway refuses it — which is
  // proof the target was what /n/ tried, rather than the feed.
  const { status, html } = await get("/n/both.eggs");
  assert.equal(status, 502);
  assert.ok(!html.includes("Soft boiled"), "the feed was not served instead");
});

test("feed page: a feed that will not load is still a page, and says why", skip, async () => {
  const { get } = await app();
  const { status, html } = await get("/n/broken.eggs");
  // 200: the name is claimed and pointed at something, so this is a site with
  // its contents missing, not a missing name.
  assert.equal(status, 200);
  assert.match(html, /Nothing came back from the feed/);
  assert.match(html, /broken\.eggs/);
  assert.match(html, /noindex/);
});

test("feed page: a name with a feed lists as a live site on the ending", skip, async () => {
  const { get } = await app();
  const { html } = await get("/n/parked.eggs");
  assert.match(html, /Sites on \.eggs/);
  assert.match(html, /blog\.eggs/);
  assert.match(html, /feed · scrambled\.example/);
});

test("feed page: the pit sets a feed on a name and clears it again", skip, async () => {
  const { post, json } = await app();
  const set = await post("/pit/eggs/names", {
    label: "settable", refeed: "1", feed: "scrambled.example/feed.xml", feed_kind: "podcast", _csrf: "csrf",
  });
  assert.equal(set.status, 302);
  assert.match(set.location, /ok=/);
  assert.match(flash(set.location), /serves its feed/);

  const after = await json("/api/moshpit/tlds/eggs/names");
  const row = after.body.names.find((n) => n.label === "settable");
  assert.equal(row.feed_url, "https://scrambled.example/feed.xml");
  assert.equal(row.feed_kind, "podcast");

  const cleared = await post("/pit/eggs/names", { label: "settable", refeed: "1", feed: "", _csrf: "csrf" });
  assert.match(flash(cleared.location), /no longer serves a feed/);

  const gone = await json("/api/moshpit/tlds/eggs/names");
  const cleanRow = gone.body.names.find((n) => n.label === "settable");
  assert.equal(cleanRow.feed_url, null);
  // The layout goes with the feed rather than waiting for the next one.
  assert.equal(cleanRow.feed_kind, null);
});

test("feed page: the pit refuses a feed that is not one", skip, async () => {
  const { post } = await app();
  const bad = await post("/pit/eggs/names", {
    label: "settable", refeed: "1", feed: "javascript:alert(1)", _csrf: "csrf",
  });
  assert.match(bad.location, /err=/);
  assert.match(flash(bad.location), /http:\/\/ or https:\/\//);
});

test("feed page: the API sets a feed, and refuses a private one", skip, async () => {
  const { json } = await app();
  const ok = await json("/api/moshpit/tlds/eggs/names/feed", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "parked", feed: "https://atom.example/feed.xml" }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.feed, "https://atom.example/feed.xml");

  const refused = await json("/api/moshpit/tlds/eggs/names/feed", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "parked", feed: "http://169.254.169.254/latest/meta-data/" }),
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /link-local|public internet/);
});

test("feed page: a name is minted with a feed in one go", skip, async () => {
  const { json } = await app();
  const made = await json("/api/moshpit/tlds/eggs/names", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "minted", feed: "https://minted.example/rss", feed_kind: "blog" }),
  });
  assert.equal(made.status, 201);
  assert.equal(made.body.name.feed_url, "https://minted.example/rss");
  assert.equal(made.body.name.feed_kind, "blog");
});
