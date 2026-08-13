// Where `/news` gets its headlines when nobody has subscribed to anything yet.
//
// These are not invented: they are the sources the two profullstack properties
// that already do this in production use, lifted so the pit answers the same
// way they do.
//
//   brisk.news — apps/web/src/lib/news/fetch-feed.ts builds Google News feeds,
//     top stories for the front page and one per category, and
//     scripts/import-opml-feeds.ts seeds its publisher table from four public
//     OPML lists. The lists are represented here as named entries `/news add`
//     accepts; the Google feeds are not, for the reason isDeadEndLink() gives.
//
//   advis0r.com — src/providers/news/rss.ts pairs a Google News query feed with
//     a Bing one (Google's links are interstitials, Bing's carry the publisher
//     URL in a `url=` parameter), and reads two newswires directly. Only the
//     Bing half of that pairing survives here — see isDeadEndLink() — and the
//     wires are under `markets`.
//
// Deliberately small. A default list is a claim that every entry works, so it
// holds feeds with stable well-known URLs and defers everything else to the
// published lists, where the list is somebody else's to maintain.

import fs from "node:fs";

/**
 * Bing News query feed — the only search feed left.
 *
 * The Google News builders that used to sit here were removed rather than left
 * unused: keeping them would imply a Google News feed is still a thing this can
 * read, and isDeadEndLink() explains at length why it is not.
 */
export function bingNewsSearch(query) {
  return `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=RSS`;
}

/**
 * Resolve a redirect wrapper to the publisher URL it carries.
 *
 * Lifted from advis0r's unwrapRedirect for the same reason it exists there:
 * aggregator feeds link to themselves, and a reader that opens
 * `news.google.com/rss/articles/CBM…` shows an interstitial instead of the
 * story. Only decodes what is already in the link — it never follows a
 * redirect, so it costs no request and cannot be led somewhere unexpected.
 */
export function unwrapRedirect(url) {
  try {
    const parsed = new URL(url);
    const inner = parsed.searchParams.get("url") ?? parsed.searchParams.get("u");
    if (!inner) return url;
    const decoded = decodeURIComponent(inner);
    return /^https?:\/\//i.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

/**
 * Is this a link that can never be resolved to the article it stands for?
 *
 * Google News item links are `news.google.com/rss/articles/CBMi…?oc=5`, and
 * they are a dead end in the strict sense — this was measured, not assumed:
 *
 *   · A HEAD returns 302 whose `location` is the *same* URL with the locale
 *     appended, which then 200s on a Google page. There is no publisher URL in
 *     any header, so unwrapping by redirect does not work.
 *   · The base64 segment decodes to a protobuf holding an opaque `AU_yqL…`
 *     token and no URL.
 *   · A full GET returns a 600KB Angular shell — the redirect is client-side,
 *     and the target is not in the HTML.
 *   · That leaves Google's internal `/_/DotsSplashUi/data/batchexecute`, which
 *     answered 429 Too Many Requests on the first unauthenticated call. A
 *     reader cannot be built on an endpoint that rate-limits a single request.
 *   · Their `<description>` is an `<ol><li><a href=…>` list of more Google
 *     links rather than a summary, so there is no content to show either.
 *
 * So an item behind one of these is a headline that cannot be read and cannot
 * be opened. collectNews drops them rather than listing rows that do nothing.
 * Bing's search feed is unaffected: it carries the publisher URL in `url=` and
 * a real summary, which is why it is the one kept for searching.
 */
export function isDeadEndLink(url) {
  try {
    const parsed = new URL(String(url));
    return /(^|\.)news\.google\.com$/i.test(parsed.hostname)
      && /^\/rss\/articles\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Words a quote page's title is padded with, and the corporate suffixes that
 * are part of a company's legal name rather than part of a headline.
 *
 * Stripped before counting words, because what is left after they go is the
 * company name — and a title that is only a company name is a label on a page,
 * not a report of something that happened.
 */
const LABEL_WORDS = new RegExp(
  "\\b(common|preferred|ordinary|class [a-c]|stock|stocks|shares?|share|price|prices|"
  + "quote|quotes|chart|charts|charting|financials?|fundamentals?|overview|profile|"
  + "summary|statistics|historical|data|dividends?|earnings|holdings?|ratings?|"
  + "forecast|analysis|news|nasdaq|nyse|amex|otc|inc|incorporated|corp|corporation|"
  + "ltd|limited|plc|llc|lp|co|company|group|holdings|sa|ag|nv|the|and|of)\\b\\.?",
  "gi",
);

/**
 * The reference-page paths, host-agnostic.
 *
 * Every finance site builds the same page — one URL per ticker, showing the
 * current price and never going stale — and they nearly all spell it with one
 * of these segments. Matching the path shape rather than a list of hostnames
 * means a site nobody thought of is still recognised, and a site that changes
 * its domain does not need a code change.
 */
const QUOTE_PATH = new RegExp(
  "(^|/)(quote|quotes|symbol|symbols|tickers?|market-activity|market-data|"
  + "investing/stock|investing/stocks|markets/companies|data/equities|"
  + "stocks/charts|stock-price|price-quote)(/|$)",
  "i",
);

/**
 * Is this a standing reference page rather than a story?
 *
 * A news search for a ticker does not come back with only news. Measured on
 * `LTRN`, four of Bing's nine results were the same kind of thing: nasdaq.com's
 * insider-activity and advanced-charting tabs, marketwatch.com's financials
 * tab, and seekingalpha.com/symbol/LTRN. None of them is an article. They are
 * the permanent page a site keeps for a ticker, and they are worse than merely
 * useless in a dated list, because the date attached to them is whenever the
 * crawler last looked:
 *
 *   · Two of the four carried a 2020 date and sorted to the bottom as "75mo
 *     ago", which reads as an old story rather than as a page with no date.
 *   · marketwatch.com/investing/stock/ltrn/financials carried *yesterday's*
 *     date and sorted to the very top, so the freshest-looking headline in the
 *     list was a page that has not changed in years.
 *
 * Both signals are required, because either alone is wrong often enough to
 * matter. A quote-shaped URL is not proof — publishers file real stories under
 * `/quote/` — and a short title is not proof either, since "Lantern Pharma
 * Halts Trial" is four words and is news. Demanding both means a story has to
 * be filed at a reference URL *and* be titled like a label before it is
 * dropped, and on the LTRN sample that is exactly the four pages and none of
 * the five stories.
 *
 * Dropped rather than merely deranked, but never silently: collectNews returns
 * the count so the listing can say how many it set aside.
 */
export function isReferencePage(url, title) {
  let path;
  try { path = new URL(String(url)).pathname; }
  catch { return false; }
  if (!QUOTE_PATH.test(path)) return false;

  // The ticker in parentheses, then a bare all-caps ticker anywhere, then the
  // boilerplate. Order matters: "(LTRN)" has to go before the bare-ticker rule
  // sees it, or the parentheses are left behind as a word of their own.
  const bare = String(title ?? "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b[A-Z]{1,5}(?:\.[A-Z]{1,2})?\b/g, " ")
    .replace(LABEL_WORDS, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim();
  const words = bare ? bare.split(/\s+/).length : 0;
  return words <= 3;
}

/** The vendored copy of what profullstack.com/feeds.opml serves. */
const PROFULLSTACK_OPML = new URL("./profullstack-feeds.opml", import.meta.url);

/** slugify() from news.mjs, kept in step by a test rather than imported. */
function slug(label) {
  return String(label ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/**
 * The profullstack blogs, read from the vendored OPML rather than typed out.
 *
 * Read synchronously and at module load because defaultFeeds() is synchronous —
 * a fresh install must not wait on a network call, or on a promise, to show
 * anything at all. The file ships with the package (`files` includes `src`), so
 * it is there in both the npm and the install.sh channel.
 *
 * Parsed here with a small matcher instead of news.mjs's parseOpml, because
 * news.mjs imports this module and taking the import back the other way makes a
 * cycle. The matcher can afford to be small: this is our own file, flat, and a
 * test asserts the two agree on every feed it contains.
 *
 * A missing or unreadable file degrades to no profullstack defaults rather than
 * throwing, which would take `/news` down entirely over a packaging mistake.
 */
function profullstackFeeds() {
  let xml;
  try { xml = fs.readFileSync(PROFULLSTACK_OPML, "utf8"); }
  catch { return []; }

  const feeds = [];
  const seen = new Set();
  for (const tag of xml.match(/<outline\b[^>]*>/gi) ?? []) {
    const attr = (name) => (new RegExp(`\\b${name}="([^"]*)"`, "i").exec(tag) ?? [])[1] ?? "";
    const url = attr("xmlUrl");
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const title = attr("title") || attr("text") || url;
    feeds.push({ name: slug(title), title, url, site: attr("htmlUrl"), category: "profullstack" });
  }
  return feeds;
}

/**
 * The feeds a fresh install reads.
 *
 * Every one of them is a publisher speaking for itself. Google News used to
 * carry the general desks here — one URL shape covering ten sections without
 * ten publisher relationships — and it was dropped precisely because of what
 * isDeadEndLink() documents: its items cannot be opened and carry no summary,
 * so a default list built on it is a list of rows that do nothing. The desks it
 * covered (world, science, politics) are named publishers now instead.
 *
 * The profullstack blogs are here too, so `profullstack.com/feeds.opml` is read
 * out of the box rather than only after `/news add profullstack`.
 */
export const DEFAULT_FEEDS = [
  { name: "ars-technica", title: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", site: "https://arstechnica.com", category: "tech" },
  { name: "techcrunch", title: "TechCrunch", url: "https://techcrunch.com/feed/", site: "https://techcrunch.com", category: "tech" },
  { name: "the-register", title: "The Register", url: "https://www.theregister.com/headlines.atom", site: "https://www.theregister.com", category: "tech" },
  { name: "hacker-news", title: "Hacker News — Front Page", url: "https://hnrss.org/frontpage", site: "https://news.ycombinator.com", category: "tech" },

  { name: "marketwatch", title: "MarketWatch — Top Stories", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", site: "https://www.marketwatch.com", category: "markets" },
  // The two newswires advis0r reads directly. Tier 0 there: issuers speaking
  // for themselves rather than a publication speaking about them.
  { name: "pr-newswire", title: "PR Newswire — Financial Services", url: "https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss", site: "https://www.prnewswire.com", category: "markets" },
  { name: "globenewswire", title: "GlobeNewswire — Public Companies", url: "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies", site: "https://www.globenewswire.com", category: "markets" },

  { name: "npr-world", title: "NPR — World", url: "https://feeds.npr.org/1004/rss.xml", site: "https://www.npr.org", category: "world" },
  { name: "bbc-world", title: "BBC News — World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", site: "https://www.bbc.co.uk/news", category: "world" },
  { name: "guardian-world", title: "The Guardian — World", url: "https://www.theguardian.com/world/rss", site: "https://www.theguardian.com", category: "world" },

  { name: "science-daily", title: "ScienceDaily — Top Science", url: "https://www.sciencedaily.com/rss/top/science.xml", site: "https://www.sciencedaily.com", category: "science" },
  { name: "phys-org", title: "Phys.org", url: "https://phys.org/rss-feed/", site: "https://phys.org", category: "science" },

  { name: "npr-politics", title: "NPR — Politics", url: "https://feeds.npr.org/1014/rss.xml", site: "https://www.npr.org", category: "politics" },

  // The profullstack blogs, read out of the box. Not typed out here: they are
  // parsed from src/profullstack-feeds.opml, which is a copy of what
  // profullstack.com/feeds.opml actually serves. Two hand-maintained lists of
  // the same fourteen blogs is one more than can be kept in step, and the copy
  // that would go stale is this one — nobody editing the published OPML has a
  // reason to think about moshcode. Refresh it with:
  //
  //   curl -sL https://profullstack.com/feeds.opml -o src/profullstack-feeds.opml
  //
  // test/profullstack-feeds.test.mjs checks that against the live file when
  // MOSHCODE_CHECK_FEED_DRIFT=1 is set.
  ...profullstackFeeds(),
];

/**
 * The public feed lists, offered by name.
 *
 * Offered by name (`/news add journalists`) rather than only by URL because
 * these are long, exact raw.githubusercontent paths that nobody is going to
 * retype, and importing one is the fastest way from an empty reader to a real
 * one. They are somebody else's lists, and that is the point: the feeds inside
 * them stay current without moshcode shipping a release.
 *
 * Two shapes, because the lists worth reading come in two:
 *
 *   `format: "opml"` — an OPML document, parsed by parseOpml.
 *   `format: "text"` — one feed URL per line, `#` comments ignored. Kagi's
 *     smallweb list is published this way and there is no OPML of it.
 *
 * `searchOnly` marks a list too large to subscribe to wholesale. smallweb is
 * 32,000+ feeds: importing it would write a 32,000-entry news.opml and then try
 * to fetch every one of them on the next `/news`. It is a catalogue to search,
 * not a subscription — `/rss search <keyword>` is how you get feeds out of it.
 */
export const FEED_LISTS = [
  {
    name: "journalists",
    description: "Dave Winer's feedsForJournalists — mainstream desks",
    url: "https://raw.githubusercontent.com/scripting/feedsForJournalists/master/list.opml",
    format: "opml",
  },
  {
    name: "web3",
    description: "ChainFeeds RSSAggregatorforWeb3 — crypto and web3",
    url: "https://raw.githubusercontent.com/chainfeeds/RSSAggregatorforWeb3/main/RAW.opml",
    format: "opml",
  },
  {
    name: "blockchain",
    description: "CoinFabrik decentralized-and-blockchain-feeds",
    url: "https://raw.githubusercontent.com/CoinFabrik/resources/master/decentralized-and-blockchain-feeds.opml",
    format: "opml",
  },
  {
    name: "profullstack",
    description: "Profullstack product blogs",
    url: "https://profullstack.com/feeds.opml",
    format: "opml",
  },
  {
    name: "smallweb",
    description: "Kagi Small Web — 33k personal blogs, with titles",
    url: "https://kagi.com/smallweb/opml",
    format: "opml",
    searchOnly: true,
  },
  {
    name: "smallweb-txt",
    description: "Kagi Small Web, profullstack's fork — the plain-text list",
    url: "https://raw.githubusercontent.com/ralyodio/smallweb/refs/heads/main/smallweb.txt",
    format: "text",
    searchOnly: true,
  },
];

/**
 * The old name for the list catalogue.
 *
 * Kept because `/news sources --json` published it and a caller may be reading
 * that key; the shape is unchanged for the three lists that were in it.
 */
export const OPML_BUNDLES = FEED_LISTS;

/** Resolve a list name to its entry, or null. */
export function resolveList(name) {
  const wanted = String(name ?? "").trim().toLowerCase();
  return FEED_LISTS.find((b) => b.name === wanted) ?? null;
}

/** The former name of resolveList. */
export const resolveBundle = resolveList;

/** The lists `/news add <name>` will import in full. */
export function subscribableLists() {
  return FEED_LISTS.filter((list) => !list.searchOnly);
}

/** A fresh copy of the defaults — callers mutate feed lists. */
export function defaultFeeds() {
  return DEFAULT_FEEDS.map((feed) => ({ ...feed }));
}
