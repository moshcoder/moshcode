// The site a name publishes here, drawn.
//
// The companion to moshpit-feed-page.mjs: that one renders writing that lives
// somewhere else, this one renders writing that lives in the pit. Same rules
// apply — everything on the page arrived over an API from a script somebody
// else wrote, so every string is escaped and every URL was checked by
// normalizeContent before it was stored.
//
// On the nav: it is one row of links and it is capped. A name's site is a
// handful of sections and pages, and the moment the navigation needs its own
// layout it has stopped being navigation. Everything past the cap is still on
// the front page, which is where a nav was pointing anyway.
//
// On embedding: a post can name any URL, and putting an arbitrary one in an
// iframe on app.moshcode.sh is a phishing surface with our hostname on it. So
// video is inlined only when it is a media file we can hand to <video>, or a
// URL on the short list of hosts whose embed form is well known. Everything
// else becomes a card that links out, which is what an `embed` post is.

import { esc } from "./html.mjs";
import { feedDate } from "./moshpit-feed-page.mjs";
import { navFor, postsFor } from "./moshpit-content.mjs";

/** A direct media file — something <video> can play without anyone's player. */
const VIDEO_FILE = /\.(mp4|webm|ogv|ogg|mov|m4v)(\?|#|$)/i;

/**
 * The embed URL for a video host, or null for "link to it instead".
 *
 * An allow-list, deliberately short. Each entry is a host whose embed URL is
 * stable and documented; anything not on it is a URL we have no reason to trust
 * inside a frame on the origin where accounts live.
 */
export function videoEmbed(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "youtube.com" || host === "m.youtube.com") {
    const id = parsed.searchParams.get("v") || parsed.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{6,20})/)?.[1];
    return id ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` : null;
  }
  if (host === "youtu.be") {
    const id = parsed.pathname.slice(1).split("/")[0];
    return /^[\w-]{6,20}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` : null;
  }
  if (host === "vimeo.com") {
    const id = parsed.pathname.split("/").filter(Boolean)[0];
    return /^\d{6,12}$/.test(id) ? `https://player.vimeo.com/video/${encodeURIComponent(id)}` : null;
  }
  if (host === "peertube.tv" || host === "tilvids.com") {
    const id = parsed.pathname.match(/\/w\/([\w-]+)/)?.[1];
    return id ? `https://${host}/videos/embed/${encodeURIComponent(id)}` : null;
  }
  return null;
}

/** The host a link points at, which is how a reader decides whether to follow it. */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/**
 * Prose, as paragraphs.
 *
 * Escaped first and split second, so the only markup in the output is the
 * paragraph tags this function put there. Blank lines separate paragraphs and
 * single newlines become breaks, which is what somebody typing into a JSON
 * field means by them.
 */
function prose(body) {
  return String(body ?? "")
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function clip(value, max) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const SITE_CSS = `
.site-wrap{max-width:760px;margin:0 auto;padding:44px 24px 80px}
.site-head{margin-bottom:22px}
.site-name{font-family:var(--mono);font-size:.68rem;letter-spacing:.2em;text-transform:uppercase;
  color:var(--acid);margin:0 0 6px}
.site-name a{color:var(--acid)}
.site-title{font-size:1.8rem;line-height:1.14;margin:0;text-transform:none;letter-spacing:-.02em}
.site-tag{color:var(--dim);margin:8px 0 0;font-size:.95rem;max-width:60ch}
.site-nav{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:18px 0 30px;
  padding-bottom:14px;border-bottom:1px solid var(--line)}
.site-nav a{font-family:var(--mono);font-size:.76rem;color:var(--dim);padding:5px 10px;border-radius:7px;
  border:1px solid transparent}
.site-nav a:hover{color:var(--acid);border-color:var(--line-2)}
.site-nav a.on{color:var(--acid-ink);background:var(--acid);border-color:var(--acid);font-weight:600}
.site-list{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.site-item{border-top:1px solid var(--line);padding:20px 0}
.site-item:last-child{border-bottom:1px solid var(--line)}
.site-when{font-family:var(--mono);font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;
  color:var(--faint);display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.site-kind{border:1px solid var(--line-2);border-radius:999px;padding:2px 8px;font-size:.6rem;letter-spacing:.12em}
.site-item h2{font-size:1.1rem;line-height:1.25;margin:8px 0 0;text-transform:none;letter-spacing:-.01em}
.site-item h2 a:hover{color:var(--acid)}
.site-body{color:var(--dim);font-size:.92rem;max-width:64ch}
.site-body p{margin:8px 0 0}
.site-out{font-family:var(--mono);font-size:.74rem;color:var(--acid);display:inline-block;margin-top:10px}
.site-out:hover{text-decoration:underline}
.site-shot{display:block;width:100%;max-height:520px;object-fit:contain;border-radius:10px;
  border:1px solid var(--line);background:var(--surface);margin-top:12px}
.site-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-top:12px}
.site-gallery img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;border:1px solid var(--line);
  background:var(--surface)}
.site-video{width:100%;aspect-ratio:16/9;border-radius:10px;border:1px solid var(--line);
  background:#000;margin-top:12px;display:block}
.site-card{display:flex;gap:12px;align-items:center;margin-top:12px;padding:12px 14px;
  border:1px solid var(--line-2);border-radius:10px;background:var(--bg-tint)}
.site-card .mono{font-size:.76rem;color:var(--dim);word-break:break-all}
.site-empty{color:var(--faint);font-family:var(--mono);font-size:.8rem;padding:26px 0}
.site-foot{margin-top:44px;padding-top:22px;border-top:1px solid var(--line);
  display:flex;gap:14px;flex-wrap:wrap;align-items:center;justify-content:space-between;
  font-family:var(--mono);font-size:.72rem;color:var(--faint)}
.site-foot a{color:var(--dim)}
.site-foot a:hover{color:var(--acid)}
@media (max-width:620px){.site-title{font-size:1.45rem}}
`;

/** The one-row navigation: sections and pages, in order, capped. */
function navBar(items, { name, here = null }) {
  const entries = navFor(items);
  const link = (href, label, on) =>
    `<a href="${href}"${on ? ' class="on" aria-current="page"' : ""}>${esc(label)}</a>`;
  const base = `/n/${encodeURIComponent(name)}`;
  return `<nav class="site-nav">
  ${link(base, "Home", here === null)}
  ${entries.map((entry) => link(`${base}/${encodeURIComponent(entry.slug)}`, entry.title, here === entry.slug)).join("")}
</nav>`;
}

/**
 * The media half of a post — the picture, the player, the card.
 *
 * `full` distinguishes a permalink from a listing: a listing shows a gallery as
 * a grid of thumbnails and a video as a player, but it does not need the whole
 * of a long body, and a permalink does.
 */
function media(item) {
  if (item.kind === "image" && item.url) {
    return `<img class="site-shot" src="${esc(item.url)}" alt="${esc(item.title || "")}" loading="lazy" referrerpolicy="no-referrer">`;
  }

  if (item.kind === "gallery" && item.media?.length) {
    return `<div class="site-gallery">${item.media.map((picture) =>
      `<a href="${esc(picture.url)}" rel="noopener nofollow ugc"><img src="${esc(picture.url)}" alt="${esc(picture.alt || "")}" loading="lazy" referrerpolicy="no-referrer"></a>`,
    ).join("")}</div>`;
  }

  if (item.kind === "video" && item.url) {
    if (VIDEO_FILE.test(item.url)) {
      return `<video class="site-video" controls preload="none" src="${esc(item.url)}"></video>`;
    }
    const embed = videoEmbed(item.url);
    if (embed) {
      return `<iframe class="site-video" src="${esc(embed)}" title="${esc(item.title || "video")}"
        loading="lazy" referrerpolicy="no-referrer" allowfullscreen
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe>`;
    }
    // A video we cannot play is a link to one, said plainly rather than shown
    // as a broken player.
    return linkCard(item.url, "watch it at");
  }

  if (item.kind === "embed" && item.url) return linkCard(item.url, "at");

  return "";
}

function linkCard(url, lead) {
  return `<div class="site-card">
  <span class="mono faint">${esc(lead)}</span>
  <a class="mono acid" href="${esc(url)}" rel="noopener nofollow ugc">${esc(clip(url, 90))}</a>
</div>`;
}

/**
 * One entry, in a listing or on its own page.
 *
 * The title links to the permalink rather than straight out, even for a link
 * post. The post is the thing that lives at this name — the URL it points at is
 * its content, and a reader who wants that has the "→ host" link right under
 * it. A title that skipped the permalink would make half a site unaddressable.
 */
export function siteItem(item, { name, full = false }) {
  const permalink = `/n/${encodeURIComponent(name)}/${encodeURIComponent(item.slug)}`;
  const when = item.published_at
    ? `<time datetime="${esc(new Date(item.published_at).toISOString())}">${esc(feedDate(item.published_at))}</time>`
    : "";
  const body = item.body
    ? `<div class="site-body">${full ? prose(item.body) : `<p>${esc(clip(item.body.replace(/\s+/g, " "), 400))}</p>`}</div>`
    : "";

  return `<li class="site-item">
  <div class="site-when">${when}<span class="site-kind">${esc(item.kind)}</span></div>
  ${item.title ? `<h2>${full ? esc(item.title) : `<a href="${permalink}">${esc(item.title)}</a>`}</h2>` : ""}
  ${media(item)}
  ${body}
  ${item.url && (item.kind === "link" || item.kind === "image")
    ? `<a class="site-out" href="${esc(item.url)}" rel="noopener nofollow ugc">→ ${esc(hostOf(item.url) || "open")}</a>`
    : ""}
</li>`;
}

function shell({ name, title, tagline, nav, main, feedUrl = null }) {
  return `<main class="site-wrap">
  <header class="site-head">
    <p class="site-name"><a href="/n/${encodeURIComponent(name)}">${esc(name)}</a></p>
    <h1 class="site-title">${esc(title)}</h1>
    ${tagline ? `<p class="site-tag">${esc(tagline)}</p>` : ""}
  </header>
  ${nav}
  ${main}
  <div class="site-foot">
    <span>${esc(name)} · published in the pit</span>
    <span>${feedUrl ? `<a href="/n/${encodeURIComponent(name)}?view=feed">its feed →</a> · ` : ""}<a href="/n/${encodeURIComponent(name)}?view=directory">this ending →</a> · <a href="/pit">the pit →</a></span>
  </div>
</main>`;
}

/**
 * The front page: everything published, newest first.
 *
 * The site's title is the name until somebody publishes a page or section that
 * says otherwise — a `home` item, whose title and body become the masthead. One
 * convention rather than a settings table: the thing that names a site is
 * content like everything else, and it is published the same way.
 */
export function sitePage({ name, items, feedUrl = null }) {
  const home = items.find((item) => item.slug === "home" && item.published_at);
  const posts = postsFor(items);

  return shell({
    name,
    title: home?.title || name,
    tagline: home?.body ? clip(home.body.replace(/\s+/g, " "), 240) : "",
    nav: navBar(items, { name }),
    feedUrl,
    main: posts.length
      ? `<ul class="site-list">${posts.map((item) => siteItem(item, { name })).join("")}</ul>`
      : `<p class="site-empty">Nothing published here yet.</p>`,
  });
}

/**
 * One slug's page: a section's listing, a page's prose, or a post's permalink.
 *
 * Three outcomes from one route because they are one URL shape. A visitor
 * following a nav link does not know or care which of the three they are about
 * to get, and neither should the link.
 */
export function sitePart({ name, items, item, feedUrl = null }) {
  const nav = navBar(items, { name, here: item.slug });

  if (item.kind === "section") {
    const posts = postsFor(items, { section: item.slug });
    return shell({
      name, nav, feedUrl,
      title: item.title,
      tagline: item.body ? clip(item.body.replace(/\s+/g, " "), 240) : "",
      main: posts.length
        ? `<ul class="site-list">${posts.map((post) => siteItem(post, { name })).join("")}</ul>`
        : `<p class="site-empty">Nothing filed under ${esc(item.title)} yet.</p>`,
    });
  }

  if (item.kind === "page") {
    return shell({
      name, nav, feedUrl,
      title: item.title,
      tagline: "",
      main: `<div class="site-body" style="font-size:1rem;color:var(--text)">${prose(item.body)}</div>`,
    });
  }

  return shell({
    name, nav, feedUrl,
    title: item.title || name,
    tagline: "",
    main: `<ul class="site-list">${siteItem(item, { name, full: true })}</ul>`,
  });
}
