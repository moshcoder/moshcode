// Swarm — one task, a herd of agents, one answer (PRD 0015, PRD 0016).
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
// AND THE RECORD OF IT (OpenFleet, PRD 0016). A swarm is minted before the
// plan call, checked against the ceiling it runs under before anything is
// written, announced with one `swarm.spawn` before the first member starts,
// and every member carries a record file and the four OPENFLEET_* variables
// beside the herd's own. Each pane is named after its member id. When the
// swarm is done, moshcode writes `member.end` for every pane that did not
// write its own, then one `swarm.end` carrying the synthesis, and only then
// kills the sessions, so the ledger never says a member ended after its
// engine had already forgotten it.
//
// The sessions are ended when the swarm is done unless `--keep` says
// otherwise: four idle engines per swarm would fill the roster by lunchtime,
// and the ledger keeps what they did either way (`moshcode herd task <id>`).
//
// Everything that talks to an engine, a pty or the fleet's files goes through
// `deps`, so the orchestration is testable without tmux or a model on the box.
import { spawnSync } from "node:child_process";
import path from "node:path";

import { ENGINES, aiExecArgs, pickAiEngine, resolveEngine, resolveExecutable } from "./engines.mjs";
import { EXIT, carriesBypass, herdKill, herdStart, ledgerRecorder, roster, waitFor } from "./herd-cli.mjs";
import { stripAnsi } from "./herd-state.mjs";
import { endTask, screenDelta, startTask } from "./herd-tasks.mjs";
import { capture, sendKeys, sendPrompt, slugifyName } from "./herd.mjs";
import * as openfleet from "./openfleet.mjs";
import { acid, amber, ash, bone, err, info, ok, warn } from "./ui.mjs";

export const DEFAULT_AGENTS = 4;
export const MAX_AGENTS = 16;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const BOOT_TIMEOUT_MS = 90 * 1000;
const PIECE_CHARS = 6000;
const SUMMARY_CHARS = 500;

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

// The headless calls run in the operator's working directory, and an engine
// in print mode still has its tools. Seen live: a synthesis asked to fold two
// failed pieces into an answer went and did the task itself instead. The
// planner, the skeptic and the synthesis are asked to think, not act — the
// agents in the herd are the ones that act.
const NO_TOOLS = "Do not run commands, read or write files, or use any tool for this: answer from the text you are given, and nothing else.";

export function planPrompt({ task, agents, cwd }) {
  return [
    `You are planning a swarm of up to ${agents} autonomous coding agents. Each will work IN PARALLEL in its own session, in the directory ${cwd}, and cannot see the others.`,
    `Split the task below into at most ${agents} independent pieces that do not edit the same files. Fewer pieces is better than pieces that overlap; one piece is fine when the task does not split.`,
    'Reply with ONLY a JSON array and nothing else, no prose, no code fence: [{"title": "short name", "prompt": "the full instructions for that agent", "files": ["the paths, relative to the directory, that this agent alone may write"]}].',
    "Each prompt must be self-contained, name the files it may touch, and tell the agent to end its work with a section headed SUMMARY: saying what it did and what it found. The files list is the same paths as data: no two pieces may share one.",
    NO_TOOLS,
    "",
    "TASK:",
    task,
  ].join("\n");
}

export function verifyPrompt({ task, piece, output }) {
  return [
    "You are a skeptical reviewer. Another agent was given one piece of a larger task and reports the output below. Try to refute it: look for claims that are not backed by what it shows, work it says it did but did not, and anything that would break the larger task.",
    'Reply with ONLY a JSON object and nothing else: {"refuted": true|false, "reason": "one or two sentences"}. Default to refuted=true when you are not sure.',
    NO_TOOLS,
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
    NO_TOOLS,
    "",
    `TASK: ${task}`,
    "",
    ...parts,
  ].join("\n");
}

/* --------------------------------------------------------------- the plan */

/**
 * The first JSON array in a model's reply, validated into pieces. A piece's
 * `files` list, when the planner gives one, becomes the member's `piece.owns`:
 * "do not touch bye.sh" as data moshcode can check instead of prose it never
 * parses. Absent means the piece may touch anything the task names.
 */
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
    .map((p, i) => {
      const piece = { title: String(p.title || `piece ${i + 1}`).trim().slice(0, 80), prompt: p.prompt.trim() };
      const files = Array.isArray(p.files) ? p.files.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim()) : [];
      if (files.length) piece.files = files;
      return piece;
    });
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

/**
 * The swarm id, minted before the plan call: `<slug>-<HHMM>`. Its members are
 * `<swarm>-<n>`, and those are also the pane names, so the whole thing fits
 * the herd's NAME_RE with room for two digits.
 */
export const swarmId = openfleet.swarmId;

/**
 * A member's closing summary: the SUMMARY: section the plan asked for when
 * the agent wrote one, else the tail of what it printed.
 */
export function summaryOf(text, { max = SUMMARY_CHARS } = {}) {
  const s = stripAnsi(String(text || "")).trim();
  if (!s) return "";
  const at = s.toUpperCase().lastIndexOf("SUMMARY:");
  const body = (at >= 0 ? s.slice(at + "SUMMARY:".length) : s).trim();
  return body.length > max ? body.slice(-max) : body;
}

/** The herd's outcome for a piece, as the end state the ledger names. */
export function endStateOf(result) {
  if (result.outcome === "matched") return "done";
  if (result.outcome === "timeout") return "timeout";
  if (result.outcome === "gone") return "lost";
  return "failed";
}

/* ----------------------------------------------------------- the engines */

/**
 * Run an engine headlessly and return what it printed. Throws on failure.
 * `omitEnv` removes variables beyond the engine's own strip list: the
 * planner runs before its swarm exists, so it must not carry OPENFLEET_SWARM.
 */
export function runHeadless(engine, prompt, { cwd = process.cwd(), runner = spawnSync, env = process.env, omitEnv = [] } = {}) {
  const spec = ENGINES[engine];
  if (!spec) throw new Error(`no engine named ${JSON.stringify(engine)}`);
  const bin = resolveExecutable(spec.bin, spec.binDirs || []) || spec.bin;
  const args = aiExecArgs(engine, prompt);
  const clean = { ...env };
  for (const k of [...(spec.stripEnv || []), ...omitEnv]) delete clean[k];
  const res = runner(bin, args, { cwd, encoding: "utf8", env: clean, maxBuffer: 16 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${engine} exited with ${res.signal || res.status}${res.stderr ? `: ${String(res.stderr).trim().slice(0, 200)}` : ""}`);
  }
  return String(res.stdout || "").trim();
}

/** The boot-spec entry this screen matches, or null. Answered once each. */
export function bootAnswer(engine, screen) {
  const text = stripAnsi(String(screen || ""));
  return (ENGINES[engine]?.boot || []).find((entry) => entry.pattern.test(text)) || null;
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Wait for an engine to draw its prompt, answering the dialogs its spec
 * names on the way. Same shape of result as herd-cli's waitFor.
 */
export async function waitForPrompt(name, {
  engine, timeoutMs = BOOT_TIMEOUT_MS, intervalMs = 500, now = () => Date.now(),
  look = (n) => roster().find((s) => s.name === n) || null,
  screen = (n) => capture(n, { lines: 40 }),
  answer = (n, keys) => sendKeys(n, keys),
} = {}) {
  const deadline = now() + timeoutMs;
  const answered = new Set();
  let state = "unknown";
  for (;;) {
    const session = look(name);
    if (!session) return { outcome: "gone", state: "gone" };
    state = session.state;
    if (state === "idle") return { outcome: "matched", state };
    const dialog = bootAnswer(engine, screen(name));
    if (dialog && !answered.has(dialog.pattern.source)) {
      answered.add(dialog.pattern.source);
      answer(name, dialog.keys);
      await sleep(intervalMs * 3);
      continue;
    }
    if (!session.alive || state === "done") return { outcome: "ended", state };
    if (now() >= deadline) return { outcome: "timeout", state };
    await sleep(intervalMs);
  }
}

/** What a swarm needs from the outside world. Tests hand in fakes. */
export function liveDeps() {
  const quiet = () => {};
  const look = (name) => roster().find((s) => s.name === name) || null;
  return {
    ai: (engine, prompt, { cwd, omitEnv } = {}) => runHeadless(engine, prompt, { cwd, omitEnv }),
    // The engine's autonomous-session flags, spelled out. NOT `--agent`: for
    // an engine with an `agentsView` that opens its agents *overview* — the
    // right screen for `/agents claude`, and a screen where a typed prompt
    // starts a background job somewhere else instead of working here. Seen
    // live: two pieces "finished" in 8s with a roster for output.
    // `env` is the member's OPENFLEET_* set, handed to `herd start --env` so it
    // lands on the pane's env line beside MOSHCODE_HERD_NAME and survives the
    // engine's strip.
    start: (name, { engine, cwd, herd, env = {} }) => {
      const lines = [];
      const envArgs = Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
      const argv = [engine, "--name", name, "--cwd", cwd, "--herd", herd, "--json", ...envArgs, ...(ENGINES[engine]?.agentArgs || [])];
      const code = herdStart(argv, { write: (l) => lines.push(l) });
      return code === EXIT.matched ? { ok: true } : { ok: false, error: lines.join(" ") || "could not start the session" };
    },
    // An engine takes a moment to draw its prompt; keystrokes typed before
    // that are lost. Idle is "ready". A dialog before any work — "trust this
    // folder?" on a directory the engine has not seen — is answered from the
    // engine's own boot spec, each one once, and then the wait resumes.
    // Anything the spec does not name is left alone and reported: guessing
    // at a dialog is how an agent ends up saying yes to something it should
    // not have — or, with Claude's trust check, "No, exit".
    boot: (name, { engine }) => waitForPrompt(name, { engine }),
    // `herd prompt --wait`, with one difference: it will not take an idle
    // screen as "finished" until it has seen the engine work. herd prompt
    // gives an engine eight seconds to notice its input; a member that is
    // still settling when the text lands needs longer, and an idle screen
    // seen before the engine has read a word is not an answer. Same ledger,
    // same task ids, same `moshcode herd task <id>` afterwards.
    // `onSubmitted` fires the moment the herd ledger's `submit` event is
    // written: the point at which a starter writes `member.start` on behalf
    // of a pane whose engine cannot write its own.
    prompt: async (name, text, { timeoutMs, onSubmitted = () => {} }) => {
      const session = look(name);
      if (!session?.alive) return { ok: false, task: null, outcome: "gone", state: "gone", artifact: "", error: `no live session named ${JSON.stringify(name)}` };
      const at = Date.now();
      const baseline = capture(name, { lines: 60 });
      const task = startTask(name, text, { screen: baseline, now: at, state: session.state });
      const sent = sendPrompt(name, text);
      if (!sent.ok) {
        const error = `moshcode could not type into ${name}: ${sent.error?.message || sent.error}`;
        endTask(name, task, { state: "done", artifact: error });
        return { ok: false, task, outcome: "failed", state: session.state, artifact: "", error };
      }
      try { onSubmitted({ at, task }); } catch { /* a ledger line must never fail the prompt */ }
      const record = ledgerRecorder(name);
      const began = await waitFor(name, ["working", "blocked", "done"], { timeoutMs: 30 * 1000, intervalMs: 500, onState: record });
      const result = began.outcome === "gone" || (began.outcome === "matched" && began.state !== "working")
        ? began
        : await waitFor(name, ["blocked", "done", "idle"], { timeoutMs, onState: record });
      const artifact = result.outcome === "gone" ? "" : screenDelta(baseline, capture(name, { lines: 400 }));
      endTask(name, task, { state: result.state, artifact });
      return { ok: true, task, outcome: result.outcome, state: result.state, artifact, error: null };
    },
    kill: async (name) => { await herdKill([name], { write: quiet }); },
    // The fleet's files. The module reads $OPENFLEET_HOME on every call, so a
    // test isolates the whole thing with one env var rather than a fake.
    fleet: openfleet,
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
export async function runSwarm(options, { write = () => {}, deps = liveDeps(), engineOf = pickAiEngine, now = () => Date.now() } = {}) {
  const { task, agents, cwd, herd, verify, planOnly, keep, timeoutMs } = options;
  const engine = engineOf(options.engine);
  if (!engine) {
    return { ok: false, error: options.engine ? `no installed engine named ${JSON.stringify(options.engine)}` : "no engine installed — moshcode install claude" };
  }
  if (!Object.hasOwn(ENGINES, engine) || !ENGINES[engine].bin) return { ok: false, error: `no engine named ${JSON.stringify(engine)}` };
  const fleetIO = deps.fleet || openfleet;

  // 0. where this swarm sits: the fleet, and the member moshcode runs inside,
  // which is the parent of every member it starts. Run by hand there is no
  // parent, the spawner is the sysop, and the members are roots at depth 0.
  const ctx = fleetIO.context();
  const hostname = fleetIO.host();
  const { fleet, sysop } = ctx;
  const parent = ctx.member || null;
  const parentSwarm = ctx.record?.swarm || null;
  const depth = parent ? ctx.depth + 1 : 0;
  const by = parent || "sysop";
  const swarm = swarmId(task, { name: options.name, now: now() });
  const approvals = carriesBypass(engine, ENGINES[engine].agentArgs || []) ? "bypass" : "native";
  const engineString = `moshcode/${engine}`;
  // The planner, the skeptic and the synthesis run in the spawner's own
  // environment. They must not carry the swarm's id: it has no swarm.spawn
  // yet when the planner runs, and a `claude -p` that found one would join it.
  const omitEnv = ["OPENFLEET_SWARM"];

  // 1. plan
  write(info(`plan — ${engine} is splitting the task into up to ${agents} pieces`));
  let plan = null, planNote = null;
  try {
    const reply = deps.ai(engine, planPrompt({ task, agents, cwd }), { cwd, omitEnv });
    plan = parsePlan(reply, { agents });
    if (!plan) planNote = "the plan did not parse — running the task as one piece";
  } catch (error) {
    planNote = `planning failed (${error.message || error}) — running the task as one piece`;
  }
  if (!plan) plan = [{ title: "the whole task", prompt: `${task}\n\nEnd your work with a section headed SUMMARY: saying what you did and what you found.` }];
  if (planNote) write(warn(planNote));
  for (const [i, piece] of plan.entries()) write(`  ${acid(String(i + 1).padStart(2))} ${bone(piece.title)}${piece.files ? ash(`  owns ${piece.files.join(",")}`) : ""}`);
  if (planOnly) return { ok: true, engine, task, agents, plan, results: [], synthesis: null, planOnly: true, swarm, fleet };

  // 2. the ceiling, checked before anything is written. The swarm narrows
  // what it inherited with --agents (fan_out) and --timeout (until: a piece
  // waits at most timeoutMs, and pieces beyond --agents wait their turn).
  const pieces = plan.map((p, i) => ({ member: `${swarm}-${i + 1}`, title: p.title, ...(p.files ? { owns: p.files } : {}) }));
  const startedAt = now();
  const narrowing = openfleet.narrowingOf({
    fan_out: agents,
    until: openfleet.iso(startedAt + Math.ceil(plan.length / agents) * timeoutMs),
  }, ctx.ceiling);
  const ceiling = openfleet.mergeCeiling(ctx.ceiling, narrowing);
  const refusal = openfleet.checkCeiling({ depth, fan_out: plan.length, hosts: [hostname] }, ceiling, { now: startedAt })
    || openfleet.checkCeiling({ approvals }, ceiling, { now: startedAt });
  if (refusal) {
    const reason = `the ceiling refuses ${refusal.key}: wanted ${JSON.stringify(refusal.wanted)}, allowed ${JSON.stringify(refusal.allowed)}`;
    const line = { event: "ceiling.refuse", by, key: refusal.key, wanted: refusal.wanted, allowed: refusal.allowed };
    // Approvals are a fact about each member, so each refused member gets its
    // line; the swarm-wide keys refuse the spawn itself, once.
    if (refusal.key === "approvals") for (const p of pieces) fleetIO.append(fleet, { ...line, member: p.member, action: "start" }, { now: startedAt });
    else fleetIO.append(fleet, { ...line, action: "spawn" }, { now: startedAt });
    write(err(`${swarm}: ${reason}`));
    const results = plan.map((piece, i) => ({
      ...piece, member: pieces[i].member, session: pieces[i].member, task: null, state: "failed", outcome: "refused", artifact: "", error: reason,
    }));
    return { ok: false, engine, task, agents, plan, results, synthesis: null, error: reason, kept: keep, swarm, fleet, refused: refusal };
  }

  // 3. swarm.spawn, before the first member starts
  fleetIO.append(fleet, {
    event: "swarm.spawn", by, swarm, ...(parentSwarm ? { parent_swarm: parentSwarm } : {}), task, ceiling: narrowing, pieces,
  }, { now: startedAt });
  write(info(`swarm ${swarm}: ${plan.length} session${plan.length === 1 ? "" : "s"}, ${Math.min(agents, plan.length)} at a time (${engine}, herd ${herd}, fleet ${fleet})`));

  const pieceOf = (i) => { const { member, ...piece } = pieces[i]; return piece; };
  const hasRealEnd = (member) => fleetIO.readLedger(fleet).some((l) => l.event === "member.end" && l.member === member && l.state !== "lost");
  const started = new Set();
  const recorded = new Set();
  let results = [];
  let synthesis = null, synthesisError = null;
  try {
    // 4. fan out. One record per member, written before its session begins
    // and never rewritten; the pane is named after the member.
    results = await throttled(plan, agents, async (piece, i) => {
      const member = pieces[i].member;
      const name = member;
      const row = (extra) => ({ ...piece, member, session: name, task: null, state: "failed", outcome: "failed", artifact: "", error: null, ...extra });
      const record = {
        openfleet: openfleet.OPENFLEET_VERSION, fleet, sysop, member, ...(parent ? { parent } : {}), swarm, task, piece: pieceOf(i), depth,
        engine: engineString, session: name, host: hostname, cwd, started: openfleet.iso(now()), approvals, ceiling,
      };
      const written = fleetIO.writeRecord(record);
      if (!written.ok) {
        write(err(`${name}: could not write its record: ${written.error?.message || written.error}`));
        return row({ error: `could not write the record: ${written.error?.message || written.error}` });
      }
      recorded.add(member);
      const env = {
        OPENFLEET_HOME: fleetIO.home(), OPENFLEET_RECORD: written.path, OPENFLEET_FLEET: fleet, OPENFLEET_MEMBER: member, OPENFLEET_SWARM: swarm,
      };
      const launch = deps.start(name, { engine, cwd, herd, env });
      if (!launch.ok) {
        write(err(`${name} — could not start: ${launch.error}`));
        return row({ error: String(launch.error) });
      }
      started.add(name);
      const boot = await deps.boot(name, { engine });
      if (boot.outcome !== "matched") {
        write(err(`${name} — never became ready (${boot.outcome}, ${boot.state})`));
        return row({ outcome: boot.outcome, error: "the engine never became ready" });
      }
      write(`  ${ash("→")} ${bone(name)} ${ash(piece.title)}`);
      // The prompt is typed into a terminal; a newline there submits early.
      const text = piece.prompt.replace(/\s*\n+\s*/g, " ").trim();
      // A claude pane with hooks claims its own record; codex, deepseek and
      // kimi cannot, and neither can a claude with no hooks installed. The
      // starter writes member.start for whichever has none by submit time.
      const onSubmitted = ({ at }) => {
        if (fleetIO.hasEvent(fleet, "member.start", { member })) return;
        fleetIO.append(fleet, {
          at: openfleet.iso(at), event: "member.start", by, member, session: name, swarm, ...(parent ? { parent } : {}), depth,
          engine: engineString, cwd, approvals, piece: pieceOf(i),
        }, { now: at });
      };
      const done = await deps.prompt(name, text, { timeoutMs, onSubmitted });
      if (!done.ok) {
        write(err(`${name} — ${done.error || "the prompt was not delivered"}`));
        return row({ task: done.task, outcome: done.outcome, artifact: done.artifact || "", error: done.error });
      }
      const mark = done.outcome === "matched" ? acid("✓") : amber("~");
      write(`  ${mark} ${bone(name)} ${ash(`${done.state} · ${done.task || ""}`)}`);
      return row({ task: done.task, state: done.state || "unknown", outcome: done.outcome, artifact: done.artifact || "" });
    });

    // 5. verify
    if (verify) {
      write(info(`verify — one skeptic per piece (${engine})`));
      for (const r of results) {
        if (r.state === "failed") continue;
        try {
          r.verified = parseVerdict(deps.ai(engine, verifyPrompt({ task, piece: r, output: r.artifact.slice(-PIECE_CHARS) }), { cwd, omitEnv }));
        } catch (error) {
          r.verified = { refuted: null, reason: `the reviewer failed: ${error.message || error}` };
        }
        const mark = r.verified.refuted === false ? acid("✓") : r.verified.refuted ? amber("✗") : ash("?");
        write(`  ${mark} ${bone(r.session)} ${ash(r.verified.reason)}`);
      }
    }

    // 6. synthesise
    write(info(`synthesis — ${engine} is folding ${results.length} piece${results.length === 1 ? "" : "s"} into one answer`));
    try {
      synthesis = deps.ai(engine, synthesisPrompt({
        task, results: results.map((r) => ({ ...r, artifact: (r.artifact || r.error || "").slice(-PIECE_CHARS) })),
      }), { cwd, omitEnv });
    } catch (error) {
      synthesisError = `synthesis failed: ${error.message || error}`;
      write(err(synthesisError));
    }

    // 7. the end lines: member.end for every member whose session did not
    // write its own, then one swarm.end carrying the synthesis. Not with
    // --keep: the members are still running, and a swarm whose members run
    // has not ended.
    if (!keep) {
      for (const r of results) {
        if (!recorded.has(r.member) || hasRealEnd(r.member)) continue;
        const state = endStateOf(r);
        const summary = summaryOf(r.artifact) || (r.error ? String(r.error) : "");
        fleetIO.append(fleet, { event: "member.end", by, member: r.member, state, ...(summary ? { summary } : {}) }, { now: now() });
      }
      if (!fleetIO.hasEvent(fleet, "swarm.end", { swarm })) {
        const lines = fleetIO.readLedger(fleet);
        const ends = pieces.map((p) => openfleet.endOf(lines, p.member)).filter(Boolean);
        const verdict = verify ? results.filter((r) => r.verified).map((r) => ({ member: r.member, refuted: r.verified.refuted, reason: r.verified.reason })) : null;
        fleetIO.append(fleet, {
          event: "swarm.end", by, swarm, state: openfleet.swarmEndState(ends),
          ...(synthesis ? { summary: synthesis } : {}), ...(verdict ? { verdict } : {}),
        }, { now: now() });
      }
    }
  } finally {
    // The kills come last, after the ledger says how everything ended, and
    // in a finally so a crash between fan-out and synthesis still ends the
    // panes it started rather than leaving sixteen idle engines behind.
    if (!keep) for (const name of started) await deps.kill(name);
  }
  return { ok: !synthesisError, engine, task, agents, plan, results, synthesis, error: synthesisError, kept: keep, swarm, fleet };
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
  if (result.swarm && !result.refused) write(ash(`  fleet: moshcode fleet log --swarm ${result.swarm}`));
  if (result.kept) write(info(`sessions kept (swarm ${result.swarm}): ${result.results.map((r) => r.session).join(", ")}. moshcode ps · moshcode fleet stop ${result.swarm}`));
  return result.ok && !failed ? EXIT.matched : EXIT.usage;
}
