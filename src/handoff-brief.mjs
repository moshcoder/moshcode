// The handoff brief: what the next engine reads first.
//
// A portable transcript carries the conversation, up to 200 messages of it. That
// is the honest record and it stays, but it is the wrong first read: the next
// engine pays for every one of those tokens before it does anything, and most of
// them are a story whose ending is already on disk. The brief is the short
// version, built without a model so it cannot invent anything:
//
//   [user]            the operator's own words, quoted from the session
//   [agent-reported]  what the previous engine SAID it did, which may be wrong
//   [observed]        what moshcode saw itself: git, and checks it ran
//   [inferred]        moshcode's reading of the above, labelled as a guess
//
// The labels are the point. An engine that is told "tests pass" by the engine
// before it repeats the claim; one told "[agent-reported] tests pass" next to
// "[observed] pnpm test exited 1" does not.
//
// Nothing here sends anything anywhere. The checks run the project's own
// commands, without a shell, in the session's directory.
import fs from "node:fs";
import path from "node:path";

import { runProcess } from "./work.mjs";
import { redact, addHits } from "./redact.mjs";

/** The default brief size, in tokens (estimated as characters / 4). */
export const DEFAULT_BUDGET = 4000;
/** Per-check limit. A test suite that runs longer is reported as timed out. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

const CHARS_PER_TOKEN = 4;
const GIT_TIMEOUT_MS = 15_000;

/* ------------------------------------------------------------------ evidence */

const lines = (s) => String(s || "").split("\n").map((l) => l.trimEnd()).filter(Boolean);

/**
 * What git says about the directory: branch, uncommitted changes, diffstat, and
 * the commits made since the session started. Null when it is not a repository
 * or git is missing; a handoff out of a scratch directory is still a handoff.
 */
export async function collectEvidence(cwd, { since = null, run = runProcess } = {}) {
  const git = (args) => run("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  const inside = await git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return null;

  const [branch, head, status, stat, log] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["rev-parse", "--short", "HEAD"]),
    git(["status", "--porcelain=v1"]),
    git(["diff", "--stat", "HEAD"]),
    since
      ? git(["log", `--since=${new Date(since).toISOString()}`, "--format=%h %s", "-n", "30"])
      : Promise.resolve({ code: 0, stdout: "" }),
  ]);
  const statusLines = status.code === 0 ? lines(status.stdout) : [];
  const statLines = stat.code === 0 ? lines(stat.stdout) : [];
  return {
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    head: head.code === 0 ? head.stdout.trim() : null,
    status: statusLines,
    untracked: statusLines.filter((l) => l.startsWith("??")).length,
    diffstat: statLines,
    commits: log.code === 0 ? lines(log.stdout) : [],
  };
}

/* -------------------------------------------------------------------- checks */

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const exists = (cwd, name) => fs.existsSync(path.join(cwd, name));

/** npm's placeholder test script, which fails by design and proves nothing. */
const PLACEHOLDER_TEST = /no test specified/i;

/** Which package manager the lockfile says this project uses. */
export function packageManager(cwd) {
  if (exists(cwd, "pnpm-lock.yaml")) return "pnpm";
  if (exists(cwd, "bun.lock") || exists(cwd, "bun.lockb")) return "bun";
  if (exists(cwd, "yarn.lock")) return "yarn";
  return "npm";
}

/**
 * The project's own checks, found rather than guessed: package.json scripts
 * named typecheck/lint/test, Cargo, Go, or a Makefile test target. Each is an
 * argv, never a shell string, so a script name cannot smuggle a command.
 */
export function detectChecks(cwd) {
  const checks = [];
  const pkg = readJson(path.join(cwd, "package.json"));
  if (pkg?.scripts) {
    const pm = packageManager(cwd);
    for (const name of ["typecheck", "type-check", "lint", "test"]) {
      const script = pkg.scripts[name];
      if (!script || (name === "test" && PLACEHOLDER_TEST.test(script))) continue;
      if (name === "type-check" && checks.some((c) => c.label === "typecheck")) continue;
      checks.push({ label: name === "type-check" ? "typecheck" : name, bin: pm, args: ["run", name] });
    }
  }
  if (exists(cwd, "Cargo.toml")) {
    checks.push({ label: "cargo check", bin: "cargo", args: ["check", "--quiet"] });
    checks.push({ label: "cargo test", bin: "cargo", args: ["test", "--quiet"] });
  }
  if (exists(cwd, "go.mod")) {
    checks.push({ label: "go vet", bin: "go", args: ["vet", "./..."] });
    checks.push({ label: "go test", bin: "go", args: ["test", "./..."] });
  }
  if (!checks.length && exists(cwd, "Makefile")) {
    const make = fs.readFileSync(path.join(cwd, "Makefile"), "utf8");
    if (/^test\s*:/m.test(make)) checks.push({ label: "make test", bin: "make", args: ["test"] });
  }
  return checks;
}

/**
 * A `--verify` value to checks. `auto` finds them, `none` is none, anything
 * else is one command split on whitespace and run without a shell. Quoting is
 * not interpreted, which is the cost of not having a shell; a command that
 * needs one belongs in a package script.
 */
export function checksFor(values, cwd) {
  const out = [];
  for (const v of values) {
    if (v === "none") continue;
    if (v === "auto") { out.push(...detectChecks(cwd)); continue; }
    const [bin, ...args] = v.trim().split(/\s+/);
    if (bin) out.push({ label: v.trim(), bin, args });
  }
  return out;
}

/** Lines that name a failure, in the vocabularies of the common runners. */
const FAILURE_LINE = /^\s*(not ok\b|FAIL\b|✗|×|✖|[0-9]+\) |error(\[E[0-9]+\])?[: ]|Error:|AssertionError|panicked at|--- FAIL)/i;

/**
 * What of a check's output is worth carrying. A runner's last lines are its
 * summary ("# fail 2"), which says that something failed and not what, so a
 * failure keeps the lines naming the failures first and then the summary.
 */
export function failureLines(output, passed = false) {
  const all = lines(output);
  if (passed) return all.slice(-5).join("\n");
  const named = [...new Set(all.filter((l) => FAILURE_LINE.test(l)))].slice(0, 12);
  const summary = all.slice(-6).filter((l) => !named.includes(l));
  return (named.length ? [...named, "…", ...summary] : all.slice(-15)).join("\n");
}

/**
 * runProcess, plus every failure line seen on the way. A test suite's output
 * runs past runProcess's capture, which keeps the tail, and the tail is the
 * summary; the lines naming what failed scrolled out long before it.
 */
export function runCheckProcess(bin, args, opts = {}) {
  const named = [];
  let partial = "";
  const scan = (chunk) => {
    const text = partial + chunk;
    const parts = text.split("\n");
    partial = parts.pop() ?? "";
    for (const l of parts) if (named.length < 40 && FAILURE_LINE.test(l)) named.push(l.trimEnd());
  };
  return runProcess(bin, args, { ...opts, onData: scan }).then((r) => {
    if (partial && FAILURE_LINE.test(partial)) named.push(partial.trimEnd());
    return { ...r, named };
  });
}

/** Run each check in turn and keep the exit code and the tail of its output. */
export async function runChecks(checks, { cwd, timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS, run = runCheckProcess, now = () => Date.now(), hits = {} } = {}) {
  const results = [];
  for (const check of checks) {
    const started = now();
    const r = await run(check.bin, check.args, { cwd, timeoutMs });
    const output = `${(r.named || []).join("\n")}\n${r.stdout || ""}\n${r.stderr || ""}`;
    const tail = failureLines(output, r.code === 0);
    const clean = redact(tail);
    addHits(hits, clean.hits);
    results.push({
      label: check.label,
      command: [check.bin, ...check.args].join(" "),
      code: r.code,
      timedOut: Boolean(r.timedOut),
      error: r.error || null,
      ms: now() - started,
      tail: clean.text,
    });
  }
  return results;
}

/** One word for a check result. */
export function verdict(check) {
  if (check.error && check.code == null) return `did not run (${check.error})`;
  if (check.timedOut) return "timed out";
  return check.code === 0 ? "passed" : `failed, exit ${check.code ?? check.signal ?? "?"}`;
}

/* --------------------------------------------------------------------- brief */

const clip = (s, n) => {
  const t = String(s || "").trim();
  return t.length > n ? `${t.slice(0, Math.max(0, n - 12)).trimEnd()} … (clipped)` : t;
};
const quote = (s) => s.split("\n").map((l) => `> ${l}`).join("\n");

/**
 * Render the brief from an already-redacted transcript doc, git evidence and
 * check results, inside `budget` tokens.
 *
 * Each section gets a share of the budget in priority order, and what a
 * section leaves unused rolls to the next. The final clamp is a backstop that
 * should not fire. Deterministic: the same inputs give the same brief.
 */
export function buildBrief(doc, { evidence = null, checks = [], budget = DEFAULT_BUDGET, transcriptFile = "" } = {}) {
  const total = Math.max(400, budget) * CHARS_PER_TOKEN;
  const users = doc.messages.filter((m) => m.role === "user");
  const assistants = doc.messages.filter((m) => m.role === "assistant");
  const s = doc.source;

  const head = [
    `# Handoff from ${s.engine}`,
    "",
    `Session ${s.session} in ${s.cwd || "(no directory recorded)"}, ${s.started || "?"} to ${s.ended || "?"}.`,
    "Every fact is tagged: [user] is the operator's words, [agent-reported] is what the previous engine claimed,",
    "[observed] is what moshcode saw in git or ran itself, [inferred] is moshcode's guess. Trust them in that order of evidence.",
    "The working tree is the real state of the work. Read it before you edit anything.",
    "",
    "",
  ].join("\n");

  let left = total - head.length;
  const sections = [];
  const take = (share, render) => {
    const cap = Math.floor(left * share);
    const body = render(cap);
    if (!body) return;
    const text = body.length > cap ? clip(body, cap) : body;
    left -= text.length + 2;
    sections.push(text);
  };

  // 1. The goal: how the operator opened the session.
  if (users.length) {
    take(0.15, (cap) => `## Goal [user]\n\n${quote(clip(users[0].text, cap - 20))}`);
  }

  // 2. Checks: the only thing in this file nobody could have made up.
  if (checks.length) {
    take(0.3, (cap) => {
      const per = Math.floor((cap - 40) / checks.length);
      const parts = checks.map((c) => {
        const line = `- \`${c.command}\`: ${verdict(c)} [observed]`;
        if (c.code === 0 || !c.tail) return line;
        return `${line}\n\n\`\`\`\n${c.tail.slice(-Math.max(0, per - line.length - 10))}\n\`\`\``;
      });
      return `## Checks [observed]\n\n${parts.join("\n")}`;
    });
  }

  // 3. The tree.
  if (evidence) {
    take(0.35, (cap) => {
      const out = [`## Working tree [observed]`, "", `Branch \`${evidence.branch || "?"}\` at ${evidence.head || "?"}.`];
      if (evidence.commits.length) {
        out.push("", `Commits since the session started (${evidence.commits.length}):`, ...evidence.commits.map((c) => `- ${c}`));
      } else out.push("", "No commits since the session started.");
      if (evidence.status.length) {
        out.push("", `Uncommitted (${evidence.status.length}, ${evidence.untracked} untracked):`, "```", ...evidence.status.slice(0, 40), "```");
        if (evidence.diffstat.length) out.push("", "```", ...evidence.diffstat.slice(-25), "```");
      } else out.push("", "Nothing uncommitted.");
      return out.join("\n").slice(0, cap);
    });
  } else if (doc.changes.length) {
    take(0.25, () => `## Files the previous engine wrote [agent-reported]\n\n${doc.changes.slice(0, 60).map((c) => `- ${c.path}`).join("\n")}`);
  }

  // 4. Where the previous engine says it got to.
  const last = assistants[assistants.length - 1];
  if (last) take(0.5, (cap) => `## Last report from ${s.engine} [agent-reported]\n\n${quote(clip(last.text, cap - 60))}`);

  // 5. What the operator asked for most recently, newest first.
  const recent = users.slice(1).slice(-5).reverse();
  if (recent.length) {
    take(0.7, (cap) => {
      const per = Math.floor((cap - 40) / recent.length);
      return `## Recent requests, newest first [user]\n\n${recent.map((m) => quote(clip(m.text, per - 10))).join("\n\n")}`;
    });
  }

  // 6. The reading. Labelled as a guess because it is one.
  const next = [];
  const failing = checks.filter((c) => c.code !== 0);
  if (failing.length) next.push(`- Failing checks (${failing.map((c) => c.label).join(", ")}) come first: fix them before new work. [inferred]`);
  else if (checks.length) next.push("- All checks passed when this was written. [inferred]");
  const lastMsg = doc.messages[doc.messages.length - 1];
  if (lastMsg?.role === "user") next.push("- The operator's last message has no answer in the transcript: start there. [inferred]");
  else if (recent.length || users.length) next.push("- Continue from the most recent request above. [inferred]");
  if (evidence?.status.length) next.push("- There is uncommitted work; it is the previous engine's, not a stray. [inferred]");
  if (next.length) take(1, () => `## Next [inferred]\n\n${next.join("\n")}`);

  const tailLine = transcriptFile
    ? `\n---\nFull conversation (${doc.messages.length} messages${s.dropped ? `, newest of ${s.messages}` : ""}): ${transcriptFile}\n`
    : "";
  const out = `${head}${sections.join("\n\n")}\n${tailLine}`;
  return out.length > total ? `${clip(out, total - tailLine.length)}\n${tailLine}` : out;
}

/** Estimated tokens in a string. */
export const estimateTokens = (s) => Math.ceil(String(s || "").length / CHARS_PER_TOKEN);
