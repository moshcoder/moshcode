// What a million tokens costs, per model, so `moshcode cost` can turn the token
// counts an engine wrote down into dollars.
//
// TOKENS ARE THE MEASUREMENT; DOLLARS ARE THE ESTIMATE. Only some engines
// record a price of their own (opencode computes one per message, aider prints
// a running session total). The rest — Claude Code, Codex — record usage and
// nothing else, because the person running them is usually on a subscription
// where the marginal request costs nothing extra. What this table produces for
// those is "what these tokens would have cost at published API rates", which is
// the number worth watching while a herd of agents burns through a repo, and is
// not a bill. src/cost.mjs keeps the two apart: `costSource` is "engine" when
// the engine priced it and "rates" when this table did.
//
// A model with no entry is NOT guessed at. Its tokens are still counted and
// reported, its cost comes back null, and `moshcode cost` names it under the
// table so you can price it yourself. A wrong number that looks authoritative is worse
// than an honest blank — especially for engines whose vendors we don't track.
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/**
 * Published rates, USD per million tokens.
 *
 * `input`/`output` are the base rates. `cacheRead` and `cacheWrite` are
 * optional; when absent they are derived from `input` by CACHE_MULTIPLIERS
 * below, which is Anthropic's published relationship (and the only vendor whose
 * cache pricing this file claims to know).
 *
 * Anthropic rates as published 2026-06; Sonnet 5's introductory $2/$10 runs
 * through 2026-08-31 and is deliberately not encoded — an intro rate that
 * expires silently would make this table wrong on a date nobody is watching.
 */
export const PRICING = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  // No OpenAI, Google, Moonshot or Alibaba entries on purpose. Their coding
  // CLIs are sold as subscriptions with model names that do not appear on a
  // public price list (`gpt-5.6-sol` is what a Codex rollout actually records),
  // so anything written here would be invented. Price them yourself:
  //
  //   ~/.moshcode/pricing.json
  //   { "gpt-5.6-sol": { "input": 1.25, "output": 10 } }
};

/**
 * Cache tokens as a multiple of the input rate: a read is a tenth of a fresh
 * input token, a five-minute write is a quarter more, a one-hour write is
 * double. Claude Code's transcript distinguishes the two write TTLs
 * (`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`), so both are here
 * rather than one blended guess.
 */
export const CACHE_MULTIPLIERS = { read: 0.1, write5m: 1.25, write1h: 2 };

/** Where a user's own rates live. Merged over PRICING, never under it. */
export const pricingFile = () => path.join(homedir(), ".moshcode", "pricing.json");

/**
 * User overrides. Never throws — a malformed pricing file must not take down a
 * cost report, and reporting tokens with no price is already a supported state.
 */
export function loadUserPricing(file = pricingFile()) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return {}; }
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [model, rate] of Object.entries(raw)) {
    if (!rate || typeof rate !== "object") continue;
    const input = Number(rate.input);
    const output = Number(rate.output);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    const entry = { input, output };
    if (Number.isFinite(Number(rate.cacheRead))) entry.cacheRead = Number(rate.cacheRead);
    if (Number.isFinite(Number(rate.cacheWrite))) entry.cacheWrite = Number(rate.cacheWrite);
    out[String(model).toLowerCase()] = entry;
  }
  return out;
}

/**
 * The rate card for one model id, or null when nobody has priced it.
 *
 * Matching is deliberately forgiving, in three steps, because the string an
 * engine writes down is not always the string a price list uses:
 *   1. exact, lowercased — `claude-opus-5`
 *   2. dated snapshot stripped — `claude-haiku-4-5-20251001` → `claude-haiku-4-5`
 *   3. longest table key that the model id starts with — so a provider prefix
 *      (`anthropic/claude-opus-5`, `us.anthropic.claude-opus-5-v1`) still finds
 *      its rate rather than reading as an unknown model.
 * A user entry wins at every step: pricing you wrote down beats pricing we
 * shipped, including for a model we already know.
 */
export function rateFor(model, { userPricing = loadUserPricing() } = {}) {
  if (!model) return null;
  const id = String(model).trim().toLowerCase();
  if (!id) return null;
  const table = { ...PRICING, ...userPricing };

  if (Object.hasOwn(table, id)) return table[id];

  const undated = id.replace(/-\d{8}$/, "");
  if (undated !== id && Object.hasOwn(table, undated)) return table[undated];

  let best = null;
  for (const key of Object.keys(table)) {
    if (!id.includes(key)) continue;
    if (!best || key.length > best.length) best = key;
  }
  return best ? table[best] : null;
}

/**
 * Dollars for one usage bundle, or null when the model has no rate.
 *
 * `usage` is the shape src/cost.mjs normalises every engine into:
 * { input, output, cacheRead, cacheWrite5m, cacheWrite1h }. Missing fields are
 * zero — an engine that never reports cache tokens must not price as NaN.
 */
export function priceUsage(model, usage = {}, options = {}) {
  const rate = rateFor(model, options);
  if (!rate) return null;
  const m = 1e6;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const readRate = rate.cacheRead ?? rate.input * CACHE_MULTIPLIERS.read;
  const writeRate = rate.cacheWrite ?? rate.input * CACHE_MULTIPLIERS.write5m;
  const write1hRate = rate.cacheWrite ?? rate.input * CACHE_MULTIPLIERS.write1h;
  return (
    (num(usage.input) * rate.input
      + num(usage.output) * rate.output
      + num(usage.cacheRead) * readRate
      + num(usage.cacheWrite5m) * writeRate
      + num(usage.cacheWrite1h) * write1hRate) / m
  );
}

/** Sum usage bundles into one. */
export function addUsage(a = {}, b = {}) {
  const keys = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"];
  const out = {};
  for (const k of keys) out[k] = (Number(a[k]) || 0) + (Number(b[k]) || 0);
  return out;
}

export const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

/** Every token in a bundle, cache included — the "how much did it read" number. */
export const totalTokens = (u = {}) =>
  (Number(u.input) || 0) + (Number(u.output) || 0)
  + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite5m) || 0) + (Number(u.cacheWrite1h) || 0);
