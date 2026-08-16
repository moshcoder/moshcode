// Reading the feed a Moshpit name publishes.
//
// A name's owner types one URL and the pit renders a site at that name. So
// this has to do three things safely, in order: decide the URL is one we may
// fetch at all, fetch it without letting a hostile feed cost us more than a
// feed's worth of memory and time, and turn a document written by a stranger
// into values that can be escaped and rendered.
//
// The XML is read with targeted regexes rather than a parser, matching
// src/news.mjs in the CLI — for the same reason there, which is that DOCTYPE
// is stripped and entities come from a fixed table, so a feed cannot declare an
// entity that expands into a file read. This is a deliberate second copy
// rather than an import: apps/pwa deploys on its own (railway.json lives in
// this directory, and the image has no ../../src), and the two have already
// diverged — the CLI lists headlines and never needed enclosures, cover art or
// episode durations, which are most of what a podcast page is.
//
// The fetch is the same threat as the gateway's: the URL is chosen by whoever
// claimed the name, so it is checked against the reserved ranges before we
// connect, and again at every redirect hop. checkTarget is imported rather than
// reimplemented — one deny-list, one place to fix it.

import { isIP } from "node:net";

import { blockedReason, checkTarget } from "./moshpit-gateway.mjs";

/** How long a feed's host has to answer before the page gives up on it. */
export const FEED_TIMEOUT_MS = 8_000;

/**
 * Where a feed read stops.
 *
 * A page shows a screenful of entries, so nothing here needs the whole of an
 * aggregator's firehose. Feeds are newest-first and parseFeed matches whole
 * `<item>` blocks, so a cut tail is simply not an item — truncating gives the
 * reader the newest entries rather than an error.
 */
export const MAX_FEED_BYTES = 2 * 1024 * 1024;

/** The most entries one page will draw. Beyond this is scrolling, not reading. */
export const MAX_ITEMS = 50;

/** Redirect hops followed. Enough for http→https→www, short of a loop. */
const MAX_REDIRECTS = 4;

/** How long a fetched feed is served without asking the origin again. */
export const FEED_TTL_MS = 5 * 60 * 1000;

/**
 * How long a feed that has stopped answering is still shown.
 *
 * A name is a site, and a site does not go blank because its feed host had a
 * bad minute. Past the TTL the cached copy is stale but still true, so it is
 * served with the failure noted rather than replaced by an error page.
 */
export const FEED_STALE_MS = 24 * 60 * 60 * 1000;

/** The layouts a feed can be drawn in. Null means "work it out from the feed". */
export const FEED_KINDS = ["blog", "podcast"];

// ---------------------------------------------------------------------------
// XML, the small subset feeds actually use
// ---------------------------------------------------------------------------

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  mdash: "—", ndash: "–", hellip: "…", eacute: "é",
};

/**
 * Decode the entities a feed actually carries: a fixed table plus numeric
 * escapes, never the document's own DOCTYPE declarations.
 */
export function decodeEntities(input) {
  return String(input ?? "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** BOM, comments and DOCTYPE out — the parts of a document that are never content. */
function scrub(xml) {
  return String(xml ?? "")
    .replace(/^﻿/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, "");
}

/**
 * CDATA out, entities decoded, tags out, whitespace collapsed.
 *
 * Decoding before stripping is load-bearing: a `<description>` arrives as
 * markup two ways — CDATA carrying real tags, or the same HTML escaped into
 * `&lt;a href=…&gt;`. Strip first and the escaped form sails through, then
 * decoding turns it back into the markup that was supposed to be gone.
 *
 * Everything this returns is plain text with no `<` left in it that came from
 * a tag. It is still escaped again at render time — this is the first of two
 * defences, not the only one.
 */
function text(raw) {
  let value = String(raw ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Twice, because publishers escape HTML that was already escaped. Bounded at
  // two: that is every doubling seen in the wild, and looping until a document
  // stops changing is a decompression bomb waiting to happen.
  for (let round = 0; round < 2; round++) {
    value = decodeEntities(value).replace(/<[^>]*>/g, " ");
  }
  return value
    .replace(/\s+/g, " ")
    // A tag removed from in front of punctuation leaves the space it stood in:
    // `<b>no more</b>.` becomes "no more ." Closing that gap is the difference
    // between an excerpt that reads as prose and one that reads as scraped
    // markup, which is most of what a summary is judged on.
    .replace(/\s+([,.;:!?%)\]}])/g, "$1")
    .replace(/([(\[{])\s+/g, "$1")
    .trim();
}

/** The text of the first `<tag>` in a block, namespace prefix optional. */
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

/**
 * Only http(s) survives.
 *
 * Every URL on a rendered feed page came out of somebody else's document and
 * ends up in an `href`, a `src` or an audio player. `javascript:` in an href is
 * script execution on app.moshcode.sh, which is where sessions live, and
 * `data:` is the same hole wearing a hat. Relative URLs resolve against the
 * feed so a site that links `/posts/1` still works.
 */
export function safeUrl(raw, base = null) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  let url;
  try { url = base ? new URL(value, base) : new URL(value); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.toString();
}

function clip(value, max) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ""; }
}

// ---------------------------------------------------------------------------
// What an owner typed into "feed"
// ---------------------------------------------------------------------------

/**
 * Validate a feed URL and return the form to store.
 *
 * A bare `example.com/feed.xml` gets https:// put on the front, because that is
 * what someone pasting from a browser bar leaves off and refusing it teaches
 * nothing. Unlike a target, IPv4 is fine here: a feed URL is somebody's
 * existing blog or podcast host, not an address this registry is asking anyone
 * to keep stable. What is refused is the same as everywhere else — an address
 * that is not on the public internet, and any scheme but http(s).
 *
 * Empty is not an error. Clearing the field is how an owner takes the feed
 * back off a name.
 */
export function normalizeFeedUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: true, feed: null };
  if (raw.length > 2048) return { ok: false, error: "that feed URL is too long" };

  // A scheme we would refuse below is worth naming: someone pasting
  // `feed://example.com/rss` has a real feed and one character of trouble.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  const candidate = scheme === "feed" || scheme === "webcal"
    ? raw.replace(/^[a-z]+:\/\//i, "https://")
    : scheme
      ? raw
      : `https://${raw}`;

  const url = safeUrl(candidate);
  if (!url) return { ok: false, error: "a feed has to be an http:// or https:// URL" };

  const parsed = new URL(url);
  if (!parsed.hostname) return { ok: false, error: "that feed URL has no host" };

  // The same deny-list the gateway applies to a target, applied here to an
  // address literal. A hostname cannot be judged until it resolves, and that
  // happens at fetch time in fetchFeed — this catches only what can be judged
  // while the owner is still looking at the form.
  const literal = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    const why = blockedReason(literal);
    if (why) return { ok: false, error: `that address is ${why} — a feed has to be on the public internet` };
  }

  return { ok: true, feed: url };
}

/** 'blog', 'podcast', or null for auto — anything else is not a layout we draw. */
export function normalizeFeedKind(input) {
  const raw = String(input ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return { ok: true, kind: null };
  if (FEED_KINDS.includes(raw)) return { ok: true, kind: raw };
  return { ok: false, error: `a feed is a ${FEED_KINDS.join(" or a ")} — "${raw}" is neither` };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Audio and video enclosures are what make a feed a podcast rather than a blog. */
const MEDIA_TYPE = /^(audio|video)\//i;

/**
 * The enclosure on an entry, when it has one.
 *
 * RSS puts it in `<enclosure url type length>`, Atom in a `<link rel="enclosure">`,
 * and Media RSS in `<media:content>`. All three mean the same thing and a
 * publisher may emit more than one, so the first one that is actually media
 * wins — a feed that encloses a cover image is not thereby a podcast.
 */
function enclosureOf(block, base) {
  const candidates = [
    ...tagsNamed(block, "(?:[a-z0-9]+\\:)?enclosure").map((tag) => ({
      url: attr(tag, "url") || attr(tag, "href"), type: attr(tag, "type"), length: attr(tag, "length"),
    })),
    ...tagsNamed(block, "(?:[a-z0-9]+\\:)?link")
      .filter((tag) => attr(tag, "rel").toLowerCase() === "enclosure")
      .map((tag) => ({ url: attr(tag, "href"), type: attr(tag, "type"), length: attr(tag, "length") })),
    ...tagsNamed(block, "media\\:content").map((tag) => ({
      url: attr(tag, "url"), type: attr(tag, "type") || `${attr(tag, "medium")}/`, length: attr(tag, "fileSize"),
    })),
  ];

  for (const candidate of candidates) {
    const url = safeUrl(candidate.url, base);
    if (!url || !MEDIA_TYPE.test(candidate.type || "")) continue;
    const bytes = Number.parseInt(candidate.length, 10);
    return {
      url,
      type: candidate.type.toLowerCase(),
      bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null,
      video: /^video\//i.test(candidate.type),
    };
  }
  return null;
}

/**
 * An episode length as `1:04:37`, from either shape iTunes allows.
 *
 * `<itunes:duration>` is documented as seconds and published as everything —
 * `3877`, `64:37`, `01:04:37`. Both are accepted and normalised to one form so
 * the page does not show three notations in one list.
 */
export function formatDuration(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";

  let seconds;
  if (/^\d+$/.test(value)) {
    seconds = Number.parseInt(value, 10);
  } else if (/^\d{1,3}(:[0-5]?\d){1,2}$/.test(value)) {
    seconds = value.split(":").reduce((total, part) => total * 60 + Number.parseInt(part, 10), 0);
  } else {
    return "";
  }
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 24 * 3600) return "";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/**
 * The link for an entry.
 *
 * Atom puts it in an attribute and may carry several: no `rel`, or
 * `rel="alternate"`, is the human-readable page; `self`, `replies` and
 * `enclosure` are not what a reader should open. RSS puts it in element text,
 * and some publishers only fill a permalink `<guid>`.
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
 * Artwork for a channel or an entry.
 *
 * Four shapes across the formats: iTunes' `<itunes:image href>` (every podcast
 * has one and it is the cover), RSS's `<image><url>`, Atom's `<logo>`/`<icon>`,
 * and Media RSS thumbnails. A podcast page without cover art is a list of
 * links, so it is worth looking in all of them.
 */
function imageOf(block, base) {
  const itunes = tagsNamed(block, "itunes\\:image")[0];
  const fromItunes = itunes ? safeUrl(attr(itunes, "href"), base) : null;
  if (fromItunes) return fromItunes;

  const thumb = tagsNamed(block, "media\\:thumbnail")[0];
  const fromThumb = thumb ? safeUrl(attr(thumb, "url"), base) : null;
  if (fromThumb) return fromThumb;

  const rss = /<image(?:\s[^>]*)?>([\s\S]*?)<\/image>/i.exec(block);
  if (rss) {
    const url = safeUrl(pick(rss[1], "url"), base);
    if (url) return url;
  }

  for (const tag of ["logo", "icon"]) {
    const url = safeUrl(pick(block, tag), base);
    if (url) return url;
  }
  return null;
}

/**
 * Which layout a feed asks for, when nobody has said.
 *
 * The question is whether the entries carry audio, and "some of them" is the
 * common case rather than an edge one — a podcast's feed often opens with a
 * text-only announcement post, and a blog may attach one recording. So it is a
 * proportion, not a presence check: a third of the entries carrying media is a
 * show, one in twenty is a blog post with a file on it.
 */
export function inferKind(items = []) {
  const withAudio = items.filter((item) => item.audio).length;
  if (!items.length) return "blog";
  return withAudio / items.length >= 0.34 ? "podcast" : "blog";
}

/**
 * Parse an RSS/Atom/RDF document into a feed a page can be drawn from.
 *
 * One code path for all three because at this level they are the same
 * document: a channel with a title and a list of dated, linked entries, some
 * of which carry a media file. Where they disagree — the entry element name,
 * where the link lives, which tag holds the date — the difference is handled at
 * that field rather than by forking the parser.
 */
export function parseFeed(xml, { url = "" } = {}) {
  const doc = scrub(xml);
  const blocks = (doc.match(
    /<(?:[a-z0-9]+:)?(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:[a-z0-9]+:)?(?:item|entry)>/gi,
  ) || []).slice(0, MAX_ITEMS);

  // The channel header is whatever precedes the first entry — taking the title
  // from the whole document would pick up an entry's title on a feed whose
  // channel has none.
  const head = blocks.length ? doc.slice(0, doc.indexOf(blocks[0])) : doc;

  const items = [];
  for (const block of blocks) {
    const title = pick(block, "title").replace(/\s*(\.\s*){3,}\s*$/, "…").trim();
    const link = linkOf(block, url);
    const audio = enclosureOf(block, url);
    // Nothing to show, nowhere to go and nothing to play: not an entry.
    if (!title && !link && !audio) continue;
    items.push({
      title: title || link || "untitled",
      link,
      date: dateOf(block),
      author: clip(pick(block, "creator") || pick(block, "author") || "", 80),
      summary: clip(
        pick(block, "description") || pick(block, "summary")
          || pick(block, "itunes:summary") || pick(block, "content") || "",
        420,
      ),
      audio,
      duration: formatDuration(pick(block, "itunes:duration")),
      image: imageOf(block, url),
    });
  }

  return {
    url,
    title: clip(pick(head, "title") || hostOf(url), 160),
    site: linkOf(head, url) || "",
    description: clip(
      pick(head, "description") || pick(head, "subtitle") || pick(head, "itunes:summary") || "",
      400,
    ),
    author: clip(pick(head, "itunes:author") || pick(head, "managingEditor") || "", 80),
    image: imageOf(head, url),
    kind: inferKind(items),
    items,
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Read a response body, stopping at the cap rather than after it.
 *
 * A feed that turns out to be a disk image should cost a couple of megabytes of
 * transfer, not all of it — so the stream is cancelled mid-read. Decoded with
 * the charset the origin declared, because a feed served as latin-1 and decoded
 * as UTF-8 renders every accent as a replacement character.
 */
async function readCapped(response, maxBytes) {
  const declared = Number.parseInt(response.headers.get("content-length") || "", 10);
  const charset = /charset\s*=\s*"?([\w-]+)"?/i.exec(response.headers.get("content-type") || "")?.[1];
  let decoder;
  try { decoder = new TextDecoder(charset || "utf-8"); } catch { decoder = new TextDecoder("utf-8"); }

  // Nothing to stream: no body (a HEAD-shaped response) or an origin that has
  // already said it is sending more than we will read.
  if (!response.body) return { text: "", truncated: false };
  if (Number.isFinite(declared) && declared > maxBytes * 8) {
    return { text: "", truncated: true };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // Sliced rather than kept whole: a body can arrive as one chunk, and
    // pushing it before checking the total would honour the cap on the
    // *transfer* while still buffering and parsing all of it.
    const room = maxBytes - size;
    if (value.byteLength >= room) {
      chunks.push(value.subarray(0, room));
      size = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    size += value.byteLength;
    chunks.push(value);
  }

  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return { text: decoder.decode(buffer), truncated };
}

/**
 * Fetch and parse one feed. Returns { ok, feed } or { ok: false, error }.
 *
 * Redirects are followed by hand, one hop at a time, because each hop is a new
 * host chosen by whoever controls the last one — following automatically would
 * check the address the owner published and none of the addresses it forwards
 * to, which is the whole SSRF hole reopened by a `Location` header.
 */
export async function fetchFeed(url, {
  fetchImpl = fetch,
  check = checkTarget,
  timeoutMs = FEED_TIMEOUT_MS,
  maxBytes = MAX_FEED_BYTES,
  maxRedirects = MAX_REDIRECTS,
} = {}) {
  let current = safeUrl(url);
  if (!current) return { ok: false, error: "that is not a fetchable feed URL" };

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const target = new URL(current);
    const verdict = await check(target.hostname);
    if (!verdict.ok) {
      return { ok: false, error: `the feed host is not reachable from the public internet — ${verdict.error}` };
    }

    let response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
          "user-agent": "moshpit-feed/1.0 (+https://pit.moshcode.sh)",
        },
      });
    } catch (error) {
      return {
        ok: false,
        error: error?.name === "TimeoutError" || error?.name === "AbortError"
          ? "the feed host did not answer in time"
          : "the feed host could not be reached",
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const next = safeUrl(response.headers.get("location") || "", current);
      if (!next) return { ok: false, error: "the feed redirects somewhere we cannot follow" };
      // Cancel the redirect's own body; nothing here reads it.
      await response.body?.cancel?.().catch(() => {});
      current = next;
      continue;
    }

    if (!response.ok) {
      return { ok: false, error: `the feed answered ${response.status}` };
    }

    const { text: body, truncated } = await readCapped(response, maxBytes);
    if (!body.trim()) {
      return { ok: false, error: truncated ? "the feed is too large to read" : "the feed came back empty" };
    }

    const feed = parseFeed(body, { url: current });
    if (!feed.items.length) {
      return { ok: false, error: "nothing at that URL parsed as an RSS or Atom feed" };
    }
    return { ok: true, feed: { ...feed, truncated } };
  }

  return { ok: false, error: "the feed redirects too many times" };
}

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

/**
 * Feeds are cached in the process, not in the database.
 *
 * A name's page is a public URL, so without this every visit — and every
 * crawler — is a request to somebody else's feed host, and a name that gets
 * linked anywhere becomes a small denial-of-service attack we host. In memory
 * because a feed is derived data with a short life: it costs one fetch to
 * rebuild after a deploy, and a table of cached XML is a schema to migrate for
 * something that is stale in five minutes anyway.
 *
 * Bounded, because the key is a URL that anybody who claims a name gets to
 * choose. Oldest out first when it fills.
 */
const CACHE_MAX = 500;
const cache = new Map();

export function clearFeedCache() { cache.clear(); }

/**
 * The feed at a URL, from cache when it is fresh.
 *
 * A stale copy beats an error page: when the origin fails and we still hold
 * something recent, it is served with `stale` set, so the page can say the
 * feed has not answered while still being a site.
 */
export async function loadFeed(url, { now = Date.now(), ttlMs = FEED_TTL_MS, staleMs = FEED_STALE_MS, ...opts } = {}) {
  const key = safeUrl(url);
  if (!key) return { ok: false, error: "that is not a fetchable feed URL" };

  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return { ok: true, feed: hit.feed, cached: true, stale: false };

  const result = await fetchFeed(key, opts);
  if (result.ok) {
    if (cache.size >= CACHE_MAX && !cache.has(key)) cache.delete(cache.keys().next().value);
    cache.delete(key);
    cache.set(key, { at: now, feed: result.feed });
    return { ...result, cached: false, stale: false };
  }

  if (hit && now - hit.at < staleMs) {
    return { ok: true, feed: hit.feed, cached: true, stale: true, error: result.error };
  }
  return result;
}
