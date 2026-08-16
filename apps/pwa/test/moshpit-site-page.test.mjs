// Publishing to a name over the API, and the site that comes out.
//
// The router against a throwaway libSQL file, same harness as the other page
// tests. What is worth checking over HTTP rather than against the module is
// the part the module cannot see: that a webhook firing twice makes one post,
// that a draft is invisible to everyone but its owner, that somebody else's
// name refuses the call, and that the nav and the permalinks line up.
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

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-site-page-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u2','x@y.z','two',1)`);
  const at = 1_700_000_000_000;
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,alias_of,created_at) VALUES ('eggs','u1','a@b.c',null,?)`, [at]);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,alias_of,created_at) VALUES ('theirs','u2','x@y.z',null,?)`, [at]);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('eggs','blue','u1',null,?)`, [at]);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('eggs','pointed','u1','192.0.2.1',?)`, [at]);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('theirs','secret','u2',null,?)`, [at]);

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
  const api = async (p, method = "GET", payload) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: payload ? { "content-type": "application/json" } : {},
      body: payload ? JSON.stringify(payload) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const publish = (name, payload) => api(`/api/moshpit/sites/${name}/content`, "POST", payload);
  return { server, db, get, api, publish };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

test("publish: one call makes a post, and says where it landed", skip, async () => {
  const { publish } = await app();
  const res = await publish("blue.eggs", {
    kind: "text", title: "Hello from a script", body: "First post.\n\nSecond paragraph.",
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.created, true);
  assert.equal(res.body.slug, "hello-from-a-script");
  assert.match(res.body.url, /\/n\/blue\.eggs\/hello-from-a-script$/);
});

test("publish: the same call twice is one post, updated", skip, async () => {
  const { publish, api } = await app();
  await publish("blue.eggs", { kind: "link", slug: "dupe", title: "First go", url: "https://e.com/1" });
  const again = await publish("blue.eggs", { kind: "link", slug: "dupe", title: "Second go", url: "https://e.com/2" });

  assert.equal(again.status, 200);
  assert.equal(again.body.created, false, "a retry updates rather than duplicating");

  const one = await api("/api/moshpit/sites/blue.eggs/content/dupe");
  assert.equal(one.body.item.title, "Second go");
  assert.equal(one.body.item.url, "https://e.com/2");
});

test("publish: an array publishes a batch, and one bad item does not sink it", skip, async () => {
  const { publish } = await app();
  const res = await publish("blue.eggs", [
    { kind: "text", slug: "batch-a", title: "A", body: "a" },
    { kind: "link", slug: "batch-b", title: "B" },
    { kind: "text", slug: "batch-c", title: "C", body: "c" },
  ]);
  // Partly applied: not a success, not a total failure.
  assert.equal(res.status, 207);
  assert.equal(res.body.results.length, 3);
  assert.equal(res.body.results[0].ok, true);
  assert.equal(res.body.results[1].ok, false);
  assert.match(res.body.results[1].error, /url/);
  assert.equal(res.body.results[2].ok, true);
});

test("publish: a name you do not hold refuses the call", skip, async () => {
  const { publish } = await app();
  const res = await publish("secret.theirs", { kind: "text", title: "Not yours", body: "hi" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /do not own/);
});

test("site: a name that publishes draws its posts, newest first", skip, async () => {
  const { publish, get } = await app();
  await publish("blue.eggs", [
    { kind: "page", slug: "home", title: "Blue Eggs", body: "Notes from the pit." },
    { kind: "text", slug: "older", title: "Older post", body: "old", published_at: 1_600_000_000_000 },
    { kind: "text", slug: "newer", title: "Newer post", body: "new", published_at: 1_700_000_000_000 },
  ]);
  const { status, html } = await get("/n/blue.eggs");
  assert.equal(status, 200);
  assert.match(html, /Blue Eggs/);
  assert.match(html, /Notes from the pit\./);
  assert.ok(html.indexOf("Newer post") < html.indexOf("Older post"), "newest first");
  assert.match(html, /href="\/n\/blue\.eggs\/newer"/);
});

test("site: sections and pages are the nav; posts are not", skip, async () => {
  const { publish, get } = await app();
  await publish("blue.eggs", [
    { kind: "section", slug: "notes", title: "Notes", position: 1 },
    { kind: "page", slug: "about", title: "About", body: "Who I am.", position: 2 },
  ]);
  const { html } = await get("/n/blue.eggs");
  const nav = html.slice(html.indexOf('<nav class="site-nav">'), html.indexOf("</nav>"));
  assert.match(nav, /Home/);
  assert.match(nav, />Notes</);
  assert.match(nav, />About</);
  assert.ok(!nav.includes("Newer post"), "a nav with every post in it is not a nav");
});

test("site: a section lists only its own posts", skip, async () => {
  const { publish, get } = await app();
  await publish("blue.eggs", [
    { kind: "text", slug: "filed", title: "Filed under notes", body: "x", section: "notes" },
  ]);
  const { status, html } = await get("/n/blue.eggs/notes");
  assert.equal(status, 200);
  assert.match(html, /Filed under notes/);
  assert.ok(!html.includes("Older post"), "an unfiled post is not in the section");
});

test("site: a page renders its prose, paragraph by paragraph", skip, async () => {
  const { get } = await app();
  const { status, html } = await get("/n/blue.eggs/about");
  assert.equal(status, 200);
  assert.match(html, /<p>Who I am\.<\/p>/);
});

test("site: a post has a permalink of its own", skip, async () => {
  const { get } = await app();
  const { status, html } = await get("/n/blue.eggs/newer");
  assert.equal(status, 200);
  assert.match(html, /Newer post/);
  assert.match(html, /<meta property="og:type" content="article">/);
});

test("site: every post type renders as itself", skip, async () => {
  const { publish, get } = await app();
  await publish("blue.eggs", [
    { kind: "link", slug: "a-link", title: "A link", url: "https://example.com/thing" },
    { kind: "image", slug: "a-shot", title: "A shot", url: "https://cdn.example/p.jpg" },
    { kind: "gallery", slug: "a-set", title: "A set", media: ["https://cdn.example/1.jpg", "https://cdn.example/2.jpg"] },
    { kind: "video", slug: "a-clip", title: "A clip", url: "https://cdn.example/clip.mp4" },
    { kind: "video", slug: "a-tube", title: "On YouTube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    { kind: "embed", slug: "a-card", title: "Elsewhere", url: "https://example.com/elsewhere" },
  ]);
  const { html } = await get("/n/blue.eggs");

  assert.match(html, /class="site-out" href="https:\/\/example\.com\/thing"[^>]*>→ example\.com/);
  assert.match(html, /<img class="site-shot" src="https:\/\/cdn\.example\/p\.jpg"/);
  assert.match(html, /class="site-gallery"/);
  assert.match(html, /<video class="site-video" controls preload="none" src="https:\/\/cdn\.example\/clip\.mp4">/);
  assert.match(html, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  // An embed is a card, not a frame — an arbitrary URL does not get an iframe
  // on the origin where accounts live.
  assert.ok(!html.includes('src="https://example.com/elsewhere"'), "no iframe for an unknown host");
  assert.match(html, /class="site-card"/);
});

test("site: a draft is visible to its owner over the API and to nobody on the page", skip, async () => {
  const { publish, get, api } = await app();
  await publish("blue.eggs", { kind: "text", slug: "quiet", title: "Not yet", body: "shh", published_at: null });

  const { html } = await get("/n/blue.eggs");
  assert.ok(!html.includes("Not yet"), "a draft is not on the site");

  const direct = await get("/n/blue.eggs/quiet");
  assert.equal(direct.status, 404, "and has no page of its own");

  // Its author can still see it, which is the point of a draft.
  const mine = await api("/api/moshpit/sites/blue.eggs/content");
  assert.ok(mine.body.content.some((item) => item.slug === "quiet"));
});

test("site: content is escaped, never rendered", skip, async () => {
  const { publish, get } = await app();
  await publish("blue.eggs", {
    kind: "text", slug: "xss", title: "<script>alert(1)</script>", body: "<img src=x onerror=alert(2)>",
  });
  const { html } = await get("/n/blue.eggs/xss");
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("<img src=x onerror"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("site: a pointed name is unaffected — the target still wins", skip, async () => {
  const { publish, get } = await app();
  await publish("pointed.eggs", { kind: "text", slug: "hi", title: "Published anyway", body: "x" });

  // 192.0.2.1 is documentation space, so the gateway refuses it — proof that
  // /n/ tried the target rather than drawing the site.
  const home = await get("/n/pointed.eggs");
  assert.equal(home.status, 502);
  assert.ok(!home.html.includes("Published anyway"));

  // And the slug path is left alone rather than quietly becoming a site page.
  const slug = await get("/n/pointed.eggs/hi");
  assert.equal(slug.status, 404);
});

test("site: taking a post down removes it from the site", skip, async () => {
  const { api, get } = await app();
  const gone = await api("/api/moshpit/sites/blue.eggs/content/a-card", "DELETE");
  assert.equal(gone.status, 200);
  assert.equal(gone.body.deleted, true);

  const { html } = await get("/n/blue.eggs");
  assert.ok(!html.includes("Elsewhere"));

  const missing = await api("/api/moshpit/sites/blue.eggs/content/a-card", "DELETE");
  assert.equal(missing.status, 404);
});

test("site: a name that publishes lists as live on the ending", skip, async () => {
  const { get } = await app();
  const { html } = await get("/n/nothing.eggs");
  assert.match(html, /Sites on \.eggs/);
  assert.match(html, /blue\.eggs/);
  assert.match(html, /items published here/);
});
