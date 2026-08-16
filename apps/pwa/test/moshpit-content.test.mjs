// What a caller has to send to publish, and what comes back out.
//
// No database: normalizeContent is the whole of the validation, so what a
// gallery may contain and what a link post cannot do without are rules worth
// checking without a table in front of them.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTENT_KINDS,
  MAX_GALLERY,
  MAX_NAV,
  navFor,
  normalizeContent,
  normalizeSlug,
  postsFor,
} from "../src/lib/moshpit-content.mjs";
import { videoEmbed } from "../src/lib/moshpit-site-page.mjs";

const NOW = 1_700_000_000_000;
const ok = (input) => {
  const result = normalizeContent(input, { now: NOW });
  assert.equal(result.ok, true, result.error);
  return result.item;
};

test("content: a slug is a URL segment, made from the title when one is not sent", () => {
  assert.equal(normalizeSlug("Hello, World!"), "hello-world");
  assert.equal(normalizeSlug("  --Trailing--  "), "trailing");
  assert.equal(normalizeSlug("///"), null);
  assert.equal(ok({ kind: "text", title: "My First Post", body: "hi" }).slug, "my-first-post");
  assert.equal(ok({ kind: "text", title: "anything", body: "hi", slug: "Custom Slug" }).slug, "custom-slug");
});

test("content: every kind is accepted, and nothing else is", () => {
  for (const kind of CONTENT_KINDS) {
    const input = { kind, title: "t", body: "b", url: "https://e.com/x", media: ["https://e.com/1.png"] };
    assert.equal(normalizeContent(input, { now: NOW }).ok, true, `${kind} should be publishable`);
  }
  assert.equal(normalizeContent({ kind: "poll", title: "t" }).ok, false);
  assert.equal(normalizeContent({ title: "t" }).ok, false);
});

test("content: each kind names the one thing it cannot be published without", () => {
  assert.match(normalizeContent({ kind: "text", title: "t" }).error, /body/);
  assert.match(normalizeContent({ kind: "page", title: "t" }).error, /body/);
  assert.match(normalizeContent({ kind: "link", title: "t" }).error, /url/);
  assert.match(normalizeContent({ kind: "video", title: "t" }).error, /url/);
  assert.match(normalizeContent({ kind: "gallery", slug: "g" }).error, /picture/);
  assert.match(normalizeContent({ kind: "section" }).error, /slug|title/);
});

test("content: a picture is its own label, so it may go without a title", () => {
  const item = ok({ kind: "image", slug: "sunset", url: "https://e.com/sunset.jpg" });
  assert.equal(item.title, "");
  assert.equal(item.url, "https://e.com/sunset.jpg");
});

test("content: only http(s) is a url, in any field that takes one", () => {
  assert.equal(normalizeContent({ kind: "link", title: "t", url: "javascript:alert(1)" }).ok, false);
  assert.equal(normalizeContent({ kind: "image", slug: "i", url: "data:image/png;base64,AAA" }).ok, false);
  assert.equal(normalizeContent({ kind: "gallery", slug: "g", media: ["file:///etc/passwd"] }).ok, false);
});

test("content: a gallery takes urls or objects, and is bounded", () => {
  const item = ok({
    kind: "gallery", slug: "g",
    media: ["https://e.com/1.png", { url: "https://e.com/2.png", alt: "two" }],
  });
  assert.deepEqual(JSON.parse(item.media), [
    { url: "https://e.com/1.png", alt: "" },
    { url: "https://e.com/2.png", alt: "two" },
  ]);

  const tooMany = Array.from({ length: MAX_GALLERY + 1 }, (_, i) => `https://e.com/${i}.png`);
  assert.match(normalizeContent({ kind: "gallery", slug: "g", media: tooMany }).error, /up to/);
});

test("content: a title cannot smuggle a line break into the nav", () => {
  const item = ok({ kind: "section", title: "Notes\n\u0000<b>x</b>" });
  assert.ok(!item.title.includes("\n"));
  assert.ok(!item.title.includes("\u0000"), "a NUL is not a character a nav has to survive");
  // Markup is left as text — it is escaped at render time, not stripped here.
  assert.match(item.title, /<b>x<\/b>/);
});

test("content: a body keeps its paragraphs", () => {
  const item = ok({ kind: "text", title: "t", body: "one\n\ntwo\nstill two" });
  assert.equal(item.body, "one\n\ntwo\nstill two");
});

test("content: publishing time takes seconds, milliseconds, a date, or null for a draft", () => {
  assert.equal(ok({ kind: "text", title: "t", body: "b" }).published_at, NOW);
  assert.equal(ok({ kind: "text", title: "t", body: "b", published_at: 1_700_000_000 }).published_at, 1_700_000_000_000);
  assert.equal(ok({ kind: "text", title: "t", body: "b", published_at: 1_700_000_000_123 }).published_at, 1_700_000_000_123);
  assert.equal(
    ok({ kind: "text", title: "t", body: "b", published_at: "2026-08-12T09:00:00Z" }).published_at,
    Date.parse("2026-08-12T09:00:00Z"),
  );
  assert.equal(ok({ kind: "text", title: "t", body: "b", published_at: null }).published_at, null);
  assert.equal(normalizeContent({ kind: "text", title: "t", body: "b", published_at: "banana" }).ok, false);
});

test("content: sections and pages are the nav, posts are not", () => {
  assert.equal(ok({ kind: "section", title: "Notes" }).nav, 1);
  assert.equal(ok({ kind: "page", title: "About", body: "hi" }).nav, 1);
  assert.equal(ok({ kind: "text", title: "A post", body: "hi" }).nav, 0);
  // Unless somebody insists.
  assert.equal(ok({ kind: "text", title: "A post", body: "hi", nav: true }).nav, 1);
});

test("content: a slug the site's own routes use is refused", () => {
  assert.match(normalizeContent({ kind: "page", title: "x", body: "b", slug: "api" }).error, /reserved/);
  assert.match(normalizeContent({ kind: "page", title: "x", body: "b", slug: "rss" }).error, /reserved/);
});

test("nav: published sections and pages in order, capped", () => {
  const items = [
    { kind: "page", slug: "about", title: "About", nav: true, position: 2, published_at: NOW },
    { kind: "section", slug: "notes", title: "Notes", nav: true, position: 1, published_at: NOW },
    { kind: "section", slug: "draft", title: "Draft", nav: true, position: 0, published_at: null },
    { kind: "text", slug: "post", title: "Post", nav: true, position: 0, published_at: NOW },
  ];
  assert.deepEqual(navFor(items).map((i) => i.slug), ["notes", "about"], "drafts and posts stay out");

  const many = Array.from({ length: MAX_NAV + 5 }, (_, i) => ({
    kind: "section", slug: `s${i}`, title: `S${i}`, nav: true, position: i, published_at: NOW,
  }));
  assert.equal(navFor(many).length, MAX_NAV);
});

test("posts: newest first, drafts out, undated last", () => {
  const items = [
    { kind: "text", slug: "old", published_at: NOW - 1000 },
    { kind: "link", slug: "new", published_at: NOW },
    { kind: "text", slug: "draft", published_at: null },
    { kind: "section", slug: "notes", published_at: NOW + 1000 },
  ];
  assert.deepEqual(postsFor(items).map((i) => i.slug), ["new", "old"]);
});

test("posts: a section listing is only that section", () => {
  const items = [
    { kind: "text", slug: "a", section: "notes", published_at: NOW },
    { kind: "text", slug: "b", section: "links", published_at: NOW },
    { kind: "text", slug: "c", section: null, published_at: NOW },
  ];
  assert.deepEqual(postsFor(items, { section: "notes" }).map((i) => i.slug), ["a"]);
});

test("video: known hosts get an embed, everything else gets a link", () => {
  assert.equal(videoEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  assert.equal(videoEmbed("https://youtu.be/dQw4w9WgXcQ"),
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  assert.equal(videoEmbed("https://vimeo.com/123456789"),
    "https://player.vimeo.com/video/123456789");
  // Not on the list: no iframe on the origin where accounts live.
  assert.equal(videoEmbed("https://evil.example/embed"), null);
  assert.equal(videoEmbed("https://youtube.com.evil.example/watch?v=x"), null);
});

test("nav: home is the masthead, not a nav entry", () => {
  const items = [
    { kind: "page", slug: "home", title: "Blue Eggs", nav: true, position: 0, published_at: NOW },
    { kind: "page", slug: "about", title: "About", nav: true, position: 1, published_at: NOW },
  ];
  assert.deepEqual(navFor(items).map((i) => i.slug), ["about"]);
});
