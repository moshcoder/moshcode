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
 * The feeds a fresh install reads.
 *
 * Every one of them is a publisher speaking for itself. Google News used to
 * carry the general desks here — one URL shape covering ten sections without
 * ten publisher relationships — and it was dropped precisely because of what
 * isDeadEndLink() documents: its items cannot be opened and carry no summary,
 * so a default list built on it is a list of rows that do nothing. The desks it
 * covered (world, science, politics) are named publishers now instead.
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
    description: "Kagi Small Web — 32k personal blogs, search it rather than subscribe",
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
