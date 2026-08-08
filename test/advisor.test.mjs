// `moshcode ticker` — argument translation, request building, and the two
// things this command must never get wrong: presenting a stored snapshot as a
// live quote, and dropping the API's disclaimer.
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ADVISOR_URL, TICKER_VERB_NAMES, advisorBase, advisorUrl, fetchAdvisor,
  normalizeSymbol, renderAdvisor, resolveVerb, tickerArgs, tickerCommand, tickerUsage,
} from "../src/advisor.mjs";
import { TICKER_VERBS } from "../src/cli-schema.mjs";

// --- the bare-symbol shortcut ------------------------------------------------

test("a bare symbol is the report, and is upper-cased on the way out", () => {
  assert.deepEqual(tickerArgs(["nvda"]), {
    verb: "report", symbol: "NVDA", path: "/api/ticker", query: { symbol: "NVDA" }, json: false,
  });
  assert.deepEqual(tickerArgs(["report", "brk.b"]), {
    verb: "report", symbol: "BRK.B", path: "/api/ticker", query: { symbol: "BRK.B" }, json: false,
  });
});

test("no arguments prints usage rather than guessing a symbol", () => {
  assert.deepEqual(tickerArgs([]), { usage: true });
  assert.match(tickerUsage(), /usage: moshcode ticker/);
});

test("a company name is refused with the lookup that resolves it", () => {
  const result = tickerArgs(["some very long company name"]);
  assert.match(result.error, /is not a ticker symbol/);
  assert.match(result.error, /moshcode ticker lookup/);
});

// --- verbs -------------------------------------------------------------------

test("every verb the schema documents is one the parser resolves", () => {
  // The schema drives help and completion; the parser drives behaviour. A verb
  // in one and not the other is a command that completes and then fails.
  assert.deepEqual(TICKER_VERBS.map(({ name }) => name).sort(), [...TICKER_VERB_NAMES].sort());
  for (const { name } of TICKER_VERBS) assert.equal(resolveVerb(name), name, `${name} does not resolve`);
});

test("aliases resolve, and anything else is treated as a symbol", () => {
  assert.equal(resolveVerb("news"), "signals");
  assert.equal(resolveVerb("watchlist"), "discover");
  assert.equal(resolveVerb("quote"), "report");
  assert.equal(resolveVerb("NVDA"), null);
});

test("search and lookup take words, not symbols", () => {
  assert.deepEqual(tickerArgs(["search", "data", "center", "--limit", "5"]), {
    verb: "search", path: "/api/search", query: { q: "data center", limit: "5" }, json: false,
  });
  assert.deepEqual(tickerArgs(["lookup", "rivian"]), {
    verb: "lookup", path: "/api/lookup", query: { q: "rivian" }, json: false,
  });
});

test("reports defaults to score order and discover to the offline provider", () => {
  assert.deepEqual(tickerArgs(["reports"]).query, { sort: "score" });
  assert.deepEqual(tickerArgs(["reports", "--sort", "recent"]).query, { sort: "recent" });
  assert.deepEqual(tickerArgs(["discover", "fusion"]).query, {
    topic: "fusion", provider: "offline", horizon: "2",
  });
});

test("discover is marked slow, because it analyzes every candidate", () => {
  // The flag is what buys it the longer timeout in fetchAdvisor. Without it the
  // route reliably aborts mid-ranking and looks like an outage.
  assert.equal(tickerArgs(["discover"]).slow, true);
  assert.equal(tickerArgs(["reports"]).slow, undefined);
});

// --- flags -------------------------------------------------------------------

test("flag values are validated rather than forwarded", () => {
  assert.match(tickerArgs(["reports", "--limit", "0"]).error, /positive number/);
  assert.match(tickerArgs(["reports", "--limit"]).error, /positive number/);
  assert.match(tickerArgs(["reports", "--sort", "sideways"]).error, /recent, score, ticker/);
  assert.match(tickerArgs(["discover", "--horizon", "9"]).error, /must be 1 or 2/);
});

test("an unknown flag is an error, not a search term", () => {
  // Left alone it would join `q` and be searched for verbatim, which returns
  // nothing and reads as "the index has no coverage".
  assert.match(tickerArgs(["search", "--depth", "3"]).error, /unknown ticker flag/);
});

test("--json survives anywhere in the argument list", () => {
  assert.equal(tickerArgs(["--json", "nvda"]).json, true);
  assert.equal(tickerArgs(["nvda", "--json"]).json, true);
});

// --- symbols -----------------------------------------------------------------

test("normalizeSymbol accepts tickers and refuses prose", () => {
  assert.equal(normalizeSymbol("aapl"), "AAPL");
  assert.equal(normalizeSymbol(" brk.b "), "BRK.B");
  assert.equal(normalizeSymbol("rivian automotive"), null);
  assert.equal(normalizeSymbol(""), null);
});

// --- URLs --------------------------------------------------------------------

test("the base URL is overridable, so a local instance is testable", () => {
  assert.equal(advisorBase({}), DEFAULT_ADVISOR_URL);
  assert.equal(advisorBase({ MOSHCODE_ADVISOR_URL: "http://localhost:8080/" }), "http://localhost:8080");
});

test("query values are encoded, not concatenated", () => {
  const url = advisorUrl(tickerArgs(["search", "data center & more"]), { base: "https://example.test" });
  assert.equal(url, "https://example.test/api/search?q=data+center+%26+more");
});

test("open builds the shareable page URL and makes no request", () => {
  const request = tickerArgs(["open", "nvda"]);
  assert.equal(request.path, undefined);
  assert.equal(advisorUrl(request, { base: "https://example.test" }), "https://example.test/ticker/NVDA");
});

// --- fetching ----------------------------------------------------------------

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok, status, text: async () => JSON.stringify(body),
});

test("a non-JSON body is a failure, not a silent empty render", () => {
  return fetchAdvisor(tickerArgs(["stats"]), {
    fetchImpl: async () => ({ ok: false, status: 502, text: async () => "<html>bad gateway" }),
  }).then((res) => {
    assert.equal(res.ok, false);
    assert.match(res.error, /502/);
  });
});

test("a transport failure is reported, never thrown at the caller", async () => {
  const res = await fetchAdvisor(tickerArgs(["stats"]), {
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /ECONNREFUSED/);
});

// --- rendering ---------------------------------------------------------------

const REPORT = {
  ticker: "NVDA", companyName: "NVIDIA CORP", exchange: "NASDAQ",
  lastPrice: 207.23, priceTimestamp: "2026-08-03T19:59:58Z", delayed: true, marketSource: "iex",
  overallScore: 64.61, confidence: 77.5, classification: "conservative",
  technical: { rsi14: 53.37, sma: { 50: 205.78, 200: 193.05 }, atr14: 7.64, relativeVolume: 0.47 },
  facts: { source: "sec", marketCap: 5.01e12, revenue: 2.69e10, revenueGrowth: 61.4 },
  analysis: { thesis: "offline thesis" },
  signals: [{ signal_type: "commercial_launch", direction: "positive", quote: "a quote", event_date: "2026-05-20" }],
  sources: [{ url: "https://example.test/a", title: "A source", publishedAt: "2026-07-24" }],
  cached: true, reportGeneratedAt: "2026-08-03T16:25:48.040Z",
  disclaimer: "Research aid, not advice.",
};

test("a report states when the snapshot was generated", () => {
  // The one rule this surface cannot break: a stored price rendered as a live
  // quote. `delayed`, the feed, and the generated-at stamp all have to survive.
  const out = renderAdvisor("report", REPORT, { columns: 88 });
  assert.match(out, /2026-08-03T16:25:48\.040Z/, "the generated-at stamp is missing");
  assert.match(out, /delayed/, "the delayed marker is missing");
  assert.match(out, /cached/);
});

test("a report carries the API's own disclaimer", () => {
  assert.match(renderAdvisor("report", REPORT, { columns: 88 }), /Research aid, not advice/);
});

test("an offline thesis is labelled offline, and a model thesis names the model", () => {
  assert.match(renderAdvisor("report", REPORT, { columns: 88 }), /thesis \(offline\)/);
  const withAi = { ...REPORT, aiAnalysis: { provider: "anthropic", model: "claude-sonnet-5", analysis: { thesis: "model thesis" } } };
  const out = renderAdvisor("report", withAi, { columns: 88 });
  assert.match(out, /thesis \(anthropic\/claude-sonnet-5\)/);
  assert.match(out, /model thesis/);
});

test("a report missing its optional sections still renders", () => {
  // Every one of these is genuinely absent in live responses when SEC or the
  // market feed rate-limits, and a throw here would mean no report at all.
  const bare = { ticker: "AAA", lastPrice: null, disclaimer: "d" };
  assert.match(renderAdvisor("report", bare, { columns: 88 }), /AAA/);
});

test("fundamentals just under a magnitude boundary carry to the next unit", () => {
  // 999,999,999 rounds to 1000.00 of a million; it must read "1B", not "1000M".
  const near = {
    ticker: "AAA", lastPrice: null, disclaimer: "d",
    facts: { source: "sec", marketCap: 999999999, revenue: 999999, freeCashFlow: 999999999999 },
  };
  const out = renderAdvisor("report", near, { columns: 88 });
  assert.match(out, /cap 1B\b/);
  assert.match(out, /rev 1M\b/);
  assert.match(out, /fcf 1T\b/);
  assert.doesNotMatch(out, /1000M|1000K|1000B/);
});

test("empty result sets say so instead of rendering an empty table", () => {
  assert.match(renderAdvisor("signals", { ticker: "AAA", signals: [] }), /no signals indexed/);
  assert.match(renderAdvisor("search", { query: "zzz", results: [] }), /nothing indexed matches/);
  assert.match(renderAdvisor("lookup", { query: "zzz", matches: [] }), /no ticker matches/);
  assert.match(renderAdvisor("reports", { reports: [] }), /no stored reports/);
});

// --- the command end to end --------------------------------------------------

function capture() {
  const lines = [];
  return { lines, out: (s) => lines.push(s), fail: (s) => lines.push(s) };
}

test("--json prints the response verbatim and renders nothing", async () => {
  const io = capture();
  const code = await tickerCommand(["stats", "--json"], {
    ...io, fetchImpl: async () => jsonResponse({ documents: 3 }),
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(io.lines.join("\n")), { documents: 3 });
});

test("the API's own error is surfaced, with its did-you-mean", async () => {
  const io = capture();
  const code = await tickerCommand(["RIVIAN"], {
    ...io,
    fetchImpl: async () => jsonResponse(
      { error: '"RIVIAN" is not a ticker — did you mean RIVN?', didYouMean: { symbol: "RIVN", name: "Rivian" } },
      { ok: false, status: 400 },
    ),
  });
  assert.equal(code, 1, "a failed lookup must not exit 0");
  const output = io.lines.join("\n");
  assert.match(output, /did you mean RIVN/);
  assert.match(output, /moshcode ticker RIVN/);
});

test("a bad argument exits non-zero without touching the network", async () => {
  const io = capture();
  let called = false;
  const code = await tickerCommand(["reports", "--sort", "sideways"], {
    ...io, fetchImpl: async () => { called = true; return jsonResponse({}); },
  });
  assert.equal(code, 1);
  assert.equal(called, false, "a rejected argument still made a request");
});

test("open never makes a request, and prints the URL when no browser opens", async () => {
  const io = capture();
  let called = false;
  const code = await tickerCommand(["open", "nvda"], {
    ...io,
    base: "https://example.test",
    openUrl: () => false,
    fetchImpl: async () => { called = true; return jsonResponse({}); },
  });
  assert.equal(code, 0);
  assert.equal(called, false);
  assert.match(io.lines.join("\n"), /https:\/\/example\.test\/ticker\/NVDA/);
});
