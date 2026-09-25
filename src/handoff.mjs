// `moshcode handoff <from> <to>`: move a conversation between engines (PRD 0018).
//
// The thing an engine cannot do for itself. Every harness imports sessions in
// one direction, into itself, because that is the only direction it can see.
// moshcode sits above eleven of them and already reads their session logs for
// `moshcode cost`, so the expensive half was written before this file existed.
// What is left is three small jobs: render what was read into a format neither
// engine owns, seed the target with it, and write down that the second session
// came from the first.
//
// WHAT TRAVELS, AND WHAT DOES NOT. The conversation travels. A list of the
// files the previous engine wrote travels. The edits themselves do not. The
// working tree is the real state of the work, and a transcript that carried
// diffs would invite the receiving engine to replay changes that are already
// applied. So the transcript names what changed and tells the next engine to
// go and look, which is both smaller and true.
//
// SEEDING IS PER ENGINE, AND SOME CANNOT BE SEEDED. An engine can be handed a
// first prompt only if it documents a way to start an interactive session
// carrying one. Six do. The rest are listed in `SEEDS` with the reason, and the
// command refuses by name rather than starting a session that quietly knows
// nothing. Half-working here is worse than not working: the operator would find
// out several turns into a conversation the engine never received.
//
// THE SEED IS A POINTER, NOT THE TRANSCRIPT, for two measured reasons. An
// engine takes its first prompt as one argv value, and argv is bounded: about
// 2MB on Linux, less elsewhere. A digest fits and a real multi-megabyte
// transcript does not, so passing the conversation itself would work until the
// first long session and then fail at exec time. And a prompt typed into a live
// pane is submitted by its first newline, which is why `swarm` flattens
// newlines out of everything it sends. A single-line pointer is under both
// limits by construction, and it is one code path for every engine rather than
// one per argument-length limit.
//
// NOTHING HERE RESUMES A SESSION BY ID. No engine moshcode wraps can reopen an
// arbitrary session from the command line: every `resume` argv in engines.mjs
// reopens that engine's own last conversation and nothing else. A handoff
// therefore always starts a NEW session on the target and gives it the old
// conversation to read. That is also why it is a handoff and not a migration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ENGINES, openSession, resolveEngine } from "./engines.mjs";
import { UNREADABLE, isReadable, listSessions, readSession } from "./transcript.mjs";
import * as openfleet from "./openfleet.mjs";

/**
 * The format version, as it appears in every file this writes.
 *
 * Documented in docs/portable-transcript.md. It is a version and not a date
 * because a reader is allowed to refuse a major it does not know, which is the
 * only way a twelfth engine can join without reading this source file.
 */
export const PORTABLE_TRANSCRIPT_VERSION = "0.1";

/** How many messages a handoff carries by default, newest kept. */
export const DEFAULT_MAX_MESSAGES = 200;

/**
 * How each engine is handed a first prompt, or why it cannot be.
 *
 * `argv` returns the full argument list that starts an interactive session
 * seeded with `text`. Verified against the engine's own `--help` at the version
 * named beside it, because this is exactly the place where a guessed flag stops
 * being a small disappointment and becomes a crash in front of someone who just
 * lost their context.
 */
export const SEEDS = {
  // `claude [options] [prompt]`, verified on 2.x. The positional prompt starts
  // an interactive session with that prompt already submitted.
  claude: { argv: (text) => [text] },
  // `codex [OPTIONS] [PROMPT]`, verified on 0.1.x. Same shape.
  codex: { argv: (text) => [text] },
  // `opencode --prompt <p>`, verified on 0.x. The positional argument is a
  // project directory, so the prompt has to be the flag.
  opencode: { argv: (text) => ["--prompt", text] },
  // An opencode fork that kept the flag, verified on the installed build.
  privacycode: { argv: (text) => ["--prompt", text] },
  // `qwen -i <p>`, verified: the bare positional is one-shot, and
  // `-i/--prompt-interactive` is the one that stays interactive afterwards.
  qwen: { argv: (text) => ["-i", text] },
  // Gemini CLI is where qwen's fork got `-i/--prompt-interactive`, and it is
  // the same flag with the same wording. Not verified on this machine, which
  // is why it is said here rather than left implied.
  gemini: { argv: (text) => ["-i", text] },
  // `omp [MESSAGES]`, verified on 18.x. A message prefixed with `@` would be
  // read as a file, and the seed never starts with one.
  omp: { argv: (text) => [text] },

  // The refusals. Every one of these engines does take a prompt, and every one
  // of them takes it HEADLESSLY: `kimi -p`, `mimo run`, `aider --message`, the
  // same argv `aiExecArgs` in engines.mjs uses for the ai() shortcut. Headless
  // means the engine answers once and exits, which is a query and not a
  // handoff. Seeding them that way would end with the operator back at a shell
  // prompt holding one reply, having been told their conversation had moved.
  // So each is refused by name until it grows an interactive form, and the
  // reason says which one it has.
  kimi: { unsupported: "Kimi Code takes a prompt only with -p, which prints one answer and exits" },
  deepseek: { unsupported: "DeepSeek Code takes a prompt only with --headless -p, which prints one answer and exits" },
  mimocode: { unsupported: "MiMo Code takes a prompt only with `run`, which prints one answer and exits" },
  aider: { unsupported: "aider takes a prompt only with --message, which runs one exchange and exits" },
  openagents: { unsupported: "OpenAgents launches other engines and holds no conversation of its own" },
};

/** Engines a handoff can read from, in the order they are worth trying. */
export const sources = () => Object.keys(ENGINES).filter((key) => isReadable(key));

/** Engines a handoff can launch. */
export const targets = () => Object.keys(ENGINES).filter((key) => SEEDS[key]?.argv);

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"));

/** `~/.moshcode/handoffs`, where a rendered transcript is kept. */
export function handoffDir(env = process.env) {
  return path.join(env.MOSHCODE_HOME || path.join(os.homedir(), ".moshcode"), "handoffs");
}

/**
 * The id a handoff is known by, in the ledger and in the file name.
 *
 * `<from>-<to>-<HHMMSS UTC>`, the same shape as a swarm id and for the same
 * reason: it sorts by time, it reads as what it is, and it is short enough to
 * be a herd pane name if one is ever wanted.
 */
export function handoffId(from, to, now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, "0");
  return `${from}-${to}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * A read session, rendered to the portable transcript.
 *
 * The cap keeps the newest messages, because a conversation's tail is the part
 * the next engine has to continue from. `dropped` says how many went, so the
 * receiving engine is told it is holding an excerpt rather than being allowed
 * to assume it has the whole thing.
 */
export function buildTranscript(session, { max = DEFAULT_MAX_MESSAGES, to, now = Date.now(), version = "" } = {}) {
  const all = session.messages || [];
  const kept = max > 0 && all.length > max ? all.slice(-max) : all;
  return {
    portable_transcript: PORTABLE_TRANSCRIPT_VERSION,
    generated: {
      by: `moshcode${version ? ` ${version}` : ""}`,
      at: iso(now),
      ...(to ? { to } : {}),
    },
    source: {
      engine: session.engine,
      session: session.id,
      cwd: session.cwd || "",
      started: iso(session.start),
      ended: iso(session.end),
      messages: all.length,
      dropped: all.length - kept.length,
    },
    messages: kept.map((m) => ({ role: m.role, at: iso(m.at), text: m.text })),
    changes: (session.changes || []).map((file) => ({ path: file, action: "written" })),
  };
}

/**
 * What the target engine is told, in one argument.
 *
 * Deliberately plain. It names the file, says what is in it, and says the one
 * thing a receiving engine can get wrong: the transcript describes work that
 * has already happened on disk, so the tree is the truth and the transcript is
 * the account of how it got that way.
 */
export function seedPrompt(doc, file) {
  const s = doc.source;
  const lines = [
    `You are continuing a conversation that was running in ${s.engine}.`,
    `Read ${file} first. It is a moshcode portable transcript, version ${doc.portable_transcript}.`,
    `It holds ${doc.messages.length} messages${s.dropped ? ` (the newest of ${s.messages})` : ""} and a list of the files that were changed.`,
    "The files were already written. The working tree is the real state, so read it before you edit anything.",
    "Pick up where the transcript stops.",
  ];
  // Joined with spaces and never newlines. A pane submits a prompt on its first
  // newline, so a multi-line seed would send the first sentence and leave the
  // rest in the composer.
  return lines.join(" ").replace(/\s*\n+\s*/g, " ").trim();
}

/** Write the transcript, 0600: it is a whole conversation about someone's code. */
export function writeTranscript(doc, id, { env = process.env } = {}) {
  const dir = handoffDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * Write the OpenFleet edge a handoff creates (R2).
 *
 * The child is a member whose `parent` is the session it came from, which is
 * the one relationship `moshcode fleet tree` was already shaped to draw and had
 * nothing to draw it from. When moshcode is itself running as a fleet member,
 * that member is the parent and nothing else needs inventing. When it is not,
 * the source session has no record at all, so one is written for it first: a
 * tree that showed the child hanging from nothing would be a worse record than
 * one extra node saying where it came from.
 *
 * Every write here is best effort. A handoff that read a transcript and cannot
 * write a record has still done the thing that was asked, and refusing at this
 * point would lose the conversation to protect the bookkeeping.
 */
export function recordHandoff({ from, to, id, session, transcript, cwd, messages, now = Date.now(), env = process.env, io = openfleet } = {}) {
  const ctx = io.context(env);
  const fleet = ctx.fleet;
  const sysop = ctx.sysop;
  const parent = ctx.member || `${from}-${String(session).replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "session"}`;
  const depth = Number(ctx.depth ?? 0);
  const written = [];

  if (!ctx.member) {
    const record = {
      openfleet: io.OPENFLEET_VERSION, fleet, sysop, member: parent, depth,
      engine: `moshcode/${from}`, session: String(session), host: io.host(), cwd,
      started: io.iso(now), approvals: "native", ceiling: ctx.ceiling,
    };
    if (io.writeRecord(record, { env }).ok) written.push(parent);
    // `member.start` carries a once-marker, so a second handoff out of the
    // same source session adds nothing rather than a duplicate line.
    io.append(fleet, {
      event: "member.start", by: "sysop", member: parent, session: String(session), depth,
      engine: `moshcode/${from}`, cwd,
    }, { env, now });
  }

  const child = {
    openfleet: io.OPENFLEET_VERSION, fleet, sysop, member: id, parent, depth: depth + 1,
    engine: `moshcode/${to}`, session: id, host: io.host(), cwd,
    started: io.iso(now), approvals: "native", ceiling: ctx.ceiling,
    handoff: { from, to, session: String(session), transcript, messages },
  };
  const ok = io.writeRecord(child, { env }).ok;
  if (ok) written.push(id);

  // The event, and then the start line the tree reads. `member.handoff` is the
  // audit trail: which conversation moved, where it came from, and what file
  // carried it. `member.start` is what `fold()` already looks for.
  io.append(fleet, {
    event: "member.handoff", by: ctx.by || "sysop", member: id, parent,
    from: `moshcode/${from}`, to: `moshcode/${to}`, session: String(session), transcript, messages,
  }, { env, now });
  io.append(fleet, {
    event: "member.start", by: ctx.by || "sysop", member: id, session: id, parent, depth: depth + 1,
    engine: `moshcode/${to}`, cwd,
  }, { env, now });

  return { fleet, parent, member: id, recorded: ok, written };
}

/* ------------------------------------------------------------------ the verb */

/** `--flag value` and bare flags, with an error rather than a silent default. */
export function parseHandoff(tokens = []) {
  const out = { from: null, to: null, session: null, cwd: null, max: DEFAULT_MAX_MESSAGES, dryRun: false, json: false };
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--json") out.json = true;
    else if (t === "--dry-run") out.dryRun = true;
    else if (t === "--session" || t === "--cwd" || t === "--max") {
      const value = tokens[i + 1];
      if (value == null || value.startsWith("-")) return { error: `${t} needs a value` };
      if (t === "--max") {
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n < 1) return { error: "--max must be a whole number of messages" };
        out.max = n;
      } else out[t === "--session" ? "session" : "cwd"] = value;
      i++;
    } else if (t.startsWith("-")) return { error: `unknown handoff flag "${t}"` };
    else positional.push(t);
  }
  if (positional.length > 2) return { error: "handoff takes two engines" };
  [out.from, out.to] = positional;
  if (!out.from || !out.to) return { error: "usage: moshcode handoff <from-engine> <to-engine> [--session <id>]" };
  return out;
}

const list = (names) => names.join(", ");

/**
 * Resolve both engines and refuse, by name, anything that cannot be done.
 *
 * Split out from the command so a test and the MCP bridge can ask "would this
 * work" without a launch, and so every refusal is one sentence in one place.
 */
export function planHandoff({ from, to }) {
  const source = resolveEngine(from);
  if (!source) return { error: `unknown engine "${from}". try: ${list(Object.keys(ENGINES))}` };
  const target = resolveEngine(to);
  if (!target) return { error: `unknown engine "${to}". try: ${list(Object.keys(ENGINES))}` };
  const [fromKey] = source;
  const [toKey, toEngine] = target;

  if (!isReadable(fromKey)) {
    return { error: `${fromKey} cannot be handed off from: ${UNREADABLE[fromKey] || "moshcode cannot read its transcripts"}. readable: ${list(sources())}` };
  }
  const seed = SEEDS[toKey];
  if (!seed?.argv) {
    return { error: `${toKey} cannot be handed off to: ${seed?.unsupported || "moshcode has no way to seed it"}. seedable: ${list(targets())}` };
  }
  return { from: fromKey, to: toKey, engine: toEngine, seed };
}

/**
 * The command. Reads, renders, records, launches.
 *
 * `--dry-run` does everything except the launch: the transcript is written, the
 * OpenFleet edge is recorded, the argv is built and printed. It is not a
 * simulation, it is the same run without the last step, which is what makes it
 * useful both to a test with no engine on the box and to the MCP bridge, which
 * has no terminal to hand anyone.
 * `deps` exists for the same reason: the launch and the clock are the only two
 * things a test cannot have.
 */
export async function handoffCommand(tokens = [], {
  write = console.log,
  fail = console.error,
  env = process.env,
  now = () => Date.now(),
  launch = openSession,
  version = "",
} = {}) {
  const parsed = parseHandoff(tokens);
  if (parsed.error) { fail(parsed.error); return 1; }

  const plan = planHandoff(parsed);
  if (plan.error) { fail(plan.error); return 1; }

  const cwd = path.resolve(parsed.cwd || process.cwd());
  let session;
  try {
    session = await readSession(plan.from, { id: parsed.session, cwd });
  } catch (error) {
    fail(String(error.message || error));
    return 1;
  }

  const at = now();
  const id = handoffId(plan.from, plan.to, at);
  const doc = buildTranscript(session, { max: parsed.max, to: plan.to, now: at, version });
  const file = writeTranscript(doc, id, { env });
  const prompt = seedPrompt(doc, file);
  const argv = plan.seed.argv(prompt);

  const fleet = recordHandoff({
    from: plan.from, to: plan.to, id, session: session.id, transcript: file,
    cwd: session.cwd || cwd, messages: doc.messages.length, now: at, env,
  });

  if (parsed.json) {
    write(JSON.stringify({
      handoff: id, from: plan.from, to: plan.to, transcript: file,
      session: doc.source, messages: doc.messages.length, changes: doc.changes.length,
      fleet, argv: [plan.engine.bin, ...argv], launched: !parsed.dryRun,
    }, null, 2));
  } else {
    // Say what was picked before anything starts, because the session was
    // chosen for the operator and a wrong pick is only visible here.
    const span = doc.source.started ? `${doc.source.started} to ${doc.source.ended}` : "no timestamps";
    write(`· ${plan.from} session ${session.id}`);
    write(`  ${doc.messages.length} message${doc.messages.length === 1 ? "" : "s"}${doc.source.dropped ? ` of ${doc.source.messages}` : ""}, ${span}`);
    write(`  ${doc.changes.length} file${doc.changes.length === 1 ? "" : "s"} changed, in ${doc.source.cwd || cwd}`);
    write(`· transcript ${file}`);
    write(`· fleet ${fleet.fleet}: ${fleet.member} under ${fleet.parent}`);
    write(parsed.dryRun
      ? `· dry run, not launching: ${plan.engine.bin} ${argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`
      : `· handing it to ${plan.to}`);
  }
  if (parsed.dryRun) return 0;

  // Plain defaults, never the agent-mode flags. A handoff moves a
  // conversation; it does not also decide that the next engine may skip its
  // approvals, and an operator who wants that says so by starting the engine
  // that way afterwards.
  const result = await launch(plan.engine, argv);
  if (!result.ok) {
    fail(result.error?.code === "ENOENT"
      ? `${plan.to} isn't installed (\`${plan.engine.bin}\`). run: moshcode install ${plan.to}`
      : `launch failed: ${result.error?.message || result.error}`);
    return 1;
  }
  return result.code || 0;
}

/** The sessions a handoff could pick, for anything that wants to offer a choice. */
export async function handoffSessions(engine, { cwd = null } = {}) {
  const resolved = resolveEngine(engine);
  if (!resolved) return [];
  return listSessions(resolved[0], { cwd });
}
