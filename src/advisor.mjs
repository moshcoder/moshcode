// `moshcode stocks` — equity research from advis0r.com, in the pit.
//
// Same split as src/trade.mjs: argument translation is pure and testable, the
// network call is injectable, and rendering is a function of the decoded JSON.
// Nothing here holds credentials — every route this touches is public and
// read-only, which is why there is no login verb and no write verb.
//
// The API is documented at https://advis0r.com/api and returns *stored*
// snapshots: a report carries `reportGeneratedAt`, and every renderer prints it.
// A stale price is fine; a stale price dressed up as a live one is not.
import { acid, ash, amber, bone, clip, danger, dim } from "./ui.mjs";

export const DEFAULT_ADVISOR_URL = "https://advis0r.com";

/** The advis0r base URL, overridable for a local instance or a test server. */
export function advisorBase(env = process.env) {
  const raw = String(env.MOSHCODE_ADVISOR_URL || DEFAULT_ADVISOR_URL).trim();
  return (raw || DEFAULT_ADVISOR_URL).replace(/\/+$/, "");
}

const USAGE = `usage: moshcode stocks <symbol|verb> [args…]

  <symbol>                       the stored research report for one ticker
  report <symbol>                same thing, when a symbol looks like a verb
  signals <symbol>               every extracted signal for a ticker
  search <words…>                full-text search across indexed transcripts
  lookup <company…>              find a ticker by company name (rivian → RIVN)
  reports                        every stored report, best score first
  discover [topic…]              a ranked watchlist for a topic
  tickers                        every ticker present in the index
  stats                          index coverage counts
  open <symbol>                  open the shareable report page in a browser

  --json                         print the raw API response
  --limit <n>                    cap results (search/lookup/reports/discover)
  --sort <recent|score|ticker>   order reports (default: score)
  --horizon <1|2>                discover: quarters to look ahead (default: 2)
  --provider <name>              discover: analysis provider (default: offline)

Research aid, not advice. Every route is public, read-only, and served from
stored snapshots — see the generated-at stamp printed with each report.`;

export function stocksUsage() {
  return USAGE;
}

/** Verb names, in help order. cli-schema's STOCKS_VERBS must match (drift test). */
export const STOCKS_VERB_NAMES = [
  "report", "signals", "search", "lookup", "reports", "discover", "tickers", "stats", "open",
];

// Aliases exist because muscle memory differs: `/stocks news AAPL` and
// `/stocks quotes AAPL` should not be errors when the intent is obvious.
const VERB_ALIASES = {
  signal: "signals", news: "signals",
  find: "search", grep: "search", q: "search",
  symbol: "lookup", company: "lookup", name: "lookup",
  index: "reports", list: "reports",
  watchlist: "discover", rank: "discover",
  symbols: "tickers",
  coverage: "stats", status: "stats",
  browse: "open", www: "open", web: "open",
  detail: "report", quote: "report", snapshot: "report",
};

/** Resolve a first argument to a canonical verb, or null when it is a symbol. */
export function resolveVerb(word) {
  const key = String(word ?? "").toLowerCase();
  if (STOCKS_VERB_NAMES.includes(key)) return key;
  return VERB_ALIASES[key] ?? null;
}

/**
 * A ticker symbol as the API will accept it, or null.
 *
 * Deliberately narrow — 1-6 letters with an optional class suffix (BRK.B) —
 * because the whole point of the check is to tell "AAPL" from "rivian", and
 * send the second one to /api/lookup with a useful message instead of a 400.
 */
export function normalizeSymbol(input) {
  const raw = String(input ?? "").trim().toUpperCase();
  return /^[A-Z]{1,6}(?:[.-][A-Z]{1,2})?$/.test(raw) ? raw : null;
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

const SORTS = ["recent", "score", "ticker"];

/**
 * Translate `stocks` arguments into a request the caller can execute.
 *
 * Returns one of `{ usage }`, `{ error }`, or
 * `{ verb, path, query, json, open? }` — never performs IO, so the whole
 * argument surface is testable without a network.
 */
export function stocksArgs(input = []) {
  const args = input.map(String);
  const jsonFlag = takeFlag(args, "--json", { boolean: true });
  let rest = jsonFlag.rest;
  const json = jsonFlag.present;

  const limitFlag = takeFlag(rest, "--limit"); rest = limitFlag.rest;
  const sortFlag = takeFlag(rest, "--sort"); rest = sortFlag.rest;
  const horizonFlag = takeFlag(rest, "--horizon"); rest = horizonFlag.rest;
  const providerFlag = takeFlag(rest, "--provider"); rest = providerFlag.rest;

  if (limitFlag.missing) return { error: "stocks --limit requires a positive number" };
  if (sortFlag.missing) return { error: `stocks --sort requires one of ${SORTS.join(", ")}` };
  if (horizonFlag.missing) return { error: "stocks --horizon requires 1 or 2" };
  if (providerFlag.missing) return { error: "stocks --provider requires a name" };

  // A limit above the server's own cap is silently clamped there; clamping here
  // too keeps `--limit 9999` from reading like a promise the API never made.
  const limit = limitFlag.value == null ? null : positiveInt(limitFlag.value, { max: 50 });
  if (limitFlag.value != null && limit == null) {
    return { error: "stocks --limit requires a positive number" };
  }
  if (sortFlag.value != null && !SORTS.includes(sortFlag.value.toLowerCase())) {
    return { error: `stocks --sort must be one of ${SORTS.join(", ")}` };
  }
  if (horizonFlag.value != null && !["1", "2"].includes(String(horizonFlag.value))) {
    return { error: "stocks --horizon must be 1 or 2" };
  }

  const stray = rest.find((arg) => arg.startsWith("-") && arg !== "-");
  if (stray) return { error: `unknown stocks flag ${JSON.stringify(stray)}` };

  const [first, ...tail] = rest;
  if (!first) return { usage: true };

  const verb = resolveVerb(first);
  const words = verb ? tail : rest;

  // No verb → the first word is the ticker. `/stocks AAPL` is the headline
  // case and must stay the shortest thing anyone types.
  const wantsReport = verb == null || verb === "report" || verb === "open";
  if (wantsReport) {
    const raw = words[0];
    if (!raw) return { error: `stocks ${verb === "open" ? "open" : "report"} requires a ticker symbol` };
    const symbol = normalizeSymbol(raw);
    if (!symbol) {
      return {
        error: `${JSON.stringify(String(raw))} is not a ticker symbol — try: moshcode stocks lookup ${String(raw)}`,
      };
    }
    if (verb === "open") return { verb: "open", symbol, open: `/ticker/${encodeURIComponent(symbol)}`, json };
    return { verb: "report", symbol, path: "/api/ticker", query: { symbol }, json };
  }

  if (verb === "signals") {
    const symbol = normalizeSymbol(words[0]);
    if (!words[0]) return { error: "stocks signals requires a ticker symbol" };
    if (!symbol) {
      return { error: `${JSON.stringify(String(words[0]))} is not a ticker symbol — try: moshcode stocks lookup ${words[0]}` };
    }
    return { verb, symbol, path: "/api/signals", query: { ticker: symbol }, json };
  }

  if (verb === "search" || verb === "lookup") {
    const q = words.join(" ").trim();
    if (!q) return { error: `stocks ${verb} requires something to look for` };
    const path = verb === "search" ? "/api/search" : "/api/lookup";
    return { verb, path, query: { q, ...(limit ? { limit: String(limit) } : {}) }, json };
  }

  if (verb === "reports") {
    return {
      verb,
      path: "/api/reports",
      query: {
        sort: (sortFlag.value || "score").toLowerCase(),
        ...(limit ? { limit: String(limit) } : {}),
      },
      json,
    };
  }

  if (verb === "discover") {
    const topic = words.join(" ").trim();
    return {
      verb,
      path: "/api/discover",
      query: {
        ...(topic ? { topic } : {}),
        provider: providerFlag.value || "offline",
        horizon: String(horizonFlag.value || 2),
        ...(limit ? { limit: String(limit) } : {}),
      },
      json,
      slow: true,
    };
  }

  if (verb === "tickers") return { verb, path: "/api/tickers", query: {}, json };
  if (verb === "stats") return { verb, path: "/api/stats", query: {}, json };

  return { error: `unknown stocks command ${JSON.stringify(String(first))}` };
}

/** Build the absolute URL for a translated request. */
export function advisorUrl(request, { base = advisorBase() } = {}) {
  const url = new URL((request.path || request.open || "/"), `${base}/`);
  for (const [k, v] of Object.entries(request.query || {})) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * Execute a translated request. `fetchImpl` is injectable for tests.
 *
 * `/api/discover` ranks candidates by running an analysis per ticker, so it can
 * legitimately take a minute; every other route is a row read. One timeout for
 * both would either abort discover or hang forever on a wedged connection.
 */
export async function fetchAdvisor(request, { fetchImpl = globalThis.fetch, base = advisorBase(), timeoutMs } = {}) {
  const url = advisorUrl(request, { base });
  const ms = timeoutMs ?? (request.slow ? 180_000 : 45_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "moshcode-stocks" },
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (data == null) {
      return { ok: false, status: res.status, url, error: `advis0r returned ${res.status} and not JSON` };
    }
    return { ok: res.ok, status: res.status, url, data };
  } catch (e) {
    const reason = e?.name === "AbortError" ? `timed out after ${Math.round(ms / 1000)}s` : (e?.message || String(e));
    return { ok: false, status: 0, url, error: `advis0r request failed: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- rendering

const num = (v, digits = 2) =>
  v == null || !Number.isFinite(Number(v)) ? null : Number(v).toFixed(digits).replace(/\.00$/, "");

const money = (v) =>
  num(v) == null
    ? "—"
    : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function compact(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (let i = 0; i < units.length; i++) {
    const [size, suffix] = units[i];
    if (Math.abs(n) < size) continue;
    // Rounding to 2 decimals can push a value just under the next boundary up to
    // a full thousand of this unit (999,999,999 → "1000M"); carry it to the next
    // unit up (→ "1B") so the number never reads as an un-carried thousand.
    const scaled = (n / size).toFixed(2);
    if (Math.abs(Number(scaled)) >= 1000 && i > 0) {
      const [upSize, upSuffix] = units[i - 1];
      return `${(n / upSize).toFixed(2).replace(/\.?0+$/, "")}${upSuffix}`;
    }
    return `${scaled.replace(/\.?0+$/, "")}${suffix}`;
  }
  return String(n);
}

const day = (v) => (v ? String(v).slice(0, 10) : "—");

/** Direction → color, so a wall of signals is skimmable. */
function tone(direction) {
  if (direction === "positive") return acid;
  if (direction === "negative") return danger;
  return ash;
}

function scoreTone(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return ash;
  if (n >= 60) return acid;
  if (n >= 40) return amber;
  return danger;
}

function reportHeader(d) {
  const lines = [];
  const name = d.companyName && d.companyName !== d.ticker ? `  ${bone(d.companyName)}` : "";
  lines.push(`  ${acid(d.ticker)}${name}${d.exchange ? ash(`  ${d.exchange}`) : ""}`);
  const asOf = day(d.priceTimestamp);
  const feed = [d.delayed === false ? "live" : "delayed", d.marketSource].filter(Boolean).join(" · ");
  lines.push(`  ${bone(money(d.lastPrice))}  ${ash(`${feed} · ${asOf}`)}`);
  return lines;
}

function renderReport(d, { width }) {
  const lines = ["", ...reportHeader(d), ""];

  if (d.overallScore != null) {
    const paint = scoreTone(d.overallScore);
    const bits = [
      `${paint(`score ${num(d.overallScore, 1)}`)}${ash("/100")}`,
      d.confidence == null ? null : ash(`confidence ${num(d.confidence, 1)}%`),
      d.classification ? bone(d.classification) : null,
    ].filter(Boolean);
    lines.push(`  ${bits.join(ash("   "))}`);
  }

  const t = d.technical;
  if (t) {
    const parts = [
      t.rsi14 == null ? null : `rsi14 ${num(t.rsi14, 1)}`,
      t.sma?.[50] == null ? null : `sma50 ${num(t.sma[50])}`,
      t.sma?.[200] == null ? null : `sma200 ${num(t.sma[200])}`,
      t.atr14 == null ? null : `atr ${num(t.atr14)}`,
      t.relativeVolume == null ? null : `rvol ${num(t.relativeVolume)}`,
    ].filter(Boolean);
    if (parts.length) lines.push(`  ${ash("technical")}   ${parts.join(ash(" · "))}`);
  }

  const f = d.facts;
  if (f && f.source !== "unavailable") {
    const parts = [
      f.marketCap == null ? null : `cap ${compact(f.marketCap)}`,
      f.revenue == null ? null : `rev ${compact(f.revenue)}`,
      f.revenueGrowth == null ? null : `growth ${num(f.revenueGrowth, 1)}%`,
      f.freeCashFlow == null ? null : `fcf ${compact(f.freeCashFlow)}`,
      f.totalDebt == null ? null : `debt ${compact(f.totalDebt)}`,
    ].filter(Boolean);
    if (parts.length) lines.push(`  ${ash("fundamentals")} ${parts.join(ash(" · "))}`);
  }

  // The hosted-model take when one has been paid for, the deterministic one
  // otherwise — labelled either way, because "an LLM said so" and "a rule fired"
  // deserve different amounts of trust.
  const ai = d.aiAnalysis;
  const thesis = ai?.analysis?.thesis || d.analysis?.thesis;
  if (thesis) {
    const label = ai ? `${ai.provider}${ai.model ? `/${ai.model}` : ""}` : "offline";
    lines.push("", `  ${ash(`thesis (${label})`)}`);
    for (const line of wrapText(thesis, width - 4)) lines.push(`    ${bone(line)}`);
  }

  const signals = Array.isArray(d.signals) ? d.signals : [];
  if (signals.length) {
    const pos = signals.filter((s) => s.direction === "positive").length;
    const neg = signals.filter((s) => s.direction === "negative").length;
    lines.push("", `  ${ash("signals")}      ${acid(`${pos} positive`)} ${ash("·")} ${danger(`${neg} negative`)} ${ash(`· ${signals.length} total`)}`);
    for (const s of signals.slice(0, 5)) {
      const paint = tone(s.direction);
      lines.push(`    ${paint("•")} ${ash(day(s.event_date))} ${bone(String(s.signal_type ?? "signal"))}  ${ash(clip(s.quote, Math.max(20, width - 40)))}`);
    }
  }

  const sources = Array.isArray(d.sources) ? d.sources : [];
  if (sources.length) {
    lines.push("", `  ${ash("sources")}      ${bone(String(sources.length))}`);
    for (const s of sources.slice(0, 4)) {
      lines.push(`    ${ash(day(s.publishedAt))} ${bone(clip(s.title, Math.max(20, width - 24)))}`);
      lines.push(`      ${dim(clip(s.url, width - 8))}`);
    }
  }

  lines.push("", `  ${ash("report")}       ${acid(`${advisorBase()}/ticker/${d.ticker}`)}`);
  if (d.reportGeneratedAt) {
    lines.push(`  ${ash(`snapshot generated ${d.reportGeneratedAt}${d.cached ? " (cached)" : ""}`)}`);
  }
  if (d.marketError) lines.push(`  ${amber(`market data unavailable: ${clip(d.marketError, width - 30)}`)}`);
  if (d.factsError) lines.push(`  ${amber(`fundamentals unavailable: ${clip(d.factsError, width - 30)}`)}`);
  lines.push("", ...disclaimerLines(d, width));
  return lines.join("\n");
}

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

/**
 * The API ships a disclaimer with every substantive response. Printing it is
 * not decoration — this surface renders scored equity research in a terminal
 * next to a broker CLI that can place orders.
 */
function disclaimerLines(d, width) {
  const text = d?.disclaimer;
  if (!text) return [];
  return wrapText(text, width - 4).map((line) => `  ${dim(line)}`);
}

function renderSignals(d, { width }) {
  const signals = Array.isArray(d.signals) ? d.signals : [];
  if (!signals.length) return `  ${ash(`no signals indexed for ${d.ticker}`)}`;
  const lines = ["", `  ${acid(d.ticker)}  ${ash(`${signals.length} signals`)}`, ""];
  for (const s of signals.slice(0, 40)) {
    const paint = tone(s.direction);
    const strength = s.strength == null ? "" : ash(` ${num(s.strength)}`);
    lines.push(`  ${paint("•")} ${ash(day(s.event_date))} ${bone(String(s.signal_type ?? "signal"))}${strength}`);
    if (s.speaker) lines.push(`    ${ash(`${s.speaker}${s.speaker_title ? `, ${s.speaker_title}` : ""}`)}`);
    if (s.quote) for (const line of wrapText(s.quote, width - 6)) lines.push(`    ${dim(line)}`);
    if (s.source_url) lines.push(`    ${dim(clip(s.source_url, width - 6))}`);
    lines.push("");
  }
  if (signals.length > 40) lines.push(`  ${ash(`… ${signals.length - 40} more`)}`, "");
  lines.push(...disclaimerLines(d, width));
  return lines.join("\n");
}

function renderSearch(d, { width }) {
  const results = Array.isArray(d.results) ? d.results : [];
  if (!results.length) return `  ${ash(`nothing indexed matches ${JSON.stringify(String(d.query ?? ""))}`)}`;
  const lines = ["", `  ${ash(`${results.length} hits for`)} ${bone(String(d.query ?? ""))}`, ""];
  for (const r of results) {
    const head = [r.ticker ? acid(String(r.ticker)) : null, r.speaker ? bone(String(r.speaker)) : null, ash(day(r.event_date))]
      .filter(Boolean).join(ash(" · "));
    lines.push(`  ${head}`);
    for (const line of wrapText(r.text, width - 6)) lines.push(`    ${dim(line)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function renderLookup(d) {
  const matches = Array.isArray(d.matches) ? d.matches : [];
  if (!matches.length) return `  ${ash(`no ticker matches ${JSON.stringify(String(d.query ?? ""))}`)}`;
  const lines = ["", `  ${ash("matches for")} ${bone(String(d.query ?? ""))}`, ""];
  for (const m of matches) {
    const report = m.hasReport ? acid("  ✓ report") : ash("  · no report yet");
    lines.push(`  ${acid(String(m.symbol).padEnd(8))}${bone(clip(m.name, 44).padEnd(46))}${ash(String(m.exchange ?? ""))}${report}`);
  }
  lines.push("", `  ${ash("then:")} ${bone(`moshcode stocks ${matches[0].symbol}`)}`);
  return lines.join("\n");
}

function renderReports(d) {
  const reports = Array.isArray(d.reports) ? d.reports : [];
  if (!reports.length) return `  ${ash("no stored reports yet")}`;
  const lines = ["", `  ${ash(`${d.total ?? reports.length} stored reports`)}`, ""];
  for (const r of reports) {
    const paint = scoreTone(r.overallScore);
    lines.push(
      `  ${acid(String(r.ticker).padEnd(7))}${paint(String(num(r.overallScore, 1) ?? "—").padStart(5))}` +
      `${ash("/100")}  ${ash(clip(r.classification ?? "", 21).padEnd(22))}` +
      `${bone(money(r.lastPrice).padStart(11))}  ${ash(clip(r.companyName, 28).padEnd(29))}${ash(day(r.generatedAt))}`,
    );
  }
  lines.push("", `  ${ash("detail:")} ${bone(`moshcode stocks ${reports[0].ticker}`)}`);
  return lines.join("\n");
}

function renderDiscover(d, { width }) {
  const ranked = Array.isArray(d.candidates) ? d.candidates : Array.isArray(d.ranked) ? d.ranked : [];
  if (!ranked.length) return `  ${ash("nothing ranked for that topic")}`;
  const provenance = [d.topic, d.provider, d.horizonQuarters ? `${d.horizonQuarters}q horizon` : null]
    .filter(Boolean).join(" · ");
  const lines = ["", `  ${ash(`ranked watchlist${provenance ? ` · ${provenance}` : ""}`)}`, ""];
  for (const c of ranked) {
    const score = c.overallScore ?? c.score;
    lines.push(
      `  ${ash(String(c.rank ?? "").padStart(2))} ${acid(String(c.ticker).padEnd(7))}` +
      `${scoreTone(score)(String(num(score, 1) ?? "—").padStart(5))}${ash("/100")}  ` +
      `${bone(money(c.lastPrice).padStart(10))}  ${ash(clip(c.classification ?? "", 22).padEnd(23))}` +
      `${bone(clip(c.companyName ?? "", 28))}`,
    );
    if (c.thesis) for (const line of wrapText(c.thesis, width - 8)) lines.push(`     ${dim(line)}`);
    if (c.mainRisk) lines.push(`     ${amber("risk")} ${dim(clip(c.mainRisk, width - 12))}`);
    lines.push("");
  }
  lines.push("", ...disclaimerLines(d, width));
  return lines.join("\n");
}

function renderTickers(d) {
  const rows = Array.isArray(d.tickers) ? d.tickers : [];
  if (!rows.length) return `  ${ash("the index is empty")}`;
  const lines = ["", `  ${ash(`${rows.length} tickers in the index`)}`, ""];
  const cells = rows.map((r) => `${acid(String(r.ticker).padEnd(7))}${ash(String(r.n ?? "").padStart(5))}`);
  for (let i = 0; i < cells.length; i += 4) lines.push(`  ${cells.slice(i, i + 4).join("   ")}`);
  return lines.join("\n");
}

function renderStats(d) {
  const rows = [
    ["documents", d.documents], ["news documents", d.news_documents],
    ["transcripts", d.transcripts], ["signals (usable)", d.signals_usable],
    ["signals (boilerplate)", d.signals_boilerplate], ["analyses", d.analyses],
    ["market bars", d.market_bars],
  ].filter(([, v]) => v != null);
  const lines = ["", `  ${ash("advis0r index coverage")}`, ""];
  for (const [label, value] of rows) {
    lines.push(`  ${ash(String(label).padEnd(24))}${bone(Number(value).toLocaleString("en-US"))}`);
  }
  return lines.join("\n");
}

/** Render a decoded API response for one verb. */
export function renderAdvisor(verb, data, { columns } = {}) {
  const width = Math.max(48, Math.min(Number(columns) || 88, 100));
  switch (verb) {
    case "report": return renderReport(data, { width });
    case "signals": return renderSignals(data, { width });
    case "search": return renderSearch(data, { width });
    case "lookup": return renderLookup(data, { width });
    case "reports": return renderReports(data, { width });
    case "discover": return renderDiscover(data, { width });
    case "tickers": return renderTickers(data);
    case "stats": return renderStats(data);
    default: return JSON.stringify(data, null, 2);
  }
}

/**
 * Run a `stocks` invocation end to end. Returns a process exit code.
 *
 * `deps` exists so tests drive the whole command — parse, fetch, render — with
 * no network and no stdout.
 */
export async function stocksCommand(argv = [], deps = {}) {
  const {
    out = (s) => console.log(s),
    fail = (s) => console.error(s),
    fetchImpl,
    base = advisorBase(),
    openUrl,
    columns = process.stdout.columns,
  } = deps;

  const request = stocksArgs(argv);
  if (request.usage) { out(stocksUsage()); return 0; }
  if (request.error) { fail(danger(`✗ ${request.error}`)); return 1; }

  if (request.verb === "open") {
    const url = advisorUrl(request, { base });
    if (request.json) { out(JSON.stringify({ url }, null, 2)); return 0; }
    const opened = openUrl ? openUrl(url) : false;
    out(opened ? `${acid("✓ ")}opened ${bone(url)}` : `${ash("· ")}open this in a browser:\n  ${acid(url)}`);
    return 0;
  }

  const res = await fetchAdvisor(request, { fetchImpl, base });
  if (res.error) { fail(danger(`✗ ${res.error}`)); return 1; }

  // The API's own error bodies are more useful than any message invented here:
  // a bad symbol comes back with a didYouMean and a lookup URL.
  if (!res.ok) {
    const message = res.data?.error || `advis0r returned ${res.status}`;
    if (request.json) { out(JSON.stringify(res.data, null, 2)); return 1; }
    fail(danger(`✗ ${message}`));
    if (res.data?.didYouMean?.symbol) {
      fail(`  ${ash("try:")} ${bone(`moshcode stocks ${res.data.didYouMean.symbol}`)}`);
    }
    return 1;
  }

  if (request.json) { out(JSON.stringify(res.data, null, 2)); return 0; }
  out(renderAdvisor(request.verb, res.data, { columns }));
  return 0;
}
