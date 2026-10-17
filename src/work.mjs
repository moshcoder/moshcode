// Work: a queue, headless workers, a verifier, an inbox (PRD 0021).
//
// The swarm (PRD 0015) is one task, planned, with a pane per piece that a
// person can watch. That shape stops at the number of panes a person can
// read. This is the other shape, the one that scales: a queue of tasks that
// each carry their own `verify` command, workers that are not panes, and a
// person who only ever sees what the verifier could not settle.
//
//   task       { prompt, verify, cwd }. `verify` is a shell command; exit 0
//              is the only definition of done. No task without one.
//   claim      a task is a file. A worker claims it by renaming it from
//              pending/ to claimed/: rename is atomic, so two workers, in
//              this process or another one on the same filesystem, never
//              hold the same task.
//   attempt    in its own git worktree at the run's base commit (unless
//              --no-isolate), the engine runs headless with its autonomous
//              flags, then `verify` runs. The engine's own opinion of how it
//              went is recorded and never consulted.
//   outcome    verify passed: done, and the diff is kept as a patch under
//              results/. Failed: back to pending with the failure appended
//              to the next attempt's prompt, until --max-attempts, then the
//              inbox. Setup failing is the inbox at once: no engine call can
//              fix the box it runs on.
//   apply      patches land in the checkout one at a time, each checked
//              first; one that no longer applies goes to the inbox.
//
// The id of a task is a hash of what it asks (prompt, verify, cwd), so adding
// the same task twice is one task, and a task that is already done stays
// done instead of being paid for again.
//
// Every run is an OpenFleet swarm (PRD 0016): checked against the ceiling
// before anything starts, one swarm.spawn, one member record and member.start
// / member.end per attempt (the verdict on the end line), one swarm.end.
// `moshcode fleet tree` shows it like any other swarm.
//
// Everything that spawns goes through `deps`, so the orchestration is tested
// with a fake engine and a real git repository.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ENGINES, aiExecArgs, pickAiEngine, resolveExecutable } from "./engines.mjs";
import * as openfleet from "./openfleet.mjs";

export const STATES = ["pending", "claimed", "done", "inbox"];
export const DEFAULT_WORKERS = 4;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_CHARS = 4000;
const CAPTURE_BYTES = 256 * 1024;
const QUEUE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// Directory names a worktree gets as symlinks to the checkout's own, wherever
// they sit in it (findLinkable), so a tree can run its tests without an
// install per attempt. Never part of a patch.
export const LINKED = ["node_modules"];

/* ---------------------------------------------------------------- the files */

export function workHome(env = process.env) {
  return env.MOSHCODE_WORK_DIR || path.join(os.homedir(), ".moshcode", "work");
}

export function validQueueName(name) {
  return QUEUE_RE.test(String(name || ""));
}

export function queueDir(queue, env = process.env) {
  if (!validQueueName(queue)) throw new Error(`not a queue name: ${JSON.stringify(queue)} (letters, digits, . _ -)`);
  return path.join(workHome(env), queue);
}

const stateDir = (dir, state) => path.join(dir, state);
const taskFile = (dir, state, id) => path.join(dir, state, `${id}.json`);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  // Write then rename: a reader never sees half a task.
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** Create the queue's directories (and its queue.json once). Returns the dir. */
export function ensureQueue(queue, { env = process.env, now = Date.now(), meta = {} } = {}) {
  const dir = queueDir(queue, env);
  for (const s of [...STATES, "results", "runs", "trees"]) ensureDir(stateDir(dir, s));
  const file = path.join(dir, "queue.json");
  if (!fs.existsSync(file)) writeJson(file, { queue, created: openfleet.iso(now), ...meta });
  return dir;
}

export function queueExists(queue, env = process.env) {
  return validQueueName(queue) && fs.existsSync(path.join(queueDir(queue, env), "queue.json"));
}

export function listQueues(env = process.env) {
  try {
    return fs.readdirSync(workHome(env)).filter((q) => queueExists(q, env)).sort();
  } catch { return []; }
}

/** The id a task gets: what it asks, hashed. Same ask, same id. */
export function taskId({ prompt, verify, cwd }) {
  return crypto.createHash("sha256").update(JSON.stringify([prompt, verify, cwd])).digest("hex").slice(0, 12);
}

/** Where a task is now, and the task. Null when it is in no state. */
export function findTask(queue, id, env = process.env) {
  const dir = queueDir(queue, env);
  for (const state of STATES) {
    const task = readJson(taskFile(dir, state, id));
    if (task) return { state, task };
  }
  return null;
}

/** Every task in a state, oldest first. */
export function listTasks(queue, state, env = process.env) {
  const dir = stateDir(queueDir(queue, env), state);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
  return names.map((n) => readJson(path.join(dir, n))).filter(Boolean)
    .sort((a, b) => String(a.created).localeCompare(String(b.created)) || String(a.id).localeCompare(String(b.id)));
}

/**
 * Add a task. `{ ok, id, added }`: added is false when the same ask is
 * already in the queue in any state, which is how a done task is never paid
 * for twice.
 */
export function addTask(queue, spec, { env = process.env, now = Date.now() } = {}) {
  const prompt = String(spec.prompt || "").trim();
  const verify = String(spec.verify || "").trim();
  if (!prompt) return { ok: false, error: "a task needs a prompt" };
  if (!verify) return { ok: false, error: "a task needs a verify command: exit 0 is the only definition of done" };
  const cwd = path.resolve(spec.cwd || process.cwd());
  const id = taskId({ prompt, verify, cwd });
  const dir = ensureQueue(queue, { env, now });
  const existing = findTask(queue, id, env);
  if (existing) return { ok: true, id, added: false, state: existing.state };
  const maxAttempts = Number(spec.maxAttempts) > 0 ? Math.floor(Number(spec.maxAttempts)) : DEFAULT_MAX_ATTEMPTS;
  const task = {
    id, title: String(spec.title || prompt.split("\n")[0]).slice(0, 120), prompt, verify, cwd,
    ...(spec.hint ? { hint: String(spec.hint).slice(-TAIL_CHARS) } : {}),
    maxAttempts, attempts: [], created: openfleet.iso(now),
  };
  writeJson(taskFile(dir, "pending", id), task);
  return { ok: true, id, added: true, state: "pending" };
}

/** Move a task between states, rewriting it on the way. False when it is not there. */
function move(dir, from, to, task) {
  const src = taskFile(dir, from, task.id);
  const dst = taskFile(dir, to, task.id);
  try { fs.renameSync(src, dst); } catch { return false; }
  writeJson(dst, task);
  return true;
}

/**
 * Claim the oldest pending task for `worker`. The rename is the lock: when it
 * fails someone else got there first, and the next file is tried.
 */
export function claimTask(queue, worker, { env = process.env, now = Date.now(), host = os.hostname(), pid = process.pid } = {}) {
  const dir = queueDir(queue, env);
  for (const pending of listTasks(queue, "pending", env)) {
    const src = taskFile(dir, "pending", pending.id);
    const dst = taskFile(dir, "claimed", pending.id);
    try { fs.renameSync(src, dst); } catch { continue; }
    const task = readJson(dst) || pending;
    task.claim = { worker, host, pid, at: openfleet.iso(now) };
    writeJson(dst, task);
    return task;
  }
  return null;
}

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

/**
 * Put back claims nobody is working on: on this host, a claim whose process is
 * gone; anywhere, a claim older than `staleMs`. The attempt it was making is
 * not counted, because nothing was verified.
 */
export function recoverClaims(queue, { env = process.env, now = Date.now(), host = os.hostname(), staleMs = null, alive = pidAlive } = {}) {
  const dir = queueDir(queue, env);
  const back = [];
  for (const task of listTasks(queue, "claimed", env)) {
    const c = task.claim || {};
    const old = staleMs !== null && now - Date.parse(c.at || 0) > staleMs;
    const dead = c.host === host && c.pid && !alive(c.pid);
    if (!old && !dead) continue;
    delete task.claim;
    if (move(dir, "claimed", "pending", task)) back.push(task.id);
  }
  return back;
}

/** Send inbox tasks (or one) back to pending with a fresh attempt budget. */
export function retryTasks(queue, ids, { env = process.env, now = Date.now(), all = false } = {}) {
  const dir = queueDir(queue, env);
  const want = new Set(ids);
  const moved = [];
  for (const task of listTasks(queue, "inbox", env)) {
    if (!all && !want.has(task.id)) continue;
    removeTree(task.inbox?.tree);
    const history = [...(task.history || []), ...task.attempts];
    const next = { ...task, attempts: [], history, retried: openfleet.iso(now) };
    delete next.inbox;
    if (move(dir, "inbox", "pending", next)) moved.push(task.id);
  }
  return moved;
}

/** Remove tasks outright, from any state but claimed. */
export function dropTasks(queue, ids, { env = process.env } = {}) {
  const dir = queueDir(queue, env);
  const dropped = [];
  for (const id of ids) {
    const found = findTask(queue, id, env);
    if (!found || found.state === "claimed") continue;
    removeTree(found.task.inbox?.tree);
    try { fs.unlinkSync(taskFile(dir, found.state, id)); dropped.push(id); } catch { /* raced */ }
    try { fs.unlinkSync(path.join(dir, "results", `${id}.patch`)); } catch { /* none */ }
  }
  return dropped;
}

function removeTree(tree) {
  if (!tree) return;
  try { fs.rmSync(tree, { recursive: true, force: true }); } catch { /* already gone */ }
}

/* ---------------------------------------------------------------- the status */

/**
 * The queue as numbers, which is all a person needs while it runs: how many
 * in each state, how many attempts it took, and how many need them.
 */
export function queueStatus(queue, { env = process.env } = {}) {
  const tasks = Object.fromEntries(STATES.map((s) => [s, listTasks(queue, s, env)]));
  const all = STATES.flatMap((s) => tasks[s]);
  const attempts = all.reduce((n, t) => n + t.attempts.length + (t.history || []).length, 0);
  const passedAttempts = tasks.done.reduce((n, t) => n + t.attempts.length, 0);
  const finished = tasks.done.length + tasks.inbox.length;
  const doneAt = tasks.done.map((t) => Date.parse(t.finished || "")).filter(Number.isFinite);
  const startedAt = all.flatMap((t) => [...t.attempts, ...(t.history || [])]).map((a) => Date.parse(a.started || "")).filter(Number.isFinite);
  const spanH = doneAt.length && startedAt.length ? Math.max(1 / 60, (Math.max(...doneAt) - Math.min(...startedAt)) / 3600000) : null;
  return {
    queue,
    dir: queueDir(queue, env),
    counts: Object.fromEntries(STATES.map((s) => [s, tasks[s].length])),
    total: all.length,
    attempts,
    passRate: finished ? tasks.done.length / finished : null,
    attemptsPerPass: tasks.done.length ? passedAttempts / tasks.done.length : null,
    alreadyPassing: tasks.done.filter((t) => t.result?.already).length,
    patches: tasks.done.filter((t) => t.result?.patch).length,
    applied: tasks.done.filter((t) => t.result?.applied).length,
    perHour: spanH ? tasks.done.length / spanH : null,
    working: tasks.claimed.map((t) => ({ id: t.id, title: t.title, worker: t.claim?.worker, since: t.claim?.at })),
  };
}

/* ---------------------------------------------------------------- the prompt */

/** What a worker is told. The verify command is the definition of done, said out loud. */
export function workerPrompt(task) {
  const parts = [
    task.prompt.trim(),
    "",
    "Done means this command exits 0 when run from this directory:",
    `    ${task.verify}`,
    "Run it yourself before you stop, and keep going until it passes. Work only in this directory. Do not commit, push, or open a pull request: the change is collected from the working tree.",
  ];
  if (task.hint) parts.push("", "It failed like this before anyone started:", fence(task.hint));
  const last = task.attempts[task.attempts.length - 1];
  if (last) {
    parts.push("", `Attempt ${last.n} of ${task.maxAttempts} did not pass. The verify command printed:`, fence(last.verifyTail || last.error || "(nothing)"));
  }
  parts.push("", "End with a section headed SUMMARY: saying what you changed and why.");
  return parts.join("\n");
}

const fence = (s) => `\`\`\`\n${String(s).slice(-TAIL_CHARS).trim()}\n\`\`\``;

export function tail(s, n = TAIL_CHARS) {
  const t = String(s || "").trim();
  return t.length > n ? t.slice(-n) : t;
}

/** The engine's SUMMARY: section, or its last lines. */
export function summaryOf(output) {
  const s = String(output || "").trim();
  const at = s.toUpperCase().lastIndexOf("SUMMARY:");
  const body = (at >= 0 ? s.slice(at + 8) : s).trim();
  return body.length > 500 ? body.slice(-500) : body;
}

/* --------------------------------------------------------------- the process */

/**
 * Run a process to completion without blocking the loop, which is what lets
 * one moshcode drive many workers. Output past CAPTURE_BYTES keeps its tail.
 */
export function runProcess(bin, args, { cwd, env = process.env, timeoutMs = 0, shell = false } = {}) {
  return new Promise((resolve) => {
    let out = "", errText = "", timedOut = false, settled = false;
    const keep = (buf, chunk) => { const s = buf + chunk; return s.length > CAPTURE_BYTES ? s.slice(-CAPTURE_BYTES) : s; };
    let child;
    try {
      child = spawn(bin, args, { cwd, env, shell, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", error: String(error.message || error), timedOut: false });
      return;
    }
    // The whole process group: a test runner's children die with it.
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; kill(); }, timeoutMs) : null;
    child.stdout.on("data", (c) => { out = keep(out, c.toString()); });
    child.stderr.on("data", (c) => { errText = keep(errText, c.toString()); });
    const done = (result) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(result); };
    child.on("error", (error) => done({ code: null, signal: null, stdout: out, stderr: errText, error: String(error.message || error), timedOut }));
    child.on("close", (code, signal) => done({ code, signal, stdout: out, stderr: errText, error: null, timedOut }));
  });
}

const sh = (command, opts) => runProcess(command, [], { ...opts, shell: true });
const git = (cwd, args) => runProcess("git", args, { cwd });

/** The argv a worker's engine runs with: its headless form plus its autonomous flags. */
export function workerArgs(engine, prompt) {
  return [...aiExecArgs(engine, prompt), ...(ENGINES[engine]?.agentArgs || [])];
}

/** What a run needs from the outside world. Tests hand in their own engine. */
export function liveWorkDeps({ env = process.env } = {}) {
  return {
    engine: (engine, prompt, { cwd, env: extra = {}, timeoutMs }) => {
      const spec = ENGINES[engine];
      const bin = resolveExecutable(spec.bin, spec.binDirs || []) || spec.bin;
      const clean = { ...env, ...extra };
      for (const k of spec.stripEnv || []) delete clean[k];
      return runProcess(bin, workerArgs(engine, prompt), { cwd, env: clean, timeoutMs });
    },
    sh: (command, { cwd, timeoutMs }) => sh(command, { cwd, env, timeoutMs }),
    git,
  };
}

/* ------------------------------------------------------------- the worktrees */

async function repoOf(cwd, deps) {
  const top = await deps.git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return null;
  const root = top.stdout.trim();
  const head = await deps.git(root, ["rev-parse", "HEAD"]);
  if (head.code !== 0) return null;
  return { root, base: head.stdout.trim() };
}

/** A detached worktree of `repo` at its base, with the checkout's LINKED paths linked in. */
async function makeTree(repo, dir, deps) {
  let res;
  for (let i = 0; i < 3; i++) {
    // Concurrent adds race on the repository's worktree lock; a retry is enough.
    res = await deps.git(repo.root, ["worktree", "add", "--detach", "--quiet", dir, repo.base]);
    if (res.code === 0) break;
    await new Promise((r) => { setTimeout(r, 200 * (i + 1)); });
  }
  if (res.code !== 0) return { ok: false, error: `git worktree add failed: ${tail(res.stderr || res.error, 400)}` };
  const linked = [];
  for (const rel of findLinkable(repo.root)) {
    const src = path.join(repo.root, rel);
    const dst = path.join(dir, rel);
    // Only where the tree has the package too: a package the base commit lacks gets nothing.
    if (fs.existsSync(path.dirname(dst)) && !fs.existsSync(dst)) {
      try { fs.symlinkSync(src, dst, "dir"); linked.push(rel); } catch { /* the tree works without it, slower */ }
    }
  }
  return { ok: true, dir, linked };
}

const NO_DESCEND = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".turbo", ".svelte-kit", "target"]);

/**
 * Every LINKED directory in the checkout, root first, at most `maxDepth`
 * levels down: a monorepo's packages each have their own node_modules
 * (pnpm puts one per package), and a tree with only the root's cannot run
 * a package's tests.
 */
export function findLinkable(root, { names = LINKED, maxDepth = 4 } = {}) {
  const out = [];
  const walk = (rel, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = rel ? path.join(rel, e.name) : e.name;
      if (names.includes(e.name)) { out.push(child); continue; }
      if (NO_DESCEND.has(e.name) || e.name.startsWith(".") || depth >= maxDepth) continue;
      walk(child, depth + 1);
    }
  };
  walk("", 0);
  return out.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
}

async function dropTree(repo, dir, deps) {
  await deps.git(repo.root, ["worktree", "remove", "--force", dir]);
  removeTree(dir);
  await deps.git(repo.root, ["worktree", "prune"]);
}

/** Everything the attempt changed against the base, as one binary-safe patch. */
async function collectPatch(dir, base, linked, deps) {
  // Add everything, then take the links back out. Naming a link in the add
  // itself (an exclude pathspec) makes git refuse the whole add when the
  // repository's .gitignore already ignores it, which `node_modules` without
  // a trailing slash does.
  const add = await deps.git(dir, ["add", "-A"]);
  if (add.code !== 0) return { ok: false, error: `git add failed: ${tail(add.stderr, 400)}` };
  if (linked.length) {
    const unstage = await deps.git(dir, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...linked]);
    if (unstage.code !== 0) return { ok: false, error: `git rm --cached failed: ${tail(unstage.stderr, 400)}` };
  }
  const diff = await deps.git(dir, ["diff", "--cached", "--binary", base]);
  if (diff.code !== 0) return { ok: false, error: `git diff failed: ${tail(diff.stderr, 400)}` };
  const names = await deps.git(dir, ["diff", "--cached", "--name-only", base]);
  return { ok: true, patch: diff.stdout, files: names.stdout.split("\n").filter(Boolean) };
}

/* ------------------------------------------------------------------- the run */

/**
 * Drain a queue with `workers` headless workers. Returns the run as data:
 * `{ ok, swarm, fleet, done, retried, inbox, attempts, status }`.
 */
export async function runWork(options, {
  write = () => {}, deps = liveWorkDeps(), engineOf = pickAiEngine, now = () => Date.now(), env = process.env,
} = {}) {
  const {
    queue, workers = DEFAULT_WORKERS, isolate = true, timeoutMs = DEFAULT_TIMEOUT_MS,
    verifyTimeoutMs = DEFAULT_VERIFY_TIMEOUT_MS, limit = 0, setup = null, precheck = true,
  } = options;
  if (!queueExists(queue, env)) return { ok: false, error: `no queue named ${JSON.stringify(queue)}: moshcode work add ${queue} …` };
  const engine = engineOf(options.engine);
  if (!engine) return { ok: false, error: options.engine ? `no installed engine named ${JSON.stringify(options.engine)}` : "no engine installed: moshcode install claude" };
  if (!Object.hasOwn(ENGINES, engine)) return { ok: false, error: `no engine named ${JSON.stringify(engine)}` };
  const dir = queueDir(queue, env);
  const fleetIO = deps.fleet || openfleet;

  const recovered = recoverClaims(queue, { env, now: now() });
  if (recovered.length) write(`recovered ${recovered.length} claim${recovered.length === 1 ? "" : "s"} whose worker is gone`);

  // The fleet, exactly the way a swarm finds it.
  const ctx = fleetIO.context(env);
  const hostname = fleetIO.host();
  const { fleet, sysop } = ctx;
  const parent = ctx.member || null;
  const parentSwarm = ctx.record?.swarm || null;
  const depth = parent ? ctx.depth + 1 : 0;
  const by = parent || "sysop";
  const ledger = (line) => fleetIO.append(fleet, line, { env, now: now() });
  // Several runs may drain one queue in the same minute, so the id carries a
  // nonce: two runs sharing a swarm id would share member ids too.
  const swarm = openfleet.swarmId(`${queue.slice(0, 18)} ${crypto.randomBytes(2).toString("hex")}`, { now: now() });
  const approvals = (ENGINES[engine].agentArgs || []).length ? "bypass" : "native";
  const engineString = `moshcode/${engine}`;
  const narrowing = openfleet.narrowingOf({ fan_out: workers }, ctx.ceiling);
  const ceiling = openfleet.mergeCeiling(ctx.ceiling, narrowing);
  const refusal = openfleet.checkCeiling({ depth, fan_out: workers, hosts: [hostname] }, ceiling, { now: now() })
    || openfleet.checkCeiling({ approvals }, ceiling, { now: now() });
  if (refusal) {
    ledger({ event: "ceiling.refuse", by, key: refusal.key, wanted: refusal.wanted, allowed: refusal.allowed, action: "spawn" });
    return { ok: false, swarm, fleet, error: `the ceiling refuses ${refusal.key}: wanted ${JSON.stringify(refusal.wanted)}, allowed ${JSON.stringify(refusal.allowed)}`, refused: refusal };
  }
  if (!parent && ceiling.approvals === undefined) ceiling.approvals = approvals;
  ledger({
    event: "swarm.spawn", by, swarm, ...(parentSwarm ? { parent_swarm: parentSwarm } : {}), task: `work ${queue}`, ceiling: narrowing, pieces: [],
  });

  const repos = new Map(); // repo root → { root, base }, fixed for the whole run
  const repoFor = async (cwd) => {
    if (!isolate) return null;
    for (const r of repos.values()) if (cwd === r.root || cwd.startsWith(`${r.root}${path.sep}`)) return r;
    const r = await repoOf(cwd, deps);
    if (r) repos.set(r.root, r);
    return r;
  };

  const tally = { done: 0, retried: 0, inbox: 0, attempts: 0 };
  let taken = 0, seq = 0;
  write(`swarm ${swarm}: ${workers} worker${workers === 1 ? "" : "s"} on queue ${queue} (${engine}${isolate ? ", a worktree per attempt" : ", in place"}, fleet ${fleet})`);

  const finish = (task, to, extra = {}) => {
    const next = { ...task, ...extra };
    delete next.claim;
    move(dir, "claimed", to, next);
  };
  const toInbox = (task, reason, extra = {}) => {
    finish(task, "inbox", { ...extra, inbox: { reason, ...(extra.tree ? { tree: extra.tree } : {}), at: openfleet.iso(now()) } });
    tally.inbox++;
    write(`  ✗ ${task.id} inbox: ${reason}`);
  };

  const attempt = async (task, worker) => {
    const n = task.attempts.length + 1;
    const started = now();
    const row = { n, worker, started: openfleet.iso(started), engine };
    const repo = await repoFor(task.cwd);
    if (isolate && !repo) {
      toInbox(task, `${task.cwd} is not inside a git repository with a commit (use --no-isolate to work in place)`);
      return;
    }
    let tree = null, cwd = task.cwd;
    if (repo) {
      const made = await makeTree(repo, path.join(dir, "trees", `${task.id}-${n}`), deps);
      if (!made.ok) { toInbox(task, made.error); return; }
      tree = made;
      cwd = path.join(made.dir, path.relative(repo.root, task.cwd));
    }
    let keepTree = false;
    try {
      if (setup) {
        const s = await deps.sh(setup, { cwd, timeoutMs: verifyTimeoutMs });
        if (s.code !== 0 || s.timedOut) {
          keepTree = Boolean(tree);
          toInbox(task, `setup failed (exit ${s.timedOut ? "timeout" : s.code}): ${tail(s.stderr || s.stdout, 400)}`, { tree: tree?.dir });
          return;
        }
      }
      // Before paying for an engine: is it already true? A flaky test, or a
      // task another fix settled, costs one verify and no tokens.
      if (precheck && n === 1 && !(task.history || []).length) {
        const pre = await deps.sh(task.verify, { cwd, timeoutMs: verifyTimeoutMs });
        if (pre.code === 0 && !pre.timedOut) {
          finish(task, "done", { finished: openfleet.iso(now()), result: { already: true } });
          tally.done++;
          write(`  ✓ ${task.id} already passes: ${task.title}`);
          return;
        }
      }

      // One attempt is one member: its record, its start, its end with the verdict.
      const member = `${swarm}-${++seq}`;
      row.member = member;
      tally.attempts++;
      const record = {
        openfleet: openfleet.OPENFLEET_VERSION, fleet, sysop, member, ...(parent ? { parent } : {}), swarm,
        task: task.title, piece: { title: task.title, work: { queue, task: task.id, attempt: n } }, depth,
        engine: engineString, session: member, host: hostname, cwd, started: openfleet.iso(started), approvals, ceiling,
      };
      const written = fleetIO.writeRecord(record, { env });
      ledger({
        event: "member.start", by, member, session: member, swarm, ...(parent ? { parent } : {}), depth, engine: engineString, cwd, approvals,
      });
      const fleetEnv = {
        OPENFLEET_HOME: fleetIO.home(env), OPENFLEET_FLEET: fleet, OPENFLEET_MEMBER: member, OPENFLEET_SWARM: swarm,
        ...(written.ok ? { OPENFLEET_RECORD: written.path } : {}),
        MOSHCODE_WORK_QUEUE: queue, MOSHCODE_WORK_TASK: task.id,
      };
      write(`  → ${task.id} attempt ${n}/${task.maxAttempts} (${worker}): ${task.title}`);
      const ran = await deps.engine(engine, workerPrompt(task), { cwd, env: fleetEnv, timeoutMs });
      fs.writeFileSync(path.join(dir, "runs", `${task.id}-${n}.log`), `${ran.stdout || ""}\n--- stderr ---\n${ran.stderr || ""}\n`);
      row.engineExit = ran.timedOut ? "timeout" : (ran.code ?? ran.signal ?? ran.error);
      row.summary = summaryOf(ran.stdout);
      const v = await deps.sh(task.verify, { cwd, timeoutMs: verifyTimeoutMs });
      row.verifyExit = v.timedOut ? "timeout" : v.code;
      row.verifyTail = tail(`${v.stdout || ""}\n${v.stderr || ""}`);
      row.ended = openfleet.iso(now());
      const passed = v.code === 0 && !v.timedOut;

      let result = null;
      if (passed && tree) {
        const p = await collectPatch(tree.dir, repo.base, tree.linked, deps);
        if (!p.ok) {
          row.error = p.error;
        } else if (p.patch.trim()) {
          const patchFile = path.join(dir, "results", `${task.id}.patch`);
          fs.writeFileSync(patchFile, p.patch);
          result = { patch: patchFile, base: repo.base, root: repo.root, files: p.files };
        } else {
          result = { patch: null, base: repo.base, root: repo.root, files: [], note: "passed with no change" };
        }
      } else if (passed) {
        result = { patch: null, inPlace: true };
      }
      const ok = passed && result !== null;
      ledger({
        event: "member.end", by, member, state: ok ? "done" : "failed",
        verdict: { verify: task.verify, exit: row.verifyExit, passed: ok },
        ...(row.summary ? { summary: row.summary } : {}),
      });

      const attempts = [...task.attempts, row];
      if (ok) {
        finish(task, "done", { attempts, finished: row.ended, result });
        tally.done++;
        const files = result.files?.length ? ` (${result.files.length} file${result.files.length === 1 ? "" : "s"})` : "";
        write(`  ✓ ${task.id} passed on attempt ${n}${files}: ${task.title}`);
      } else if (passed) {
        // Verify passed and the change could not be collected: another attempt
        // would pass again and fail the same way. The kept tree has the work.
        keepTree = Boolean(tree);
        toInbox(task, `verify passed, but the change could not be collected: ${row.error}`, { attempts, tree: tree?.dir });
      } else if (n < task.maxAttempts) {
        finish(task, "pending", { attempts });
        tally.retried++;
        write(`  ~ ${task.id} failed verify (exit ${row.verifyExit}), back in the queue`);
      } else {
        keepTree = Boolean(tree);
        toInbox(task, row.error || `failed verify ${n} time${n === 1 ? "" : "s"}`, { attempts, tree: tree?.dir });
      }
    } finally {
      if (tree && !keepTree) await dropTree(repo, tree.dir, deps);
    }
  };

  const loop = async (w) => {
    const worker = `${swarm}/w${w + 1}`;
    for (;;) {
      if (limit && taken >= limit) return;
      const task = claimTask(queue, worker, { env, now: now() });
      if (!task) return;
      taken++;
      try {
        await attempt(task, worker);
      } catch (error) {
        // A crash in the orchestration is not the task's fault: put it back
        // once, and stop this worker so a bug cannot spin on the same task.
        finish(task, "pending", {});
        write(`  ! ${task.id}: ${error.message || error}`);
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, workers) }, (_, w) => loop(w)));

  const state = tally.inbox && !tally.done ? "failed" : "done";
  ledger({
    event: "swarm.end", by, swarm, state,
    summary: `${tally.done} done, ${tally.inbox} to the inbox, ${tally.retried} retried, ${tally.attempts} engine attempt${tally.attempts === 1 ? "" : "s"}`,
  });
  return { ok: tally.inbox === 0, engine, swarm, fleet, ...tally, status: queueStatus(queue, { env }) };
}

/* ------------------------------------------------------------------- apply */

/**
 * Land done patches in their checkout, oldest first. Each is checked before it
 * is applied, so the checkout never gets half a patch; one that no longer
 * applies is sent to the inbox (retry re-runs it against the new HEAD).
 */
export async function applyPatches(queue, { env = process.env, deps = liveWorkDeps(), now = () => Date.now(), write = () => {}, dryRun = false } = {}) {
  const dir = queueDir(queue, env);
  const ready = listTasks(queue, "done", env)
    .filter((t) => t.result?.patch && !t.result.applied)
    .sort((a, b) => String(a.finished).localeCompare(String(b.finished)));
  const applied = [], conflicted = [];
  for (const task of ready) {
    const root = task.result.root;
    const check = await deps.git(root, ["apply", "--check", "--binary", task.result.patch]);
    if (check.code !== 0) {
      if (!dryRun) move(dir, "done", "inbox", { ...task, inbox: { reason: `the patch no longer applies to ${root}: ${tail(check.stderr, 400)}`, at: openfleet.iso(now()) } });
      conflicted.push(task.id);
      write(`  ✗ ${task.id} no longer applies: ${task.title}`);
      continue;
    }
    if (dryRun) { applied.push(task.id); write(`  · ${task.id} would apply: ${task.title}`); continue; }
    const res = await deps.git(root, ["apply", "--binary", task.result.patch]);
    if (res.code !== 0) {
      conflicted.push(task.id);
      write(`  ✗ ${task.id} failed to apply: ${tail(res.stderr, 200)}`);
      continue;
    }
    writeJson(taskFile(dir, "done", task.id), { ...task, result: { ...task.result, applied: openfleet.iso(now()) } });
    applied.push(task.id);
    write(`  ✓ ${task.id} applied: ${task.title}`);
  }
  return { ok: conflicted.length === 0, applied, conflicted };
}

/* --------------------------------------------------------- from failing tests */

/** Test files under `dirs` (default test/ and tests/), node_modules skipped. */
export function findTestFiles(root, { dirs = ["test", "tests"], pattern = /\.test\.(m?[jt]s|cjs)$/ } = {}) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (pattern.test(e.name)) out.push(path.relative(root, p));
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  return out.sort();
}

const shQuote = (s) => (/^[\w./@:=+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);

/**
 * Run each test file on its own and queue one task per file that fails: the
 * pilot workload, because a failing test already is a verifier.
 */
export async function queueFailingTests(queue, {
  cwd = process.cwd(), runner = "node --test", files = null, jobs = 8, timeoutMs = 120000, maxAttempts,
  env = process.env, deps = liveWorkDeps(), write = () => {}, now = () => Date.now(),
} = {}) {
  const root = path.resolve(cwd);
  const list = files?.length ? files : findTestFiles(root);
  const failing = [];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const file = list[i++];
      const verify = `${runner} ${shQuote(file)}`;
      const r = await deps.sh(verify, { cwd: root, timeoutMs });
      if (r.code === 0 && !r.timedOut) continue;
      failing.push({ file, verify, hint: tail(`${r.stdout || ""}\n${r.stderr || ""}`), timedOut: r.timedOut });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, list.length)) }, worker));
  failing.sort((a, b) => a.file.localeCompare(b.file));
  const added = [];
  for (const f of failing) {
    const r = addTask(queue, {
      title: `make ${f.file} pass`,
      prompt: `The tests in ${f.file} fail${f.timedOut ? " (they timed out)" : ""}. Find out why and fix it. Fix the code under test; change the test only when the test itself is wrong, and say so in your summary.`,
      verify: f.verify, cwd: root, hint: f.hint, maxAttempts,
    }, { env, now: now() });
    if (r.ok && r.added) added.push(r.id);
    write(`  ${r.added ? "+" : "="} ${r.id} ${f.file}${r.added ? "" : ` (already ${r.state})`}`);
  }
  return { ok: true, scanned: list.length, failing: failing.length, added };
}
