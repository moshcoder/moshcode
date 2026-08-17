// What a name may publish, and what a caller has to send to publish it.
//
// Every value here arrives over HTTP from a script holding an API key. That is
// the point — publishing to a Moshpit name should be one call from whatever is
// already generating the thing being published — but it means nothing can be
// assumed about shape, size or intent. So this module is the whole of the
// validation: the route parses JSON, calls normalizeContent, and stores what
// comes back or returns the error it got. There is no second, looser path in.
//
// Kept apart from the SQL for the usual reason: what a gallery is allowed to
// contain is a rule worth testing without a database in front of it.

import { safeUrl } from "./feed.mjs";

/**
 * The kinds a name can publish.
 *
 * Two structural, six that are posts. The six are the set a link aggregator
 * has, because that is the set people actually post: say something, point at
 * something, show something, play something.
 */
export const CONTENT_KINDS = ["section", "page", "text", "link", "image", "gallery", "video", "embed"];

/** The kinds that are navigation rather than content. */
export const NAV_KINDS = ["section", "page"];

/** The kinds that are a post on the front page. */
export const POST_KINDS = ["text", "link", "image", "gallery", "video", "embed"];

/** The kinds whose whole content is a URL somewhere else. */
const URL_KINDS = ["link", "image", "video", "embed"];

export const MAX_TITLE = 200;
export const MAX_BODY = 20_000;
export const MAX_GALLERY = 24;
export const MAX_SLUG = 64;

/** The most items one name's site will hold. A site, not a database. */
export const MAX_ITEMS_PER_NAME = 500;

/** The most entries a navigation will draw. Past this it is not a nav, it is a list. */
export const MAX_NAV = 12;

/** The most items one POST may carry. A webhook delivers a batch; this bounds it. */
export const MAX_BATCH = 50;

/**
 * The largest a batch may be on the wire, in bytes.
 *
 * Derived rather than picked, because the two numbers have to agree: the API
 * documents a ceiling of MAX_BATCH items, and body-parser's 100kb default is
 * far below what MAX_BATCH items of this size actually weigh. The documented
 * limit would then 413 before reaching the handler — the request rejected for
 * a reason no field limit here explains, which is a bad afternoon.
 *
 * MAX_BATCH full-length bodies is ~1 MB of text. The doubling covers titles,
 * slugs, sections, URLs and JSON escaping, which can widen one character to
 * six bytes on the wire.
 *
 * A batch of MAX_BATCH *maximal galleries* is larger still and will 413. That
 * is deliberate — the alternative is accepting multi-megabyte bodies on every
 * request to buy headroom for a shape nobody sends. Split the batch; the
 * endpoint upserts on the slug, so splitting is safe and retryable.
 */
export const MAX_PUBLISH_BYTES = MAX_BATCH * (MAX_BODY + MAX_TITLE) * 2;

/**
 * A slug: lowercase, dashes, no leading or trailing dash.
 *
 * This is the URL, so it has the same shape as a name's label — and for the
 * same reason. A slug that needs escaping to appear in a path is a slug that
 * will be wrong somewhere.
 */
export function normalizeSlug(input) {
  const raw = String(input ?? "").trim().toLowerCase();
  if (!raw) return null;
  const slug = raw
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  return slug || null;
}

/**
 * A slug derived from a title, when a caller did not send one.
 *
 * Publishing should be one call with the fields you already have, and a script
 * posting a headline has a headline, not a URL segment. A collision is the
 * caller's to resolve by sending an explicit slug — silently appending `-2`
 * would make a retry create a second copy, which is the exact failure the
 * slug-as-primary-key is there to prevent.
 */
export function slugFromTitle(title) {
  return normalizeSlug(title);
}

/** Reserved because the site's own routes use them. */
const RESERVED_SLUGS = new Set(["api", "feed", "feed.xml", "rss", "sitemap.xml", "robots.txt", "n", "pit"]);

/**
 * Trim, cap, and take the control characters out.
 *
 * They are invisible in a payload, survive HTML escaping unchanged, and are how
 * a title smuggles a line break into a nav that assumed one line. Prose keeps
 * its newlines — a body is the one field where a line break is content rather
 * than an attack on the layout.
 */
function clean(value, max, { multiline = false } = {}) {
  const text = String(value ?? "");
  // eslint-disable-next-line no-control-regex
  const stripped = multiline ? text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ") : text.replace(/[\x00-\x1f\x7f]/g, " ");
  const collapsed = multiline
    ? stripped.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n")
    : stripped.replace(/\s+/g, " ");
  return collapsed.trim().slice(0, max);
}

/** A gallery's pictures: a list of URLs, or of {url, alt} objects. */
function normalizeMedia(input) {
  if (input === undefined || input === null) return { ok: true, media: null };
  const list = Array.isArray(input) ? input : [input];
  if (!list.length) return { ok: true, media: null };
  if (list.length > MAX_GALLERY) {
    return { ok: false, error: `a gallery holds up to ${MAX_GALLERY} pictures` };
  }

  const media = [];
  for (const entry of list) {
    const raw = typeof entry === "string" ? { url: entry } : (entry || {});
    const url = safeUrl(raw.url);
    if (!url) return { ok: false, error: "every picture in a gallery needs an http(s) url" };
    media.push({ url, alt: clean(raw.alt, MAX_TITLE) });
  }
  return { ok: true, media };
}

/**
 * A publishing time.
 *
 * Accepts what a caller is likely to already hold: epoch milliseconds, epoch
 * seconds, or anything Date can parse. `null` is an explicit draft; leaving the
 * field out means "now", because a script that posts something without saying
 * when meant now.
 */
function normalizePublished(input, now) {
  if (input === undefined) return { ok: true, at: now };
  if (input === null || input === false || input === "") return { ok: true, at: null };
  if (input === true) return { ok: true, at: now };

  if (typeof input === "number" && Number.isFinite(input)) {
    // Seconds are ten digits until 2286; milliseconds are thirteen. Nobody
    // publishing today means 1970-01-20, so the small number is seconds.
    return { ok: true, at: Math.round(input < 1e11 ? input * 1000 : input) };
  }
  const parsed = Date.parse(String(input));
  if (!Number.isFinite(parsed)) return { ok: false, error: "that is not a date we can read" };
  return { ok: true, at: parsed };
}

/**
 * Validate one item to publish, and return the row to store.
 *
 * Every kind has exactly one thing it cannot be published without — a link with
 * no URL and an image with no picture are not posts, they are empty rows that
 * render as a title and a shrug. Saying which is missing is the difference
 * between a caller fixing their payload and a caller filing a bug.
 */
export function normalizeContent(input = {}, { now = Date.now() } = {}) {
  const kind = String(input.kind ?? "").trim().toLowerCase();
  if (!CONTENT_KINDS.includes(kind)) {
    return { ok: false, error: `kind must be one of ${CONTENT_KINDS.join(", ")}` };
  }

  const title = clean(input.title, MAX_TITLE);
  const slug = normalizeSlug(input.slug) || slugFromTitle(title);
  if (!slug) {
    return { ok: false, error: "send a slug, or a title one can be made from" };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, error: `"${slug}" is reserved` };
  }

  // A title is what a nav entry, a card and a permalink are all labelled with.
  // Only a picture can do without one, because a picture is its own label.
  if (!title && kind !== "image" && kind !== "gallery") {
    return { ok: false, error: `a ${kind} needs a title` };
  }

  const body = clean(input.body ?? input.text ?? input.content, MAX_BODY, { multiline: true });
  if (kind === "text" && !body) return { ok: false, error: "a text post needs a body" };
  if (kind === "page" && !body) return { ok: false, error: "a page needs a body" };

  let url = null;
  if (URL_KINDS.includes(kind)) {
    url = safeUrl(input.url ?? input.href ?? input.link);
    if (!url) return { ok: false, error: `a ${kind} needs an http(s) url` };
  }

  const media = normalizeMedia(input.media ?? input.images ?? input.gallery);
  if (!media.ok) return media;
  if (kind === "gallery" && !media.media?.length) {
    return { ok: false, error: "a gallery needs at least one picture" };
  }

  // Read by key presence rather than with `??`: an explicit `null` is how a
  // caller says "draft", and `??` would fall through it to the next field and
  // then to "now" — quietly publishing the thing that asked not to be.
  const publishedInput = "published_at" in input ? input.published_at
    : "published" in input ? input.published
      : undefined;
  const published = normalizePublished(publishedInput, now);
  if (!published.ok) return published;

  // A post's section is a slug like any other; an unknown one is not an error,
  // it just does not appear in the nav until the section is created.
  const section = POST_KINDS.includes(kind) ? normalizeSlug(input.section ?? input.parent) : null;

  // Sections and pages are the nav; posts are not, unless somebody insists.
  const nav = input.nav === undefined ? NAV_KINDS.includes(kind) : Boolean(input.nav);

  const position = Number.parseInt(input.position, 10);

  return {
    ok: true,
    item: {
      slug,
      kind,
      title,
      body: body || null,
      url,
      media: media.media ? JSON.stringify(media.media) : null,
      section,
      nav: nav ? 1 : 0,
      position: Number.isFinite(position) ? Math.max(-999, Math.min(999, position)) : 0,
      published_at: published.at,
    },
  };
}

/** A stored row, as the API and the renderer want it: media parsed, nav a boolean. */
export function contentOut(row) {
  if (!row) return null;
  let media = null;
  try { media = row.media ? JSON.parse(row.media) : null; } catch { media = null; }
  return {
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    body: row.body ?? null,
    url: row.url ?? null,
    media,
    section: row.section ?? null,
    nav: Boolean(row.nav),
    position: row.position ?? 0,
    published_at: row.published_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * The navigation for a site.
 *
 * Sections and pages that are published and marked for the nav, in position
 * order, bounded. Bounded rather than scrolled: a nav is a promise that the
 * whole site is a few clicks away, and one that wraps onto three lines has
 * stopped making it. Everything past the cap is still reachable — it is on the
 * front page, which is where a nav was pointing anyway.
 */
export function navFor(items = [], { max = MAX_NAV } = {}) {
  return items
    .filter((item) => item.nav && NAV_KINDS.includes(item.kind) && item.published_at)
    // `home` is the masthead — its title is already the site's title, and a nav
    // that lists it puts the same page next to "Home" under a different name.
    .filter((item) => item.slug !== "home")
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
    .slice(0, max);
}

/**
 * The posts on the front page, newest first.
 *
 * Undated posts sort last rather than first: a published post with no date is
 * usually an import that lost one, and letting it sit above today's writing is
 * how an archive buries a site.
 */
export function postsFor(items = [], { section = null } = {}) {
  return items
    .filter((item) => POST_KINDS.includes(item.kind) && item.published_at)
    .filter((item) => (section === null ? true : item.section === section))
    .sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0));
}
