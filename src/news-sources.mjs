// Where `/news` gets its headlines when nobody has subscribed to anything yet.
//
// These are not invented: they are the sources the two profullstack properties
// that already do this in production use, lifted so the pit answers the same
// way they do.
//
//   brisk.news — apps/web/src/lib/news/fetch-feed.ts builds Google News feeds,
//     top stories for the front page and one per category, and
//     scripts/import-opml-feeds.ts seeds its publisher table from four public
//     OPML lists. Both are represented here: the Google feeds as the defaults,
//     the OPML lists as named bundles `/news add` accepts by name.
//
//   advis0r.com — src/providers/news/rss.ts pairs a Google News query feed with
//     a Bing one (Google's links are interstitials, Bing's carry the publisher
//     URL in a `url=` parameter), and reads two newswires directly. The search
//     pairing is why `/news <keyword>` queries both, and the wires are here
//     under `markets`.
//
// Deliberately small. A default list is a claim that every entry works, so it
// holds feeds with stable well-known URLs and defers everything else to the
// OPML bundles, where the list is somebody else's to maintain.

/** Google News locale. One place, because every builder below needs it. */
const GOOGLE_LOCALE = "hl=en-US&gl=US&ceid=US:en";

/**
 * Google News category feeds, keyed the way brisk.news keys them.
 *
 * `general` is null there and means "top stories", which is a different URL
 * rather than a search for the word "general" — the same distinction is kept.
 */
export const GOOGLE_NEWS_CATEGORIES = {
  general: null,
  science: "science",
  sports: "sports",
  business: "business",
  health: "health",
  entertainment: "entertainment",
  tech: "technology",
  politics: "politics",
  food: "food",
  travel: "travel",
};

/** Google News top stories, or one category from the map above. */
export function googleNewsFeed(category = null) {
  const mapped = category ? GOOGLE_NEWS_CATEGORIES[category] ?? null : null;
  if (!mapped) return `https://news.google.com/rss?${GOOGLE_LOCALE}`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(mapped)}&${GOOGLE_LOCALE}`;
}

/**
 * Google News query feed. `when:7d` style windows keep results recent —
 * advis0r's googleNewsFeed() does the same, for the same reason.
 */
export function googleNewsSearch(query, { window = "7d" } = {}) {
  const q = window ? `${query} when:${window}` : String(query);
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${GOOGLE_LOCALE}`;
}

/** Bing News query feed — the half of a search whose links are real articles. */
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
 * The feeds a fresh install reads.
 *
 * Google News carries the general desks because that is exactly what brisk.news
 * serves its front page from, and it means one URL shape covers ten sections
 * without ten publisher relationships to keep working. The named publishers are
 * tier-1 hosts from advis0r's own tiering table that publish a stable feed, and
 * they earn their place by being readable end to end — a Google News item is a
 * headline behind an interstitial, theirs is the article.
 */
export const DEFAULT_FEEDS = [
  { name: "top-stories", title: "Google News — Top Stories", url: googleNewsFeed(), site: "https://news.google.com", category: "" },
  { name: "world", title: "Google News — World", url: googleNewsSearch("world news", { window: "2d" }), site: "https://news.google.com", category: "" },

  { name: "tech", title: "Google News — Technology", url: googleNewsFeed("tech"), site: "https://news.google.com", category: "tech" },
  { name: "ars-technica", title: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", site: "https://arstechnica.com", category: "tech" },
  { name: "techcrunch", title: "TechCrunch", url: "https://techcrunch.com/feed/", site: "https://techcrunch.com", category: "tech" },
  { name: "the-register", title: "The Register", url: "https://www.theregister.com/headlines.atom", site: "https://www.theregister.com", category: "tech" },
  { name: "hacker-news", title: "Hacker News — Front Page", url: "https://hnrss.org/frontpage", site: "https://news.ycombinator.com", category: "tech" },

  { name: "business", title: "Google News — Business", url: googleNewsFeed("business"), site: "https://news.google.com", category: "markets" },
  { name: "marketwatch", title: "MarketWatch — Top Stories", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", site: "https://www.marketwatch.com", category: "markets" },
  // The two newswires advis0r reads directly. Tier 0 there: issuers speaking
  // for themselves rather than a publication speaking about them.
  { name: "pr-newswire", title: "PR Newswire — Financial Services", url: "https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss", site: "https://www.prnewswire.com", category: "markets" },
  { name: "globenewswire", title: "GlobeNewswire — Public Companies", url: "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies", site: "https://www.globenewswire.com", category: "markets" },

  { name: "science", title: "Google News — Science", url: googleNewsFeed("science"), site: "https://news.google.com", category: "science" },
  { name: "politics", title: "Google News — Politics", url: googleNewsFeed("politics"), site: "https://news.google.com", category: "politics" },
];

/**
 * The public OPML lists brisk.news imports its publisher table from.
 *
 * Offered by name (`/news add journalists`) rather than only by URL because
 * these are long, exact raw.githubusercontent paths that nobody is going to
 * retype, and importing one is the fastest way from an empty reader to a real
 * one. They are somebody else's lists, and that is the point: the feeds inside
 * them stay current without moshcode shipping a release.
 */
export const OPML_BUNDLES = [
  {
    name: "journalists",
    description: "Dave Winer's feedsForJournalists — mainstream desks",
    url: "https://raw.githubusercontent.com/scripting/feedsForJournalists/master/list.opml",
  },
  {
    name: "web3",
    description: "ChainFeeds RSSAggregatorforWeb3 — crypto and web3",
    url: "https://raw.githubusercontent.com/chainfeeds/RSSAggregatorforWeb3/main/RAW.opml",
  },
  {
    name: "blockchain",
    description: "CoinFabrik decentralized-and-blockchain-feeds",
    url: "https://raw.githubusercontent.com/CoinFabrik/resources/master/decentralized-and-blockchain-feeds.opml",
  },
];

/** Resolve a bundle name to its OPML URL, or null. */
export function resolveBundle(name) {
  const wanted = String(name ?? "").trim().toLowerCase();
  return OPML_BUNDLES.find((b) => b.name === wanted) ?? null;
}

/** A fresh copy of the defaults — callers mutate feed lists. */
export function defaultFeeds() {
  return DEFAULT_FEEDS.map((feed) => ({ ...feed }));
}
