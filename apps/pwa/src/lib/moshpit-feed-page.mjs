// The site a Moshpit name gets when its owner has a feed but no server.
//
// Two layouts, because a feed is one of two things to a reader. A blog is read
// — the entry is a headline, a date and enough of the opening to decide, and
// the destination is somebody else's page. A podcast is played — the entry is
// an episode with artwork and a running time, and the destination is right
// here, in an audio element, because making someone leave to press play is the
// one thing a podcast page must not do.
//
// Everything drawn here came out of a document written by whoever owns the
// feed, which is not necessarily whoever owns the name and is certainly not us.
// So every string goes through esc() and every URL through the parser's
// safeUrl() before it reaches an href, a src or a player. There is no path in
// this file that interpolates feed content unescaped.

import { esc } from "./html.mjs";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A date a reader can scan, in UTC.
 *
 * Fixed rather than localised: this is rendered on the server for a visitor
 * whose locale we do not know, so a format that changes with the request's
 * headers would only make the same page differ between caches.
 */
export function feedDate(ms) {
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** An ISO stamp for `<time datetime>`, so a machine reading the page gets the real value. */
function isoDate(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

/** A file size in the units a reader thinks in. Enclosures are megabytes. */
function fileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(mb >= 10 ? 0 : 1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export const FEED_CSS = `
.feed-wrap{max-width:760px;margin:0 auto;padding:56px 24px 80px}
.feed-head{display:flex;gap:22px;align-items:flex-start;margin-bottom:34px}
.feed-cover{width:132px;height:132px;flex:none;border-radius:var(--r);border:1px solid var(--line-2);
  object-fit:cover;background:var(--surface)}
.feed-head-text{min-width:0}
.feed-name{font-family:var(--mono);font-size:.68rem;letter-spacing:.2em;text-transform:uppercase;
  color:var(--acid);margin:0 0 8px}
.feed-title{font-size:1.9rem;line-height:1.12;margin:0 0 10px;text-transform:none;letter-spacing:-.02em}
.feed-desc{color:var(--dim);margin:0;font-size:.95rem;max-width:60ch}
.feed-meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px}
.feed-note{border:1px solid color-mix(in srgb,var(--warn) 40%,var(--line));color:var(--warn);
  border-radius:9px;padding:9px 13px;font-family:var(--mono);font-size:.74rem;margin:0 0 24px}
.feed-list{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.feed-item{border-top:1px solid var(--line);padding:22px 0}
.feed-item:last-child{border-bottom:1px solid var(--line)}
.feed-when{font-family:var(--mono);font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;
  color:var(--faint);display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.feed-item h2{font-size:1.12rem;line-height:1.25;margin:8px 0 0;text-transform:none;letter-spacing:-.01em}
.feed-item h2 a:hover{color:var(--acid)}
.feed-sum{color:var(--dim);font-size:.9rem;margin:8px 0 0;max-width:64ch}
.feed-more{font-family:var(--mono);font-size:.74rem;color:var(--acid);display:inline-block;margin-top:10px}
.feed-more:hover{text-decoration:underline}
.ep{display:flex;gap:16px;align-items:flex-start}
.ep-art{width:74px;height:74px;flex:none;border-radius:8px;border:1px solid var(--line);object-fit:cover;
  background:var(--surface)}
.ep-body{min-width:0;flex:1}
.ep audio{width:100%;margin-top:12px;height:38px;border-radius:8px}
.feed-foot{margin-top:44px;padding-top:22px;border-top:1px solid var(--line);
  display:flex;gap:14px;flex-wrap:wrap;align-items:center;justify-content:space-between;
  font-family:var(--mono);font-size:.72rem;color:var(--faint)}
.feed-foot a{color:var(--dim)}
.feed-foot a:hover{color:var(--acid)}
@media (max-width:620px){
  .feed-head{flex-direction:column;gap:16px}
  .feed-cover{width:104px;height:104px}
  .feed-title{font-size:1.5rem}
  .ep{gap:12px}
  .ep-art{width:56px;height:56px}
}
`;

/** The chips under the title: what it is, who makes it, and how to subscribe. */
function headMeta({ feed, kind, feedUrl }) {
  const chips = [`<span class="pill on">${kind === "podcast" ? "podcast" : "blog"}</span>`];
  if (feed.author) chips.push(`<span class="pill">${esc(feed.author)}</span>`);
  if (feed.site) chips.push(`<a class="pill" href="${esc(feed.site)}" rel="noopener nofollow ugc">website ↗</a>`);
  chips.push(`<a class="pill" href="${esc(feedUrl)}" rel="noopener nofollow ugc">subscribe ↗</a>`);
  return `<div class="feed-meta">${chips.join("")}</div>`;
}

/**
 * One post.
 *
 * The whole row is not a link even though the title is: an entry with no link
 * is a legitimate feed entry (a note with no permalink), and wrapping the row
 * would leave a clickable card that goes nowhere.
 */
function post(item) {
  const when = item.date
    ? `<time datetime="${esc(isoDate(item.date))}">${esc(feedDate(item.date))}</time>`
    : "";
  const by = item.author ? `<span>${esc(item.author)}</span>` : "";
  const title = item.link
    ? `<a href="${esc(item.link)}" rel="noopener nofollow ugc">${esc(item.title)}</a>`
    : esc(item.title);

  return `<li class="feed-item">
  ${when || by ? `<div class="feed-when">${when}${by}</div>` : ""}
  <h2>${title}</h2>
  ${item.summary ? `<p class="feed-sum">${esc(item.summary)}</p>` : ""}
  ${item.link ? `<a class="feed-more" href="${esc(item.link)}" rel="noopener nofollow ugc">read →</a>` : ""}
</li>`;
}

/**
 * One episode.
 *
 * `preload="none"` on every player: a page of twenty episodes that each start
 * buffering on load is tens of megabytes pulled from the show's host for a
 * visitor who has pressed nothing.
 */
function episode(item, feed) {
  const art = item.image || feed.image;
  const when = item.date
    ? `<time datetime="${esc(isoDate(item.date))}">${esc(feedDate(item.date))}</time>`
    : "";
  const bits = [when];
  if (item.duration) bits.push(`<span>${esc(item.duration)}</span>`);
  if (item.audio?.bytes) bits.push(`<span>${esc(fileSize(item.audio.bytes))}</span>`);
  const title = item.link
    ? `<a href="${esc(item.link)}" rel="noopener nofollow ugc">${esc(item.title)}</a>`
    : esc(item.title);

  // A video enclosure in a podcast feed is still an episode; it just needs the
  // element that can play it.
  const player = item.audio
    ? `<${item.audio.video ? "video" : "audio"} controls preload="none" src="${esc(item.audio.url)}"></${item.audio.video ? "video" : "audio"}>`
    : "";

  return `<li class="feed-item"><div class="ep">
  ${art ? `<img class="ep-art" src="${esc(art)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
  <div class="ep-body">
    ${bits.filter(Boolean).length ? `<div class="feed-when">${bits.filter(Boolean).join("")}</div>` : ""}
    <h2>${title}</h2>
    ${item.summary ? `<p class="feed-sum">${esc(item.summary)}</p>` : ""}
    ${player}
  </div>
</div></li>`;
}

/**
 * The page a name with a feed shows.
 *
 * @param {object} input
 * @param {string} input.name     the Moshpit name being visited
 * @param {object} input.feed     what parseFeed returned
 * @param {string} input.feedUrl  where it came from
 * @param {string|null} input.kind the owner's choice of layout, if they made one
 * @param {boolean} input.stale   the origin failed and this is the last good copy
 */
export function feedPage({ name, feed, feedUrl, kind = null, stale = false }) {
  const layout = kind || feed.kind || "blog";
  const items = layout === "podcast"
    ? feed.items.map((item) => episode(item, feed)).join("")
    : feed.items.map(post).join("");

  return `<main class="feed-wrap">
  <header class="feed-head">
    ${layout === "podcast" && feed.image
      ? `<img class="feed-cover" src="${esc(feed.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : ""}
    <div class="feed-head-text">
      <p class="feed-name">${esc(name)}</p>
      <h1 class="feed-title">${esc(feed.title || name)}</h1>
      ${feed.description ? `<p class="feed-desc">${esc(feed.description)}</p>` : ""}
      ${headMeta({ feed, kind: layout, feedUrl })}
    </div>
  </header>

  ${stale ? `<p class="feed-note">The feed has not answered recently — showing the last copy that came through.</p>` : ""}

  <ul class="feed-list">${items}</ul>

  <div class="feed-foot">
    <span>${esc(name)} · served from its feed by the pit</span>
    <span><a href="/n/${encodeURIComponent(name)}?view=directory">what else is on this ending →</a> · <a href="/pit">the pit →</a></span>
  </div>
</main>`;
}

/**
 * What a name shows when its feed cannot be read.
 *
 * Not a 502 page: the name is claimed and pointed at something, so the visitor
 * is looking at a site whose contents are temporarily missing, not at a broken
 * name. The reason is named because exactly one person can act on it, and
 * "the feed answered 404" tells them which thing to go and fix.
 */
export function feedUnavailable({ name, feedUrl, error }) {
  return `<main class="feed-wrap">
  <header class="feed-head"><div class="feed-head-text">
    <p class="feed-name">${esc(name)}</p>
    <h1 class="feed-title">Nothing came back from the feed.</h1>
    <p class="feed-desc">This name publishes
      <a class="acid" href="${esc(feedUrl)}" rel="noopener nofollow ugc">its feed</a>,
      but ${esc(error || "it could not be read")}.</p>
  </div></header>
  <div class="feed-foot">
    <span>${esc(name)}</span>
    <span><a href="/n/${encodeURIComponent(name)}?view=directory">the rest of this ending →</a> · <a href="/pit">the pit →</a></span>
  </div>
</main>`;
}
