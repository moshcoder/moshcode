// `moshcode crypto` — crypto market data from advis0r.com, in the pit.
//
// The same split as src/advisor.mjs, for the same reasons: argument translation
// is pure and testable, the network call is injectable, and rendering is a
// function of the decoded JSON. Every route is public and read-only, so there
// is no login verb and no write verb — `moshcode trade` is where orders live.
//
// This is a *sibling* of `stocks`, not a mode of it, because the two answer
// different questions from different data. A stocks report is a stored snapshot
// built from transcripts, SEC fundamentals and extracted signals. A crypto
// report is a live read of Alpaca's US crypto venue: no transcripts, no
// filings, no signals, and a `fetchedAt` measured in seconds rather than days.
// Rendering them through one code path would mean one set of labels lying about
// one of them.
import { advisorBase } from "./advisor.mjs";
import { acid, ash, amber, bone, clip, danger, dim, sparkline } from "./ui.mjs";

// `spark` is this module's own command, so the renderer keeps its name in the
// public surface even though the drawing now lives in ui.mjs with the rest of
// the layout primitives.
export { sparkline };

const USAGE = `usage: moshcode crypto <pair|verb> [args…]

  <pair>                         the full report for one pair (BTC, BTC-USD, BTC/USD)
  report <pair>                  same thing, when a pair looks like a verb
  quote <pair>                   latest trade and quote, with the bid/ask spread
  snapshot <pair…>               trade, quote and daily bars for up to 20 pairs
  technicals <pair>              SMA/EMA/RSI/MACD/Bollinger/ATR + technical score
  bars <pair>                    historical OHLCV
  book <pair>                    top of the order book, both sides
  spark <pair…>                  recent closes, drawn as sparklines
  assets                         every supported pair
  lookup <name…>                 find a pair by asset name (bitcoin → BTC/USD)
  open <pair>                    open the shareable page in a browser

  --json                         print the raw API response
  --timeframe <tf>               bars: 1Min | 5Min | 15Min | 1Hour | 1Day | 1Week
  --start <iso> / --end <iso>    bars: the window to cover
  --limit <n>                    cap results (bars/lookup)
  --depth <n>                    book: levels per side (default 10)
  --period <p>                   spark: 24h | 7d
  --horizon <1|2>                technicals: quarters the score looks ahead

Research aid, not advice. Crypto trades 24/7 with no circuit breakers, and
these prices are Alpaca's US venue alone — they can differ materially from
other exchanges.`;

export function cryptoUsage() {
  return USAGE;
}

/** Verb names, in help order. cli-schema's CRYPTO_VERBS must match (drift test). */
export const CRYPTO_VERB_NAMES = [
  "report", "quote", "snapshot", "technicals", "bars", "book", "spark", "assets", "lookup", "open",
];

// The same reasoning as stocks's alias table: `/crypto price BTC` and
// `/crypto candles BTC` should not be errors when the intent is obvious.
// `search` maps to lookup rather than erroring — crypto has no transcript
// index to search, and a directory lookup is what the word means here.
const VERB_ALIASES = {
  detail: "report", pair: "report", info: "report",
  price: "quote", last: "quote", latest: "quote",
  snap: "snapshot", snapshots: "snapshot",
  technical: "technicals", ta: "technicals", indicators: "technicals",
  ohlc: "bars", ohlcv: "bars", candles: "bars", history: "bars",
  orderbook: "book", depth: "book", l2: "book",
  sparkline: "spark", sparklines: "spark", chart: "spark", trend: "spark",
  pairs: "assets", markets: "assets", symbols: "assets", list: "assets",
  find: "lookup", search: "lookup", name: "lookup", coin: "lookup",
  browse: "open", www: "open", web: "open",
};

/** Resolve a first argument to a canonical verb, or null when it is a pair. */
export function resolveVerb(word) {
  const key = String(word ?? "").toLowerCase();
  if (CRYPTO_VERB_NAMES.includes(key)) return key;
  return VERB_ALIASES[key] ?? null;
}

/**
 * A crypto pair in the URL-safe form the API documents for paths, or null.
 *
 * The API accepts four spellings (BTC/USD, BTC-USD, BTC, BTCUSD); everything
 * here is normalized to the dashed one so a request built from `BTC/USD` and
 * one built from `btc-usd` are the same request. A bare asset is left bare —
 * the API resolves it to that asset's USD pair, and inventing the `-USD` here
 * would silently break the day a base has no USD pair.
 *
 * Deliberately narrow, like stocks's: the whole job of the check is to tell
 * `BTC` from `bitcoin` and send the second one to lookup with a useful message
 * instead of a 400. Bases run to five characters (SUSHI, MATIC, TRUMP), so six
 * leaves room for the concatenated `BTCUSD` spelling without swallowing words.
 */
export function normalizeSymbol(input) {
  const raw = String(input ?? "").trim().toUpperCase().replace(/\//g, "-");
  if (/^[A-Z0-9]{2,6}$/.test(raw)) return raw;
  return /^[A-Z0-9]{2,6}-[A-Z0-9]{2,5}$/.test(raw) ? raw : null;
}

function takeFlag(args, name, { boolean = false } = {}) {
  const out = { value: null, rest: [], missing: false, present: false };
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === name) {
      out.present = true;
      if (boolean) continue;
      const next = args[i + 1];
      if (next == null || String(next).startsWith("-")) out.missing = true;
      else { out.value = String(next); i++; }
      continue;
    }
    if (!boolean && arg.startsWith(`${name}=`)) {
      out.present = true;
      const value = arg.slice(name.length + 1);
      if (value === "") out.missing = true; else out.value = value;
      continue;
    }
    out.rest.push(arg);
  }
  return out;
}

function positiveInt(value, { max }) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, max);
}

const TIMEFRAMES = ["1Min", "5Min", "15Min", "1Hour", "1Day", "1Week"];
const PERIODS = ["24h", "7d"];

/** The documented cap on multi-symbol routes. Exceeding it is a 400, not a truncation. */
export const MAX_SYMBOLS = 20;

function canonicalTimeframe(value) {
  const key = String(value).toLowerCase();
  return TIMEFRAMES.find((tf) => tf.toLowerCase() === key) ?? null;
}

/** Normalize a list of pair arguments, reporting the first one that is not a pair. */
function symbolList(words, verb) {
  if (!words.length) return { error: `crypto ${verb} requires at least one pair` };
  const symbols = [];
  for (const word of words) {
    const symbol = normalizeSymbol(word);
    if (!symbol) {
      return { error: `${JSON.stringify(String(word))} is not a crypto pair — try: moshcode crypto lookup ${String(word)}` };
    }
    symbols.push(symbol);
  }
  if (symbols.length > MAX_SYMBOLS) {
    return { error: `crypto ${verb} accepts at most ${MAX_SYMBOLS} pairs (got ${symbols.length})` };
  }
  return { symbols };
}

/**
 * Translate `crypto` arguments into a request the caller can execute.
 *
 * Returns one of `{ usage }`, `{ error }`, or
 * `{ verb, path, query, json, open? }` — never performs IO, so the whole
 * argument surface is testable without a network.
 */
export function cryptoArgs(input = []) {
  const args = input.map(String);
  const jsonFlag = takeFlag(args, "--json", { boolean: true });
  let rest = jsonFlag.rest;
  const json = jsonFlag.present;

  const limitFlag = takeFlag(rest, "--limit"); rest = limitFlag.rest;
  const timeframeFlag = takeFlag(rest, "--timeframe"); rest = timeframeFlag.rest;
  const startFlag = takeFlag(rest, "--start"); rest = startFlag.rest;
  const endFlag = takeFlag(rest, "--end"); rest = endFlag.rest;
  const depthFlag = takeFlag(rest, "--depth"); rest = depthFlag.rest;
  const periodFlag = takeFlag(rest, "--period"); rest = periodFlag.rest;
  const horizonFlag = takeFlag(rest, "--horizon"); rest = horizonFlag.rest;

  if (limitFlag.missing) return { error: "crypto --limit requires a positive number" };
  if (timeframeFlag.missing) return { error: `crypto --timeframe requires one of ${TIMEFRAMES.join(", ")}` };
  if (startFlag.missing) return { error: "crypto --start requires a date or timestamp" };
  if (endFlag.missing) return { error: "crypto --end requires a date or timestamp" };
  if (depthFlag.missing) return { error: "crypto --depth requires a positive number" };
  if (periodFlag.missing) return { error: `crypto --period requires one of ${PERIODS.join(", ")}` };
  if (horizonFlag.missing) return { error: "crypto --horizon requires 1 or 2" };

  const limit = limitFlag.value == null ? null : positiveInt(limitFlag.value, { max: 1000 });
  if (limitFlag.value != null && limit == null) {
    return { error: "crypto --limit requires a positive number" };
  }
  const depth = depthFlag.value == null ? null : positiveInt(depthFlag.value, { max: 50 });
  if (depthFlag.value != null && depth == null) {
    return { error: "crypto --depth requires a positive number" };
  }
  const timeframe = timeframeFlag.value == null ? null : canonicalTimeframe(timeframeFlag.value);
  if (timeframeFlag.value != null && timeframe == null) {
    return { error: `crypto --timeframe must be one of ${TIMEFRAMES.join(", ")}` };
  }
  const period = periodFlag.value == null ? null : String(periodFlag.value).toLowerCase();
  if (period != null && !PERIODS.includes(period)) {
    return { error: `crypto --period must be one of ${PERIODS.join(", ")}` };
  }
  if (horizonFlag.value != null && !["1", "2"].includes(String(horizonFlag.value))) {
    return { error: "crypto --horizon must be 1 or 2" };
  }

  const stray = rest.find((arg) => arg.startsWith("-") && arg !== "-");
  if (stray) return { error: `unknown crypto flag ${JSON.stringify(stray)}` };

  const [first, ...tail] = rest;
  if (!first) return { usage: true };

  const verb = resolveVerb(first);
  const words = verb ? tail : rest;

  // No verb → the first word is the pair. `/crypto BTC` is the headline case
  // and must stay the shortest thing anyone types.
  const single = { report: "report", quote: "quote", technicals: "technicals", bars: "bars", book: "book", open: "open" };
  const wanted = verb == null ? "report" : verb;

  if (single[wanted]) {
    const raw = words[0];
    if (!raw) return { error: `crypto ${wanted} requires a pair` };
    const symbol = normalizeSymbol(raw);
    if (!symbol) {
      return { error: `${JSON.stringify(String(raw))} is not a crypto pair — try: moshcode crypto lookup ${String(raw)}` };
    }
    if (wanted === "open") {
      return { verb: "open", symbol, open: `/crypto/${encodeURIComponent(symbol)}`, json };
    }
    if (wanted === "report") return { verb: "report", symbol, path: "/api/crypto/report", query: { symbol }, json };
    if (wanted === "quote") return { verb: "quote", symbol, path: "/api/crypto/quote", query: { symbol }, json };
    if (wanted === "technicals") {
      return {
        verb: "technicals", symbol, path: "/api/crypto/technicals",
        query: { symbol, ...(horizonFlag.value ? { horizon: String(horizonFlag.value) } : {}) }, json,
      };
    }
    if (wanted === "bars") {
      return {
        verb: "bars", symbol, path: "/api/crypto/bars",
        query: {
          symbol,
          timeframe: timeframe || "1Day",
          ...(startFlag.value ? { start: startFlag.value } : {}),
          ...(endFlag.value ? { end: endFlag.value } : {}),
          ...(limit ? { limit: String(limit) } : {}),
        },
        // Upstream treats `limit` as a page size over its own window, not a cap
        // on what comes back — `--limit 5` can return seventeen bars. The flag
        // is carried through here so the renderer can honour what it promised,
        // and say out loud that it trimmed.
        limit,
        json,
      };
    }
    return {
      verb: "book", symbol, path: "/api/crypto/orderbook",
      query: { symbol, ...(depth ? { depth: String(depth) } : {}) }, json,
    };
  }

  if (verb === "snapshot" || verb === "spark") {
    const list = symbolList(words, verb);
    if (list.error) return { error: list.error };
    const symbols = list.symbols;
    if (verb === "snapshot") {
      return { verb, symbols, path: "/api/crypto/snapshot", query: { symbols: symbols.join(",") }, json };
    }
    return {
      verb, symbols, path: "/api/crypto/sparklines",
      query: { symbols: symbols.join(","), period: period || "24h" }, json,
    };
  }

  if (verb === "lookup") {
    const q = words.join(" ").trim();
    if (!q) return { error: "crypto lookup requires something to look for" };
    return { verb, path: "/api/crypto/lookup", query: { q, ...(limit ? { limit: String(limit) } : {}) }, json };
  }

  if (verb === "assets") return { verb, path: "/api/crypto/assets", query: {}, json };

  return { error: `unknown crypto command ${JSON.stringify(String(first))}` };
}

/** Build the absolute URL for a translated request. */
export function cryptoUrl(request, { base = advisorBase() } = {}) {
  const url = new URL((request.path || request.open || "/"), `${base}/`);
  for (const [k, v] of Object.entries(request.query || {})) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * Execute a translated request. `fetchImpl` is injectable for tests.
 *
 * Every crypto route is a live venue read, so one timeout fits all of them —
 * unlike stocks, which has to budget separately for `discover`'s per-candidate
 * analysis.
 */
export async function fetchCrypto(request, { fetchImpl = globalThis.fetch, base = advisorBase(), timeoutMs = 45_000 } = {}) {
  const url = cryptoUrl(request, { base });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "moshcode-crypto" },
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (data == null) {
      return { ok: false, status: res.status, url, error: `advis0r returned ${res.status} and not JSON` };
    }
    return { ok: res.ok, status: res.status, url, data };
  } catch (e) {
    const reason = e?.name === "AbortError" ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (e?.message || String(e));
    return { ok: false, status: 0, url, error: `advis0r request failed: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- rendering

/** Quote assets that are dollars, or a claim to be one. */
const FIAT = new Set(["USD", "USDC", "USDT"]);

/**
 * Format a price at a precision the pair actually trades at.
 *
 * Crypto spans nine orders of magnitude on one venue — BTC near $65,000 and
 * SHIB near $0.000006. A fixed two decimals renders half the index as "$0.00",
 * so the decimals follow the magnitude.
 */
export function price(value, quote = "USD", { like } = {}) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return "—";
  // `like` prices a derived number at the precision of the number it sits next
  // to: a $126 move on a $65,000 coin belongs at two decimals, the same as the
  // price above it, not at the four its own magnitude would earn.
  const reference = Number(like);
  const abs = Math.abs(Number.isFinite(reference) ? reference : n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : abs >= 0.0001 ? 6 : 8;
  const text = n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return FIAT.has(String(quote).toUpperCase()) ? `$${text}` : `${text} ${String(quote).toUpperCase()}`;
}

const num = (v, digits = 2) =>
  v == null || !Number.isFinite(Number(v)) ? null : Number(v).toFixed(digits).replace(/\.00$/, "");

/** A signed percentage, because "0.29%" and "-0.29%" must never look alike. */
function pct(value, digits = 2) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function compact(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (let i = 0; i < units.length; i++) {
    const [size, suffix] = units[i];
    if (Math.abs(n) < size) continue;
    // Same carry as advisor's: rounding can push a value up to a full thousand
    // of this unit (999,999,999 → "1000M"); carry it to the next unit instead.
    const scaled = (n / size).toFixed(2);
    if (Math.abs(Number(scaled)) >= 1000 && i > 0) {
      const [upSize, upSuffix] = units[i - 1];
      return `${(n / upSize).toFixed(2).replace(/\.?0+$/, "")}${upSuffix}`;
    }
    return `${scaled.replace(/\.?0+$/, "")}${suffix}`;
  }
  // Below 1K a raw count is more honest than "0.94K".
  return Number(n.toFixed(2)).toLocaleString("en-US");
}

/** A timestamp trimmed to the minute — seconds and nanoseconds are noise here. */
function stamp(v) {
  if (!v) return "—";
  const s = String(v);
  return s.length >= 16 ? `${s.slice(0, 16).replace("T", " ")}Z` : s;
}

const day = (v) => (v ? String(v).slice(0, 10) : "—");

function wrapText(text, width) {
  const words = String(text).replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** Up is acid, down is danger, flat is ash. */
function changeTone(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return ash;
  return n > 0 ? acid : danger;
}

function scoreTone(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return ash;
  if (n >= 60) return acid;
  if (n >= 40) return amber;
  return danger;
}

/**
 * The API ships a disclaimer with every substantive response. Printing it is
 * not decoration — this renders scored market analysis in a terminal next to a
 * broker CLI that can place orders, for an asset class with no circuit breakers.
 */
function disclaimerLines(d, width) {
  const text = d?.disclaimer;
  if (!text) return [];
  return wrapText(text, width - 4).map((line) => `  ${dim(line)}`);
}

/**
 * Caveats are per-response and specific — the score's liquidity component is
 * venue-local, the 200-day window counts calendar days on a 24/7 market. They
 * qualify the numbers directly above them, so they print with them.
 */
function caveatLines(d, width) {
  const caveats = Array.isArray(d?.caveats) ? d.caveats : [];
  if (!caveats.length) return [];
  const lines = ["", `  ${ash("caveats")}`];
  for (const caveat of caveats) {
    const wrapped = wrapText(caveat, width - 8);
    lines.push(`    ${amber("•")} ${dim(wrapped[0] ?? "")}`);
    for (const line of wrapped.slice(1)) lines.push(`      ${dim(line)}`);
  }
  return lines;
}

/**
 * A left-hand label in the report's column, padded to one width.
 *
 * Hand-counted spaces after each label drift the moment a label is renamed —
 * `all-time high` is exactly the column width, so it would butt straight up
 * against its own value.
 */
const LABEL_WIDTH = 14;
const label = (text) => ash(String(text).padEnd(LABEL_WIDTH));

/** `BTC/USD  Bitcoin` — the identity line every renderer starts from. */
function pairHeading(d) {
  const symbol = String(d?.symbol ?? "");
  const name = d?.name && d.name !== symbol ? `  ${bone(d.name)}` : "";
  return `  ${acid(symbol)}${name}`;
}

function quoteAsset(d) {
  return String(d?.quote || String(d?.symbol ?? "").split("/")[1] || "USD").toUpperCase();
}

/** The price + change line, shared by report and quote. */
function priceLine(snapshot, quote) {
  const last = snapshot?.latestTrade?.price ?? snapshot?.mid ?? snapshot?.dailyBar?.close;
  const change = snapshot?.change;
  const bits = [bone(price(last, quote))];
  if (change) {
    const paint = changeTone(change.percent);
    // Sign the magnitude, don't let price() sign it: a signed price puts the
    // minus after the currency mark ("$-186.36"), so a down move reads unlike
    // the up move's "+$186.36". The sign leads, the way pct() already signs.
    const signed = `${change.absolute >= 0 ? "+" : "-"}${price(Math.abs(Number(change.absolute)), quote, { like: last })}`;
    bits.push(paint(signed), paint(`(${pct(change.percent)})`));
  }
  const feed = [
    snapshot?.delayed === false ? "live" : snapshot?.delayed === true ? "delayed" : null,
    snapshot?.feed ? `${snapshot.feed} venue` : null,
    "24/7",
  ].filter(Boolean).join(" · ");
  return `  ${bits.join("  ")}  ${ash(feed)}`;
}

function bookLine(latestQuote, quote, extra = {}) {
  if (!latestQuote) return null;
  const spreadBps = extra.spreadBps ?? spreadBpsOf(latestQuote);
  const parts = [
    `bid ${price(latestQuote.bidPrice, quote)} × ${num(latestQuote.bidSize, 4) ?? "—"}`,
    `ask ${price(latestQuote.askPrice, quote)} × ${num(latestQuote.askSize, 4) ?? "—"}`,
    spreadBps == null ? null : `spread ${num(spreadBps, 2)}bps`,
  ].filter(Boolean);
  return `  ${label("book")}${parts.join(ash(" · "))}`;
}

function spreadBpsOf(latestQuote) {
  const bid = Number(latestQuote?.bidPrice);
  const ask = Number(latestQuote?.askPrice);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid + ask === 0) return null;
  return ((ask - bid) / ((ask + bid) / 2)) * 10_000;
}

function technicalLines(t, quote) {
  if (!t) return [];
  const lines = [];
  const indicators = [
    t.rsi14 == null ? null : `rsi14 ${num(t.rsi14, 1)}`,
    t.sma?.[20] == null ? null : `sma20 ${price(t.sma[20], quote)}`,
    t.sma?.[50] == null ? null : `sma50 ${price(t.sma[50], quote)}`,
    t.sma?.[200] == null ? null : `sma200 ${price(t.sma[200], quote)}`,
    t.atr14 == null ? null : `atr ${price(t.atr14, quote)}`,
    t.relativeVolume == null ? null : `rvol ${num(t.relativeVolume, 2)}`,
  ].filter(Boolean);
  if (indicators.length) lines.push(`  ${label("technical")}${indicators.join(ash(" · "))}`);

  const regime = [
    t.trend ? `trend ${t.trend}` : null,
    t.volatilityRegime ? `volatility ${t.volatilityRegime}` : null,
    t.goldenCross ? "golden cross" : null,
    t.deathCross ? "death cross" : null,
    t.breakout ? "breakout" : null,
    t.breakdown ? "breakdown" : null,
  ].filter(Boolean);
  if (regime.length) lines.push(`  ${label("regime")}${regime.map((r) => bone(r)).join(ash(" · "))}`);

  const momentum = [
    t.momentum?.[20] == null ? null : `20d ${pct(t.momentum[20], 1)}`,
    t.momentum?.[60] == null ? null : `60d ${pct(t.momentum[60], 1)}`,
    t.momentum?.[120] == null ? null : `120d ${pct(t.momentum[120], 1)}`,
    t.distanceFrom52WeekHigh == null ? null : `from 52w high ${pct(t.distanceFrom52WeekHigh, 1)}`,
  ].filter(Boolean);
  if (momentum.length) lines.push(`  ${label("momentum")}${momentum.join(ash(" · "))}`);
  return lines;
}

/** CoinGecko supply/market-cap facts. Absent for most pairs, and that is fine. */
function fundamentalLines(f, quote) {
  if (!f || f.source === "unavailable") return [];
  const parts = [
    f.marketCap == null ? null : `cap ${compact(f.marketCap)}`,
    f.marketCapRank == null ? null : `rank #${f.marketCapRank}`,
    f.volume24h == null ? null : `vol24h ${compact(f.volume24h)}`,
    f.circulatingSupply == null ? null : `circ ${compact(f.circulatingSupply)}${f.maxSupply ? `/${compact(f.maxSupply)}` : ""}`,
  ].filter(Boolean);
  const lines = [];
  if (parts.length) lines.push(`  ${label("market")}${parts.join(ash(" · "))}`);
  if (f.ath != null) {
    lines.push(`  ${label("all-time high")}${bone(price(f.ath, quote))} ${ash(day(f.athDate))}  ${changeTone(f.athChangePercent)(pct(f.athChangePercent, 1))}`);
  }
  if (lines.length && f.source) lines.push(`  ${ash(`supply data: ${f.source}`)}`);
  return lines;
}

function renderReport(d, { width }) {
  const quote = quoteAsset(d);
  const snapshot = d.snapshot || {};
  const lines = ["", pairHeading(d), priceLine(snapshot, quote), ""];

  const score = d.technicalScore;
  if (score?.score != null) {
    const paint = scoreTone(score.score);
    const bits = [
      `${paint(`technical score ${num(score.score, 1)}`)}${ash("/100")}`,
      score.horizonQuarters ? ash(`${score.horizonQuarters}q horizon`) : null,
    ].filter(Boolean);
    lines.push(`  ${bits.join(ash("   "))}`);
  }

  lines.push(...technicalLines(d.technical, quote));
  const book = bookLine(snapshot.latestQuote, quote);
  if (book) lines.push(book);

  const bar = snapshot.dailyBar;
  if (bar) {
    const parts = [
      `o ${price(bar.open, quote)}`, `h ${price(bar.high, quote)}`,
      `l ${price(bar.low, quote)}`, `c ${price(bar.close, quote)}`,
      bar.vwap == null ? null : `vwap ${price(bar.vwap, quote)}`,
      bar.volume == null ? null : `vol ${compact(bar.volume)} ${d.base ?? ""}`.trim(),
    ].filter(Boolean);
    lines.push(`  ${label("day")}${parts.join(ash(" · "))}`);
  }

  lines.push(...fundamentalLines(d.fundamentals, quote));

  lines.push("", `  ${label("page")}${acid(`${advisorBase()}/crypto/${d.slug ?? String(d.symbol ?? "").replace("/", "-")}`)}`);
  const fetchedAt = d.generatedAt || snapshot.fetchedAt;
  if (fetchedAt) lines.push(`  ${ash(`fetched ${stamp(fetchedAt)}`)}`);
  lines.push(...caveatLines(d, width));
  lines.push("", ...disclaimerLines(d, width));
  return lines.join("\n");
}

function renderQuote(d, { width }) {
  const quotes = Array.isArray(d.quotes) ? d.quotes : [];
  if (!quotes.length) return `  ${ash("no quote came back for that pair")}`;
  const lines = [""];
  for (const q of quotes) {
    const quote = quoteAsset(q);
    lines.push(pairHeading(q));
    const trade = q.latestTrade;
    if (trade) {
      lines.push(`  ${bone(price(trade.price, quote))}  ${ash(`last trade ${num(trade.size, 6) ?? "—"} @ ${stamp(trade.timestamp)}`)}`);
    }
    const book = bookLine(q.latestQuote, quote, { spreadBps: q.spreadBps });
    if (book) lines.push(book);
    if (q.mid != null) lines.push(`  ${label("mid")}${bone(price(q.mid, quote))}`);
    lines.push("");
  }
  if (d.fetchedAt) lines.push(`  ${ash(`fetched ${stamp(d.fetchedAt)} · ${d.feed ?? "us"} venue · 24/7`)}`, "");
  lines.push(...disclaimerLines(d, width));
  return lines.join("\n");
}

function renderSnapshot(d, { width }) {
  const snapshots = Array.isArray(d.snapshots) ? d.snapshots : [];
  if (!snapshots.length) return `  ${ash("no snapshots came back")}`;
  const lines = ["", `  ${ash(`${snapshots.length} ${snapshots.length === 1 ? "pair" : "pairs"}`)}`, ""];
  for (const s of snapshots) {
    const quote = quoteAsset(s);
    const change = s.change?.percent;
    lines.push(
      `  ${acid(String(s.symbol).padEnd(11))}` +
      `${bone(price(s.latestTrade?.price ?? s.dailyBar?.close, quote).padStart(16))}  ` +
      `${changeTone(change)(pct(change).padStart(8))}  ` +
      `${ash(`h ${price(s.dailyBar?.high, quote)} · l ${price(s.dailyBar?.low, quote)}`)}  ` +
      `${ash(clip(s.name ?? "", 20))}`,
    );
  }
  const fetchedAt = snapshots.find((s) => s.fetchedAt)?.fetchedAt;
  if (fetchedAt) lines.push("", `  ${ash(`fetched ${stamp(fetchedAt)} · 24/7`)}`);
  if (Array.isArray(d.rejected) && d.rejected.length) {
    lines.push(`  ${amber(`not supported: ${d.rejected.join(", ")}`)}`);
  }
  lines.push("", ...disclaimerLines(d, width));
  return lines.join("\n");
}

function renderTechnicals(d, { width }) {
  const t = d.indicators;
  if (!t) return `  ${ash("no indicators came back for that pair")}`;
  const quote = quoteAsset({ symbol: d.symbol });
  const lines = ["", `  ${acid(String(d.symbol ?? ""))}  ${ash(`${d.bars ?? "?"} bars · as of ${stamp(t.asOf)}`)}`, ""];

  const score = d.score;
  if (score?.score != null) {
    lines.push(`  ${scoreTone(score.score)(`technical score ${num(score.score, 1)}`)}${ash("/100")}${score.horizonQuarters ? ash(`   ${score.horizonQuarters}q horizon`) : ""}`);
    const breakdown = Object.entries(score.breakdown || {});
    if (breakdown.length) {
      for (const [key, value] of breakdown) {
        lines.push(`    ${ash(String(key).padEnd(16))}${bone(String(num(value, 2) ?? "—").padStart(6))}`);
      }
    }
    lines.push("");
  }

  lines.push(...technicalLines(t, quote));
  if (t.lastClose != null) lines.push(`  ${label("last close")}${bone(price(t.lastClose, quote))}`);
  const macd = t.macd;
  if (macd) {
    lines.push(`  ${label("macd")}${[`macd ${num(macd.macd, 2)}`, `signal ${num(macd.signal, 2)}`, `hist ${num(macd.histogram, 2)}`].join(ash(" · "))}`);
  }
  const bb = t.bollinger;
  if (bb) {
    lines.push(`  ${label("bollinger")}${[`upper ${price(bb.upper, quote)}`, `mid ${price(bb.middle, quote)}`, `lower ${price(bb.lower, quote)}`].join(ash(" · "))}`);
  }
  const volume = [
    t.avgDailyVolume == null ? null : `avg daily ${compact(t.avgDailyVolume)}`,
    t.avgDollarVolume == null ? null : `avg $ volume ${compact(t.avgDollarVolume)}`,
    t.vwap == null ? null : `vwap ${price(t.vwap, quote)}`,
  ].filter(Boolean);
  if (volume.length) lines.push(`  ${label("volume")}${volume.join(ash(" · "))}`);

  lines.push(...caveatLines(d, width));
  lines.push("", ...disclaimerLines(d, width));
  return lines.join("\n");
}

function renderBars(d, { width, limit }) {
  const groups = Object.entries(d.bars || {});
  if (!groups.length) return `  ${ash("no bars came back for that window")}`;
  const lines = [];
  for (const [symbol, bars] of groups) {
    const quote = quoteAsset({ symbol });
    const all = Array.isArray(bars) ? bars : [];
    // The most recent bars are the ones worth keeping when trimming.
    const rows = limit && all.length > limit ? all.slice(-limit) : all;
    const trimmed = all.length - rows.length;
    const heading = `${rows.length} × ${d.timeframe ?? "1Day"}${trimmed > 0 ? ` · newest of ${all.length}` : ""}`;
    lines.push("", `  ${acid(symbol)}  ${ash(heading)}`, "");
    if (!rows.length) { lines.push(`  ${ash("no bars in this window")}`); continue; }
    lines.push(`  ${ash("when".padEnd(17))}${ash("open".padStart(14))}${ash("high".padStart(14))}${ash("low".padStart(14))}${ash("close".padStart(14))}${ash("volume".padStart(12))}`);
    for (const bar of rows) {
      // Intraday timeframes need the clock; daily and weekly do not.
      const when = /Min|Hour/.test(String(d.timeframe ?? "")) ? stamp(bar.timestamp) : day(bar.timestamp);
      const up = Number(bar.close) >= Number(bar.open);
      lines.push(
        `  ${ash(String(when).padEnd(17))}` +
        `${bone(price(bar.open, quote).padStart(14))}` +
        `${bone(price(bar.high, quote).padStart(14))}` +
        `${bone(price(bar.low, quote).padStart(14))}` +
        `${(up ? acid : danger)(price(bar.close, quote).padStart(14))}` +
        `${ash(String(compact(bar.volume) ?? "—").padStart(12))}`,
      );
    }
    const closes = rows.map((b) => Number(b.close)).filter(Number.isFinite);
    if (closes.length > 1) {
      const move = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
      lines.push("", `  ${ash("window")}  ${changeTone(move)(pct(move))}  ${dim(sparkline(closes))}`);
    }
  }
  lines.push("", ...disclaimerLines(d, width));
  return lines.join("\n");
}

function renderBook(d, { width }) {
  const books = Array.isArray(d.orderbooks) ? d.orderbooks : [];
  if (!books.length) return `  ${ash("no order book came back for that pair")}`;
  const lines = [];
  for (const book of books) {
    const quote = quoteAsset(book);
    const bids = Array.isArray(book.bids) ? book.bids : [];
    const asks = Array.isArray(book.asks) ? book.asks : [];
    lines.push("", pairHeading(book), `  ${ash(stamp(book.timestamp))}`, "");
    lines.push(`  ${acid("bid".padEnd(16))}${ash("size".padStart(12))}    ${danger("ask".padEnd(16))}${ash("size".padStart(12))}`);
    for (let i = 0; i < Math.max(bids.length, asks.length); i++) {
      const bid = bids[i];
      const ask = asks[i];
      lines.push(
        `  ${acid((bid ? price(bid.price, quote) : "").padEnd(16))}${ash((bid ? String(num(bid.size, 6) ?? "") : "").padStart(12))}    ` +
        `${danger((ask ? price(ask.price, quote) : "").padEnd(16))}${ash((ask ? String(num(ask.size, 6) ?? "") : "").padStart(12))}`,
      );
    }
    const spreadBps = spreadBpsOf({ bidPrice: bids[0]?.price, askPrice: asks[0]?.price });
    if (spreadBps != null) {
      lines.push("", `  ${ash("spread")}  ${bone(`${num(spreadBps, 2)}bps`)}  ${ash(`${price((asks[0].price + bids[0].price) / 2, quote)} mid`)}`);
    }
  }
  lines.push("", ...disclaimerLines(d, width));
  return lines.join("\n");
}

function renderSpark(d, { width }) {
  const series = Object.entries(d.series || {});
  if (!series.length) return `  ${ash("no series came back")}`;
  const lines = ["", `  ${ash(`last ${d.period ?? "24h"}`)}`, ""];
  for (const [symbol, s] of series) {
    const quote = quoteAsset({ symbol });
    const paint = changeTone(s.changePercent);
    lines.push(
      `  ${acid(String(symbol).padEnd(11))}${paint(sparkline(s.points))}  ` +
      `${bone(price(s.last, quote).padStart(14))}  ${paint(pct(s.changePercent).padStart(8))}`,
    );
  }
  const first = series[0]?.[1];
  if (first?.start) lines.push("", `  ${ash(`${stamp(first.start)} → ${stamp(first.end)}`)}`);
  lines.push("", ...disclaimerLines(d, width));
  return lines.join("\n");
}

function renderAssets(d) {
  const assets = Array.isArray(d.assets) ? d.assets : [];
  if (!assets.length) return `  ${ash("no pairs are listed")}`;
  const byQuote = new Map();
  for (const asset of assets) {
    const key = String(asset.quote ?? "?").toUpperCase();
    if (!byQuote.has(key)) byQuote.set(key, []);
    byQuote.get(key).push(asset);
  }
  const lines = ["", `  ${ash(`${d.count ?? assets.length} pairs${d.liveness ? ` · liveness ${d.liveness}` : ""}`)}`];
  for (const [quote, rows] of [...byQuote].sort((a, b) => b[1].length - a[1].length)) {
    lines.push("", `  ${bone(`quoted in ${quote}`)} ${ash(`(${rows.length})`)}`);
    // `idle` is the API's own word for a listed pair with no recent prints;
    // it stays visible rather than being filtered out, because "missing" and
    // "listed but not trading" are different answers to "can I trade this".
    const cells = rows.map((r) => {
      const paint = r.status === "live" ? acid : ash;
      return `${paint(String(r.slug ?? r.symbol).padEnd(11))}${ash(clip(r.name, 14).padEnd(15))}`;
    });
    for (let i = 0; i < cells.length; i += 3) lines.push(`  ${cells.slice(i, i + 3).join(" ")}`);
  }
  lines.push("", `  ${ash("then:")} ${bone(`moshcode crypto ${assets[0].slug ?? assets[0].symbol}`)}`);
  return lines.join("\n");
}

function renderLookup(d) {
  const matches = Array.isArray(d.matches) ? d.matches : [];
  if (!matches.length) return `  ${ash(`no crypto pair matches ${JSON.stringify(String(d.query ?? ""))}`)}`;
  const lines = ["", `  ${ash("matches for")} ${bone(String(d.query ?? ""))}`, ""];
  for (const m of matches) {
    lines.push(`  ${acid(String(m.slug ?? m.symbol).padEnd(12))}${bone(clip(m.name, 28).padEnd(30))}${ash(`${m.base ?? ""}/${m.quote ?? ""}`)}`);
  }
  lines.push("", `  ${ash("then:")} ${bone(`moshcode crypto ${matches[0].slug ?? matches[0].symbol}`)}`);
  return lines.join("\n");
}

/** Render a decoded API response for one verb. */
export function renderCrypto(verb, data, { columns, limit } = {}) {
  const width = Math.max(48, Math.min(Number(columns) || 88, 100));
  switch (verb) {
    case "report": return renderReport(data, { width });
    case "quote": return renderQuote(data, { width });
    case "snapshot": return renderSnapshot(data, { width });
    case "technicals": return renderTechnicals(data, { width });
    case "bars": return renderBars(data, { width, limit });
    case "book": return renderBook(data, { width });
    case "spark": return renderSpark(data, { width });
    case "assets": return renderAssets(data);
    case "lookup": return renderLookup(data);
    default: return JSON.stringify(data, null, 2);
  }
}

/**
 * Run a `crypto` invocation end to end. Returns a process exit code.
 *
 * `deps` exists so tests drive the whole command — parse, fetch, render — with
 * no network and no stdout.
 */
export async function cryptoCommand(argv = [], deps = {}) {
  const {
    out = (s) => console.log(s),
    fail = (s) => console.error(s),
    fetchImpl,
    base = advisorBase(),
    openUrl,
    columns = process.stdout.columns,
  } = deps;

  const request = cryptoArgs(argv);
  if (request.usage) { out(cryptoUsage()); return 0; }
  if (request.error) { fail(danger(`✗ ${request.error}`)); return 1; }

  if (request.verb === "open") {
    const url = cryptoUrl(request, { base });
    if (request.json) { out(JSON.stringify({ url }, null, 2)); return 0; }
    const opened = openUrl ? openUrl(url) : false;
    out(opened ? `${acid("✓ ")}opened ${bone(url)}` : `${ash("· ")}open this in a browser:\n  ${acid(url)}`);
    return 0;
  }

  const res = await fetchCrypto(request, { fetchImpl, base });
  if (res.error) { fail(danger(`✗ ${res.error}`)); return 1; }

  // The API's own error bodies are more useful than any message invented here:
  // an unsupported pair comes back naming the lookup that would have resolved it.
  if (!res.ok) {
    const message = res.data?.error || `advis0r returned ${res.status}`;
    if (request.json) { out(JSON.stringify(res.data, null, 2)); return 1; }
    fail(danger(`✗ ${message}`));
    if (res.data?.lookup) {
      const q = String(res.data.lookup).split("q=")[1];
      if (q) fail(`  ${ash("try:")} ${bone(`moshcode crypto lookup ${decodeURIComponent(q)}`)}`);
    }
    return 1;
  }

  if (request.json) { out(JSON.stringify(res.data, null, 2)); return 0; }
  out(renderCrypto(request.verb, res.data, { columns, limit: request.limit }));
  return 0;
}
