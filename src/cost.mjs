// What the agents are spending, read out of the agent CLIs themselves.
//
// Every engine moshcode wraps already writes down what it used — Claude Code
// keeps a per-message `usage` block in ~/.claude/projects/**/<session>.jsonl,
// Codex emits cumulative `token_count` events into ~/.codex/sessions/…, and
// opencode stores a per-message `cost` it computed itself in SQLite. Nobody has
// to be instrumented and nothing has to be proxied: the numbers are on disk
// because the CLI put them there. This module reads them, normalises them into
// one usage shape, and (for the engines that record tokens and no price) prices
// them through src/cost-pricing.mjs.
//
// PREFER THE ENGINE'S OWN NUMBER. When a CLI computed a cost, that cost is
// reported as-is with `costSource: "engine"` — it knows which model actually
// served the request and what the account pays. Only when there is no such
// number do we multiply tokens by a rate card and mark it `costSource: "rates"`.
// The distinction is carried all the way to the rendered table, because one is
// a measurement and the other is an estimate.
//
// ATTRIBUTION IS A HEURISTIC AND SAYS SO. An engine's session log has no idea a
// herd exists. A run is matched to a herd session by engine, directory, and
// time — the most recently started session in that directory running that
// engine, at the time the run began. That is right for the ordinary case (one
// agent per directory) and can be wrong when two sessions of the same engine
// share a directory; `moshcode cost --json` carries the run list so the raw
// attribution is inspectable rather than implied.
import fs from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import { EMPTY_USAGE, addUsage, priceUsage, loadUserPricing } from "./cost-pricing.mjs";

/** Default reporting window: today's work, not the whole history on disk. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

const home = () => homedir();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ---------------------------------------------------------------------------
// File plumbing
// ---------------------------------------------------------------------------

function safeStat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/**
 * The last `bytes` of a file as whole lines.
 *
 * Codex writes one cumulative `token_count` event per turn, so the answer is
 * always near the end of a rollout that can be tens of megabytes. Reading the
 * tail keeps a cost report cheap enough to put in front of `moshcode ps`.
 */
function tailLines(file, bytes = 256 * 1024) {
  const stat = safeStat(file);
  if (!stat) return [];
  const start = Math.max(0, stat.size - bytes);
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(bytes, stat.size));
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    // A read that began mid-file almost certainly began mid-line; that first
    // fragment is not parseable JSON and must not be handed on as if it were.
    return (start > 0 ? text.slice(text.indexOf("\n") + 1) : text).split("\n");
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}

/** The first `bytes` of a file as whole lines (the trailing fragment dropped). */
function headLines(file, bytes = 512 * 1024) {
  const stat = safeStat(file);
  if (!stat) return [];
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(bytes, stat.size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    if (stat.size > buf.length) lines.pop();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}

const parseJson = (line) => {
  try { return JSON.parse(line); } catch { return null; }
};

const stamp = (value) => {
  const t = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
};

/** Paths compare after resolution, so `~/src/api` and `~/src/api/` are one place. */
const samePath = (a, b) => {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(String(p)).replace(/\/+$/, "");
  return norm(a) === norm(b);
};

// ---------------------------------------------------------------------------
// Claude Code — ~/.claude/projects/<slug>/<session>.jsonl
// ---------------------------------------------------------------------------

/**
 * Claude Code names a project directory after the working directory with every
 * character that isn't a letter or digit replaced by a dash, so `/home/a/.x`
 * becomes `-home-a--x`. Both spellings are produced here because the exact
 * character class has changed across releases and an unreadable transcript is
 * indistinguishable from a free session — guessing one slug and finding nothing
 * would silently report $0.
 */
export function claudeProjectSlugs(cwd) {
  const p = path.resolve(String(cwd || ""));
  return [...new Set([p.replace(/[^A-Za-z0-9]/g, "-"), p.replace(/[/.]/g, "-")])];
}

const claudeProjectsDir = () => path.join(home(), ".claude", "projects");

/** Claude Code's stand-in model id for a turn it produced without an API call. */
const SYNTHETIC_MODEL = "<synthetic>";

function claudeUsageOf(message) {
  const u = message?.usage;
  if (!u) return null;
  const creation = u.cache_creation || {};
  // Both TTLs are recorded separately when present; the flat
  // `cache_creation_input_tokens` is the older shape and prices as a 5m write.
  const write5m = num(creation.ephemeral_5m_input_tokens);
  const write1h = num(creation.ephemeral_1h_input_tokens);
  const flat = num(u.cache_creation_input_tokens);
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite5m: write5m || write1h ? write5m : flat,
    cacheWrite1h: write1h,
  };
}

/** One Claude Code transcript → one run, or null when it holds no usage. */
function readClaudeTranscript(file, { since }) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }

  const seen = new Set();
  const byModel = new Map();
  let usage = { ...EMPTY_USAGE };
  let engineCost = 0;
  let hasEngineCost = false;
  let start = null;
  let end = null;
  let cwd = "";
  let id = path.basename(file, ".jsonl");

  for (const line of text.split("\n")) {
    if (!line || line.charCodeAt(0) !== 123) continue; // fast reject: not "{"
    const entry = parseJson(line);
    if (!entry || entry.type !== "assistant") continue;
    const at = stamp(entry.timestamp);
    if (at != null && since != null && at < since) continue;

    const message = entry.message;
    // `<synthetic>` is Claude Code's marker for a message it wrote itself — an
    // API error surfaced as an assistant turn, a cancellation notice. No
    // request was made, so it is not a model anyone can price and its zero
    // usage would otherwise show up as an unpriced model in the report.
    if (message?.model === SYNTHETIC_MODEL) continue;
    const one = claudeUsageOf(message);
    if (!one) continue;

    // A transcript replays the same assistant message when a session is resumed
    // or a subagent's output is folded back in. Claude's own pair of ids is the
    // only thing that distinguishes a genuine second request from an echo.
    const key = `${message.id || ""}|${entry.requestId || ""}`;
    if (key !== "|" && seen.has(key)) continue;
    seen.add(key);

    usage = addUsage(usage, one);
    const model = message.model || "unknown";
    byModel.set(model, addUsage(byModel.get(model) || EMPTY_USAGE, one));
    if (Number.isFinite(Number(entry.costUSD))) { engineCost += Number(entry.costUSD); hasEngineCost = true; }
    if (at != null) { start = start == null ? at : Math.min(start, at); end = end == null ? at : Math.max(end, at); }
    if (entry.cwd) cwd = entry.cwd;
    if (entry.sessionId) id = entry.sessionId;
  }

  if (!seen.size) return null;
  return { engine: "claude", id, cwd, usage, byModel, start, end, engineCost: hasEngineCost ? engineCost : null };
}

function claudeRuns({ since, cwd } = {}) {
  const root = claudeProjectsDir();
  const dirs = cwd
    ? claudeProjectSlugs(cwd).map((slug) => path.join(root, slug)).filter((d) => safeStat(d)?.isDirectory())
    : listDir(root).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));

  const runs = [];
  for (const dir of dirs) {
    for (const entry of listDir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const file = path.join(dir, entry.name);
      // mtime is the cheap gate: a transcript untouched since before the window
      // cannot contain a request inside it, and there are thousands of these.
      const stat = safeStat(file);
      if (!stat || (since != null && stat.mtimeMs < since)) continue;
      const run = readClaudeTranscript(file, { since });
      if (!run) continue;
      // The slug is lossy, so confirm against the cwd the transcript recorded.
      if (cwd && run.cwd && !samePath(run.cwd, cwd)) continue;
      runs.push({ ...run, cwd: run.cwd || cwd || "" });
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Codex — ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// ---------------------------------------------------------------------------

const codexSessionsDir = () => path.join(home(), ".codex", "sessions");

/**
 * Codex's `total_token_usage` is cumulative for the whole rollout, so the last
 * event is the answer and earlier ones are prefixes of it. `input_tokens`
 * there *includes* the cached portion, so the fresh input is the difference —
 * counting both would bill the cache twice at the full input rate.
 */
function codexUsageOf(info) {
  const t = info?.total_token_usage || {};
  const cached = num(t.cached_input_tokens);
  return {
    input: Math.max(0, num(t.input_tokens) - cached),
    output: num(t.output_tokens),
    cacheRead: cached,
    cacheWrite5m: num(t.cache_write_input_tokens),
    cacheWrite1h: 0,
  };
}

function readCodexRollout(file, { since, cwd }) {
  const head = headLines(file);
  let meta = null;
  let model = "";
  for (const line of head) {
    const entry = parseJson(line);
    if (!entry) continue;
    if (entry.type === "session_meta" && !meta) meta = entry.payload || {};
    if (entry.type === "turn_context" && entry.payload?.model) model = entry.payload.model;
    if (meta && model) break;
  }
  if (!meta) return null;
  if (cwd && meta.cwd && !samePath(meta.cwd, cwd)) return null;

  const tail = tailLines(file);
  let last = null;
  for (const line of tail) {
    const entry = parseJson(line);
    if (!entry) continue;
    if (entry.payload?.type === "token_count" && entry.payload?.info) last = entry;
    // The model can change mid-rollout; the last turn_context wins.
    if (entry.type === "turn_context" && entry.payload?.model) model = entry.payload.model;
  }
  if (!last) return null;

  const end = stamp(last.timestamp);
  const start = stamp(meta.timestamp) ?? end;
  // A rollout that finished before the window still has its cumulative total in
  // it; including it would bill yesterday's work against today.
  if (since != null && end != null && end < since) return null;

  const usage = codexUsageOf(last.payload.info);
  return {
    engine: "codex",
    id: meta.session_id || meta.id || path.basename(file, ".jsonl"),
    cwd: meta.cwd || cwd || "",
    usage,
    byModel: new Map([[model || "unknown", usage]]),
    start, end, engineCost: null,
  };
}

function codexRuns({ since, cwd } = {}) {
  const root = codexSessionsDir();
  const runs = [];
  // The tree is YYYY/MM/DD, which is a date filter you can walk without opening
  // anything: a whole day older than the window is skipped by name.
  const cutoffDay = since != null ? new Date(since - 24 * 60 * 60 * 1000).toISOString().slice(0, 10) : null;
  for (const y of listDir(root)) {
    if (!y.isDirectory()) continue;
    for (const m of listDir(path.join(root, y.name))) {
      if (!m.isDirectory()) continue;
      for (const d of listDir(path.join(root, y.name, m.name))) {
        if (!d.isDirectory()) continue;
        if (cutoffDay && `${y.name}-${m.name}-${d.name}` < cutoffDay) continue;
        const dir = path.join(root, y.name, m.name, d.name);
        for (const f of listDir(dir)) {
          if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
          const file = path.join(dir, f.name);
          const stat = safeStat(file);
          if (!stat || (since != null && stat.mtimeMs < since)) continue;
          const run = readCodexRollout(file, { since, cwd });
          if (run) runs.push(run);
        }
      }
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// opencode / privacycode — SQLite, and it priced the messages itself
// ---------------------------------------------------------------------------

const OPENCODE_DBS = {
  opencode: () => path.join(home(), ".local", "share", "opencode", "opencode.db"),
  // A fork that kept the schema and the file name, under its own data dir.
  privacycode: () => path.join(home(), ".local", "share", "privacycode", "opencode.db"),
};

/**
 * Open a live SQLite database without disturbing it.
 *
 * Read-only is the first attempt and usually works. When the database is in WAL
 * mode and its shared-memory file is missing, SQLite cannot open it read-only
 * at all — so the fallback copies the three files somewhere private and reads
 * the copy. Never write to the original: opencode may be running on it.
 */
async function openReadonly(file) {
  if (!safeStat(file)) return null;
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { return null; } // no built-in sqlite on this runtime; opencode is simply not reported
  try {
    return { db: new DatabaseSync(file, { readOnly: true }), cleanup: () => {} };
  } catch { /* fall through to the copy */ }
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(tmpdir(), "moshcode-cost-"));
    for (const suffix of ["", "-wal", "-shm"]) {
      if (safeStat(file + suffix)) fs.copyFileSync(file + suffix, path.join(dir, path.basename(file) + suffix));
    }
    const db = new DatabaseSync(path.join(dir, path.basename(file)));
    return { db, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } };
  } catch {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
    return null;
  }
}

async function opencodeRuns(engine, { since, cwd } = {}) {
  const handle = await openReadonly(OPENCODE_DBS[engine]());
  if (!handle) return [];
  const { db, cleanup } = handle;
  const bySession = new Map();
  try {
    const rows = db.prepare(
      "select session_id, time_created, data from message where time_created >= ? order by time_created",
    ).all(since ?? 0);
    for (const row of rows) {
      const data = parseJson(row.data);
      if (!data || data.role !== "assistant") continue;
      if (cwd && data.path?.cwd && !samePath(data.path.cwd, cwd)) continue;
      const t = data.tokens || {};
      const one = {
        input: num(t.input),
        // Reasoning tokens are billed as output and reported separately.
        output: num(t.output) + num(t.reasoning),
        cacheRead: num(t.cache?.read),
        cacheWrite5m: num(t.cache?.write),
        cacheWrite1h: 0,
      };
      const key = row.session_id;
      const run = bySession.get(key) || {
        engine, id: key, cwd: data.path?.cwd || cwd || "",
        usage: { ...EMPTY_USAGE }, byModel: new Map(),
        start: null, end: null, engineCost: 0,
      };
      run.usage = addUsage(run.usage, one);
      const model = data.modelID || "unknown";
      run.byModel.set(model, addUsage(run.byModel.get(model) || EMPTY_USAGE, one));
      // opencode records the price it computed per message — that is the
      // authoritative number and the rate card never gets a vote on it.
      run.engineCost += num(data.cost);
      const at = num(row.time_created) || stamp(data.time?.created);
      if (at) { run.start = run.start == null ? at : Math.min(run.start, at); run.end = run.end == null ? at : Math.max(run.end, at); }
      bySession.set(key, run);
    }
  } catch {
    // A schema that moved under us is a reason to report nothing for this
    // engine, not a reason to fail the whole report.
  } finally {
    try { db.close(); } catch { /* already closed */ }
    cleanup();
  }
  return [...bySession.values()];
}

// ---------------------------------------------------------------------------
// aider — it prints the running total into its own chat history
// ---------------------------------------------------------------------------

/** "12.3k" / "1.1M" / "450" as aider writes token counts. */
function parseCount(raw) {
  const m = /^([\d.]+)\s*([kKmM])?$/.exec(String(raw).trim());
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const scale = m[2] ? { k: 1e3, m: 1e6 }[m[2].toLowerCase()] : 1;
  return Math.round(n * scale);
}

/**
 * aider keeps `.aider.chat.history.md` beside the code and writes a line like
 *   > Tokens: 12k sent, 1.1k received. Cost: $0.03 message, $0.24 session.
 * after every exchange, with a `# aider chat started at …` banner between runs.
 * The session figure is cumulative, so the last one in a segment is that run's
 * total — and it is aider's own arithmetic, not ours.
 */
export function parseAiderHistory(text, { since } = {}) {
  const runs = [];
  const lines = String(text).split("\n");
  let current = null;
  const close = () => { if (current && (current.engineCost || current.usage.input || current.usage.output)) runs.push(current); current = null; };

  for (const line of lines) {
    const banner = /^#\s*aider chat started at\s+(.+?)\s*$/i.exec(line);
    if (banner) {
      close();
      current = {
        engine: "aider", id: banner[1].trim(), cwd: "",
        usage: { ...EMPTY_USAGE }, byModel: new Map(),
        start: stamp(banner[1].replace(" ", "T")), end: null, engineCost: 0,
      };
      continue;
    }
    const tokens = /Tokens:\s*([\d.]+\s*[kKmM]?)\s*sent,\s*([\d.]+\s*[kKmM]?)\s*received/.exec(line);
    const cost = /Cost:\s*\$([\d.]+)\s*message,\s*\$([\d.]+)\s*session/.exec(line);
    if (!tokens && !cost) continue;
    // A history file that starts mid-run (rotated, or hand-edited) still has
    // numbers worth reporting; give them a run with an unknown start.
    if (!current) current = { engine: "aider", id: "aider", cwd: "", usage: { ...EMPTY_USAGE }, byModel: new Map(), start: null, end: null, engineCost: 0 };
    if (tokens) {
      current.usage = addUsage(current.usage, { input: parseCount(tokens[1]), output: parseCount(tokens[2]) });
    }
    if (cost) current.engineCost = Number(cost[2]) || current.engineCost;
  }
  close();
  return runs.filter((r) => since == null || r.start == null || r.start >= since);
}

function aiderRuns({ since, cwd } = {}) {
  // Unlike the others, aider's record lives in the project, so there is nothing
  // to scan when no directory was named.
  if (!cwd) return [];
  const file = path.join(cwd, ".aider.chat.history.md");
  const stat = safeStat(file);
  if (!stat || (since != null && stat.mtimeMs < since)) return [];
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  return parseAiderHistory(text, { since }).map((run) => ({ ...run, cwd, end: run.end ?? stat.mtimeMs }));
}

// ---------------------------------------------------------------------------
// The readers, and the runs they produce
// ---------------------------------------------------------------------------

/**
 * Which engines can be costed, and how. An engine absent from here is not free
 * — it is unreported, and `moshcode cost` says so rather than showing $0.
 */
export const COST_READERS = {
  claude: (opts) => claudeRuns(opts),
  codex: (opts) => codexRuns(opts),
  opencode: (opts) => opencodeRuns("opencode", opts),
  privacycode: (opts) => opencodeRuns("privacycode", opts),
  aider: (opts) => aiderRuns(opts),
};

/** Engines moshcode can launch but cannot cost — named so the report can say so. */
export const UNCOSTED_ENGINES = ["gemini", "kimi", "qwen", "deepseek", "openagents"];

/**
 * Finish a run: price it, and record where the price came from.
 *
 * A run whose model has no rate keeps its tokens and reports `cost: null`. The
 * caller renders that as a blank, never as zero.
 */
function priceRun(run, options) {
  const models = [...run.byModel.keys()];
  let cost = null;
  let costSource = null;
  let unpriced = [];

  if (run.engineCost != null && run.engineCost > 0) {
    cost = run.engineCost;
    costSource = "engine";
  } else {
    let total = 0;
    let any = false;
    for (const [model, usage] of run.byModel) {
      const priced = priceUsage(model, usage, options);
      if (priced == null) { unpriced.push(model); continue; }
      total += priced;
      any = true;
    }
    if (any) { cost = total; costSource = "rates"; }
  }
  return { ...run, models, model: models[0] || "unknown", cost, costSource, unpriced, byModel: undefined };
}

/**
 * Every engine session on this machine inside the window, priced.
 *
 * `engines` narrows the readers, `cwd` narrows to one directory (which is also
 * the only way aider can be read at all). Runs come back newest-last.
 */
export async function engineRuns({
  since = Date.now() - DEFAULT_WINDOW_MS,
  cwd = null,
  engines = null,
  userPricing = loadUserPricing(),
} = {}) {
  const wanted = engines?.length ? engines.filter((e) => Object.hasOwn(COST_READERS, e)) : Object.keys(COST_READERS);
  const collected = await Promise.all(wanted.map(async (engine) => {
    // One engine's data being unreadable must not cost the report the others.
    try { return await COST_READERS[engine]({ since, cwd }); }
    catch { return []; }
  }));
  return collected
    .flat()
    .map((run) => priceRun(run, { userPricing }))
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/**
 * Hang each run on the herd session that produced it.
 *
 * The match is engine + directory + "started before this run did", newest such
 * session wins. Runs that match nothing are returned separately rather than
 * spread across the sessions that happen to be nearby — a total that quietly
 * absorbed another terminal's work would be worse than an honest "unattributed"
 * line.
 */
export function attributeRuns(sessions = [], runs = []) {
  const rows = sessions.map((s) => ({ ...s, runs: [], usage: { ...EMPTY_USAGE }, cost: null, costSource: null, unpriced: [] }));
  const unattributed = [];

  for (const run of runs) {
    const at = run.start ?? run.end ?? 0;
    let best = null;
    for (const row of rows) {
      if (row.engine !== run.engine) continue;
      if (row.cwd && run.cwd && !samePath(row.cwd, run.cwd)) continue;
      const created = row.created ?? 0;
      // A run that predates the session belongs to whatever came before it.
      if (created > (run.end ?? at)) continue;
      if (!best || created > (best.created ?? 0)) best = row;
    }
    if (!best) { unattributed.push(run); continue; }
    best.runs.push(run);
  }

  for (const row of rows) {
    for (const run of row.runs) {
      row.usage = addUsage(row.usage, run.usage);
      if (run.cost != null) row.cost = (row.cost ?? 0) + run.cost;
      // A session that mixes a measured price with an estimated one is
      // estimated: the weaker claim is the true one for the sum.
      if (run.costSource) row.costSource = row.costSource && row.costSource !== run.costSource ? "mixed" : run.costSource;
      row.unpriced.push(...(run.unpriced || []));
    }
    row.unpriced = [...new Set(row.unpriced)];
    row.models = [...new Set(row.runs.flatMap((r) => r.models))];
  }

  return { rows, unattributed };
}

/** Grand total across priced rows, plus what could not be priced. */
export function totals(items = []) {
  let cost = null;
  let usage = { ...EMPTY_USAGE };
  const unpriced = new Set();
  for (const item of items) {
    usage = addUsage(usage, item.usage);
    if (item.cost != null) cost = (cost ?? 0) + item.cost;
    for (const m of item.unpriced || []) unpriced.add(m);
  }
  return { cost, usage, unpriced: [...unpriced] };
}

// ---------------------------------------------------------------------------
// Formatting helpers, shared by the CLI and the bar
// ---------------------------------------------------------------------------

/**
 * Money, at a precision that matches the amount. Sub-cent costs are the normal
 * case for a single turn, and "$0.00" for four tenths of a cent reads as free.
 */
export function formatUsd(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/** 1_234_567 → "1.2M". Token columns are for scale, not for arithmetic. */
export function formatTokens(value) {
  const n = num(value);
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 10e3 ? 1 : 0)}k`;
  // A week of cache reads runs to billions, and "1221.0M" is a number nobody
  // reads at a glance.
  if (n < 1e9) return `${(n / 1e6).toFixed(1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}
