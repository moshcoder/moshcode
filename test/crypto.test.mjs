// `moshcode crypto` — argument translation, request building, and the things
// this command must never get wrong: rendering a sub-cent coin as "$0.00",
// promising a cap it does not apply, and dropping the API's disclaimer.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CRYPTO_VERB_NAMES, MAX_SYMBOLS, cryptoArgs, cryptoCommand, cryptoUrl, cryptoUsage,
  fetchCrypto, normalizeSymbol, price, renderCrypto, resolveVerb, sparkline,
} from "../src/crypto.mjs";
import { CRYPTO_VERBS } from "../src/cli-schema.mjs";

// --- the bare-pair shortcut --------------------------------------------------

test("a bare pair is the report, in every spelling the API accepts", () => {
  const expected = {
    verb: "report", symbol: "BTC-USD", path: "/api/crypto/report",
    query: { symbol: "BTC-USD" }, json: false,
  };
  assert.deepEqual(cryptoArgs(["btc-usd"]), expected);
  assert.deepEqual(cryptoArgs(["BTC/USD"]), expected);
  assert.deepEqual(cryptoArgs(["report", "btc/usd"]), expected);
});

test("a bare asset stays bare — the API resolves it, this does not guess", () => {
  // Appending -USD here would break the day a base has no USD pair.
  assert.deepEqual(cryptoArgs(["btc"]), {
    verb: "report", symbol: "BTC", path: "/api/crypto/report",
    query: { symbol: "BTC" }, json: false,
  });
});

test("no arguments prints usage rather than guessing a pair", () => {
  assert.deepEqual(cryptoArgs([]), { usage: true });
  assert.match(cryptoUsage(), /usage: moshcode crypto/);
});

test("an asset name is refused with the lookup that resolves it", () => {
  const result = cryptoArgs(["bitcoin"]);
  assert.match(result.error, /is not a crypto pair/);
  assert.match(result.error, /moshcode crypto lookup bitcoin/);
});

// --- verbs -------------------------------------------------------------------

test("every verb the schema documents is one the parser resolves", () => {
  // The schema drives help and completion; the parser drives behaviour. A verb
  // in one and not the other is a command that completes and then fails.
  assert.deepEqual(CRYPTO_VERBS.map(({ name }) => name).sort(), [...CRYPTO_VERB_NAMES].sort());
  for (const { name } of CRYPTO_VERBS) assert.equal(resolveVerb(name), name, `${name} does not resolve`);
});

test("aliases resolve, and anything else is treated as a pair", () => {
  assert.equal(resolveVerb("candles"), "bars");
  assert.equal(resolveVerb("orderbook"), "book");
  assert.equal(resolveVerb("price"), "quote");
  assert.equal(resolveVerb("search"), "lookup");
  assert.equal(resolveVerb("BTC"), null);
});

test("multi-pair verbs take a list, and stop at the documented cap", () => {
  assert.deepEqual(cryptoArgs(["snapshot", "btc", "eth-usd"]), {
    verb: "snapshot", symbols: ["BTC", "ETH-USD"], path: "/api/crypto/snapshot",
    query: { symbols: "BTC,ETH-USD" }, json: false,
  });
  assert.deepEqual(cryptoArgs(["spark", "btc", "--period", "7d"]), {
    verb: "spark", symbols: ["BTC"], path: "/api/crypto/sparklines",
    query: { symbols: "BTC", period: "7d" }, json: false,
  });
  const tooMany = cryptoArgs(["snapshot", ...Array.from({ length: MAX_SYMBOLS + 1 }, (_, i) => `AA${i}`)]);
  assert.match(tooMany.error, new RegExp(`at most ${MAX_SYMBOLS} pairs`));
});

test("a bad pair anywhere in a list is named, not silently dropped", () => {
  const result = cryptoArgs(["snapshot", "btc", "dogecoin-to-the-moon"]);
  assert.match(result.error, /"dogecoin-to-the-moon" is not a crypto pair/);
});

test("bars defaults to daily and carries its window", () => {
  assert.deepEqual(cryptoArgs(["bars", "eth", "--timeframe", "1hour", "--start", "2026-01-01"]), {
    verb: "bars", symbol: "ETH", path: "/api/crypto/bars",
    query: { symbol: "ETH", timeframe: "1Hour", start: "2026-01-01" }, limit: null, json: false,
  });
  assert.equal(cryptoArgs(["bars", "eth"]).query.timeframe, "1Day");
});

test("lookup takes words, not pairs", () => {
  assert.deepEqual(cryptoArgs(["lookup", "basic", "attention", "--limit", "3"]), {
    verb: "lookup", path: "/api/crypto/lookup", query: { q: "basic attention", limit: "3" }, json: false,
  });
});

// --- flags -------------------------------------------------------------------

test("flag values are validated before a request is ever built", () => {
  assert.match(cryptoArgs(["bars", "btc", "--timeframe", "1Fortnight"]).error, /--timeframe must be one of/);
  assert.match(cryptoArgs(["spark", "btc", "--period", "1y"]).error, /--period must be one of/);
  assert.match(cryptoArgs(["technicals", "btc", "--horizon", "9"]).error, /--horizon must be 1 or 2/);
  assert.match(cryptoArgs(["book", "btc", "--depth", "0"]).error, /--depth requires a positive number/);
  assert.match(cryptoArgs(["bars", "btc", "--limit"]).error, /--limit requires a positive number/);
  assert.match(cryptoArgs(["btc", "--nope"]).error, /unknown crypto flag/);
});

test("--json is a flag, not a pair", () => {
  assert.equal(cryptoArgs(["btc", "--json"]).json, true);
  assert.equal(cryptoArgs(["--json", "btc"]).symbol, "BTC");
});

// --- symbols -----------------------------------------------------------------

test("normalizeSymbol keeps pairs and refuses prose", () => {
  assert.equal(normalizeSymbol("btc/usd"), "BTC-USD");
  assert.equal(normalizeSymbol(" eth-usdt "), "ETH-USDT");
  assert.equal(normalizeSymbol("BTCUSD"), "BTCUSD");
  assert.equal(normalizeSymbol("bitcoin"), null);
  assert.equal(normalizeSymbol(""), null);
  assert.equal(normalizeSymbol("a"), null);
});

// --- URLs --------------------------------------------------------------------

test("query values are encoded, and open builds the shareable page", () => {
  const url = cryptoUrl(cryptoArgs(["lookup", "basic attention"]), { base: "https://example.test" });
  assert.equal(url, "https://example.test/api/crypto/lookup?q=basic+attention");
  assert.deepEqual(cryptoArgs(["open", "btc/usd"]), {
    verb: "open", symbol: "BTC-USD", open: "/crypto/BTC-USD", json: false,
  });
  assert.equal(
    cryptoUrl(cryptoArgs(["open", "btc/usd"]), { base: "https://example.test" }),
    "https://example.test/crypto/BTC-USD",
  );
});

// --- rendering ---------------------------------------------------------------

test("prices are formatted at the precision the pair trades at", () => {
  // A fixed two decimals renders half the index as "$0.00".
  assert.match(price(65082.1), /^\$65,082\.10$/);
  assert.match(price(91.458), /^\$91\.4580$/);
  assert.match(price(0.06897), /^\$0\.06897$/);
  assert.match(price(0.00000469), /^\$0\.00000469$/);
  assert.equal(price(null), "—");
});

test("a BTC-quoted pair is not priced in dollars", () => {
  assert.equal(price(0.0295, "BTC"), "0.02950 BTC");
  assert.equal(price(0.0295, "USDC"), "$0.02950", "a dollar stablecoin still reads as dollars");
});

test("a derived number is priced like the number beside it", () => {
  // $126.10 next to $65,021.84, not $126.0980.
  assert.equal(price(126.098, "USD", { like: 65021.84 }), "$126.10");
});

test("a flat series does not draw as a crash", () => {
  assert.equal(sparkline([5, 5, 5]), "▄▄▄");
  assert.equal(sparkline([]), "");
  assert.equal(sparkline([1, 2, 3]).length, 3);
});

test("the report renders the live stamp, the score and the disclaimer", () => {
  const out = renderCrypto("report", {
    symbol: "BTC/USD", slug: "BTC-USD", name: "Bitcoin", base: "BTC", quote: "USD",
    snapshot: {
      latestTrade: { price: 65082.1 },
      latestQuote: { bidPrice: 65017.605, bidSize: 0.7766, askPrice: 65064.367, askSize: 0.78609 },
      dailyBar: { open: 64891.7, high: 65156.1, low: 64758.2, close: 65084.2, volume: 0.28 },
      delayed: false, feed: "us", change: { absolute: 186.363, percent: 0.2872 },
    },
    technical: { rsi14: 55.268, sma: { 20: 64409.08 }, trend: "neutral", deathCross: true },
    technicalScore: { score: 34.33, horizonQuarters: 2 },
    fundamentals: { marketCap: 1305297819040, marketCapRank: 1, source: "coingecko" },
    caveats: ["Volume reflects Alpaca's US crypto venue alone."],
    generatedAt: "2026-08-08T16:05:27.385Z",
    disclaimer: "Research aid, not advice.",
  }, { columns: 88 });

  assert.match(out, /BTC\/USD/);
  assert.match(out, /\$65,082\.10/);
  assert.match(out, /\+0\.29%/);
  assert.match(out, /technical score 34\.3/);
  assert.match(out, /death cross/);
  assert.match(out, /cap 1\.31T/);
  assert.match(out, /fetched 2026-08-08 16:05Z/, "a live read must say when it was read");
  assert.match(out, /Volume reflects Alpaca/, "the response's caveats qualify the numbers above them");
  assert.match(out, /Research aid, not advice\./);
});

test("--limit on bars is honoured here, because upstream does not honour it", () => {
  // The API treats limit as a page size over its own window, so a renderer that
  // just printed everything would silently break the flag's promise.
  const bars = Array.from({ length: 17 }, (_, i) => ({
    timestamp: `2026-08-08T${String(i).padStart(2, "0")}:00:00Z`,
    open: 1900 + i, high: 1910 + i, low: 1890 + i, close: 1905 + i, volume: 1,
  }));
  const out = renderCrypto("bars", { timeframe: "1Hour", bars: { "ETH/USD": bars } }, { columns: 88, limit: 5 });
  assert.match(out, /5 × 1Hour · newest of 17/, "trimming must be stated, not silent");
  assert.match(out, /2026-08-08 16:00Z/, "the newest bar is kept");
  assert.doesNotMatch(out, /2026-08-08 05:00Z/, "older bars are the ones dropped");
});

test("an empty payload reads as empty rather than throwing", () => {
  assert.match(renderCrypto("assets", {}), /no pairs are listed/);
  assert.match(renderCrypto("lookup", { query: "zzz", matches: [] }), /no crypto pair matches/);
  assert.match(renderCrypto("quote", { quotes: [] }), /no quote came back/);
  assert.match(renderCrypto("bars", { bars: {} }), /no bars came back/);
  assert.match(renderCrypto("book", { orderbooks: [] }), /no order book came back/);
  assert.match(renderCrypto("spark", { series: {} }), /no series came back/);
});

// --- the command, end to end -------------------------------------------------

const jsonResponse = (data, { ok = true, status = 200 } = {}) => async () => ({
  ok, status, text: async () => JSON.stringify(data),
});

test("--json prints the API response untouched", async () => {
  const lines = [];
  const code = await cryptoCommand(["assets", "--json"], {
    out: (s) => lines.push(s),
    fail: (s) => lines.push(s),
    fetchImpl: jsonResponse({ count: 1, assets: [{ symbol: "BTC/USD", slug: "BTC-USD", quote: "USD" }] }),
    base: "https://example.test",
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(lines.join("\n")).assets[0].slug, "BTC-USD");
});

test("an unsupported pair surfaces the API's own lookup suggestion", async () => {
  const errors = [];
  const code = await cryptoCommand(["ZZZZ"], {
    out: () => {},
    fail: (s) => errors.push(s),
    fetchImpl: jsonResponse(
      { error: '"ZZZZ" is not a supported crypto pair', lookup: "/crypto/lookup?q=ZZZZ" },
      { ok: false, status: 400 },
    ),
    base: "https://example.test",
  });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /is not a supported crypto pair/);
  assert.match(errors.join("\n"), /moshcode crypto lookup ZZZZ/);
});

test("a bad argument fails before any request is made", async () => {
  let called = false;
  const code = await cryptoCommand(["bars", "btc", "--timeframe", "1Century"], {
    out: () => {},
    fail: () => {},
    fetchImpl: async () => { called = true; throw new Error("should not fetch"); },
  });
  assert.equal(code, 1);
  assert.equal(called, false);
});

test("open does not hit the network, and falls back to printing the URL", async () => {
  const lines = [];
  const code = await cryptoCommand(["open", "btc"], {
    out: (s) => lines.push(s),
    fail: (s) => lines.push(s),
    fetchImpl: async () => { throw new Error("should not fetch"); },
    base: "https://example.test",
    openUrl: () => false,
  });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /https:\/\/example\.test\/crypto\/BTC/);
});

test("a non-JSON body is reported as one, not parsed into nothing", async () => {
  const res = await fetchCrypto(cryptoArgs(["assets"]), {
    fetchImpl: async () => ({ ok: false, status: 502, text: async () => "<html>bad gateway</html>" }),
    base: "https://example.test",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /returned 502 and not JSON/);
});

test("a wedged connection times out instead of hanging forever", async () => {
  const res = await fetchCrypto(cryptoArgs(["assets"]), {
    fetchImpl: (url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
    base: "https://example.test",
    timeoutMs: 10,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /timed out after/);
});
