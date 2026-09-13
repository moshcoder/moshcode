import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  attributeRuns, burn, claudeProjectSlugs, engineRuns, formatTokens, formatUsd,
  parseAiderHistory, totals,
} from "../src/cost.mjs";
import { addUsage, priceUsage, rateFor, totalTokens } from "../src/cost-pricing.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

// os.homedir() reads $HOME on POSIX, which is how these tests point every
// reader at a throwaway tree instead of the machine's real transcripts.
function withHome(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "moshcode-cost-test-"));
  const previous = process.env.HOME;
  process.env.HOME = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    });
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const claudeAssistant = ({ id, requestId, model = "claude-opus-5", at, cwd, sessionId, usage }) => JSON.stringify({
  type: "assistant", timestamp: at, cwd, sessionId, requestId,
  message: { id, model, usage },
});

/** The record Claude Code appends when a session opens a pull request. */
const claudePrLink = ({ number, at, repository = "profullstack/moshcode", sessionId = "s" }) => JSON.stringify({
  type: "pr-link", sessionId, prNumber: number,
  prUrl: `https://github.com/${repository}/pull/${number}`,
  prRepository: repository, timestamp: at,
});

const USAGE = {
  input_tokens: 1000,
  output_tokens: 2000,
  cache_read_input_tokens: 10_000,
  cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 0 },
};

test("pricing", async (t) => {
  await t.test("prices a known model from published rates", () => {
    // 1M input at $5 + 1M output at $25.
    assert.equal(priceUsage("claude-opus-5", { input: 1e6, output: 1e6 }), 30);
  });

  await t.test("cache reads are a tenth of input and 5m writes a quarter more", () => {
    assert.equal(priceUsage("claude-opus-5", { cacheRead: 1e6 }), 0.5);
    assert.equal(priceUsage("claude-opus-5", { cacheWrite5m: 1e6 }), 6.25);
    assert.equal(priceUsage("claude-opus-5", { cacheWrite1h: 1e6 }), 10);
  });

  await t.test("Claude Fable 5.1 reads the cache at a quarter cent, not a tenth of input", () => {
    // Without its own entry the prefix match lands on claude-fable-5 and prices
    // cache reads at $1.00/MTok — four times the published $0.25, on the token
    // class that is most of a long agent session.
    assert.equal(priceUsage("claude-fable-5-1", { cacheRead: 1e6 }), 0.25);
    assert.equal(priceUsage("claude-fable-5-1[1m]", { cacheRead: 1e6 }), 0.25);
    assert.equal(priceUsage("claude-fable-5-1", { input: 1e6, output: 1e6 }), 60);
    // Writes still derive from the input rate: a one-hour write is double it.
    assert.equal(priceUsage("claude-fable-5-1", { cacheWrite1h: 1e6 }), 20);
    assert.equal(priceUsage("claude-fable-5", { cacheRead: 1e6 }), 1);
  });

  await t.test("matches dated snapshots and provider prefixes", () => {
    assert.deepEqual(rateFor("claude-haiku-4-5-20251001"), { input: 1, output: 5 });
    assert.deepEqual(rateFor("anthropic/claude-sonnet-5"), { input: 3, output: 15 });
    assert.deepEqual(rateFor("us.anthropic.claude-opus-5-v1"), { input: 5, output: 25 });
  });

  await t.test("an unpriced model prices as null, never as zero", () => {
    assert.equal(rateFor("gpt-5.6-sol"), null);
    assert.equal(priceUsage("gpt-5.6-sol", { input: 1e6, output: 1e6 }), null);
  });

  await t.test("user pricing wins over the shipped table", () => {
    const userPricing = { "claude-opus-5": { input: 1, output: 1 } };
    assert.equal(priceUsage("claude-opus-5", { input: 1e6, output: 1e6 }, { userPricing }), 2);
    assert.equal(priceUsage("gpt-5.6-sol", { output: 1e6 }, { userPricing: { "gpt-5.6-sol": { input: 1, output: 10 } } }), 10);
  });

  await t.test("missing usage fields count as zero, not NaN", () => {
    assert.equal(priceUsage("claude-opus-5", {}), 0);
    assert.equal(priceUsage("claude-opus-5", { input: undefined, output: null }), 0);
  });

  await t.test("usage adds and totals", () => {
    const sum = addUsage({ input: 1, output: 2 }, { input: 3, cacheRead: 4 });
    assert.equal(sum.input, 4);
    assert.equal(sum.output, 2);
    assert.equal(sum.cacheRead, 4);
    assert.equal(totalTokens(sum), 10);
  });
});

test("claude transcripts", async (t) => {
  await t.test("project slugs cover both spellings of a dotted path", () => {
    const slugs = claudeProjectSlugs("/home/a/.claude/x");
    assert.ok(slugs.includes("-home-a--claude-x"));
  });

  await t.test("sums usage, keeps the cwd, and prices it at API rates", () => withHome(async (home) => {
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    write(path.join(dir, "sess-1.jsonl"), [
      claudeAssistant({ id: "m1", requestId: "r1", at: new Date().toISOString(), cwd, sessionId: "sess-1", usage: USAGE }),
      claudeAssistant({ id: "m2", requestId: "r2", at: new Date().toISOString(), cwd, sessionId: "sess-1", usage: USAGE }),
    ].join("\n"));

    const runs = await engineRuns({ since: Date.now() - 3600e3, engines: ["claude"] });
    assert.equal(runs.length, 1);
    const [run] = runs;
    assert.equal(run.engine, "claude");
    assert.equal(run.id, "sess-1");
    assert.equal(run.cwd, cwd);
    assert.equal(run.usage.input, 2000);
    assert.equal(run.usage.output, 4000);
    assert.equal(run.usage.cacheRead, 20_000);
    assert.equal(run.usage.cacheWrite5m, 8000);
    assert.equal(run.costSource, "rates");
    assert.equal(run.cost, priceUsage("claude-opus-5", run.usage));
  }));

  await t.test("a pr-link record becomes the run's clickable target", () => withHome(async (home) => {
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    write(path.join(dir, "s.jsonl"), [
      claudeAssistant({ id: "m1", requestId: "r1", at: new Date().toISOString(), cwd, sessionId: "s", usage: USAGE }),
      claudePrLink({ number: 42, at: new Date().toISOString() }),
    ].join("\n"));

    const [run] = await engineRuns({ since: Date.now() - 3600e3, engines: ["claude"] });
    assert.equal(run.pr.number, 42);
    assert.equal(run.pr.url, "https://github.com/profullstack/moshcode/pull/42");
    assert.equal(run.pr.repository, "profullstack/moshcode");
  }));

  await t.test("a PR opened before the window still belongs to the run", () => withHome(async (home) => {
    // The window is about which requests to bill, not about which PR the
    // session produced. A run in today's table that opened its PR yesterday is
    // the ordinary case for anything that ran overnight.
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    write(path.join(dir, "s.jsonl"), [
      claudePrLink({ number: 7, at: new Date(Date.now() - 86400e3 * 3).toISOString() }),
      claudeAssistant({ id: "m1", requestId: "r1", at: new Date().toISOString(), cwd, sessionId: "s", usage: USAGE }),
    ].join("\n"));

    const [run] = await engineRuns({ since: Date.now() - 3600e3, engines: ["claude"] });
    assert.equal(run.pr.number, 7);
  }));

  await t.test("two PRs from one session: the newest is the one shown", () => withHome(async (home) => {
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    write(path.join(dir, "s.jsonl"), [
      claudePrLink({ number: 1, at: new Date(Date.now() - 7200e3).toISOString() }),
      claudeAssistant({ id: "m1", requestId: "r1", at: new Date().toISOString(), cwd, sessionId: "s", usage: USAGE }),
      claudePrLink({ number: 2, at: new Date(Date.now() - 60e3).toISOString() }),
    ].join("\n"));

    const [run] = await engineRuns({ since: Date.now() - 3600e3, engines: ["claude"] });
    assert.equal(run.pr.number, 2);
  }));

  await t.test("a pr-link with no usable url is dropped, not shown as a dead link", () => withHome(async (home) => {
    // This string is handed to the terminal's link handler and then to a
    // browser. A transcript is a file on disk, so it is not trusted to hold a
    // scheme we are willing to open.
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    for (const url of ["", "javascript:alert(1)", "file:///etc/passwd", "http://example.com/pull/1", "not a url"]) {
      write(path.join(dir, "s.jsonl"), [
        claudeAssistant({ id: "m1", requestId: "r1", at: new Date().toISOString(), cwd, sessionId: "s", usage: USAGE }),
        JSON.stringify({ type: "pr-link", sessionId: "s", prNumber: 3, prUrl: url, timestamp: new Date().toISOString() }),
      ].join("\n"));
      const [run] = await engineRuns({ since: Date.now() - 3600e3, engines: ["claude"] });
      assert.equal(run.pr, null, `accepted ${JSON.stringify(url)}`);
    }
  }));

  await t.test("a transcript with no PR reports null rather than guessing one", () => withHome(async (home) => {
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    write(path.join(dir, "s.jsonl"), claudeAssistant({ id: "m1", requestId: "r1", at: new Date().toISOString(), cwd, sessionId: "s", usage: USAGE }));

    const [run] = await engineRuns({ since: Date.now() - 3600e3, engines: ["claude"] });
    assert.equal(run.pr, null);
  }));

  await t.test("every request is kept as a sample, on the engine's clock", () => withHome(async (home) => {
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    const earlier = new Date(Date.now() - 600e3).toISOString();
    const later = new Date().toISOString();
    write(path.join(dir, "s.jsonl"), [
      claudeAssistant({ id: "m1", requestId: "r1", at: earlier, cwd, sessionId: "s", usage: USAGE }),
      claudeAssistant({ id: "m2", requestId: "r2", at: later, cwd, sessionId: "s", usage: USAGE }),
    ].join("\n"));

    const [run] = await engineRuns({ since: Date.now() - 3600e3, engines: ["claude"] });
    assert.equal(run.samples.length, 2);
    assert.deepEqual(run.samples.map((s) => s.at), [Date.parse(earlier), Date.parse(later)]);
    assert.equal(run.samples[0].model, "claude-opus-5");
    assert.equal(run.samples[0].usage.output, 2000);
    assert.equal(run.samples[0].engineCost, null);
  }));

  await t.test("a session's subagents and workflow agents fold into its run", () => withHome(async (home) => {
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    const at = new Date().toISOString();
    write(path.join(dir, "s.jsonl"), claudeAssistant({ id: "m1", requestId: "r1", at, cwd, sessionId: "s", usage: USAGE }));
    write(path.join(dir, "s", "subagents", "agent-1.jsonl"), claudeAssistant({ id: "m2", requestId: "r2", at, cwd, sessionId: "s", usage: USAGE }));
    write(path.join(dir, "s", "subagents", "workflows", "wf_1", "agent-2.jsonl"), [
      claudeAssistant({ id: "m3", requestId: "r3", at, cwd, sessionId: "s", usage: USAGE }),
      // The parent replays a subagent's message when it folds the output in:
      // the same id across two files is still one request.
      claudeAssistant({ id: "m1", requestId: "r1", at, cwd, sessionId: "s", usage: USAGE }),
    ].join("\n"));

    const runs = await engineRuns({ since: Date.now() - 3600e3, engines: ["claude"] });
    assert.equal(runs.length, 1, "one session, however many agents it spawned");
    assert.equal(runs[0].id, "s");
    assert.equal(runs[0].usage.output, 6000);
    assert.equal(runs[0].samples.length, 3);
  }));

  await t.test("a replayed message is counted once", () => withHome(async (home) => {
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    const line = claudeAssistant({ id: "m1", requestId: "r1", at: new Date().toISOString(), cwd, sessionId: "s", usage: USAGE });
    write(path.join(dir, "s.jsonl"), [line, line, line].join("\n"));

    const [run] = await engineRuns({ since: Date.now() - 3600e3, engines: ["claude"] });
    assert.equal(run.usage.output, 2000);
  }));

  await t.test("synthetic turns are not a model and are skipped", () => withHome(async (home) => {
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    write(path.join(dir, "s.jsonl"), [
      claudeAssistant({ id: "m1", requestId: "r1", model: "<synthetic>", at: new Date().toISOString(), cwd, sessionId: "s", usage: { input_tokens: 0, output_tokens: 0 } }),
      claudeAssistant({ id: "m2", requestId: "r2", at: new Date().toISOString(), cwd, sessionId: "s", usage: USAGE }),
    ].join("\n"));

    const [run] = await engineRuns({ since: Date.now() - 3600e3, engines: ["claude"] });
    assert.deepEqual(run.models, ["claude-opus-5"]);
    assert.deepEqual(run.unpriced, []);
  }));

  await t.test("narrowing by cwd ignores other projects", () => withHome(async (home) => {
    const at = new Date().toISOString();
    for (const cwd of ["/home/anthony/src/api", "/home/anthony/src/web"]) {
      const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
      write(path.join(dir, "s.jsonl"), claudeAssistant({ id: "m", requestId: "r", at, cwd, sessionId: cwd, usage: USAGE }));
    }
    const runs = await engineRuns({ since: Date.now() - 3600e3, engines: ["claude"], cwd: "/home/anthony/src/api" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].cwd, "/home/anthony/src/api");
  }));

  await t.test("entries older than the window do not count", () => withHome(async (home) => {
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    write(path.join(dir, "s.jsonl"), [
      claudeAssistant({ id: "old", requestId: "r0", at: new Date(Date.now() - 86400e3 * 3).toISOString(), cwd, sessionId: "s", usage: USAGE }),
      claudeAssistant({ id: "new", requestId: "r1", at: new Date().toISOString(), cwd, sessionId: "s", usage: USAGE }),
    ].join("\n"));

    const [run] = await engineRuns({ since: Date.now() - 3600e3, engines: ["claude"] });
    assert.equal(run.usage.output, 2000);
  }));

  await t.test("a malformed line does not lose the file", () => withHome(async (home) => {
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    write(path.join(dir, "s.jsonl"), [
      "{not json at all",
      claudeAssistant({ id: "m", requestId: "r", at: new Date().toISOString(), cwd, sessionId: "s", usage: USAGE }),
    ].join("\n"));

    const runs = await engineRuns({ since: Date.now() - 3600e3, engines: ["claude"] });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].usage.output, 2000);
  }));
});

test("codex rollouts", async (t) => {
  const rollout = ({ cwd, at, total }) => [
    JSON.stringify({ timestamp: at, type: "session_meta", payload: { session_id: "cx-1", cwd, timestamp: at } }),
    JSON.stringify({ timestamp: at, type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    // Cumulative: the earlier event is a prefix of the later one and must not
    // be added to it.
    JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 5, cache_write_input_tokens: 1, output_tokens: 2 } } } }),
    JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total } } }),
  ].join("\n");

  await t.test("reads the last cumulative count and nets out the cached input", () => withHome(async (home) => {
    const at = new Date().toISOString();
    const day = at.slice(0, 10).split("-");
    write(
      path.join(home, ".codex", "sessions", day[0], day[1], day[2], "rollout-x.jsonl"),
      rollout({ cwd: "/home/anthony/src/api", at, total: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 50, output_tokens: 200 } }),
    );

    const [run] = await engineRuns({ since: Date.now() - 3600e3, engines: ["codex"] });
    assert.equal(run.engine, "codex");
    assert.equal(run.id, "cx-1");
    assert.equal(run.usage.input, 400); // 1000 total minus the 600 that were cached
    assert.equal(run.usage.cacheRead, 600);
    assert.equal(run.usage.cacheWrite5m, 50);
    assert.equal(run.usage.output, 200);
    assert.deepEqual(run.models, ["gpt-5.6-sol"]);
    // No published rate for a Codex model, so tokens stand and cost does not.
    assert.equal(run.cost, null);
    assert.deepEqual(run.unpriced, ["gpt-5.6-sol"]);
  }));

  await t.test("a turn is the difference between two running totals", () => withHome(async (home) => {
    const at = new Date().toISOString();
    const day = at.slice(0, 10).split("-");
    write(
      path.join(home, ".codex", "sessions", day[0], day[1], day[2], "rollout-x.jsonl"),
      rollout({ cwd: "/home/anthony/src/api", at, total: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 50, output_tokens: 200 } }),
    );

    const [run] = await engineRuns({ since: Date.now() - 3600e3, engines: ["codex"] });
    assert.equal(run.samples.length, 2);
    // First event: 10 in of which 5 cached → 5 fresh. Second: 400 fresh in all,
    // so 395 for this turn — not 400 again.
    assert.equal(run.samples[0].usage.input, 5);
    assert.equal(run.samples[1].usage.input, 395);
    assert.equal(run.samples[1].usage.output, 198);
    assert.equal(run.samples[1].usage.cacheRead, 595);
    assert.equal(run.samples[1].usage.cacheWrite5m, 49);
    assert.equal(run.samples[0].model, "gpt-5.6-sol");
    assert.equal(run.samples[0].at, Date.parse(at));
  }));

  await t.test("a rollout in another directory is not this directory's cost", () => withHome(async (home) => {
    const at = new Date().toISOString();
    const day = at.slice(0, 10).split("-");
    write(
      path.join(home, ".codex", "sessions", day[0], day[1], day[2], "rollout-x.jsonl"),
      rollout({ cwd: "/home/anthony/src/web", at, total: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } }),
    );
    const runs = await engineRuns({ since: Date.now() - 3600e3, engines: ["codex"], cwd: "/home/anthony/src/api" });
    assert.deepEqual(runs, []);
  }));
});

test("qwen usage log", async (t) => {
  const record = ({ at, session = "qw-1", model = "qwen3.8-max", authType = "openai", source = "main", input, output, cached = 0, thoughts = 0 }) => JSON.stringify({
    schemaVersion: 1, id: `${session}-${at}-${source}`, timestamp: at, sessionId: session,
    model, authType, source,
    inputTokens: input, outputTokens: output, cachedTokens: cached, thoughtsTokens: thoughts,
    totalTokens: input + output,
  });

  const monthFile = (home, at) => path.join(home, ".qwen", "usage", `token-usage-${at.slice(0, 7)}.jsonl`);

  const runtime = (home, { slug, session, workDir }) => write(
    path.join(home, ".qwen", "projects", slug, "chats", `${session}.runtime.json`),
    JSON.stringify({ schema_version: 1, session_id: session, work_dir: workDir }),
  );

  await t.test("sums a session's requests and nets the cached prompt out of input", () => withHome(async (home) => {
    const at = new Date().toISOString();
    runtime(home, { slug: "-home-anthony-src-api", session: "qw-1", workDir: "/home/anthony/src/api" });
    write(monthFile(home, at), [
      record({ at, input: 1000, output: 200, cached: 600, thoughts: 120 }),
      // A subagent's requests carry the session that spawned them.
      record({ at, source: "Explore", input: 500, output: 50, cached: 0 }),
    ].join("\n"));

    const [run] = await engineRuns({ since: Date.now() - 3600e3, engines: ["qwen"] });
    assert.equal(run.engine, "qwen");
    assert.equal(run.id, "qw-1");
    assert.equal(run.cwd, "/home/anthony/src/api");
    assert.equal(run.usage.input, 900); // (1000 - 600) + 500
    assert.equal(run.usage.cacheRead, 600);
    // The OpenAI-compatible path counts reasoning inside `outputTokens`, so the
    // 120 thinking tokens are already in the 200 and must not be added again.
    assert.equal(run.usage.output, 250);
    assert.deepEqual(run.models, ["qwen3.8-max"]);
    // Alibaba rates are deliberately not shipped, so tokens stand and cost does not.
    assert.equal(run.cost, null);
    assert.deepEqual(run.unpriced, ["qwen3.8-max"]);
  }));

  await t.test("the native path reports thinking separately, so it is added back", () => withHome(async (home) => {
    const at = new Date().toISOString();
    write(monthFile(home, at), record({ at, authType: "qwen-oauth", input: 100, output: 40, thoughts: 60 }));
    const [run] = await engineRuns({ since: Date.now() - 3600e3, engines: ["qwen"] });
    assert.equal(run.usage.output, 100);
  }));

  await t.test("a session in another directory is not this directory's cost", () => withHome(async (home) => {
    const at = new Date().toISOString();
    runtime(home, { slug: "-home-anthony-src-web", session: "qw-1", workDir: "/home/anthony/src/web" });
    write(monthFile(home, at), record({ at, input: 10, output: 1 }));
    const runs = await engineRuns({ since: Date.now() - 3600e3, engines: ["qwen"], cwd: "/home/anthony/src/api" });
    assert.deepEqual(runs, []);
  }));

  await t.test("requests older than the window do not count", () => withHome(async (home) => {
    const old = new Date(Date.now() - 48 * 3600e3).toISOString();
    const now = new Date().toISOString();
    write(monthFile(home, now), [
      record({ at: old, input: 999, output: 999 }),
      record({ at: now, input: 10, output: 2 }),
    ].join("\n"));
    const [run] = await engineRuns({ since: Date.now() - 3600e3, engines: ["qwen"] });
    assert.equal(run.usage.input, 10);
    assert.equal(run.usage.output, 2);
  }));

  await t.test("a session with no runtime file still reports, with no directory", () => withHome(async (home) => {
    const at = new Date().toISOString();
    write(monthFile(home, at), record({ at, input: 10, output: 2 }));
    const [run] = await engineRuns({ since: Date.now() - 3600e3, engines: ["qwen"] });
    assert.equal(run.cwd, "");
  }));
});

test("aider history", async (t) => {
  const history = [
    "# aider chat started at 2026-08-16 09:00:00",
    "",
    "> Tokens: 12k sent, 1.1k received. Cost: $0.03 message, $0.03 session.",
    "> Tokens: 8.0k sent, 900 received. Cost: $0.02 message, $0.05 session.",
    "",
    "# aider chat started at 2026-08-16 11:00:00",
    "> Tokens: 1.0M sent, 2k received. Cost: $0.40 message, $0.40 session.",
  ].join("\n");

  await t.test("takes the engine's own running session total", () => {
    const runs = parseAiderHistory(history);
    assert.equal(runs.length, 2);
    // The session figure is cumulative — the last one wins, it is not summed.
    assert.equal(runs[0].engineCost, 0.05);
    assert.equal(runs[0].usage.input, 20_000);
    assert.equal(runs[0].usage.output, 2000);
    assert.equal(runs[1].engineCost, 0.4);
    assert.equal(runs[1].usage.input, 1_000_000);
  });

  await t.test("older runs fall outside the window", () => {
    const runs = parseAiderHistory(history, { since: Date.parse("2026-08-16T10:00:00") });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].engineCost, 0.4);
  });
});

test("attribution", async (t) => {
  const session = (over = {}) => ({ name: "api", engine: "claude", cwd: "/src/api", created: 1000, age: 10, ...over });
  const run = (over = {}) => ({
    engine: "claude", id: "r", cwd: "/src/api", start: 2000, end: 3000,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    models: ["claude-opus-5"], model: "claude-opus-5", cost: 1.5, costSource: "rates", unpriced: [], ...over,
  });

  await t.test("hangs a run on the session that was running in that directory", () => {
    const { rows, unattributed } = attributeRuns([session()], [run()]);
    assert.equal(rows[0].runs.length, 1);
    assert.equal(rows[0].cost, 1.5);
    assert.equal(rows[0].costSource, "rates");
    assert.deepEqual(unattributed, []);
  });

  await t.test("the newest session started before the run wins", () => {
    const older = session({ name: "old", created: 1000 });
    const newer = session({ name: "new", created: 1900 });
    const { rows } = attributeRuns([older, newer], [run()]);
    assert.equal(rows.find((r) => r.name === "new").runs.length, 1);
    assert.equal(rows.find((r) => r.name === "old").runs.length, 0);
  });

  await t.test("a different engine or directory is not a match", () => {
    const { unattributed } = attributeRuns([session({ engine: "codex" })], [run()]);
    assert.equal(unattributed.length, 1);
    const elsewhere = attributeRuns([session({ cwd: "/src/web" })], [run()]);
    assert.equal(elsewhere.unattributed.length, 1);
  });

  await t.test("a run that finished before the session started belongs to neither", () => {
    const { rows, unattributed } = attributeRuns([session({ created: 9000 })], [run()]);
    assert.equal(rows[0].runs.length, 0);
    assert.equal(unattributed.length, 1);
  });

  await t.test("trailing slashes are the same directory", () => {
    const { rows } = attributeRuns([session({ cwd: "/src/api/" })], [run({ cwd: "/src/api" })]);
    assert.equal(rows[0].runs.length, 1);
  });

  await t.test("a measured price and an estimated one sum as estimated", () => {
    const { rows } = attributeRuns([session()], [run(), run({ id: "r2", costSource: "engine", cost: 0.5 })]);
    assert.equal(rows[0].cost, 2);
    assert.equal(rows[0].costSource, "mixed");
  });

  await t.test("totals carry the models nobody priced", () => {
    const { rows } = attributeRuns([session()], [run({ cost: null, costSource: null, unpriced: ["gpt-5.6-sol"] })]);
    const sum = totals(rows);
    assert.equal(sum.cost, null);
    assert.deepEqual(sum.unpriced, ["gpt-5.6-sol"]);
  });
});

test("burn", async (t) => {
  const NOW = Date.parse("2026-09-13T12:00:00Z");
  const usage = { input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }; // $5 on claude-opus-5
  const run = (id, samples, over = {}) => ({ engine: "claude", id, samples, ...over });
  const sample = (minutesAgo, over = {}) => ({ at: NOW - minutesAgo * 60e3, usage, model: "claude-opus-5", engineCost: null, ...over });
  const day = { now: NOW, since: NOW - 24 * 3600e3, userPricing: {} };

  await t.test("every standard window is a row, the report window is last, a longer one is dropped", () => {
    const rows = burn([], { now: NOW, since: NOW - 2 * 3600e3, windowLabel: "window (2h)", userPricing: {} });
    assert.deepEqual(rows.map((r) => r.key), ["1m", "15m", "1h", "window"]);
    assert.equal(rows.at(-1).label, "window (2h)");
    assert.equal(rows.at(-1).ms, 2 * 3600e3);
    assert.deepEqual(burn([], { now: NOW, userPricing: {} }).map((r) => r.key), ["1m", "15m", "1h", "4h", "8h"]);
  });

  await t.test("a request lands in every window that reaches back to it", () => {
    const rows = burn([run("a", [sample(0.5), sample(10), sample(50), sample(200), sample(600)])], day);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    assert.equal(by["1m"].cost, 5);
    assert.equal(by["15m"].cost, 10);
    assert.equal(by["1h"].cost, 15);
    assert.equal(by["4h"].cost, 20);
    assert.equal(by["8h"].cost, 20); // 600 minutes is ten hours: outside
    assert.equal(by.window.cost, 25);
    // Per hour of window, not per hour of activity.
    assert.equal(by["1h"].perHour, 15);
    assert.equal(by["4h"].perHour, 5);
    assert.equal(by.window.perMinute, 25 / (24 * 60));
    assert.equal(by["1m"].costSource, "rates");
    assert.equal(by["1m"].runs, 1);
  });

  await t.test("runs are counted per window and the engine's own price wins", () => {
    const rows = burn([
      run("a", [sample(5)]),
      run("b", [sample(5, { engineCost: 0.75 })], { engine: "opencode" }),
      run("c", [sample(300)]),
    ], day);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    assert.equal(by["15m"].runs, 2);
    assert.equal(by["15m"].cost, 5.75);
    assert.equal(by["15m"].costSource, "mixed");
    assert.deepEqual(by["15m"].engines, { claude: 5, opencode: 0.75 });
    assert.equal(by.window.runs, 3);
  });

  await t.test("an unpriced request is counted and named, never billed as zero", () => {
    const rows = burn([run("x", [sample(1, { model: "gpt-5.6-sol" })], { engine: "codex" })], { now: NOW, since: NOW - 3600e3, userPricing: {} });
    const row = rows.find((r) => r.key === "15m");
    assert.equal(row.cost, null);
    assert.equal(row.perHour, null);
    assert.equal(row.runs, 1);
    assert.deepEqual(row.unpriced, ["gpt-5.6-sol"]);
  });

  await t.test("a sample with no timestamp cannot be placed and is left out", () => {
    const rows = burn([run("a", [{ at: null, usage, model: "claude-opus-5", engineCost: null }])], { now: NOW, since: NOW - 3600e3, userPricing: {} });
    assert.ok(rows.every((r) => r.cost == null && r.runs === 0));
  });
});

test("moshcode cost", async (t) => {
  // The CLI is the only surface: `--json` is what a script reads, so it has to
  // survive the whole path — router, herd verb table, readers, pricing.
  const run = (args, home) => new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, HOME: home, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let error = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { error += c; });
    child.on("exit", (code) => resolve({ code, out, error }));
  });

  await t.test("reports an engine session with no herd behind it", () => withHome(async (home) => {
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    write(path.join(dir, "s.jsonl"), claudeAssistant({
      id: "m", requestId: "r", at: new Date().toISOString(), cwd, sessionId: "s", usage: USAGE,
    }));

    const { code, out } = await run(["cost", "--all", "--json", "--since", "1h"], home);
    assert.equal(code, 0);
    const report = JSON.parse(out);
    assert.equal(report.unattributed.length, 1);
    assert.equal(report.unattributed[0].engine, "claude");
    assert.equal(report.unattributed[0].model, "claude-opus-5");
    assert.equal(report.unattributed[0].costSource, "rates");
    assert.ok(report.totals.cost > 0);
  }));

  await t.test("--all totals the table it just printed", () => withHome(async (home) => {
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    write(path.join(dir, "s.jsonl"), claudeAssistant({
      id: "m", requestId: "r", at: new Date().toISOString(), cwd, sessionId: "s", usage: USAGE,
    }));

    const { code, out } = await run(["cost", "--all", "--since", "1h"], home);
    assert.equal(code, 0);
    // The rows are the runs, so a "$0"/"—" total under a priced row means the
    // footer is summing a different list than the table.
    assert.doesNotMatch(out, /total\s+—/);
    assert.match(out, /total\s+\$\d/);
  }));

  await t.test("--json carries the burn windows over the same runs", () => withHome(async (home) => {
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    write(path.join(dir, "s.jsonl"), claudeAssistant({
      id: "m", requestId: "r", at: new Date().toISOString(), cwd, sessionId: "s", usage: USAGE,
    }));

    const { code, out } = await run(["cost", "--all", "--json", "--since", "1h"], home);
    assert.equal(code, 0);
    const report = JSON.parse(out);
    assert.deepEqual(report.burn.map((b) => b.key), ["1m", "15m", "1h", "window"]);
    assert.equal(report.burn.at(-1).label, "window (1h)");
    // One request, written just now: every row holds it, and it is the total.
    assert.equal(report.burn[0].cost, report.totals.cost);
    assert.equal(report.burn[0].runs, 1);
    assert.ok(report.burn[0].perHour > report.burn[0].cost);
    assert.deepEqual(Object.keys(report.burn[0].engines), ["claude"]);
  }));

  await t.test("the table is followed by the burn block", () => withHome(async (home) => {
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    write(path.join(dir, "s.jsonl"), claudeAssistant({
      id: "m", requestId: "r", at: new Date().toISOString(), cwd, sessionId: "s", usage: USAGE,
    }));

    const { code, out } = await run(["cost", "--all", "--since", "1h"], home);
    assert.equal(code, 0);
    assert.match(out, /burn\s+cost\s+rate\s+runs/);
    assert.match(out, /last 15 min\s+\$[\d.]+~\s+\$[\d.]+\/h\s+1/);
    assert.match(out, /window \(1h\)/);
    assert.match(out, /a minute over the window/);
  }));

  await t.test("an unknown session name is an error, not an empty report", () => withHome(async (home) => {
    const { code, out } = await run(["cost", "nope"], home);
    assert.equal(code, 3);
    assert.match(out, /no session named/);
  }));

  await t.test("an empty machine says so instead of reporting $0", () => withHome(async (home) => {
    const { code, out } = await run(["cost", "--since", "1h"], home);
    assert.equal(code, 0);
    assert.match(out, /the herd is empty/);
  }));

  // `/usage` is the word every coding agent uses for this, so it has to reach
  // the same reader rather than the router's "unknown command".
  await t.test("usage is the same command under the name people type", () => withHome(async (home) => {
    const cwd = "/home/anthony/src/api";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(cwd)[0]);
    write(path.join(dir, "s.jsonl"), claudeAssistant({
      id: "m", requestId: "r", at: new Date().toISOString(), cwd, sessionId: "s", usage: USAGE,
    }));

    const asUsage = await run(["usage", "--all", "--json", "--since", "1h"], home);
    const asCost = await run(["cost", "--all", "--json", "--since", "1h"], home);
    assert.equal(asUsage.code, 0);
    // `since` is the wall clock at the moment each ran, and the burn rows are
    // measured from it, so the clock-derived fields are the ones two identical
    // reports are allowed to disagree about. Costs and counts are not.
    const body = ({ since, burn, ...rest }) => ({
      ...rest,
      burn: burn.map(({ from, ms, perHour, perMinute, ...row }) => row),
    });
    assert.deepEqual(body(JSON.parse(asUsage.out)), body(JSON.parse(asCost.out)));
  }));

  await t.test("--watch and --json are refused together", () => withHome(async (home) => {
    const { code, out } = await run(["cost", "--watch", "--json"], home);
    assert.notEqual(code, 0);
    assert.match(out, /do not go together/);
  }));
});

test("formatting", async (t) => {
  await t.test("money keeps sub-cent amounts visible", () => {
    assert.equal(formatUsd(null), "—");
    assert.equal(formatUsd(0), "$0");
    assert.equal(formatUsd(0.0004), "$0.0004");
    assert.equal(formatUsd(0.25), "$0.250");
    assert.equal(formatUsd(12.345), "$12.35");
  });

  await t.test("tokens scale to k, M and B", () => {
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(1500), "1.5k");
    assert.equal(formatTokens(250_000), "250k");
    assert.equal(formatTokens(2_500_000), "2.5M");
    assert.equal(formatTokens(1_221_000_000), "1.22B");
  });
});
