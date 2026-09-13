// Swarm — one task, a herd of agents, one answer (PRD 0015).
//
// Claude Code calls it ultracode: a prompt that becomes a workflow of agents,
// planned, fanned out, verified and synthesised. The herd already has every
// piece of that — sessions that outlive the terminal, `prompt --wait`, a task
// ledger with each session's output — and `moshscript` could already wire them
// together by hand. This is the verb that does it for you, with any engine
// moshcode can start, not one vendor's.
//
// FOUR PHASES, and the operator sees each one:
//
//   plan       one headless engine call splits the task into independent
//              pieces that do not touch the same files. JSON in, JSON out;
//              a plan that does not parse degrades to one piece (the whole
//              task) rather than to nothing.
//   fan out    one herd session per piece, `--agents` of them at a time
//              (default 4 — the same number the claude engine's settings
//              defaults cap Claude's own workflows at). Each is prompted and
//              waited on exactly the way `moshcode herd prompt --wait` does,
//              so every piece is a task in the ledger with its output.
//   verify     optional: a skeptic per piece, prompted to refute it. What it
//              says is attached to the piece, never used to drop it — the
//              synthesis sees both and the operator decides.
//   synthesise one more headless call folds the pieces into an answer.
//
// The sessions are ended when the swarm is done unless `--keep` says
// otherwise: four idle engines per swarm would fill the roster by lunchtime,
// and the ledger keeps what they did either way (`moshcode herd task <id>`).
//
// Everything that talks to an engine or a pty goes through `deps`, so the
// orchestration is testable without tmux or a model on the box.
import { spawnSync } from "node:child_process";
import path from "node:path";

import { ENGINES, aiExecArgs, pickAiEngine, resolveEngine, resolveExecutable } from "./engines.mjs";
import { EXIT, herdKill, herdPrompt, herdStart, waitFor } from "./herd-cli.mjs";
import { findTask } from "./herd-tasks.mjs";
import { sendKeys, slugifyName } from "./herd.mjs";
import { acid, amber, ash, bone, err, info, ok, warn } from "./ui.mjs";

export const DEFAULT_AGENTS = 4;
export const MAX_AGENTS = 16;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const BOOT_TIMEOUT_MS = 90 * 1000;
const PIECE_CHARS = 6000;

const USAGE = 'usage: moshcode swarm "<task>" [--agents 4] [--engine claude] [--cwd .] [--verify] [--plan-only] [--keep] [--timeout 30m] [--json]';

function parseDuration(raw, fallback) {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(String(raw || "").trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  return { ms: n, s: n * 1000, m: n * 60000, h: n * 3600000 }[m[2] || "s"];
}

/** The flags, and the task — every positional word that is not one. */
export function parseSwarmArgs(argv = []) {
  const flags = {
    agents: DEFAULT_AGENTS, engine: null, cwd: process.cwd(), herd: "swarm", name: null,
    verify: false, planOnly: false, keep: false, timeoutMs: DEFAULT_TIMEOUT_MS, json: false,
  };
  const words = [];
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const eq = a.indexOf("=");
    const [key, inline] = a.startsWith("--") && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (key === "--agents") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > MAX_AGENTS) errors.push(`--agents must be a whole number from 1 to ${MAX_AGENTS}`);
      else flags.agents = n;
    } else if (key === "--engine") flags.engine = value();
    else if (key === "--cwd") flags.cwd = path.resolve(value() || ".");
    else if (key === "--herd") flags.herd = slugifyName(value());
    else if (key === "--name") flags.name = slugifyName(value());
    else if (key === "--timeout") flags.timeoutMs = parseDuration(value(), flags.timeoutMs);
    else if (key === "--verify") flags.verify = true;
    else if (key === "--plan-only") flags.planOnly = true;
    else if (key === "--keep") flags.keep = true;
    else if (key === "--json") flags.json = true;
    else if (a.startsWith("-") && a.length > 1) errors.push(`unknown flag ${a}`);
    else words.push(a);
  }
  return { ...flags, task: words.join(" ").trim(), errors };
}

/* ------------------------------------------------------------- the prompts */

export function planPrompt({ task, agents, cwd }) {
  return [
    `You are planning a swarm of up to ${agents} autonomous coding agents. Each will work IN PARALLEL in its own session, in the directory ${cwd}, and cannot see the others.`,
    `Split the task below into at most ${agents} independent pieces that do not edit the same files. Fewer pieces is better than pieces that overlap; one piece is fine when the task does not split.`,
    'Reply with ONLY a JSON array and nothing else — no prose, no code fence: [{"title": "short name", "prompt": "the full instructions for that agent"}].',
    "Each prompt must be self-contained, name the files it may touch, and tell the agent to end its work with a section headed SUMMARY: saying what it did and what it found.",
    "",
    "TASK:",
    task,
  ].join("\n");
}

export function verifyPrompt({ task, piece, output }) {
  return [
    "You are a skeptical reviewer. Another agent was given one piece of a larger task and reports the output below. Try to refute it: look for claims that are not backed by what it shows, work it says it did but did not, and anything that would break the larger task.",
    'Reply with ONLY a JSON object and nothing else: {"refuted": true|false, "reason": "one or two sentences"}. Default to refuted=true when you are not sure.',
    "",
    `LARGER TASK: ${task}`,
    `PIECE: ${piece.title}`,
    `INSTRUCTIONS GIVEN: ${piece.prompt}`,
    "",
    "OUTPUT:",
    output || "(the agent produced no output)",
  ].join("\n");
}

export function synthesisPrompt({ task, results }) {
  const parts = results.map((r, i) => [
    `--- piece ${i + 1}: ${r.title} (${r.state}${r.verified ? `, review: ${r.verified.refuted ? "REFUTED" : "stands"} — ${r.verified.reason}` : ""}) ---`,
    r.artifact || "(no output captured)",
  ].join("\n"));
  return [
    `A swarm of ${results.length} agents worked in parallel on the task below, one piece each. Their outputs follow. Write the single answer the operator should read: what was done, what was found, what is unfinished or contradicted, and what to do next. Plain prose, no preamble, no restating the task.`,
    "",
    `TASK: ${task}`,
    "",
    ...parts,
  ].join("\n");
}

/* --------------------------------------------------------------- the plan */

/** The first JSON array in a model's reply, validated into pieces. */
export function parsePlan(text, { agents = DEFAULT_AGENTS } = {}) {
  const s = String(text || "");
  const from = s.indexOf("[");
  const to = s.lastIndexOf("]");
  if (from < 0 || to <= from) return null;
  let parsed;
  try { parsed = JSON.parse(s.slice(from, to + 1)); }
  catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const pieces = parsed
    .filter((p) => p && typeof p === "object" && typeof p.prompt === "string" && p.prompt.trim())
    .map((p, i) => ({ title: String(p.title || `piece ${i + 1}`).trim().slice(0, 80), prompt: p.prompt.trim() }));
  return pieces.length ? pieces.slice(0, agents) : null;
}

export function parseVerdict(text) {
  const s = String(text || "");
  const from = s.indexOf("{");
  const to = s.lastIndexOf("}");
  if (from < 0 || to <= from) return { refuted: null, reason: "the reviewer did not answer in the expected form" };
  try {
    const v = JSON.parse(s.slice(from, to + 1));
    return { refuted: typeof v.refuted === "boolean" ? v.refuted : null, reason: String(v.reason || "").slice(0, 400) };
  } catch { return { refuted: null, reason: "the reviewer did not answer in the expected form" }; }
}

/** `swarm-<slug>` — what the sessions are named after, within NAME_RE. */
export function swarmPrefix(task, { name = null } = {}) {
  const base = name || slugifyName(task).slice(0, 14).replace(/-+$/, "") || "task";
  return `swarm-${base}`.slice(0, 28);
}

/* ----------------------------------------------------------- the engines */

/** Run an engine headlessly and return what it printed. Throws on failure. */
export function runHeadless(engine, prompt, { cwd = process.cwd(), runner = spawnSync, env = process.env } = {}) {
  const spec = ENGINES[engine];
  if (!spec) throw new Error(`no engine named ${JSON.stringify(engine)}`);
  const bin = resolveExecutable(spec.bin, spec.binDirs || []) || spec.bin;
  const args = aiExecArgs(engine, prompt);
  const clean = { ...env };
  for (const k of spec.stripEnv || []) delete clean[k];
  const res = runner(bin, args, { cwd, encoding: "utf8", env: clean, maxBuffer: 16 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${engine} exited with ${res.signal || res.status}${res.stderr ? `: ${String(res.stderr).trim().slice(0, 200)}` : ""}`);
  }
  return String(res.stdout || "").trim();
}

/** What a swarm needs from the outside world. Tests hand in fakes. */
export function liveDeps() {
  const quiet = () => {};
  const lastJson = (lines) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]); } catch { /* not this line */ }
    }
    return null;
  };
  return {
    ai: (engine, prompt, { cwd }) => runHeadless(engine, prompt, { cwd }),
    start: (name, { engine, cwd, herd }) => {
      const lines = [];
      const code = herdStart([engine, "--agent", "--name", name, "--cwd", cwd, "--herd", herd, "--json"], { write: (l) => lines.push(l) });
      return code === EXIT.matched ? { ok: true } : { ok: false, error: lines.join(" ") || "could not start the session" };
    },
    // An engine takes a moment to draw its prompt; keystrokes typed before
    // that are lost. Idle is "ready". Blocked at boot is a dialog before any
    // work — "trust this folder?" on a directory the engine has not seen —
    // and its default answer is the one a swarm wants, so Enter once and wait
    // for the prompt. Anything still blocked after that is reported, not
    // answered: guessing at a second dialog is how an agent ends up saying
    // yes to something it should not have.
    boot: async (name) => {
      const first = await waitFor(name, ["idle", "blocked"], { timeoutMs: BOOT_TIMEOUT_MS, intervalMs: 500 });
      if (first.outcome !== "matched" || first.state !== "blocked") return first;
      sendKeys(name, "Enter");
      const second = await waitFor(name, ["idle"], { timeoutMs: 30 * 1000, intervalMs: 500 });
      return second.outcome === "matched" ? second : { outcome: "blocked", state: second.state };
    },
    prompt: async (name, text, { timeoutMs }) => {
      const lines = [];
      await herdPrompt([name, text, "--wait", "--timeout", `${Math.ceil(timeoutMs / 1000)}s`, "--json"], { write: (l) => lines.push(l) });
      const result = lastJson(lines) || {};
      const task = result.task ? findTask(result.task) : null;
      return {
        ok: Boolean(result.sent), task: result.task || null,
        outcome: result.outcome || (result.sent ? "sent" : "failed"), state: result.state || null,
        artifact: task?.artifact || "", error: result.sent ? null : lines.join(" "),
      };
    },
    kill: async (name) => { await herdKill([name], { write: quiet }); },
  };
}

/* ----------------------------------------------------------- the swarm */

/** Run `fn` over `items`, at most `limit` at a time, preserving order. */
export async function throttled(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * The whole thing, as data. `write` gets the narration; the return value is
 * what `--json` prints. Never throws for an engine's failure — a piece that
 * failed is a piece with `state: "failed"` and the synthesis says so.
 */
export async function runSwarm(options, { write = () => {}, deps = liveDeps(), engineOf = pickAiEngine } = {}) {
  const { task, agents, cwd, herd, verify, planOnly, keep, timeoutMs } = options;
  const engine = engineOf(options.engine);
  if (!engine) {
    return { ok: false, error: options.engine ? `no installed engine named ${JSON.stringify(options.engine)}` : "no engine installed — moshcode install claude" };
  }
  if (!Object.hasOwn(ENGINES, engine) || !ENGINES[engine].bin) return { ok: false, error: `no engine named ${JSON.stringify(engine)}` };

  // 1. plan
  write(info(`plan — ${engine} is splitting the task into up to ${agents} pieces`));
  let plan = null, planNote = null;
  try {
    const reply = deps.ai(engine, planPrompt({ task, agents, cwd }), { cwd });
    plan = parsePlan(reply, { agents });
    if (!plan) planNote = "the plan did not parse — running the task as one piece";
  } catch (error) {
    planNote = `planning failed (${error.message || error}) — running the task as one piece`;
  }
  if (!plan) plan = [{ title: "the whole task", prompt: `${task}\n\nEnd your work with a section headed SUMMARY: saying what you did and what you found.` }];
  if (planNote) write(warn(planNote));
  for (const [i, piece] of plan.entries()) write(`  ${acid(String(i + 1).padStart(2))} ${bone(piece.title)}`);
  if (planOnly) return { ok: true, engine, task, agents, plan, results: [], synthesis: null, planOnly: true };

  // 2. fan out
  const prefix = swarmPrefix(task, { name: options.name });
  write(info(`swarm — ${plan.length} session${plan.length === 1 ? "" : "s"}, ${Math.min(agents, plan.length)} at a time (${engine}, herd ${herd})`));
  const results = await throttled(plan, agents, async (piece, i) => {
    const name = `${prefix}-${i + 1}`;
    const started = deps.start(name, { engine, cwd, herd });
    if (!started.ok) {
      write(err(`${name} — could not start: ${started.error}`));
      return { ...piece, session: name, task: null, state: "failed", outcome: "failed", artifact: "", error: String(started.error) };
    }
    const boot = await deps.boot(name);
    if (boot.outcome !== "matched") {
      write(err(`${name} — never became ready (${boot.outcome}, ${boot.state})`));
      if (!keep) await deps.kill(name);
      return { ...piece, session: name, task: null, state: "failed", outcome: boot.outcome, artifact: "", error: "the engine never became ready" };
    }
    write(`  ${ash("→")} ${bone(name)} ${ash(piece.title)}`);
    // The prompt is typed into a terminal; a newline there submits early.
    const text = piece.prompt.replace(/\s*\n+\s*/g, " ").trim();
    const done = await deps.prompt(name, text, { timeoutMs });
    if (!done.ok) {
      write(err(`${name} — ${done.error || "the prompt was not delivered"}`));
      if (!keep) await deps.kill(name);
      return { ...piece, session: name, task: done.task, state: "failed", outcome: done.outcome, artifact: done.artifact || "", error: done.error };
    }
    const mark = done.outcome === "matched" ? acid("✓") : amber("~");
    write(`  ${mark} ${bone(name)} ${ash(`${done.state} · ${done.task || ""}`)}`);
    if (!keep) await deps.kill(name);
    return { ...piece, session: name, task: done.task, state: done.state || "unknown", outcome: done.outcome, artifact: done.artifact || "", error: null };
  });

  // 3. verify
  if (verify) {
    write(info(`verify — one skeptic per piece (${engine})`));
    for (const r of results) {
      if (r.state === "failed") continue;
      try {
        r.verified = parseVerdict(deps.ai(engine, verifyPrompt({ task, piece: r, output: r.artifact.slice(-PIECE_CHARS) }), { cwd }));
      } catch (error) {
        r.verified = { refuted: null, reason: `the reviewer failed: ${error.message || error}` };
      }
      const mark = r.verified.refuted === false ? acid("✓") : r.verified.refuted ? amber("✗") : ash("?");
      write(`  ${mark} ${bone(r.session)} ${ash(r.verified.reason)}`);
    }
  }

  // 4. synthesise
  write(info(`synthesis — ${engine} is folding ${results.length} piece${results.length === 1 ? "" : "s"} into one answer`));
  let synthesis = null, synthesisError = null;
  try {
    synthesis = deps.ai(engine, synthesisPrompt({
      task, results: results.map((r) => ({ ...r, artifact: (r.artifact || r.error || "").slice(-PIECE_CHARS) })),
    }), { cwd });
  } catch (error) {
    synthesisError = `synthesis failed: ${error.message || error}`;
    write(err(synthesisError));
  }
  return { ok: !synthesisError, engine, task, agents, plan, results, synthesis, error: synthesisError, kept: keep };
}

/* ------------------------------------------------------------ the command */

export async function swarmCommand(argv = [], { write = console.log, deps, engineOf } = {}) {
  const options = parseSwarmArgs(argv);
  if (options.errors.length) { for (const e of options.errors) write(err(e)); write(err(USAGE)); return EXIT.usage; }
  if (!options.task) { write(err(USAGE)); return EXIT.usage; }
  if (options.engine && !resolveEngine(options.engine)) {
    write(err(`no engine named ${JSON.stringify(options.engine)} — one of ${Object.keys(ENGINES).join(", ")}`));
    return EXIT.usage;
  }

  const narrate = options.json ? () => {} : write;
  const result = await runSwarm(options, { write: narrate, ...(deps ? { deps } : {}), ...(engineOf ? { engineOf } : {}) });

  if (options.json) { write(JSON.stringify(result, null, 2)); return result.ok ? EXIT.matched : EXIT.usage; }
  if (!result.ok && !result.results?.length) { write(err(result.error)); return EXIT.usage; }
  if (result.planOnly) { write(info("plan only — nothing was started.")); return EXIT.matched; }

  const failed = result.results.filter((r) => r.state === "failed").length;
  write("");
  if (result.synthesis) write(result.synthesis);
  if (result.error) write(err(result.error));
  write("");
  const tasks = result.results.filter((r) => r.task).map((r) => r.task);
  write(failed
    ? warn(`${result.results.length - failed} of ${result.results.length} pieces finished; ${failed} failed.`)
    : ok(`${result.results.length} piece${result.results.length === 1 ? "" : "s"} finished.`));
  if (tasks.length) write(ash(`  ledger: ${tasks.map((t) => `moshcode herd task ${t}`).join(" · ")}`));
  if (result.kept) write(info(`sessions kept: ${result.results.map((r) => r.session).join(", ")} — moshcode ps`));
  return result.ok && !failed ? EXIT.matched : EXIT.usage;
}
