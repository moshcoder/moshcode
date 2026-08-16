// `moshcode herd eval` — which engine is best at *this* repo (PRD 0011 R13).
//
// "Which engine should I use" is answered on the internet with benchmarks run
// against engines nobody deploys, on repos nobody has. The herd can answer it
// the only way that means anything: run your dataset through the engines you
// actually have, on the machine you actually work on, and count.
//
// Nothing here is new machinery. A row is fanned across the named engines with
// the verbs that already exist — start a session, prompt it, wait, read what
// came back out of the ledger — and scored either by a pattern the dataset
// carries or by an engine acting as judge (the `ai()` verb, which is the same
// headless invocation moshscript uses). The exit code follows `wait`'s
// discipline, because a CI job needs to tell "the agent got worse" apart from
// "the harness fell over", and a single non-zero code cannot.
//
// The DO Gradient ADK ships `gradient agent evaluate --dataset-file --categories
// --success-threshold` for deployed agents. This is that idea pointed at
// interactive engines, which is the comparison nobody else is placed to run.
import fs from "node:fs";
import path from "node:path";

import { runAi } from "./cli.mjs";
import { ENGINES, resolveEngine, resolveExecutable } from "./engines.mjs";
import { capture, killSession, listSessions, sendPrompt, startSession } from "./herd.mjs";
import { endTask, screenDelta, startTask } from "./herd-tasks.mjs";

export const DEFAULT_THRESHOLD = 0.8;

/* --------------------------------------------------------------- datasets */

/**
 * A minimal CSV reader: quoted fields, doubled quotes, embedded newlines.
 *
 * Deliberately not a dependency. A dataset is a file someone wrote by hand or
 * exported from a spreadsheet, and those two shapes are the whole requirement.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const src = String(text ?? "").replace(/\r\n/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => String(cell).trim()));
}

/**
 * Read a dataset. `.jsonl` is one object per line, `.json` an array, `.csv` a
 * header row plus rows. Every shape ends up as the same list of cases.
 *
 * A case is { id, prompt, expect?, rubric? }: the prompt to submit, an optional
 * pattern the answer must match (the `rules` judge), and an optional rubric for
 * an engine judge to score against.
 */
export function loadDataset(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) { return { ok: false, error }; }

  const ext = path.extname(file).toLowerCase();
  let raw;
  try {
    if (ext === ".csv") {
      const rows = parseCsv(text);
      if (!rows.length) return { ok: false, error: new Error(`${file} is empty`) };
      const header = rows[0].map((h) => String(h).trim().toLowerCase());
      raw = rows.slice(1).map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
    } else if (ext === ".json") {
      const parsed = JSON.parse(text);
      raw = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cases) ? parsed.cases : null;
      if (!raw) return { ok: false, error: new Error(`${file} must hold an array of cases`) };
    } else {
      raw = text.split("\n").filter((l) => l.trim()).map((line, i) => {
        try { return JSON.parse(line); }
        catch (error) { throw new Error(`${file}:${i + 1} is not valid JSON (${error.message})`); }
      });
    }
  } catch (error) { return { ok: false, error }; }

  const cases = [];
  for (const [i, entry] of raw.entries()) {
    const prompt = String(entry?.prompt ?? entry?.input ?? "").trim();
    if (!prompt) return { ok: false, error: new Error(`${file}: case ${i + 1} has no prompt`) };
    cases.push({
      id: String(entry.id ?? `case-${i + 1}`),
      prompt,
      expect: entry.expect ? String(entry.expect) : null,
      rubric: entry.rubric ? String(entry.rubric) : null,
    });
  }
  if (!cases.length) return { ok: false, error: new Error(`${file} holds no cases`) };
  return { ok: true, cases };
}

/* ---------------------------------------------------------------- scoring */

/**
 * The `rules` judge: does the answer match what the dataset expected?
 *
 * The pattern is a regex, case-insensitive, because a dataset written by hand
 * says `expect: "3 tests passed"` and means it loosely. A case with no
 * expectation cannot be scored by rules, and says so rather than scoring zero —
 * a missing expectation is the dataset's bug, not the engine's.
 */
export function scoreByRules(testCase, answer) {
  if (!testCase.expect) {
    return { ok: false, score: 0, why: "no `expect` pattern — this case needs a judge, or an expectation" };
  }
  let re;
  try { re = new RegExp(testCase.expect, "i"); }
  catch { re = null; }
  const hit = re ? re.test(String(answer ?? "")) : String(answer ?? "").toLowerCase().includes(testCase.expect.toLowerCase());
  return { ok: true, score: hit ? 1 : 0, why: hit ? "matched the expectation" : "did not match the expectation" };
}

/** Pull the first JSON object out of an engine's answer. */
export function extractVerdict(text) {
  const raw = String(text ?? "");
  const start = raw.indexOf("{");
  if (start < 0) return null;
  for (let end = raw.lastIndexOf("}"); end > start; end = raw.lastIndexOf("}", end - 1)) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* keep shrinking */ }
  }
  return null;
}

export function judgePrompt(testCase, answer) {
  return [
    "You are grading one answer produced by a coding agent. Reply with JSON only.",
    "",
    `TASK: ${testCase.prompt}`,
    testCase.rubric ? `RUBRIC: ${testCase.rubric}` : "RUBRIC: is this a correct, complete, and directly responsive answer to the task?",
    "",
    "ANSWER:",
    String(answer ?? "").slice(-6000),
    "",
    'Reply with exactly: {"score": <0 to 1>, "why": "<one sentence>"}',
  ].join("\n");
}

/** The engine judge. Returns { ok, score, why } and never throws. */
export function scoreByJudge(testCase, answer, { engine, run = runAi, out = () => {} } = {}) {
  let text;
  try { text = run({ out, dryRun: false }, judgePrompt(testCase, answer), { engine }); }
  catch (error) { return { ok: false, score: 0, why: `judge failed: ${String(error.message || error)}` }; }
  const verdict = extractVerdict(text);
  if (!verdict || typeof verdict.score !== "number" || !Number.isFinite(verdict.score)) {
    return { ok: false, score: 0, why: `judge did not answer with a score (${String(text).trim().slice(0, 120)})` };
  }
  return { ok: true, score: Math.max(0, Math.min(1, verdict.score)), why: String(verdict.why || "").slice(0, 200) };
}

/* ----------------------------------------------------------------- running */

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Run every case against one engine, in its own session.
 *
 * Sequential within an engine because a terminal is a terminal: two prompts
 * typed into one session at once interleave into one prompt neither of them
 * asked. Engines run against each other in parallel, which is the fan-out.
 */
export async function runEngine(engineKey, cases, {
  waitFor,
  cwd = process.cwd(),
  timeoutMs = 10 * 60 * 1000,
  session = `eval-${engineKey}`,
  keep = false,
  out = () => {},
  now = () => Date.now(),
} = {}) {
  const engine = ENGINES[engineKey];
  if (!engine) return { engine: engineKey, ok: false, error: `unknown engine ${engineKey}`, results: [] };

  const already = listSessions().some((s) => s.name === session && s.alive);
  if (!already) {
    const bin = resolveExecutable(engine.bin, engine.binDirs || []) || engine.bin;
    const started = startSession({ name: session, engine: engineKey, bin, args: engine.agentArgs || [], stripEnv: engine.stripEnv || [], cwd });
    if (!started.ok) {
      // Infrastructure, not quality. Reported as such so a missing engine never
      // reads as an engine that failed the dataset.
      return { engine: engineKey, ok: false, error: String(started.error?.message || started.error), results: [] };
    }
    // An engine needs a moment to draw its first screen; prompting into a
    // terminal that has not finished starting types into nothing.
    await sleep(4000);
  }

  const results = [];
  for (const testCase of cases) {
    const at = now();
    const baseline = capture(session, { lines: 60 });
    const taskId = startTask(session, testCase.prompt, { screen: baseline, now: at });
    const sent = sendPrompt(session, testCase.prompt);
    if (!sent.ok) {
      endTask(session, taskId, { state: "done", artifact: "", ts: now() });
      results.push({ ...testCase, engine: engineKey, taskId, ok: false, answer: "", error: String(sent.error?.message || sent.error) });
      continue;
    }
    await waitFor(session, ["working"], { timeoutMs: 8000, intervalMs: 500 });
    const outcome = await waitFor(session, ["blocked", "done", "idle"], { timeoutMs });
    const answer = screenDelta(baseline, capture(session, { lines: 400 }));
    endTask(session, taskId, { state: outcome.state, artifact: answer, ts: now() });
    out(`  ${engineKey} · ${testCase.id} · ${outcome.outcome} (${outcome.state})`);
    results.push({ ...testCase, engine: engineKey, taskId, ok: outcome.outcome === "matched", answer, outcome: outcome.outcome, state: outcome.state });
  }

  if (!already && !keep) killSession(session);
  return { engine: engineKey, ok: true, session, results };
}

/**
 * The whole run: fan the dataset across the engines, score, and total up.
 *
 * `waitFor` is injected rather than imported so the runner can be exercised
 * without a herd — the alternative is a test that starts real engines, which is
 * not a test anyone will run.
 */
export async function runEval({
  cases,
  engines,
  judge = "rules",
  threshold = DEFAULT_THRESHOLD,
  waitFor,
  cwd = process.cwd(),
  timeoutMs = 10 * 60 * 1000,
  keep = false,
  out = () => {},
  judgeRun = runAi,
  // Injected so the scoring and aggregation — the parts with the decisions in
  // them — can be tested without starting an engine. A test that needs Claude
  // installed is a test nobody runs.
  run = runEngine,
} = {}) {
  const runs = await Promise.all(engines.map((engineKey) =>
    run(engineKey, cases, { waitFor, cwd, timeoutMs, keep, out })));

  const engineResults = runs.map((run) => {
    if (!run.ok) return { engine: run.engine, ok: false, error: run.error, score: 0, cases: [] };
    const scored = run.results.map((result) => {
      const verdict = judge === "rules"
        ? scoreByRules(result, result.answer)
        : scoreByJudge(result, result.answer, { engine: judge, run: judgeRun, out });
      return {
        id: result.id, prompt: result.prompt, taskId: result.taskId,
        answer: result.answer, state: result.state ?? null,
        score: verdict.score, why: verdict.why, scored: verdict.ok,
        ...(result.error ? { error: result.error } : {}),
      };
    });
    const total = scored.reduce((sum, c) => sum + c.score, 0);
    return {
      engine: run.engine,
      ok: true,
      score: scored.length ? total / scored.length : 0,
      passed: scored.filter((c) => c.score >= 1).length,
      unscorable: scored.filter((c) => !c.scored).length,
      cases: scored,
    };
  });

  const infrastructure = engineResults.filter((e) => !e.ok);
  const below = engineResults.filter((e) => e.ok && e.score < threshold);
  return {
    judge, threshold,
    engines: engineResults,
    // The three outcomes CI needs to tell apart, decided here rather than at
    // the exit-code site, so `--json` and the exit code cannot disagree.
    outcome: infrastructure.length ? "infrastructure" : below.length ? "below" : "pass",
    below: below.map((e) => e.engine),
    broken: infrastructure.map((e) => ({ engine: e.engine, error: e.error })),
  };
}

/** Resolve `--engines a,b` to canonical keys, naming anything it cannot. */
export function resolveEngines(list) {
  const wanted = String(list || "").split(",").map((s) => s.trim()).filter(Boolean);
  const keys = [], unknown = [];
  for (const name of wanted) {
    const resolved = resolveEngine(name);
    if (resolved) keys.push(resolved[0]);
    else unknown.push(name);
  }
  return { keys: [...new Set(keys)], unknown };
}
