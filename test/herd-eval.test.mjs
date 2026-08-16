// Evals: the dataset shapes, the two judges, and the three outcomes CI has to
// be able to tell apart.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_THRESHOLD, extractVerdict, judgePrompt, loadDataset, parseCsv,
  resolveEngines, runEval, scoreByJudge, scoreByRules,
} from "../src/herd-eval.mjs";

function withFile(name, body, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-eval-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  try { return fn(file); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/* --------------------------------------------------------------- datasets */

test("a jsonl dataset is one case per line", () => {
  withFile("d.jsonl", '{"prompt":"a","expect":"x"}\n{"prompt":"b","rubric":"is it right?"}\n', (file) => {
    const { ok, cases } = loadDataset(file);
    assert.equal(ok, true);
    assert.equal(cases.length, 2);
    assert.equal(cases[0].expect, "x");
    assert.equal(cases[1].rubric, "is it right?");
    assert.equal(cases[0].id, "case-1", "a case with no id still needs a handle in the report");
  });
});

test("a csv dataset survives quotes, commas and newlines inside a prompt", () => {
  // A dataset is a file somebody wrote by hand or exported from a spreadsheet,
  // and those two shapes are the whole requirement.
  const rows = parseCsv('prompt,expect\n"say ""hi"", then stop",hi\n"two\nlines",x\n');
  assert.deepEqual(rows[1], ['say "hi", then stop', "hi"]);
  assert.deepEqual(rows[2], ["two\nlines", "x"]);
});

test("a csv dataset loads by header name", () => {
  withFile("d.csv", "prompt,expect\nrun the tests,passed\n", (file) => {
    const { cases } = loadDataset(file);
    assert.equal(cases[0].prompt, "run the tests");
    assert.equal(cases[0].expect, "passed");
  });
});

test("a case with no prompt is the dataset's error, and is named as one", () => {
  withFile("d.jsonl", '{"expect":"x"}\n', (file) => {
    const result = loadDataset(file);
    assert.equal(result.ok, false);
    assert.match(String(result.error.message), /case 1 has no prompt/);
  });
});

test("a malformed line names its line number", () => {
  withFile("d.jsonl", '{"prompt":"a"}\n{oops\n', (file) => {
    assert.match(String(loadDataset(file).error.message), /:2 is not valid JSON/);
  });
});

test("a missing dataset is a failure to load, not an empty run", () => {
  assert.equal(loadDataset("/nope/nothing.jsonl").ok, false);
});

/* ---------------------------------------------------------------- scoring */

test("the rules judge treats the expectation as a loose pattern", () => {
  assert.equal(scoreByRules({ expect: "3 tests passed" }, "…\n3 TESTS PASSED\n").score, 1);
  assert.equal(scoreByRules({ expect: "^done$" }, "done").score, 1);
  assert.equal(scoreByRules({ expect: "passed" }, "everything failed").score, 0);
});

test("a case with no expectation is unscorable, not a zero", () => {
  // A missing expectation is the dataset's bug. Scoring it against the engine
  // would mark a good answer wrong for a reason the engine cannot fix.
  const verdict = scoreByRules({ prompt: "x" }, "a fine answer");
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /needs a judge, or an expectation/);
});

test("an unparseable expectation falls back to a substring rather than throwing", () => {
  assert.equal(scoreByRules({ expect: "a(b" }, "xxa(bxx").score, 1);
});

test("the judge's verdict is pulled out of whatever prose it wrapped it in", () => {
  assert.deepEqual(extractVerdict('Sure!\n{"score": 0.5, "why": "partly"}\nHope that helps'), { score: 0.5, why: "partly" });
  assert.equal(extractVerdict("no json here"), null);
});

test("a judge that does not answer with a score is unscorable, not a zero", () => {
  const verdict = scoreByJudge({ prompt: "x" }, "answer", { engine: "claude", run: () => "I'd rather not" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.score, 0);
  assert.match(verdict.why, /did not answer with a score/);
});

test("a judge that throws is reported, not allowed to end the run", () => {
  const verdict = scoreByJudge({ prompt: "x" }, "answer", { engine: "claude", run: () => { throw new Error("no engine installed"); } });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /no engine installed/);
});

test("the judge is asked for JSON and given the rubric", () => {
  const prompt = judgePrompt({ prompt: "port the routes", rubric: "did it keep the auth middleware?" }, "I ported them");
  assert.match(prompt, /RUBRIC: did it keep the auth middleware\?/);
  assert.match(prompt, /"score"/);
});

test("a judged score is clamped to the range it is supposed to be in", () => {
  assert.equal(scoreByJudge({}, "a", { run: () => '{"score": 4}' }).score, 1);
  assert.equal(scoreByJudge({}, "a", { run: () => '{"score": -2}' }).score, 0);
});

/* ------------------------------------------------------------- the report */

const cases = [{ id: "one", prompt: "p1", expect: "good" }, { id: "two", prompt: "p2", expect: "good" }];
const fakeRun = (answers) => async (engine) => ({
  engine, ok: true, session: `eval-${engine}`,
  results: cases.map((c, i) => ({ ...c, engine, taskId: `t-${i}`, ok: true, answer: answers[engine][i], state: "idle" })),
});

test("an engine below the threshold is a distinct outcome from a broken harness", async () => {
  // The whole point of the exit codes: CI has to tell "the agent got worse"
  // apart from "the box fell over", and one non-zero code cannot say both.
  const report = await runEval({
    cases, engines: ["claude", "codex"], threshold: 0.8,
    run: fakeRun({ claude: ["good", "good"], codex: ["good", "bad"] }),
  });
  assert.equal(report.outcome, "below");
  assert.deepEqual(report.below, ["codex"]);
  assert.equal(report.engines.find((e) => e.engine === "claude").score, 1);
  assert.equal(report.engines.find((e) => e.engine === "codex").score, 0.5);
});

test("everything at or above the threshold passes", async () => {
  const report = await runEval({ cases, engines: ["claude"], threshold: 1, run: fakeRun({ claude: ["good", "good"] }) });
  assert.equal(report.outcome, "pass");
  assert.deepEqual(report.below, []);
});

test("an engine that could not start is infrastructure, not a bad score", async () => {
  const report = await runEval({
    cases, engines: ["claude"],
    run: async (engine) => ({ engine, ok: false, error: "no such binary", results: [] }),
  });
  assert.equal(report.outcome, "infrastructure");
  assert.deepEqual(report.broken, [{ engine: "claude", error: "no such binary" }]);
});

test("infrastructure trouble outranks a low score in the outcome", async () => {
  const report = await runEval({
    cases, engines: ["claude", "codex"], threshold: 0.9,
    run: async (engine) => (engine === "claude"
      ? { engine, ok: false, error: "gone", results: [] }
      : (await fakeRun({ codex: ["bad", "bad"] })(engine))),
  });
  assert.equal(report.outcome, "infrastructure", "a broken run must not be reported as a failing engine");
});

test("unscorable cases are counted and shown, not quietly averaged in", async () => {
  const report = await runEval({
    cases: [{ id: "one", prompt: "p" }], engines: ["claude"],
    run: async (engine) => ({ engine, ok: true, results: [{ id: "one", prompt: "p", engine, taskId: "t", answer: "x" }] }),
  });
  assert.equal(report.engines[0].unscorable, 1);
});

test("engine names resolve through the same aliases as everywhere else", () => {
  assert.deepEqual(resolveEngines("cc,codex").keys, ["claude", "codex"]);
  assert.deepEqual(resolveEngines("cc,cc").keys, ["claude"], "asking for one engine twice is one engine");
  assert.deepEqual(resolveEngines("nope").unknown, ["nope"]);
});

test("the default threshold is a number, not a vibe", () => {
  assert.ok(DEFAULT_THRESHOLD > 0 && DEFAULT_THRESHOLD <= 1);
});
