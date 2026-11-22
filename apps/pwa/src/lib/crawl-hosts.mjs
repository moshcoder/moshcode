// Which host a robots.txt / sitemap.xml request is about.
//
// One app answers on two hostnames: the pit (PIT_ORIGIN, the canonical home of
// /pit and /n/<name>) and the app (PUBLIC_ORIGIN, app.moshcode.sh). They used to
// share one robots.txt and one sitemap, both naming the pit, so the app host
// advertised another host's URLs. Now the app host describes its own public
// pages; every other host (the pit, a bare IP, a test server) keeps the pit's.

/** Public pages on the app host that answer 200 signed out. */
export const APP_PUBLIC_PATHS = ["/", "/privacy", "/terms"];

const hostOf = (origin) => {
  try { return new URL(origin).host.toLowerCase(); } catch { return ""; }
};

/**
 * True when the request reached the app's own hostname and that hostname is
 * not also the pit's.
 * @param {string | undefined} hostHeader
 * @param {{ origin: string, pitOrigin: string }} cfg
 */
export function isAppHost(hostHeader, cfg) {
  const host = String(hostHeader || "").toLowerCase();
  const appHost = hostOf(cfg.origin);
  return Boolean(host) && host === appHost && appHost !== hostOf(cfg.pitOrigin);
}

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The app host's sitemap: its signed-out pages, on its own origin. */
export function appSitemapXml(origin) {
  const base = String(origin).replace(/\/+$/, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${APP_PUBLIC_PATHS.map((p) => `  <url><loc>${xmlEscape(base + p)}</loc></url>`).join("\n")}
</urlset>
`;
}

/** The shared crawl rules, with the Sitemap line for whichever origin was asked. */
export function robotsTxt(origin) {
  return `User-agent: *
Allow: /$
Allow: /pit
Allow: /n/
Disallow: /api/
Disallow: /app
Disallow: /settings
Disallow: /sessions

Sitemap: ${String(origin).replace(/\/+$/, "")}/sitemap.xml
`;
}
