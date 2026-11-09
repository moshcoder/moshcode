// The handoff brief, redaction, evidence and checks, and the c0mpute target.
//
// The brief is what the next engine believes first, so the tests here are
// about provenance: a claim must never be dressed as an observation, a failing
// check must never read as a pass, and a secret must never reach the file.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { redact } from "../src/redact.mjs";
import {
  buildBrief, checksFor, collectEvidence, detectChecks, estimateTokens, packageManager, runChecks, verdict,
} from "../src/handoff-brief.mjs";
import { buildTranscript, handoffCommand, parseHandoff, planHandoff, seedPrompt } from "../src/handoff.mjs";
import { claudeProjectSlugs } from "../src/cost.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/handoff", import.meta.url));
const CWD = "/work/api";

function tmp(prefix = "moshcode-brief-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function withHome(fn) {
  const dir = tmp("moshcode-handoff-");
  const saved = { HOME: process.env.HOME, OPENFLEET_HOME: process.env.OPENFLEET_HOME, MOSHCODE_HOME: process.env.MOSHCODE_HOME };
  process.env.HOME = dir;
  process.env.OPENFLEET_HOME = path.join(dir, ".openfleet");
  process.env.MOSHCODE_HOME = path.join(dir, ".moshcode");
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(dir, { recursive: true, force: true });
    });
}

function plantClaude(home) {
  const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(CWD)[0]);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "c41b501f-de0a-411d-90a9-1e858636a4c2.jsonl"), fs.readFileSync(path.join(FIXTURES, "claude-session.jsonl"), "utf8"));
}

/* ------------------------------------------------------------------ redaction */

test("redaction removes the common secret shapes and says which", () => {
  const secrets = [
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
    "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "AKIAIOSFODNN7EXAMPLE",
    "ik_live_abcdef0123456789xyz",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ];
  const text = [
    ...secrets.map((s) => `token ${s} here`),
    "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345' https://api",
    "DATABASE_URL=postgres://app:hunter2hunter2@db:5432/app",
    "OPENAI_API_KEY=notarealkeybutlongenough",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  const { text: out, hits } = redact(text);
  for (const s of secrets) assert.ok(!out.includes(s), `${s} survived`);
  assert.ok(!out.includes("hunter2hunter2"));
  assert.ok(!out.includes("notarealkeybutlongenough"));
  assert.ok(!out.includes("b3BlbnNzaC1rZXktdjEAAAA"));
  assert.match(out, /Bearer \[redacted:token\]/);
  assert.match(out, /postgres:\/\/app:\[redacted:password\]@db/);
  assert.equal(hits["private-key"], 1);
  assert.ok(Object.values(hits).reduce((a, b) => a + b, 0) >= 10);
});

test("redaction leaves prose about secrets alone", () => {
  const prose = "Set the API key in the settings page. The token field is optional; password resets go by email.";
  assert.deepEqual(redact(prose), { text: prose, hits: {} });
});

test("the transcript is redacted and counts what it removed", () => {
  const doc = buildTranscript({
    engine: "claude", id: "x", cwd: CWD, start: 0, end: 1, changes: [],
    messages: [{ role: "user", text: "use GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789", at: 0 }],
  });
  assert.ok(!doc.messages[0].text.includes("ghp_"));
  assert.equal(doc.redactions.total, 1);
});

/* --------------------------------------------------------------------- checks */

test("checks come from the project, by its own package manager, and skip npm's placeholder", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "node --test", build: "x" } }));
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
    assert.equal(packageManager(dir), "pnpm");
    assert.deepEqual(detectChecks(dir).map((c) => [c.label, c.bin, ...c.args]), [["lint", "pnpm", "run", "lint"], ["test", "pnpm", "run", "test"]]);

    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }));
    assert.deepEqual(detectChecks(dir), []);

    fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\n");
    assert.deepEqual(detectChecks(dir).map((c) => c.label), ["cargo check", "cargo test"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--verify values: auto finds, none is nothing, a command is an argv with no shell", () => {
  assert.deepEqual(checksFor(["none"], "/nonexistent"), []);
  assert.deepEqual(checksFor(["make  check"], "/x"), [{ label: "make  check", bin: "make", args: ["check"] }]);
  assert.equal(parseHandoff(["claude", "codex", "--verify"]).verify[0], "auto");
  assert.deepEqual(parseHandoff(["--verify", "claude", "codex"]).verify, ["auto"]);
  assert.equal(parseHandoff(["--verify", "claude", "codex"]).from, "claude", "--verify must not swallow an engine");
  assert.deepEqual(parseHandoff(["claude", "codex", "--verify", "none"]).verify, ["none"]);
  assert.deepEqual(parseHandoff(["claude", "codex", "--verify=pnpm test", "--verify=pnpm lint"]).verify, ["pnpm test", "pnpm lint"]);
  assert.match(parseHandoff(["claude", "codex", "--budget", "10"]).error, /400 or more/);
  assert.equal(parseHandoff(["claude", "codex", "--budget", "2000"]).budget, 2000);
});

test("a check's real exit code is kept, and its output is redacted", async () => {
  const dir = tmp();
  try {
    const results = await runChecks([
      { label: "ok", bin: process.execPath, args: ["-e", "process.exit(0)"] },
      { label: "bad", bin: process.execPath, args: ["-e", "console.log('leaked sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'); process.exit(3)"] },
      { label: "missing", bin: "definitely-not-a-binary-moshcode", args: [] },
    ], { cwd: dir });
    assert.equal(results[0].code, 0);
    assert.equal(verdict(results[0]), "passed");
    assert.equal(results[1].code, 3);
    assert.equal(verdict(results[1]), "failed, exit 3");
    assert.ok(!results[1].tail.includes("sk-ant-"));
    assert.match(results[1].tail, /\[redacted:anthropic-key\]/);
    assert.match(verdict(results[2]), /did not run/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed check carries the lines that name the failures, not just the runner's summary", async () => {
  const { failureLines } = await import("../src/handoff-brief.mjs");
  const output = [
    "ok 1 - parses", "not ok 2 - retries after a 503", "  AssertionError: expected 3", ...Array.from({ length: 40 }, (_, i) => `ok ${i + 3} - fine`),
    "# pass 41", "# fail 1",
  ].join("\n");
  const tail = failureLines(output);
  assert.match(tail, /not ok 2 - retries after a 503/);
  assert.match(tail, /AssertionError/);
  assert.match(tail, /# fail 1/);
  assert.ok(!tail.includes("ok 20 - fine"));
});

test("a failure printed early survives a run whose output overflows the capture", async () => {
  const dir = tmp();
  try {
    // ~600 KB after the failure line, well past runProcess's 256 KB tail.
    const script = "console.log('not ok 7 - the early one'); for (let i = 0; i < 20000; i++) console.log('ok ' + i + ' - filler filler filler'); process.exit(1)";
    const [r] = await runChecks([{ label: "t", bin: process.execPath, args: ["-e", script] }], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.tail, /not ok 7 - the early one/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------- evidence */

test("evidence is what git says: branch, uncommitted, commits since the start", async () => {
  const dir = tmp();
  try {
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    fs.writeFileSync(path.join(dir, "a.txt"), "2\n");
    fs.writeFileSync(path.join(dir, "new.txt"), "n\n");
    const ev = await collectEvidence(dir, { since: Date.now() - 60_000 });
    assert.equal(ev.branch, "main");
    assert.equal(ev.status.length, 2);
    assert.equal(ev.untracked, 1);
    assert.deepEqual(ev.commits.map((c) => c.replace(/^\w+ /, "")), ["first"]);
    assert.ok(ev.diffstat.some((l) => l.includes("a.txt")));
    assert.equal(await collectEvidence(tmpdir()).then((e) => e === null || typeof e === "object"), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outside a repository there is no evidence, not an error", async () => {
  const dir = tmp();
  try { assert.equal(await collectEvidence(dir), null); } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------------------------------------------------------------- brief */

const DOC = buildTranscript({
  engine: "claude", id: "s1", cwd: CWD, start: 0, end: 1000, changes: ["/work/api/src/q.mjs"],
  messages: [
    { role: "user", text: "Build a retry queue for webhooks.", at: 0 },
    { role: "assistant", text: "Started on src/q.mjs.", at: 1 },
    { role: "user", text: "Add dead letters after 5 tries.", at: 2 },
    { role: "assistant", text: "Done. All tests pass.", at: 3 },
  ],
});

test("the brief tags every section by where it came from", () => {
  const brief = buildBrief(DOC, {
    evidence: { branch: "main", head: "abc123", status: [" M src/q.mjs"], untracked: 0, diffstat: [" src/q.mjs | 4 ++--"], commits: [] },
    checks: [{ label: "test", command: "pnpm run test", code: 1, timedOut: false, error: null, tail: "1 failing" }],
    transcriptFile: "/h/t.json",
  });
  assert.match(brief, /## Goal \[user\][\s\S]*retry queue/);
  assert.match(brief, /## Last report from claude \[agent-reported\][\s\S]*All tests pass/);
  // The agent's claim and the observation that contradicts it, both labelled.
  assert.match(brief, /`pnpm run test`: failed, exit 1 \[observed\]/);
  assert.match(brief, /Failing checks \(test\) come first.*\[inferred\]/);
  assert.match(brief, /## Working tree \[observed\][\s\S]*M src\/q\.mjs/);
  assert.match(brief, /## Recent requests, newest first \[user\][\s\S]*dead letters/);
  assert.match(brief, /\/h\/t\.json/);
});

test("the brief stays inside its budget however long the session was", () => {
  const long = "word ".repeat(20_000);
  const doc = buildTranscript({
    engine: "codex", id: "s", cwd: CWD, start: 0, end: 1, changes: [],
    messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: long, at: i })),
  });
  for (const budget of [400, 1000, 4000]) {
    const brief = buildBrief(doc, { budget, transcriptFile: "/h/t.json" });
    assert.ok(estimateTokens(brief) <= budget + 40, `budget ${budget}: got ${estimateTokens(brief)}`);
    assert.match(brief, /\/h\/t\.json/, "the pointer to the full record survives any clamp");
  }
});

test("without git, the files the engine wrote are listed as its own report", () => {
  const brief = buildBrief(DOC, {});
  assert.match(brief, /## Files the previous engine wrote \[agent-reported\][\s\S]*src\/q\.mjs/);
});

test("the seed names the brief first and stays one line", () => {
  const prompt = seedPrompt(DOC, "/h/t.json", "/h/t.md");
  assert.ok(!prompt.includes("\n"));
  assert.ok(prompt.indexOf("/h/t.md") < prompt.indexOf("/h/t.json"));
  assert.match(prompt, /\[observed\]/);
});

/* ------------------------------------------------------------------- command */

test("the command writes a 0600 brief with evidence and check results", async () => {
  await withHome(async () => {
    plantClaude(process.env.HOME);
    const out = [];
    const errors = [];
    const code = await handoffCommand(["claude", "codex", "--cwd", CWD, "--dry-run", "--json", "--verify=fake test", "--budget", "1200"], {
      write: (l) => out.push(l), fail: (l) => errors.push(l),
      launch: () => { throw new Error("a dry run must not launch"); },
      evidenceOf: async () => ({ branch: "feat", head: "abc", status: [" M x"], untracked: 0, diffstat: [], commits: ["abc wip"] }),
      check: async (checks) => checks.map((c) => ({ label: c.label, command: [c.bin, ...c.args].join(" "), code: 2, timedOut: false, error: null, ms: 5, tail: "boom" })),
    });
    assert.equal(code, 0, errors.join("\n"));
    const r = JSON.parse(out.join("\n"));
    assert.equal(r.budget, 1200);
    assert.ok(r.brief_tokens <= 1240);
    assert.deepEqual(r.checks.map((c) => c.verdict), ["failed, exit 2"]);
    assert.deepEqual(r.evidence, { branch: "feat", head: "abc", uncommitted: 1, commits: 1 });
    assert.equal(fs.statSync(r.brief).mode & 0o077, 0);
    const brief = fs.readFileSync(r.brief, "utf8");
    assert.match(brief, /`fake test`: failed, exit 2 \[observed\]/);
    const doc = JSON.parse(fs.readFileSync(r.transcript, "utf8"));
    assert.equal(doc.checks[0].code, 2);
    assert.equal(doc.evidence.branch, "feat");
    assert.ok(r.argv[1].includes(r.brief), "the seed points at the brief");
  });
});

test("c0mpute is a target: planned without a binary, launched in process with the brief inline", async () => {
  const plan = planHandoff({ from: "claude", to: "c0mpute" });
  assert.equal(plan.to, "c0mpute");
  assert.equal(planHandoff({ from: "cc", to: "c0" }).to, "c0mpute");
  assert.match(planHandoff({ from: "omp", to: "c0mpute" }).error, /cannot be handed off from/);

  await withHome(async () => {
    plantClaude(process.env.HOME);
    const lines = [];
    const got = [];
    const code = await handoffCommand(["claude", "c0mpute", "--cwd", CWD], {
      write: (l) => lines.push(l), fail: (l) => lines.push(l),
      launch: () => { throw new Error("c0mpute must not be spawned as a binary"); },
      launchC0mpute: async (prompt, opts) => { got.push([prompt, opts]); return 0; },
      evidenceOf: async () => null,
    });
    assert.equal(code, 0, lines.join("\n"));
    assert.equal(got.length, 1);
    const [prompt, opts] = got[0];
    assert.match(prompt, /# Handoff from claude/);
    assert.match(prompt, /\[user\]/);
    assert.ok(opts.cwd);
    assert.ok(lines.some((l) => /network peers/.test(l)), "the operator is told where the prompt goes");
  });
});
