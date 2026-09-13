// Swarm (PRD 0015): the flag grammar, the lenient readers of what a model
// says, the gate that keeps a swarm to N at a time, and the four phases run
// against fakes — no tmux, no model.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_AGENTS, MAX_AGENTS, bootAnswer, parsePlan, parseSwarmArgs, parseVerdict, planPrompt, runSwarm,
  swarmCommand, swarmPrefix, synthesisPrompt, throttled, verifyPrompt, waitForPrompt,
} from "../src/swarm.mjs";
import { ENGINES } from "../src/engines.mjs";

/* -------------------------------------------------------------- the flags */

test("the task is every positional word, so the pit and the CLI agree", () => {
  const cli = parseSwarmArgs(["port the auth routes", "--agents", "3"]);
  const pit = parseSwarmArgs(["port", "the", "auth", "routes", "--agents=3"]);
  assert.equal(cli.task, "port the auth routes");
  assert.equal(pit.task, "port the auth routes");
  assert.equal(cli.agents, 3);
  assert.equal(pit.agents, 3);
});

test("four at a time is the default, and the cap is the herd's", () => {
  assert.equal(DEFAULT_AGENTS, 4);
  assert.equal(parseSwarmArgs(["x"]).agents, 4);
  assert.match(parseSwarmArgs(["x", "--agents", "0"]).errors[0], /1 to/);
  assert.match(parseSwarmArgs(["x", "--agents", String(MAX_AGENTS + 1)]).errors[0], /1 to/);
  assert.match(parseSwarmArgs(["x", "--agents", "lots"]).errors[0], /whole number/);
});

test("the four defaults match the claude engine's settings cap", () => {
  // The whole point of the number: a swarm may not run more agents at once
  // than moshcode tells Claude's own workflows to.
  assert.equal(String(DEFAULT_AGENTS), ENGINES.claude.settings.defaults.env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS);
});

test("an unknown flag is an error, not part of the task", () => {
  const parsed = parseSwarmArgs(["fix it", "--fast"]);
  assert.deepEqual(parsed.errors, ["unknown flag --fast"]);
  assert.equal(parsed.task, "fix it");
});

test("--timeout takes the herd's durations", () => {
  assert.equal(parseSwarmArgs(["x", "--timeout", "5m"]).timeoutMs, 300000);
  assert.equal(parseSwarmArgs(["x", "--timeout=90s"]).timeoutMs, 90000);
});

test("session names come from the task and fit the herd's name rule", () => {
  const prefix = swarmPrefix("Port the auth routes and the dashboard to the new API");
  assert.match(prefix, /^swarm-[a-z0-9-]+$/);
  assert.ok(prefix.length + 3 <= 32, "prefix plus -NN must fit NAME_RE");
  assert.equal(swarmPrefix("anything", { name: "api" }), "swarm-api");
  assert.equal(swarmPrefix("!!!"), "swarm-agent", "the herd's own fallback name for a task with no letters");
});

test("claude's trust dialog is answered with Down then Enter, never a bare Enter", () => {
  // Seen live: the dialog's default is "No, exit". A swarm that pressed Enter
  // on "something is blocking at boot" ended its own engine.
  const screen = " Quick safety check: Is this a project you created or one you trust? \n ❯ No, exit\n   Yes, I trust this folder\n";
  const answer = bootAnswer("claude", screen);
  assert.ok(answer, "the trust dialog was not recognised");
  assert.deepEqual(answer.keys, ["Down", "Enter"]);
  assert.equal(bootAnswer("claude", "? for shortcuts"), null);
  assert.equal(bootAnswer("codex", screen), null, "an engine with no boot spec answers nothing");
});

test("waiting for the prompt answers a boot dialog once and then sees idle", async () => {
  const trust = " Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder";
  let screens = [trust, trust, "? for shortcuts"];
  let states = ["unknown", "unknown", "idle"];
  const answers = [];
  let t = 0;
  const result = await waitForPrompt("s", {
    engine: "claude", timeoutMs: 10000, intervalMs: 1, now: () => (t += 1),
    look: () => ({ name: "s", alive: true, state: states.shift() ?? "idle" }),
    screen: () => screens.shift() ?? "",
    answer: (name, keys) => answers.push(keys),
  });
  assert.deepEqual(result, { outcome: "matched", state: "idle" });
  assert.deepEqual(answers, [["Down", "Enter"]], "the same dialog is never answered twice");
});

test("waiting for the prompt gives up on a session that ends or times out", async () => {
  const ended = await waitForPrompt("s", {
    engine: "claude", timeoutMs: 10000, intervalMs: 1,
    look: () => ({ name: "s", alive: false, state: "done" }), screen: () => "", answer: () => {},
  });
  assert.equal(ended.outcome, "ended");
  let t = 0;
  const late = await waitForPrompt("s", {
    engine: "claude", timeoutMs: 5, intervalMs: 1, now: () => (t += 3),
    look: () => ({ name: "s", alive: true, state: "unknown" }), screen: () => "", answer: () => {},
  });
  assert.equal(late.outcome, "timeout");
  const gone = await waitForPrompt("s", { engine: "claude", look: () => null, screen: () => "", answer: () => {} });
  assert.equal(gone.outcome, "gone");
});

/* ------------------------------------------------------------ the readers */

test("the plan is the first JSON array in the reply, whatever surrounds it", () => {
  const reply = 'Sure! Here is the split:\n```json\n[{"title":"a","prompt":"do a"},{"title":"b","prompt":"do b"}]\n```\nGood luck.';
  assert.deepEqual(parsePlan(reply), [{ title: "a", prompt: "do a" }, { title: "b", prompt: "do b" }]);
});

test("a plan is capped at --agents and drops entries with no prompt", () => {
  const reply = JSON.stringify([{ title: "a", prompt: "x" }, { title: "b" }, { prompt: "y" }, { title: "d", prompt: "z" }]);
  const plan = parsePlan(reply, { agents: 2 });
  assert.deepEqual(plan.map((p) => p.prompt), ["x", "y"]);
  assert.equal(plan[1].title, "piece 2", "an untitled piece still gets a name");
});

test("a plan that does not parse is null, not a throw", () => {
  assert.equal(parsePlan("I cannot split this."), null);
  assert.equal(parsePlan("[not json"), null);
  assert.equal(parsePlan("[]"), null);
  assert.equal(parsePlan('{"title":"a","prompt":"b"}'), null);
});

test("a verdict is read leniently and defaults to unknown", () => {
  assert.deepEqual(parseVerdict('{"refuted": false, "reason": "it shows the diff"}'), { refuted: false, reason: "it shows the diff" });
  assert.equal(parseVerdict("no").refuted, null);
  assert.equal(parseVerdict('{"reason":"hmm"}').refuted, null);
});

/* ------------------------------------------------------------ the prompts */

test("the planning prompt asks for pieces that do not collide, as bare JSON", () => {
  const p = planPrompt({ task: "T", agents: 3, cwd: "/x" });
  assert.match(p, /at most 3/);
  assert.match(p, /do not edit the same files/);
  assert.match(p, /ONLY a JSON array/);
  assert.match(p, /SUMMARY:/);
  assert.match(p, /\/x/);
  assert.ok(p.endsWith("T"));
});

test("the headless calls are told to think, not act", () => {
  // Seen live: a synthesis run in the working directory did the task itself
  // instead of summarising what the agents had done.
  const guard = /Do not run commands, read or write files, or use any tool/;
  assert.match(planPrompt({ task: "T", agents: 2, cwd: "/x" }), guard);
  assert.match(verifyPrompt({ task: "T", piece: { title: "a", prompt: "a" }, output: "o" }), guard);
  assert.match(synthesisPrompt({ task: "T", results: [] }), guard);
});

test("the verifier is told to refute and to default to refuted", () => {
  const p = verifyPrompt({ task: "T", piece: { title: "a", prompt: "do a" }, output: "did a" });
  assert.match(p, /Try to refute/);
  assert.match(p, /Default to refuted=true/);
  assert.match(p, /did a$/);
});

test("the synthesis carries every piece, its state, and its verdict", () => {
  const p = synthesisPrompt({ task: "T", results: [
    { title: "a", state: "done", artifact: "A!" },
    { title: "b", state: "failed", artifact: "", verified: { refuted: true, reason: "no diff" } },
  ] });
  assert.match(p, /piece 1: a \(done\)/);
  assert.match(p, /piece 2: b \(failed, review: REFUTED — no diff\)/);
  assert.match(p, /A!/);
  assert.match(p, /\(no output captured\)/);
});

/* -------------------------------------------------------------- the gate */

test("throttled runs at most N at a time and keeps order", async () => {
  let running = 0, peak = 0;
  const out = await throttled([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5 * (7 - n)));
    running--;
    return n * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
});

/* ------------------------------------------------------------- the phases */

function fakes({ plan, verdict = { refuted: false, reason: "fine" }, synthesis = "THE ANSWER", failStart = [], neverReady = [] } = {}) {
  const calls = { ai: [], start: [], boot: [], prompt: [], kill: [] };
  let running = 0, peak = 0;
  const deps = {
    ai: (engine, prompt) => {
      calls.ai.push({ engine, prompt });
      if (prompt.startsWith("You are planning")) return typeof plan === "string" ? plan : JSON.stringify(plan);
      if (prompt.startsWith("You are a skeptical")) return JSON.stringify(verdict);
      return synthesis;
    },
    start: (name, opts) => { calls.start.push({ name, ...opts }); return failStart.includes(name) ? { ok: false, error: "tmux said no" } : { ok: true }; },
    boot: async (name) => { calls.boot.push(name); return neverReady.includes(name) ? { outcome: "timeout", state: "working" } : { outcome: "matched", state: "idle" }; },
    prompt: async (name, text) => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      calls.prompt.push({ name, text });
      return { ok: true, task: `t-${name}`, outcome: "matched", state: "done", artifact: `output of ${name}`, error: null };
    },
    kill: async (name) => { calls.kill.push(name); },
  };
  return { deps, calls, peak: () => peak };
}

const engineOf = () => "claude";

test("a swarm plans, fans out, kills its sessions, and synthesises", async () => {
  const { deps, calls } = fakes({ plan: [{ title: "a", prompt: "do a\nthen b" }, { title: "b", prompt: "do b" }] });
  const lines = [];
  const result = await runSwarm({ task: "T", agents: 4, cwd: "/x", herd: "swarm", timeoutMs: 1000 }, { write: (l) => lines.push(l), deps, engineOf });
  assert.equal(result.ok, true);
  assert.equal(result.engine, "claude");
  assert.deepEqual(result.plan.map((p) => p.title), ["a", "b"]);
  assert.deepEqual(calls.start.map((s) => s.name), ["swarm-t-1", "swarm-t-2"]);
  assert.equal(calls.start[0].herd, "swarm");
  assert.equal(calls.start[0].cwd, "/x");
  assert.equal(calls.prompt[0].text, "do a then b", "a newline in a prompt would submit it early");
  assert.deepEqual(calls.kill, ["swarm-t-1", "swarm-t-2"], "sessions are ended when the swarm is done");
  assert.equal(result.results[1].task, "t-swarm-t-2");
  assert.equal(result.results[1].artifact, "output of swarm-t-2");
  assert.equal(result.synthesis, "THE ANSWER");
  const synth = calls.ai.at(-1).prompt;
  assert.match(synth, /output of swarm-t-1/);
  assert.match(synth, /output of swarm-t-2/);
  assert.equal(calls.ai.length, 2, "plan, synthesis — and no verifier unless asked");
});

test("--agents caps the plan as well as gating the sessions", async () => {
  // A model that answers with more pieces than it was asked for does not get
  // to run more agents than the operator allowed.
  const plan = Array.from({ length: 6 }, (_, i) => ({ title: `p${i}`, prompt: `do ${i}` }));
  const f = fakes({ plan });
  const result = await runSwarm({ task: "T", agents: 2, cwd: "/x", herd: "swarm", timeoutMs: 1000 }, { deps: f.deps, engineOf });
  assert.equal(result.results.length, 2);
  assert.ok(f.peak() <= 2);
});

test("a plan the model fluffs becomes one piece holding the whole task, and says so", async () => {
  const { deps, calls } = fakes({ plan: "I would rather not." });
  const lines = [];
  const result = await runSwarm({ task: "T", agents: 4, cwd: "/x", herd: "swarm", timeoutMs: 1000 }, { write: (l) => lines.push(l), deps, engineOf });
  assert.equal(result.plan.length, 1);
  assert.match(result.plan[0].prompt, /^T\b/);
  assert.match(result.plan[0].prompt, /SUMMARY:/);
  assert.ok(lines.some((l) => /did not parse/.test(l)));
  assert.equal(calls.start.length, 1);
});

test("a planning call that throws degrades the same way", async () => {
  const f = fakes({ plan: [] });
  f.deps.ai = (engine, prompt) => { if (prompt.startsWith("You are planning")) throw new Error("boom"); return "S"; };
  const lines = [];
  const result = await runSwarm({ task: "T", agents: 4, cwd: "/x", herd: "swarm", timeoutMs: 1000 }, { write: (l) => lines.push(l), deps: f.deps, engineOf });
  assert.equal(result.ok, true);
  assert.equal(result.plan.length, 1);
  assert.ok(lines.some((l) => /planning failed \(boom\)/.test(l)));
});

test("a piece whose session never starts or never boots is failed, not fatal", async () => {
  const { deps, calls } = fakes({
    plan: [{ title: "a", prompt: "a" }, { title: "b", prompt: "b" }, { title: "c", prompt: "c" }],
    failStart: ["swarm-t-1"], neverReady: ["swarm-t-2"],
  });
  const result = await runSwarm({ task: "T", agents: 4, cwd: "/x", herd: "swarm", timeoutMs: 1000 }, { deps, engineOf });
  assert.equal(result.ok, true, "the synthesis still ran");
  assert.deepEqual(result.results.map((r) => r.state), ["failed", "failed", "done"]);
  assert.match(result.results[0].error, /tmux said no/);
  assert.match(result.results[1].error, /never became ready/);
  assert.deepEqual(calls.kill, ["swarm-t-2", "swarm-t-3"], "a session that booted but never answered is still ended; one that never started is not");
  assert.match(calls.ai.at(-1).prompt, /piece 1: a \(failed\)/);
});

test("--verify attaches a verdict to every piece and shows it to the synthesis", async () => {
  const { deps, calls } = fakes({ plan: [{ title: "a", prompt: "a" }], verdict: { refuted: true, reason: "claims a test it never ran" } });
  const result = await runSwarm({ task: "T", agents: 4, cwd: "/x", herd: "swarm", timeoutMs: 1000, verify: true }, { deps, engineOf });
  assert.deepEqual(result.results[0].verified, { refuted: true, reason: "claims a test it never ran" });
  assert.equal(calls.ai.length, 3, "plan, verify, synthesis");
  assert.match(calls.ai[1].prompt, /output of swarm-t-1/);
  assert.match(calls.ai.at(-1).prompt, /REFUTED — claims a test it never ran/);
});

test("--keep leaves the sessions running", async () => {
  const { deps, calls } = fakes({ plan: [{ title: "a", prompt: "a" }] });
  const result = await runSwarm({ task: "T", agents: 4, cwd: "/x", herd: "swarm", timeoutMs: 1000, keep: true }, { deps, engineOf });
  assert.deepEqual(calls.kill, []);
  assert.equal(result.kept, true);
});

test("--plan-only starts nothing", async () => {
  const { deps, calls } = fakes({ plan: [{ title: "a", prompt: "a" }, { title: "b", prompt: "b" }] });
  const result = await runSwarm({ task: "T", agents: 4, cwd: "/x", herd: "swarm", timeoutMs: 1000, planOnly: true }, { deps, engineOf });
  assert.equal(result.planOnly, true);
  assert.equal(result.plan.length, 2);
  assert.equal(calls.start.length, 0);
  assert.equal(calls.ai.length, 1);
});

test("no installed engine is a clear error", async () => {
  const result = await runSwarm({ task: "T", agents: 4, cwd: "/x", herd: "swarm", timeoutMs: 1000 }, { deps: fakes().deps, engineOf: () => null });
  assert.equal(result.ok, false);
  assert.match(result.error, /install claude/);
});

/* ------------------------------------------------------------- the command */

test("the command needs a task", async () => {
  const lines = [];
  assert.equal(await swarmCommand([], { write: (l) => lines.push(l) }), 1);
  assert.match(lines.join("\n"), /usage: moshcode swarm/);
});

test("the command refuses an engine nobody has heard of before touching anything", async () => {
  const lines = [];
  assert.equal(await swarmCommand(["do it", "--engine", "hal9000"], { write: (l) => lines.push(l) }), 1);
  assert.match(lines.join("\n"), /no engine named "hal9000"/);
});

test("--json prints the run as data and narrates nothing", async () => {
  const { deps } = fakes({ plan: [{ title: "a", prompt: "a" }] });
  const lines = [];
  const code = await swarmCommand(["T", "--json"], { write: (l) => lines.push(l), deps, engineOf });
  assert.equal(code, 0);
  assert.equal(lines.length, 1, "one JSON document, no narration");
  const data = JSON.parse(lines[0]);
  assert.equal(data.synthesis, "THE ANSWER");
  assert.equal(data.results[0].session, "swarm-t-1");
});

test("the human form ends with the answer, the ledger, and the count", async () => {
  const { deps } = fakes({ plan: [{ title: "a", prompt: "a" }, { title: "b", prompt: "b" }] });
  const lines = [];
  const code = await swarmCommand(["T"], { write: (l) => lines.push(l), deps, engineOf });
  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.match(text, /THE ANSWER/);
  assert.match(text, /2 pieces finished/);
  assert.match(text, /moshcode herd task t-swarm-t-1/);
});

test("a failed piece is a non-zero exit even though the answer was written", async () => {
  const { deps } = fakes({ plan: [{ title: "a", prompt: "a" }], failStart: ["swarm-t-1"] });
  const lines = [];
  const code = await swarmCommand(["T"], { write: (l) => lines.push(l), deps, engineOf });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /0 of 1 pieces finished; 1 failed/);
});
