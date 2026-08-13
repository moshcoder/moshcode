// `moshcode news` — the headlines, in the pit.
//
// The same split as src/crypto.mjs, for the same reasons: argument translation
// is pure and testable, the network call is injectable, and rendering is a
// function of the parsed feed. What differs is where the data comes from —
// there is no advis0r API here, only whatever feeds the operator subscribed to.
//
// Subscriptions live in an OPML file (~/.moshcode/news.opml) rather than in a
// news.json of our own invention. OPML is the interchange format every reader
// already speaks, so the subscription list can be exported from an existing
// reader, dropped in, and taken back out again — which is the whole reason to
// have a file instead of a flag. `/news add` accepts either an OPML document or
// a single RSS/Atom link and works out which it was given, because "a feed" and
// "a list of feeds" are the two shapes a URL handed to a news reader can have.
//
// The XML is read with targeted regexes rather than a parser. That is a real
// constraint and it is deliberate: moshcode ships with no runtime dependencies,
// and feeds are a small, well-trodden subset of XML. It also removes a class of
// risk outright — DOCTYPE is stripped and entities are decoded from a fixed
// table, so a hostile feed cannot expand an entity into a file read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { acid, ash, amber, bone, danger } from "./ui.mjs";
import {
  bingNewsSearch,
  defaultFeeds,
  FEED_LISTS,
  isDeadEndLink,
  resolveList,
  subscribableLists,
  unwrapRedirect,
} from "./news-sources.mjs";

const USAGE = `usage: moshcode news [verb|keyword…] [args…]

  (no verb)                      latest headlines across every subscribed feed
  latest                         the same thing, said out loud
  <keyword…>                     search the news for a word or phrase
  <url>                          read one feed without subscribing to it
  list                           the feeds you are subscribed to
  find <keyword[,keyword…]>      search every published list for feeds to add
  add <url|file|list|#n>         subscribe — an RSS/Atom link, an OPML file, a
                                 list by name (${subscribableLists().map((b) => b.name).join(", ")}),
                                 or #n from the last find
  rm <name|url|list>             unsubscribe — one feed, or a whole list at once
  open <n>                       open headline <n> from the last listing
  lists                          the published lists, and which you have added
  sources                        the default feeds and the lists on offer
  export                         print the subscription list as OPML

  --json                         print structured data instead of headlines
  --limit <n>                    how many headlines to show (default 20)
  --feed <name>                  only this subscribed feed
  --timeout <sec>                per-feed fetch timeout (default 10)

\`moshcode rss\` opens the same headlines as a full-screen reader.

Feeds live in ~/.moshcode/news.opml — export it to any reader, or point
MOSHCODE_NEWS_OPML at a list you already keep somewhere else. With no
subscriptions the defaults are read instead, so \`/news\` works on a fresh
install; \`/news add\` anything and the defaults step aside.`;

export function newsUsage() {
  return USAGE;
}

/** Verb names, in help order. cli-schema's NEWS_VERBS must match (drift test). */
export const NEWS_VERB_NAMES = ["latest", "search", "list", "find", "add", "rm", "open", "lists", "sources", "export"];

// The same reasoning as crypto's alias table: the obvious synonym should not be
// an error. `import` is the word an OPML file invites, and it is the same verb
// as `add` here precisely because `add` already takes an OPML document.
const VERB_ALIASES = {
  new: "latest", recent: "latest", top: "latest", headlines: "latest",
  find: "search", q: "search", query: "search", grep: "search",
  feeds: "list", ls: "list", subscriptions: "list",
  sub: "add", subscribe: "add", import: "add", follow: "add",
  remove: "rm", unsub: "rm", unsubscribe: "rm", del: "rm", delete: "rm",
  read: "open", browse: "open", www: "open",
  discover: "find", catalog: "find", catalogue: "find",
  bundles: "lists",
  defaults: "sources",
  opml: "export", dump: "export",
};

/** Resolve a first argument to a canonical verb, or null when it is not one. */
export function resolveVerb(word) {
  const key = String(word ?? "").toLowerCase();
  if (NEWS_VERB_NAMES.includes(key)) return key;
  return VERB_ALIASES[key] ?? null;
}

/** Owner-only, like aliases.json: a subscription list is a reading history. */
const FILE_MODE = 0o600;

/** Enough for a large feed, small enough that one bad URL cannot eat the pit. */
const MAX_BYTES = 8 * 1024 * 1024;

/** How many feeds are in flight at once. Politeness, not throughput. */
const CONCURRENCY = 6;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Where the subscription list lives. Derived per call so tests can move $HOME,
 * and overridable so an operator can point at a list they already maintain.
 */
export function opmlFile(env = process.env) {
  const override = String(env.MOSHCODE_NEWS_OPML || "").trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".moshcode", "news.opml");
}

/** Where the last rendered listing is remembered, so `/news open 3` knows what 3 was. */
export function cacheFile(env = process.env) {
  return path.join(path.dirname(opmlFile(env)), "news-last.json");
}

// ---------------------------------------------------------------------------
// XML, the small subset feeds actually use
// ---------------------------------------------------------------------------

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  mdash: "—", ndash: "–", hellip: "…", eacute: "é",
};

/**
 * Decode the entities a feed actually carries. A fixed table plus numeric
 * escapes — never the document's own DOCTYPE entities, which is what keeps a
 * feed from declaring one that expands to the contents of /etc/passwd.
 */
export function decodeEntities(text) {
  return String(text ?? "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // Surrogates and out-of-range code points would throw; leave them as text.
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** Strip the parts of a document that are never content: BOM, comments, DOCTYPE. */
function scrub(xml) {
  return String(xml ?? "")
    .replace(/^﻿/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, "");
}

/**
 * CDATA out, entities decoded, tags out, whitespace collapsed.
 *
 * Decoding before stripping, not after, and the order is load-bearing: a
 * `<description>` arrives as markup two different ways. CDATA carries real
 * tags, but plenty of publishers — Google News among them — escape the same
 * HTML into `&lt;a href=…&gt;` instead. Strip first and the escaped form sails
 * through untouched, then decoding turns it back into the markup that was
 * supposed to have been removed, and the headline reads as an anchor tag.
 */
function text(raw) {
  let value = String(raw ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Twice, because aggregators escape HTML that was already escaped: a Google
  // News description arrives as `&lt;a…&gt;` for the tags and `&amp;nbsp;` for
  // the spaces between them, so one round leaves a literal `&nbsp;` on screen.
  // Bounded at two — that is every doubling seen in the wild, and looping until
  // a document stops changing is a decompression bomb waiting to happen.
  for (let round = 0; round < 2; round++) {
    value = decodeEntities(value).replace(/<[^>]*>/g, " ");
  }
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The text of the first `<tag>` in a block, namespace prefix optional.
 *
 * Namespace-agnostic because feeds are inconsistent about it in exactly the
 * places that matter: the same publisher's `<title>` and `<dc:title>` mean the
 * same thing. Callers that need one specific namespace pass the prefix in.
 */
function pick(block, tag) {
  const name = tag.includes(":") ? tag.replace(":", "\\:") : `(?:[a-z0-9]+\\:)?${tag}`;
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return match ? text(match[1]) : "";
}

/** The value of an attribute on a tag, unescaped. Single or double quoted. */
function attr(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return match ? decodeEntities(match[2] ?? match[3] ?? "") : "";
}

/** Every `<tag …>` opening in a document, in order, as raw strings. */
function tagsNamed(xml, name) {
  return xml.match(new RegExp(`<${name}(?:\\s[^>]*)?/?>`, "gi")) || [];
}

/** Only http(s) survives. A feed must not talk us into opening file: or data:. */
export function safeUrl(raw, base = null) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  let url;
  try { url = base ? new URL(value, base) : new URL(value); }
  catch { return null; }
  return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
}

// ---------------------------------------------------------------------------
// OPML — the subscription list
// ---------------------------------------------------------------------------

/**
 * Every feed in an OPML document, as { name, url, site, category }.
 *
 * Outlines nest: readers use a bare `<outline text="Tech">` as a folder around
 * the feeds inside it. The stack below tracks that, so an imported list keeps
 * the grouping its owner gave it instead of flattening to one pile. Only
 * outlines carrying an `xmlUrl` are feeds; the rest are folders.
 */
export function parseOpml(xml) {
  const doc = scrub(xml);
  const body = /<body(?:\s[^>]*)?>([\s\S]*)<\/body>/i.exec(doc);
  const source = body ? body[1] : doc;
  const feeds = [];
  const seen = new Set();
  const stack = [];

  // One pass over every outline tag and every </outline>, in document order, so
  // the folder stack stays in step with the nesting.
  const token = /<outline(?:\s[^>]*)?>|<\/outline\s*>/gi;
  let match;
  while ((match = token.exec(source)) !== null) {
    if (match[0][1] === "/") { stack.pop(); continue; }
    const tag = match[0];
    // Read the slash off the raw tag rather than capturing it: an attribute
    // group greedy enough to hold `text="Tech" xmlUrl="…"` also swallows the
    // trailing `/`, so every self-closing outline reads as a folder that never
    // closes and the category stack grows without bound.
    const selfClosing = /\/\s*>$/.test(tag);
    const xmlUrl = safeUrl(attr(tag, "xmlUrl"));
    const label = attr(tag, "title") || attr(tag, "text") || "";

    if (!xmlUrl) {
      // A folder. Self-closing folders enclose nothing, so they never nest.
      if (!selfClosing) stack.push(label);
      continue;
    }
    if (!seen.has(xmlUrl)) {
      seen.add(xmlUrl);
      feeds.push({
        name: slugify(label) || hostSlug(xmlUrl),
        title: label || hostOf(xmlUrl),
        url: xmlUrl,
        site: safeUrl(attr(tag, "htmlUrl")) || "",
        category: stack.filter(Boolean).join("/"),
      });
    }
    // A feed outline can still have children in the wild; keep the stack honest.
    if (!selfClosing) stack.push(label);
  }
  return feeds;
}

/** Escape a string for an XML attribute. */
function xmlAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render a subscription list back to OPML, grouped by category. */
export function buildOpml(feeds, { title = "moshcode news" } = {}) {
  const groups = new Map();
  for (const feed of feeds) {
    const key = feed.category || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(feed);
  }
  const outline = (feed, indent) =>
    `${indent}<outline type="rss" text="${xmlAttr(feed.title || feed.name)}" `
    + `title="${xmlAttr(feed.title || feed.name)}" xmlUrl="${xmlAttr(feed.url)}"`
    + `${feed.site ? ` htmlUrl="${xmlAttr(feed.site)}"` : ""}/>`;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head>",
    `    <title>${xmlAttr(title)}</title>`,
    "  </head>",
    "  <body>",
  ];
  // Ungrouped feeds first, then folders — the order a reader displays them in.
  for (const [category, rows] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!category) { for (const feed of rows) lines.push(outline(feed, "    ")); continue; }
    lines.push(`    <outline text="${xmlAttr(category)}" title="${xmlAttr(category)}">`);
    for (const feed of rows) lines.push(outline(feed, "      "));
    lines.push("    </outline>");
  }
  lines.push("  </body>", "</opml>", "");
  return lines.join("\n");
}

/** A stable, typeable short name for a feed. */
export function slugify(label) {
  return String(label ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return String(url); }
}

function hostSlug(url) {
  return slugify(hostOf(url).replace(/\.[a-z]{2,}$/i, "")) || "feed";
}

/** Make `name` unique against `taken` by suffixing -2, -3, … */
function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${name}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${name}-${taken.size}`;
}

// ---------------------------------------------------------------------------
// The subscription store
// ---------------------------------------------------------------------------

/**
 * The subscribed feeds.
 *
 * A missing or unreadable file reads as "no subscriptions" rather than
 * throwing, the way loadAliases() does: this runs on the way into a command
 * that should still be able to tell you how to fix it.
 */
export function loadFeeds(env = process.env) {
  let raw;
  try { raw = fs.readFileSync(opmlFile(env), "utf8"); }
  catch { return []; }
  try { return parseOpml(raw); }
  catch { return []; }
}

/**
 * The feeds to read, and whether they are the operator's own.
 *
 * An empty reader is a useless one — `/news` on a fresh install should print
 * the news, not instructions for how to earn the news. So with no
 * subscriptions the defaults stand in, and the flag comes back with them so
 * the UI can say which it is showing rather than quietly implying the operator
 * subscribed to thirteen feeds they have never seen.
 */
export function readingList(env = process.env) {
  const subscribed = loadFeeds(env);
  if (subscribed.length) return { feeds: subscribed, usingDefaults: false };
  return { feeds: defaultFeeds(), usingDefaults: true };
}

/** Write the list back, creating ~/.moshcode if this is the first feed. */
export function saveFeeds(feeds, env = process.env) {
  const file = opmlFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, buildOpml(feeds), { mode: FILE_MODE });
  // `mode` only applies at creation, so tighten every write — aliases.mjs and
  // the history file do the same for the same reason.
  try { fs.chmodSync(file, FILE_MODE); } catch { /* best effort */ }
}

/** Add one feed to a list, naming it uniquely. Returns { feeds, added, existed }. */
export function withFeed(feeds, candidate) {
  const existing = feeds.find((f) => f.url === candidate.url);
  if (existing) return { feeds, added: existing, existed: true };
  const taken = new Set(feeds.map((f) => f.name));
  const added = { ...candidate, name: uniqueName(candidate.name || hostSlug(candidate.url), taken) };
  return { feeds: [...feeds, added], added, existed: false };
}

/** Find a feed by name, url, or title. */
export function findFeed(feeds, needle) {
  const wanted = String(needle ?? "").trim().toLowerCase();
  if (!wanted) return null;
  return feeds.find((f) => f.name.toLowerCase() === wanted)
    ?? feeds.find((f) => f.url.toLowerCase() === wanted)
    ?? feeds.find((f) => (f.title || "").toLowerCase() === wanted)
    ?? null;
}

// ---------------------------------------------------------------------------
// Published lists — a catalogue to search, and a unit to subscribe to
// ---------------------------------------------------------------------------

/**
 * Parse a newline-delimited feed list: one URL per line, `#` comments ignored.
 *
 * The other shape a published list comes in. Kagi's smallweb list is a plain
 * text file of 32,000 URLs and there is no OPML of it, so a reader that only
 * speaks OPML cannot read the largest list there is. No titles are invented
 * beyond the hostname — naming 32,000 feeds properly would mean fetching
 * 32,000 feeds, and the host is what the URL already tells us for free.
 */
export function parseFeedList(text) {
  const feeds = [];
  const seen = new Set();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const url = safeUrl(trimmed);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    feeds.push({ name: hostSlug(url), title: hostOf(url), url, site: "", category: "" });
  }
  return feeds;
}

/** Parse a list document as whichever of the two shapes it is. */
export function parseListDocument(body, format = "") {
  if (format === "text") return parseFeedList(body);
  if (format === "opml") return parseOpml(body);
  return looksLikeOpml(body) ? parseOpml(body) : parseFeedList(body);
}

/** Where a fetched list is cached, so searching does not refetch 32k feeds. */
export function listCacheFile(name, env = process.env) {
  return path.join(path.dirname(opmlFile(env)), "lists", `${slugify(name) || "list"}.json`);
}

/** Where the last `find` results are remembered, so `add 3` knows what 3 was. */
export function findCacheFile(env = process.env) {
  return path.join(path.dirname(opmlFile(env)), "news-found.json");
}

/** A day. These lists change on the order of weeks; a search must not wait on the network. */
const LIST_CACHE_MS = 24 * 60 * 60 * 1000;

/**
 * The feeds in a published list, from cache when it is fresh.
 *
 * A stale cache is preferred to an error when the fetch fails: the list was
 * good yesterday and a search that works offline beats one that does not.
 */
export async function loadListFeeds(list, {
  fetchImpl, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now(), refresh = false,
} = {}) {
  const file = listCacheFile(list.name, env);
  const cached = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(parsed?.feeds) ? parsed : null;
    } catch { return null; }
  };

  if (!refresh) {
    const hit = cached();
    if (hit && now - Number(hit.at || 0) < LIST_CACHE_MS) {
      return { ok: true, feeds: hit.feeds, cached: true };
    }
  }

  const res = await readSource(list.url, { fetchImpl, timeoutMs });
  if (!res.ok) {
    const hit = cached();
    if (hit) return { ok: true, feeds: hit.feeds, cached: true, stale: true };
    return { ok: false, error: res.error, feeds: [] };
  }

  const feeds = parseListDocument(res.body, list.format);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify({ at: now, url: list.url, feeds })}\n`, { mode: FILE_MODE });
    try { fs.chmodSync(file, FILE_MODE); } catch { /* best effort */ }
  } catch { /* a cache that cannot be written must not fail the search */ }
  return { ok: true, feeds, cached: false };
}

/**
 * Split `ai,crypto` into keywords.
 *
 * Comma-separated rather than space-separated because feed titles have spaces
 * in them: `/rss search hacker news` means one thing to a person and two to a
 * tokenizer, and the comma settles it. Spaces around a comma are trimmed.
 */
export function parseKeywords(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Feeds matching any keyword, best match first.
 *
 * Ranked rather than filtered, because filtering cannot win both halves of this:
 *
 *   · Plain substring matching searches 32,000 feeds for `rust` and returns
 *     Trust Machines, Trustnodes, frustrat.com and popthruster.com.
 *   · Requiring the keyword to start a word fixes that and then finds nothing
 *     at all for `homelab`, because the list's only metadata is the hostname
 *     and the blog is called myhomelab.net.
 *
 * So everything containing the keyword is kept, and a whole-word match sorts
 * above a word that starts with it, which sorts above a match buried anywhere.
 * With the results capped for display, the good ones are the ones you see.
 * Sorting is stable, so the list's own order survives within a rank.
 */
export function scoreFeed(feed, keywords) {
  const hay = `${feed.title || ""} ${feed.url} ${feed.category || ""}`.toLowerCase();
  let best = 0;
  for (const k of keywords) {
    if (!hay.includes(k)) continue;
    const tokens = hay.split(/[^a-z0-9]+/).filter(Boolean);
    if (tokens.some((t) => t === k)) { best = Math.max(best, 3); continue; }
    if (tokens.some((t) => t.startsWith(k))) { best = Math.max(best, 2); continue; }
    best = Math.max(best, 1);
  }
  return best;
}

export function matchFeeds(feeds, keywords) {
  if (!keywords.length) return [];
  return feeds
    .map((feed, i) => ({ feed, rank: scoreFeed(feed, keywords), i }))
    .filter((row) => row.rank > 0)
    .sort((a, b) => (b.rank - a.rank) || (a.i - b.i))
    .map((row) => row.feed);
}

/**
 * The list a subscribed feed came from, or "".
 *
 * Provenance rides in the OPML folder — the first path segment of `category` —
 * rather than in a sidecar file, so it survives a round trip through any other
 * reader and needs no format of our own. Only catalogue names count, so a
 * folder someone happens to call "tech" is not mistaken for a list.
 */
export function listOf(feed) {
  const head = String(feed?.category || "").split("/")[0];
  return resolveList(head) ? head : "";
}

/** How many subscribed feeds came from each published list. */
export function subscribedLists(feeds = []) {
  const counts = new Map();
  for (const feed of feeds) {
    const name = listOf(feed);
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

/** Tag a list's feeds with where they came from, keeping any folder they had. */
export function tagWithList(feeds, listName) {
  return feeds.map((feed) => ({
    ...feed,
    category: feed.category ? `${listName}/${feed.category}` : listName,
  }));
}

// ---------------------------------------------------------------------------
// Feeds — RSS 2.0, Atom, and RSS 1.0/RDF
// ---------------------------------------------------------------------------

/** Is this document a subscription list rather than a feed? */
export function looksLikeOpml(xml) {
  return /<opml[\s>]/i.test(scrub(xml));
}

/**
 * The link for an entry.
 *
 * Atom puts it in an attribute and may carry several: `rel="alternate"` (or no
 * rel at all, which means alternate) is the human-readable page, while
 * `rel="self"`, `"replies"` and `"enclosure"` are not what a reader should
 * open. RSS puts it in element text, and some publishers only fill a permalink
 * `<guid>` — hence the third fallback.
 */
function linkOf(block, base) {
  const links = tagsNamed(block, "(?:[a-z0-9]+\\:)?link");
  const alternate = links.find((tag) => {
    const rel = attr(tag, "rel").toLowerCase();
    return (!rel || rel === "alternate") && attr(tag, "href");
  });
  if (alternate) return safeUrl(attr(alternate, "href"), base);

  const inline = pick(block, "link");
  if (inline) return safeUrl(inline, base);

  const guid = /<(?:[a-z0-9]+:)?guid(\s[^>]*)?>([\s\S]*?)<\/(?:[a-z0-9]+:)?guid>/i.exec(block);
  if (guid && !/isPermaLink\s*=\s*["']false["']/i.test(guid[1] || "")) {
    return safeUrl(text(guid[2]), base);
  }
  return null;
}

/** The publication time of an entry as epoch ms, or null when it has none. */
function dateOf(block) {
  for (const tag of ["pubDate", "published", "updated", "dc:date", "date", "created"]) {
    const raw = pick(block, tag);
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * Parse an RSS/Atom/RDF document into { title, site, items }.
 *
 * One code path for all three because, at the level a headline list needs, they
 * genuinely are the same document: a channel with a title and a list of dated,
 * linked entries. Where they disagree — the entry element name, where the link
 * lives, which tag holds the date — the difference is handled at that field
 * rather than by forking the whole parser.
 */
export function parseFeed(xml, { url = "" } = {}) {
  const doc = scrub(xml);
  const blocks = doc.match(/<(?:[a-z0-9]+:)?(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:[a-z0-9]+:)?(?:item|entry)>/gi) || [];

  // The channel header is whatever precedes the first entry — taking the title
  // from the whole document would pick up an entry's title on a feed whose
  // channel has none.
  const head = blocks.length ? doc.slice(0, doc.indexOf(blocks[0])) : doc;
  const feedTitle = pick(head, "title") || hostOf(url);
  const site = linkOf(head, url) || "";

  const items = [];
  for (const block of blocks) {
    const title = pick(block, "title");
    const link = linkOf(block, url);
    if (!title && !link) continue; // nothing to show and nothing to open
    items.push({
      title: title || link,
      link,
      date: dateOf(block),
      author: pick(block, "creator") || pick(block, "author") || "",
      summary: clip(pick(block, "description") || pick(block, "summary") || "", 400),
    });
  }
  return { title: feedTitle, site, url, items };
}

function clip(value, max) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Fetch one document. Returns { ok, body, error }.
 *
 * Size-capped while streaming rather than after: a feed that turns out to be a
 * disk image should cost a few megabytes of transfer, not all of it.
 */
export async function fetchDocument(url, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const impl = fetchImpl || globalThis.fetch;
  if (typeof impl !== "function") return { ok: false, error: "no fetch available in this runtime" };
  const safe = safeUrl(url);
  if (!safe) return { ok: false, error: `not an http(s) URL: ${url}` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await impl(safe, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8",
        "user-agent": "moshcode/news (+https://moshcode.sh)",
      },
    });
    if (!res.ok) return { ok: false, status: res.status, error: `${res.status} ${res.statusText || ""}`.trim() };

    // Prefer the stream so the cap can stop a huge body early; fall back to
    // text() for any fetch implementation (tests included) that has no body.
    if (!res.body || typeof res.body.getReader !== "function") {
      const body = await res.text();
      if (body.length > MAX_BYTES) return { ok: false, error: `feed is larger than ${MAX_BYTES} bytes` };
      return { ok: true, body };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let body = "";
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        try { await reader.cancel(); } catch { /* already gone */ }
        return { ok: false, error: `feed is larger than ${MAX_BYTES} bytes` };
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return { ok: true, body };
  } catch (e) {
    const aborted = e?.name === "AbortError";
    return { ok: false, error: aborted ? `timed out after ${Math.round(timeoutMs / 1000)}s` : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Read a document from a local path, or over the network when it is a URL. */
export async function readSource(source, opts = {}) {
  const asUrl = safeUrl(source);
  if (asUrl) return fetchDocument(asUrl, opts);
  try { return { ok: true, body: fs.readFileSync(path.resolve(source), "utf8"), local: true }; }
  catch (e) { return { ok: false, error: `can't read ${source}: ${e.message}` }; }
}

/** Run `worker` over `items` with a bounded number in flight. Order is preserved. */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Fetch every feed and merge them into one dated list.
 *
 * A feed that fails is reported, not fatal: a reader whose whole listing
 * disappears because one publisher is having an outage is not a reader. The
 * failures come back alongside the items so the caller can say which.
 */
export async function collectNews(feeds, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const results = await mapLimit(feeds, CONCURRENCY, async (feed) => {
    const res = await fetchDocument(feed.url, { fetchImpl, timeoutMs });
    if (!res.ok) return { feed, error: res.error };
    let parsed;
    try { parsed = parseFeed(res.body, { url: feed.url }); }
    catch (e) { return { feed, error: `unreadable feed (${e.message})` }; }
    return { feed, parsed };
  });

  const items = [];
  const failures = [];
  const seen = new Set();
  for (const result of results) {
    if (result.error) { failures.push({ name: result.feed.name, url: result.feed.url, error: result.error }); continue; }
    for (const item of result.parsed.items) {
      // Aggregator feeds wrap the publisher's URL in one of their own. Unwrap
      // before deduping, so the same story arriving via Google News and via the
      // publisher's own feed is recognised as one story rather than two.
      const link = item.link ? unwrapRedirect(item.link) : null;
      // A link that unwrapping cannot rescue is a row that would do nothing
      // when opened, so the headline is dropped rather than shown. Only
      // aggregator interstitials qualify; an item with no link at all is still
      // worth listing, because its title carries the news.
      if (link && isDeadEndLink(link)) continue;
      const key = link || `${result.feed.name}:${item.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ ...item, link, feed: result.feed.name, feedTitle: result.parsed.title || result.feed.title });
    }
  }
  // Newest first, and undated entries last rather than pretending they are old:
  // plenty of feeds omit dates entirely, and sorting them to the bottom keeps
  // them reachable without letting them claim the top of the list.
  items.sort((a, b) => (b.date ?? -Infinity) - (a.date ?? -Infinity));
  return { items, failures };
}

/**
 * The feeds a keyword search reads.
 *
 * Two engines rather than one, which is advis0r's reasoning carried over
 * verbatim: Google has the better index, but its RSS links are interstitials
 * that a reader cannot open into an article, while Bing wraps the real
 * publisher URL in a `url=` parameter that unwrapRedirect decodes. Querying
 * both and deduping on the unwrapped link gets Google's coverage with Bing's
 * openable links wherever the two overlap.
 */
export function searchFeeds(query) {
  // Bing only. The Google half of advis0r's pairing returned headlines whose
  // links go nowhere and whose descriptions are lists of more Google links, so
  // every one of its results was dropped downstream anyway — see
  // isDeadEndLink(). Bing carries the publisher URL and a real summary.
  return [
    { name: "bing", title: `Bing News — ${query}`, url: bingNewsSearch(query), site: "", category: "" },
  ];
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function takeFlag(args, name, { boolean = false } = {}) {
  const out = { value: null, rest: [], missing: false, present: false };
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === name) {
      out.present = true;
      if (boolean) continue;
      const next = args[i + 1];
      if (next == null || String(next).startsWith("-")) out.missing = true;
      else { out.value = String(next); i++; }
      continue;
    }
    if (!boolean && arg.startsWith(`${name}=`)) {
      out.present = true;
      const value = arg.slice(name.length + 1);
      if (value === "") out.missing = true; else out.value = value;
      continue;
    }
    out.rest.push(arg);
  }
  return out;
}

/**
 * Translate argv into a request. Pure — no network, no filesystem.
 *
 * Returns { verb, target, limit, feed, json, timeoutMs } or { error } / { usage }.
 */
export function newsArgs(argv = []) {
  const args = (Array.isArray(argv) ? argv : []).map(String);
  if (args.includes("--help") || args.includes("-h") || args.includes("help")) return { usage: true };

  const json = takeFlag(args, "--json", { boolean: true });
  const limitFlag = takeFlag(json.rest, "--limit");
  if (limitFlag.missing) return { error: "--limit needs a number" };
  const feedFlag = takeFlag(limitFlag.rest, "--feed");
  if (feedFlag.missing) return { error: "--feed needs a feed name" };
  const timeoutFlag = takeFlag(feedFlag.rest, "--timeout");
  if (timeoutFlag.missing) return { error: "--timeout needs a number of seconds" };

  let limit = DEFAULT_LIMIT;
  if (limitFlag.value != null) {
    const n = Number(limitFlag.value);
    if (!Number.isInteger(n) || n < 1) return { error: `--limit takes a whole number of headlines, got ${JSON.stringify(limitFlag.value)}` };
    limit = Math.min(n, MAX_LIMIT);
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutFlag.value != null) {
    const secs = Number(timeoutFlag.value);
    if (!Number.isFinite(secs) || secs <= 0 || secs > 120) return { error: `--timeout takes 1-120 seconds, got ${JSON.stringify(timeoutFlag.value)}` };
    timeoutMs = Math.round(secs * 1000);
  }

  const rest = timeoutFlag.rest.filter((a) => a !== "");
  const unknown = rest.find((a) => a.startsWith("--"));
  if (unknown) return { error: `unknown flag ${unknown}` };

  const base = { limit, feed: feedFlag.value, json: json.present, timeoutMs };
  const [first, ...tail] = rest;

  // No argument at all: the headlines. This is the common case and it is why
  // `/news` is worth having as one word.
  if (!first) return { ...base, verb: "headlines", target: null };

  const verb = resolveVerb(first);
  if (!verb) {
    // Not a verb. Two things it can still be, and the URL check decides which:
    // a feed to read directly — the "or rss link" half of the feature — or a
    // keyword to search for. Everything that is not a URL is a keyword, so
    // `/news tariffs` and `/news openai earnings` both work and neither needs
    // a verb in front of it. That does mean a mistyped verb searches for the
    // typo instead of erroring, which is the right trade: `/news lst` finding
    // nothing is recoverable, and refusing every unrecognised word would make
    // the headline search unreachable without ceremony.
    const url = safeUrl(first);
    if (url) {
      if (tail.length) return { error: "reading one feed takes a single URL" };
      return { ...base, verb: "headlines", target: url, oneOff: true };
    }
    return { ...base, verb: "search", query: [first, ...tail].join(" ") };
  }

  if (verb === "latest") {
    if (tail.length) return { error: "latest takes no arguments — /news <keyword> to search" };
    return { ...base, verb: "headlines", target: null };
  }
  if (verb === "search") {
    const query = tail.join(" ").trim();
    if (!query) return { error: "usage: moshcode news search <keyword…>" };
    return { ...base, verb, query };
  }
  if (verb === "find") {
    const query = tail.join(" ").trim();
    if (!query) return { error: "usage: moshcode news find <keyword[,keyword…]>" };
    const keywords = parseKeywords(query);
    if (!keywords.length) return { error: "find needs a keyword" };
    return { ...base, verb, keywords };
  }
  if (verb === "add") {
    if (!tail.length) return { error: "usage: moshcode news add <url|file|list|#n>" };
    if (tail.length > 1) return { error: "add takes one URL, list, or number at a time" };
    // `add 3` and `add #3` take the third result of the last find. A feed URL
    // is never a bare number, so this cannot shadow one.
    const asIndex = /^#?(\d+)$/.exec(String(tail[0]).trim());
    if (asIndex) {
      const n = Number(asIndex[1]);
      if (n < 1) return { error: `add takes a result number from 1, got ${JSON.stringify(tail[0])}` };
      return { ...base, verb, target: null, index: n };
    }
    return { ...base, verb, target: tail[0] };
  }
  if (verb === "rm") {
    if (!tail.length) return { error: "usage: moshcode news rm <name|url|list>" };
    return { ...base, verb, target: tail.join(" ") };
  }
  if (verb === "open") {
    if (tail.length !== 1) return { error: "usage: moshcode news open <n>" };
    const n = Number(tail[0]);
    if (!Number.isInteger(n) || n < 1) return { error: `open takes a headline number, got ${JSON.stringify(tail[0])}` };
    return { ...base, verb, index: n };
  }
  if (tail.length) return { error: `${verb} takes no arguments` };
  return { ...base, verb, target: null };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** "3h ago" — how long before `now` something was published. */
export function ago(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return "";
  const secs = Math.round((now - ms) / 1000);
  if (secs < 0) return "just now";
  if (secs < 90) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/** The headline list. */
export function renderHeadlines(items, { failures = [], columns, limit = DEFAULT_LIMIT, now = Date.now(), source = "" } = {}) {
  const width = Math.max(48, Math.min(Number(columns) || 88, 100));
  const shown = items.slice(0, limit);
  if (!shown.length) {
    const lines = ["", `  ${ash("nothing came back")}`];
    if (failures.length) lines.push("", ...failureLines(failures));
    else lines.push("", `  ${ash("subscribe with")} ${bone("/news add <url>")}`);
    return lines.join("\n");
  }

  // The widest index, so "9." and "10." line their titles up.
  const gutter = String(shown.length).length + 1;
  const tails = shown.map((item) => {
    const when = ago(item.date, now);
    return `${item.feed || ""}${when ? ` · ${when}` : ""}`.trim();
  });
  // One column width for every tail, not one per row: the feed name and the age
  // are what make a headline placeable, so they keep their room and the title
  // is what gives — and they line up, which is the whole point of a column.
  const tailWidth = Math.max(0, ...tails.map((t) => t.length));
  const room = Math.max(24, width - gutter - tailWidth - 4);

  const lines = ["", `  ${ash(source || `${items.length} headline${items.length === 1 ? "" : "s"}`)}`, ""];
  for (const [i, item] of shown.entries()) {
    const n = `${i + 1}.`.padStart(gutter);
    lines.push(`  ${acid(n)} ${bone(clip(item.title, room).padEnd(room))} ${ash(tails[i].padStart(tailWidth))}`);
  }
  lines.push("", `  ${ash("open one with")} ${bone("/news open <n>")}`);
  if (failures.length) lines.push("", ...failureLines(failures));
  return lines.join("\n");
}

function failureLines(failures) {
  return [
    `  ${amber(`${failures.length} feed${failures.length === 1 ? "" : "s"} didn't answer`)}`,
    ...failures.map((f) => `    ${ash(`${f.name} — ${f.error}`)}`),
  ];
}

/** The subscription list. */
export function renderFeeds(feeds, { file = "", usingDefaults = false } = {}) {
  if (!feeds.length) {
    return ["", `  ${ash("no feeds yet")}`, "",
      `  ${ash("add one:")}    ${bone("/news add https://example.com/feed.xml")}`,
      `  ${ash("or a file:")}  ${bone("/news add ~/subscriptions.opml")}`,
      `  ${ash("or a list:")}  ${bone("/news add journalists")}`,
      `  ${ash("or search:")}  ${bone("/rss search ai,crypto")}`].join("\n");
  }
  const width = Math.max(...feeds.map((f) => f.name.length));
  const header = usingDefaults
    ? `${feeds.length} default feeds · nothing subscribed yet`
    : `${feeds.length} feed${feeds.length === 1 ? "" : "s"}${file ? ` · ${file}` : ""}`;
  const lines = ["", `  ${ash(header)}`, ""];
  let category = null;
  for (const feed of feeds) {
    if ((feed.category || "") !== category) {
      category = feed.category || "";
      if (category) lines.push(`  ${ash(category)}`);
    }
    lines.push(`  ${acid(feed.name.padEnd(width))}  ${bone(clip(feed.title || "", 34).padEnd(36))}${ash(feed.url)}`);
  }
  lines.push("", usingDefaults
    ? `  ${ash("subscribe to your own with")} ${bone("/news add <url|list>")} ${ash("· see them with")} ${bone("/news lists")}`
    : `  ${ash("read them with")} ${bone("/news")} ${ash("· one of them with")} ${bone("/news --feed <name>")}`);
  return lines.join("\n");
}

/** What a fresh install reads, and the lists it can pull in by name. */
export function renderSources() {
  const defaults = defaultFeeds();
  const width = Math.max(...defaults.map((f) => f.name.length));
  const lines = ["", `  ${bone("defaults")} ${ash(`— read when nothing is subscribed (${defaults.length})`)}`, ""];
  let category = null;
  for (const feed of defaults) {
    if ((feed.category || "") !== category) {
      category = feed.category || "";
      if (category) lines.push(`  ${ash(category)}`);
    }
    lines.push(`  ${acid(feed.name.padEnd(width))}  ${ash(clip(feed.title || "", 44))}`);
  }
  lines.push("", `  ${bone("lists")} ${ash("— published feed lists, pull one in by name")}`, "");
  const bw = Math.max(...FEED_LISTS.map((b) => b.name.length));
  for (const list of FEED_LISTS) {
    const note = list.searchOnly ? ash(" (search only)") : "";
    lines.push(`  ${acid(list.name.padEnd(bw))}  ${ash(clip(list.description, 52))}${note}`);
  }
  lines.push("", `  ${ash("pull one in with")} ${bone(`/news add ${subscribableLists()[0].name}`)} ${ash("· search them all with")} ${bone("/rss search <keyword>")}`);
  return lines.join("\n");
}

/**
 * The published lists, and how many feeds you have from each.
 *
 * `subscribed` is counted from the subscription file rather than remembered
 * separately, so a list stays "added" exactly as long as its feeds are there —
 * removing them by hand cannot leave a phantom membership behind.
 */
export function renderLists(feeds = []) {
  const mine = subscribedLists(feeds);
  const width = Math.max(...FEED_LISTS.map((b) => b.name.length));
  const lines = ["", `  ${ash("published lists")}`, ""];
  for (const list of FEED_LISTS) {
    const count = mine.get(list.name) || 0;
    const state = count
      ? acid(`✓ ${count} feed${count === 1 ? "" : "s"}`)
      : (list.searchOnly ? ash("search only") : ash("—"));
    lines.push(`  ${acid(list.name.padEnd(width))}  ${bone(clip(list.description, 46).padEnd(48))}${state}`);
  }
  lines.push("",
    `  ${ash("add one:")}     ${bone("/news add profullstack")}`,
    `  ${ash("drop one:")}    ${bone("/news rm profullstack")} ${ash("— removes every feed it brought in")}`,
    `  ${ash("search them:")} ${bone("/rss search ai,crypto")}`);
  return lines.join("\n");
}

/** Feeds found in the published lists, numbered so `add #n` can take one. */
export function renderFindHits(hits, { keywords = [], total = 0, subscribed = [] } = {}) {
  if (!hits.length) {
    return ["", `  ${ash(`nothing in the published lists matches ${keywords.join(", ")}`)}`, "",
      `  ${ash("the lists searched:")} ${bone(FEED_LISTS.map((l) => l.name).join(", "))}`,
      `  ${ash("or subscribe by URL:")} ${bone("/rss add https://example.com/feed.xml")}`].join("\n");
  }
  const have = new Set(subscribed.map((f) => f.url));
  const width = String(hits.length).length;
  const lines = ["",
    `  ${ash(`${total} feed${total === 1 ? "" : "s"} match ${keywords.join(", ")}${total > hits.length ? ` · showing ${hits.length}` : ""}`)}`,
    ""];
  hits.forEach((feed, i) => {
    const n = String(i + 1).padStart(width);
    const mark = have.has(feed.url) ? acid(" ✓") : "  ";
    lines.push(`  ${bone(n)}.${mark} ${acid(clip(feed.title || hostOf(feed.url), 30).padEnd(32))}${ash(clip(feed.url, 58))}`);
    if (feed.list) lines.push(`      ${ash(`from ${feed.list}`)}`);
  });
  lines.push("", `  ${ash("subscribe with")} ${bone("/rss add 1")} ${ash("· or the URL ·")} ${acid("✓")} ${ash("means already subscribed")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/** Remember what the numbers in the last listing pointed at. Best effort. */
function rememberListing(items, env) {
  try {
    const file = cacheFile(env);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const rows = items.map(({ title, link, feed, date }) => ({ title, link, feed, date }));
    fs.writeFileSync(file, `${JSON.stringify({ at: Date.now(), items: rows }, null, 2)}\n`, { mode: FILE_MODE });
    try { fs.chmodSync(file, FILE_MODE); } catch { /* best effort */ }
  } catch { /* a cache that cannot be written must not fail the listing */ }
}

function readListing(env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(env), "utf8"));
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch { return []; }
}

/**
 * Run a `news` invocation end to end. Returns a process exit code.
 *
 * `deps` exists so tests drive the whole command — parse, fetch, render — with
 * no network and no stdout, the way cryptoCommand's does.
 */
export async function newsCommand(argv = [], deps = {}) {
  const {
    out = (s) => console.log(s),
    fail = (s) => console.error(s),
    fetchImpl,
    openUrl,
    columns = process.stdout.columns,
    env = process.env,
    now = Date.now(),
  } = deps;

  const request = newsArgs(argv);
  if (request.usage) { out(newsUsage()); return 0; }
  if (request.error) { fail(danger(`✗ ${request.error}`)); return 1; }

  if (request.verb === "list") {
    const { feeds, usingDefaults } = readingList(env);
    if (request.json) { out(JSON.stringify({ file: opmlFile(env), usingDefaults, feeds }, null, 2)); return 0; }
    out(renderFeeds(feeds, { file: opmlFile(env), usingDefaults }));
    return 0;
  }

  if (request.verb === "sources") {
    // `bundles` is the old key for the same array; kept so a caller reading it
    // does not break on the rename.
    if (request.json) { out(JSON.stringify({ defaults: defaultFeeds(), lists: FEED_LISTS, bundles: FEED_LISTS }, null, 2)); return 0; }
    out(renderSources());
    return 0;
  }

  if (request.verb === "lists") {
    const feeds = loadFeeds(env);
    if (request.json) {
      const mine = subscribedLists(feeds);
      out(JSON.stringify({
        lists: FEED_LISTS.map((list) => ({ ...list, subscribed: mine.get(list.name) || 0 })),
      }, null, 2));
      return 0;
    }
    out(renderLists(feeds));
    return 0;
  }

  if (request.verb === "find") return findCommand(request, { out, fail, fetchImpl, env });

  if (request.verb === "export") {
    // The defaults deliberately: exporting an empty file to hand to a reader is
    // not what anyone means by "export my feeds" on a fresh install.
    out(buildOpml(readingList(env).feeds).trimEnd());
    return 0;
  }

  if (request.verb === "add") return addCommand(request, { out, fail, fetchImpl, env });
  if (request.verb === "rm") return removeCommand(request, { out, fail, env });

  if (request.verb === "open") {
    const items = readListing(env);
    if (!items.length) { fail(danger("✗ nothing to open — run `/news` first")); return 1; }
    const item = items[request.index - 1];
    if (!item) { fail(danger(`✗ there is no headline ${request.index} — the last listing had ${items.length}`)); return 1; }
    if (!item.link) { fail(danger(`✗ "${clip(item.title, 60)}" has no link`)); return 1; }
    if (request.json) { out(JSON.stringify(item, null, 2)); return 0; }
    const opened = openUrl ? openUrl(item.link) : false;
    out(opened
      ? `${acid("✓ ")}opened ${bone(clip(item.title, 60))}`
      : `${ash("· ")}open this in a browser:\n  ${acid(item.link)}`);
    return 0;
  }

  // Headlines — a keyword search, one URL passed straight in, or the reading list.
  let feeds;
  let source;
  if (request.verb === "search") {
    feeds = searchFeeds(request.query);
    source = `“${request.query}”`;
  } else if (request.oneOff) {
    feeds = [{ name: hostSlug(request.target), title: hostOf(request.target), url: request.target, site: "", category: "" }];
    source = hostOf(request.target);
  } else {
    const list = readingList(env);
    feeds = list.feeds;
    if (list.usingDefaults) source = "default feeds";
    if (request.feed) {
      const one = findFeed(feeds, request.feed);
      if (!one) {
        fail(danger(`✗ no feed named "${request.feed}"`));
        if (feeds.length) fail(`  ${ash("try:")} ${bone(feeds.map((f) => f.name).slice(0, 8).join(", "))}`);
        return 1;
      }
      feeds = [one];
      source = one.title || one.name;
    }
  }

  const { items, failures } = await collectNews(feeds, { fetchImpl, timeoutMs: request.timeoutMs });
  const shown = items.slice(0, request.limit);

  if (request.json) {
    out(JSON.stringify({ items: shown, failures, feeds: feeds.length }, null, 2));
  } else {
    out(renderHeadlines(items, {
      failures,
      columns,
      limit: request.limit,
      now,
      source: source ? `${source} · ${items.length} headline${items.length === 1 ? "" : "s"}` : "",
    }));
  }
  // Cached even for --json: the numbers a script just read are the numbers
  // `/news open <n>` should resolve.
  if (shown.length) rememberListing(shown, env);
  // Every feed failing is a failed command, not an empty one — a script that
  // branches on the exit status should not read a total outage as "no news".
  return items.length === 0 && failures.length === feeds.length ? 1 : 0;
}

/** How many matches a find prints. The rest are counted, not listed. */
const FIND_LIMIT = 25;

/**
 * `news find <keyword,…>` — search every published list for feeds to subscribe to.
 *
 * This is the way into the big lists. smallweb alone is 32,000 feeds, which is
 * a fine thing to search and an impossible thing to subscribe to, so the
 * catalogue is read here and only the matches become candidates for `add`.
 */
async function findCommand(request, { out, fail, fetchImpl, env }) {
  const hits = [];
  const seen = new Set();
  const failures = [];

  for (const list of FEED_LISTS) {
    const loaded = await loadListFeeds(list, { fetchImpl, env, timeoutMs: request.timeoutMs });
    if (!loaded.ok) { failures.push(`${list.name}: ${loaded.error}`); continue; }
    for (const feed of matchFeeds(loaded.feeds, request.keywords)) {
      if (seen.has(feed.url)) continue;
      seen.add(feed.url);
      hits.push({ ...feed, list: list.name });
    }
  }

  // Ranked across every list, not within each one. Sorting per list and then
  // concatenating puts all of web3's weak matches above smallweb's exact ones
  // purely because web3 is fetched first.
  hits.sort((a, b) => scoreFeed(b, request.keywords) - scoreFeed(a, request.keywords));

  if (!hits.length && failures.length === FEED_LISTS.length) {
    fail(danger("✗ could not read any of the published lists"));
    for (const line of failures) fail(`  ${ash(line)}`);
    return 1;
  }

  const shown = hits.slice(0, FIND_LIMIT);
  // Remembered so `add 3` resolves, and only the shown ones — a number the
  // operator never saw is not a number they can have meant.
  try {
    const file = findCacheFile(env);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify({ at: Date.now(), keywords: request.keywords, hits: shown }, null, 2)}\n`, { mode: FILE_MODE });
    try { fs.chmodSync(file, FILE_MODE); } catch { /* best effort */ }
  } catch { /* a cache that cannot be written must not fail the search */ }

  if (request.json) { out(JSON.stringify({ keywords: request.keywords, total: hits.length, hits: shown, failures }, null, 2)); return 0; }
  out(renderFindHits(shown, { keywords: request.keywords, total: hits.length, subscribed: loadFeeds(env) }));
  for (const line of failures) fail(`  ${ash(`· ${line}`)}`);
  return 0;
}

/** The feed a previous `find` numbered `n`, or null. */
function foundAt(index, env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(findCacheFile(env), "utf8"));
    return Array.isArray(parsed?.hits) ? parsed.hits[index - 1] ?? null : null;
  } catch { return null; }
}

/** `news add <url|file|list|#n>` — one feed, or every feed in a list. */
async function addCommand(request, { out, fail, fetchImpl, env }) {
  // `add 3` — the third result of the last find, subscribed by its URL.
  if (request.index != null) {
    const found = foundAt(request.index, env);
    if (!found) {
      fail(danger(`✗ there is no result ${request.index} — run \`/rss search <keyword>\` first`));
      return 1;
    }
    request = { ...request, target: found.url, index: null };
  }

  // A list name resolves to somebody else's published list. Checked before the
  // URL and the path so `journalists` is a name rather than a missing file.
  const bundle = resolveList(request.target);
  if (bundle?.searchOnly) {
    fail(danger(`✗ ${bundle.name} is ${bundle.description}`));
    fail(`  ${ash("too large to subscribe to wholesale — search it instead:")} ${bone(`/rss search <keyword>`)}`);
    return 1;
  }
  const target = bundle ? bundle.url : request.target;
  if (bundle) out(`${ash("· ")}fetching ${bone(bundle.name)} ${ash(`— ${bundle.description}`)}`);

  const res = await readSource(target, { fetchImpl, timeoutMs: request.timeoutMs });
  if (!res.ok) { fail(danger(`✗ ${res.error}`)); return 1; }

  // Subscribing for the first time replaces the defaults rather than merging
  // with them: the defaults are a stand-in, and silently welding thirteen feeds
  // onto the first one somebody chooses is not what `add` means.
  const existing = loadFeeds(env);
  const asUrl = safeUrl(target);

  // A named list is whichever shape it says it is; anything else is a list only
  // if it announces itself as OPML, so a plain feed is never read as one.
  if (bundle || looksLikeOpml(res.body)) {
    const parsedList = parseListDocument(res.body, bundle?.format);
    // Tagged with the list it came from, so `rm <list>` can take it back out.
    const incoming = bundle ? tagWithList(parsedList, bundle.name) : parsedList;
    if (!incoming.length) { fail(danger(`✗ that ${bundle?.format === "text" ? "list" : "OPML file"} lists no feeds`)); return 1; }
    let feeds = existing;
    const added = [];
    let skipped = 0;
    for (const feed of incoming) {
      const result = withFeed(feeds, feed);
      feeds = result.feeds;
      if (result.existed) skipped++; else added.push(result.added);
    }
    if (!added.length) {
      out(`${ash("· ")}already subscribed to all ${incoming.length} feed${incoming.length === 1 ? "" : "s"} in that list`);
      return 0;
    }
    try { saveFeeds(feeds, env); }
    catch (e) { fail(danger(`✗ can't write ${opmlFile(env)}: ${e.message}`)); return 1; }
    if (request.json) { out(JSON.stringify({ added, skipped }, null, 2)); return 0; }
    out(`${acid("✓ ")}subscribed to ${bone(String(added.length))} feed${added.length === 1 ? "" : "s"}${skipped ? ash(` (${skipped} already there)`) : ""}`);
    for (const feed of added.slice(0, 10)) out(`  ${acid(feed.name.padEnd(18))}${ash(clip(feed.title || feed.url, 56))}`);
    if (added.length > 10) out(`  ${ash(`…and ${added.length - 10} more — /news list`)}`);
    return 0;
  }

  // A single feed. It has to be a URL: parsing a local file would subscribe to
  // a path that only exists on this machine and would never refresh.
  if (!asUrl) {
    fail(danger(`✗ ${target} is a feed, not an OPML list — subscribe to it by URL so it can refresh`));
    return 1;
  }
  let parsed;
  try { parsed = parseFeed(res.body, { url: asUrl }); }
  catch (e) { fail(danger(`✗ can't read that feed (${e.message})`)); return 1; }
  if (!parsed.items.length && !parsed.title) {
    fail(danger(`✗ ${asUrl} doesn't look like an RSS, Atom, or OPML document`));
    return 1;
  }

  const candidate = {
    name: slugify(parsed.title) || hostSlug(asUrl),
    title: parsed.title || hostOf(asUrl),
    url: asUrl,
    site: parsed.site || "",
    category: "",
  };
  const { feeds, added, existed } = withFeed(existing, candidate);
  if (existed) {
    out(`${ash("· ")}already subscribed to ${bone(added.name)} ${ash(added.url)}`);
    return 0;
  }
  try { saveFeeds(feeds, env); }
  catch (e) { fail(danger(`✗ can't write ${opmlFile(env)}: ${e.message}`)); return 1; }
  if (request.json) { out(JSON.stringify({ added, skipped: 0 }, null, 2)); return 0; }
  out(`${acid("✓ ")}subscribed to ${bone(added.name)} ${ash(`— ${added.title}`)}`);
  out(`  ${ash(`${parsed.items.length} item${parsed.items.length === 1 ? "" : "s"} right now · read them with`)} ${bone(`/news --feed ${added.name}`)}`);
  return 0;
}

/** `news rm <name|url|list>` — unsubscribe from one feed, or a whole list. */
function removeCommand(request, { out, fail, env }) {
  const feeds = loadFeeds(env);

  // A list name takes the whole list back out. Checked first: subscribing to a
  // list is one action and unsubscribing from it should be one action too,
  // rather than the operator deleting forty feeds by hand.
  const asList = resolveList(request.target);
  if (asList) {
    const mine = feeds.filter((f) => listOf(f) === asList.name);
    if (!mine.length) {
      fail(danger(`✗ you have no feeds from "${asList.name}"`));
      return 1;
    }
    try { saveFeeds(feeds.filter((f) => listOf(f) !== asList.name), env); }
    catch (e) { fail(danger(`✗ can't write ${opmlFile(env)}: ${e.message}`)); return 1; }
    if (request.json) { out(JSON.stringify({ removed: mine, list: asList.name }, null, 2)); return 0; }
    out(`${acid("✓ ")}unsubscribed from ${bone(asList.name)} ${ash(`— ${mine.length} feed${mine.length === 1 ? "" : "s"}`)}`);
    return 0;
  }

  const feed = findFeed(feeds, request.target);
  if (!feed) {
    fail(danger(`✗ no feed named "${request.target}"`));
    if (feeds.length) fail(`  ${ash("try:")} ${bone(feeds.map((f) => f.name).slice(0, 8).join(", "))}`);
    return 1;
  }
  try { saveFeeds(feeds.filter((f) => f !== feed), env); }
  catch (e) { fail(danger(`✗ can't write ${opmlFile(env)}: ${e.message}`)); return 1; }
  if (request.json) { out(JSON.stringify({ removed: feed }, null, 2)); return 0; }
  out(`${acid("✓ ")}unsubscribed from ${bone(feed.name)} ${ash(feed.url)}`);
  return 0;
}
