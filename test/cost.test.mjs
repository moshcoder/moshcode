import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  attributeRuns, claudeProjectSlugs, engineRuns, formatTokens, formatUsd,
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
    // `since` is the wall clock at the moment each ran, so it is the one field
    // two identical reports are allowed to disagree about.
    const body = ({ since, ...rest }) => rest;
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
