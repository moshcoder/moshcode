// app.moshcode.sh served pit.moshcode.sh's sitemap and robots Sitemap line, so the
// app host advertised another host's URLs. These pin the host split.
import assert from "node:assert/strict";
import test from "node:test";

import { appSitemapXml, isAppHost, robotsTxt } from "../src/lib/crawl-hosts.mjs";

const cfg = { origin: "https://app.example.test", pitOrigin: "https://pit.example.test" };

test("only the app's own hostname counts as the app host", () => {
  assert.equal(isAppHost("app.example.test", cfg), true);
  assert.equal(isAppHost("APP.example.test", cfg), true);
  assert.equal(isAppHost("pit.example.test", cfg), false);
  assert.equal(isAppHost("127.0.0.1:3000", cfg), false);
  assert.equal(isAppHost(undefined, cfg), false);
  // One host for both: that host is the pit.
  assert.equal(isAppHost("app.example.test", { origin: cfg.origin, pitOrigin: cfg.origin }), false);
});

test("the app sitemap lists its signed-out pages on its own origin only", () => {
  const xml = appSitemapXml(cfg.origin);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, ["https://app.example.test/", "https://app.example.test/privacy", "https://app.example.test/terms"]);
});

test("robots keeps the rules and names the asked origin's sitemap", () => {
  const txt = robotsTxt(cfg.origin);
  assert.match(txt, /^Sitemap: https:\/\/app\.example\.test\/sitemap\.xml$/m);
  assert.match(txt, /^Disallow: \/api\/$/m);
  assert.doesNotMatch(txt, /Disallow: \/sitemap/);
});
