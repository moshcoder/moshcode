// `moshcode work` — the queue, its workers, and the inbox (PRD 0021).
//
// The verbs are the operator's whole interface to a run that may hold
// thousands of tasks: add work, start workers, read the numbers, and deal with
// the inbox. Nothing here prints a task's transcript unless asked for it by
// id; at that scale the transcripts are what nobody can read.
import fs from "node:fs";

import { resolveEngine, ENGINES } from "./engines.mjs";
import { acid, amber, ash, bone, err, info, ok, warn } from "./ui.mjs";
import * as work from "./work.mjs";

export const WORK_USAGE = `usage: moshcode work <verb> [args…]
  ls                                       every queue, with its counts
  add <queue> "<prompt>" --verify "<cmd>"  one task (or --file tasks.jsonl)
  from-tests <queue> [--runner "node --test"]  one task per failing test file
  run <queue> [-n 4] [--engine claude]     drain it with headless workers
  status <queue>                           the numbers
  inbox <queue>                            what the verifier could not settle
  show <queue> <id>                        one task, every attempt
  retry <queue> <id…|--all>                inbox back to the queue, fresh attempts
  drop <queue> <id…>                       remove tasks
  apply <queue> [--dry-run]                land the passing patches in the checkout
  recover <queue> [--stale 2h]             put back claims whose worker is gone`;

const EXIT = { ok: 0, fail: 1, usage: 2 };

function parseDuration(raw) {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(String(raw || "").trim());
  if (!m) return null;
  return Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || "s"];
}

/**
 * Flags and positionals. `spec` maps a flag to "string" | "number" |
 * "duration" | "bool"; aliases map short forms.
 */
export function parseWorkArgs(argv, spec, aliases = {}) {
  const flags = {}, words = [], errors = [];
  for (let i = 0; i < argv.length; i++) {
    let a = String(argv[i]);
    let inline;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    a = aliases[a] || a;
    if (!a.startsWith("-") || a === "-") { words.push(a); continue; }
    const key = a.replace(/^-+/, "");
    const kind = spec[key];
    if (!kind) { errors.push(`unknown flag ${a}`); continue; }
    if (kind === "bool") { flags[key] = true; continue; }
    const raw = inline ?? argv[++i];
    if (raw === undefined) { errors.push(`${a} needs a value`); continue; }
    if (kind === "number") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) { errors.push(`${a} needs a positive whole number`); continue; }
      flags[key] = n;
    } else if (kind === "duration") {
      const ms = parseDuration(raw);
      if (!ms) { errors.push(`${a} needs a duration like 90s, 30m or 2h`); continue; }
      flags[key] = ms;
    } else {
      flags[key] = String(raw);
    }
  }
  return { flags, words, errors };
}

const pct = (x) => (x === null ? "—" : `${Math.round(x * 100)}%`);

function renderStatus(s) {
  const c = s.counts;
  const lines = [
    `${bone(s.queue)}  ${ash(s.dir)}`,
    `  ${amber(`${c.pending} pending`)} · ${acid(`${c.claimed} working`)} · ${acid(`${c.done} done`)} · ${c.inbox ? amber(`${c.inbox} inbox`) : ash("0 inbox")}  ${ash(`(${s.total} tasks)`)}`,
    `  ${ash(`${s.attempts} engine attempts · pass rate ${pct(s.passRate)}`
      + `${s.attemptsPerPass === null ? "" : ` · ${s.attemptsPerPass.toFixed(1)} attempts per pass`}`
      + `${s.alreadyPassing ? ` · ${s.alreadyPassing} already passed` : ""}`
      + `${s.perHour === null ? "" : ` · ${s.perHour.toFixed(1)} done/h`}`)}`,
  ];
  if (s.patches) lines.push(`  ${ash(`${s.applied} of ${s.patches} patches applied`)}${s.applied < s.patches ? ash(`  moshcode work apply ${s.queue}`) : ""}`);
  if (c.inbox) lines.push(`  ${warn(`${c.inbox} need${c.inbox === 1 ? "s" : ""} you: moshcode work inbox ${s.queue}`)}`);
  return lines.join("\n");
}

function readTasksFile(file) {
  const text = file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8");
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export async function workCommand(argv = [], { write = console.log, env = process.env, deps, engineOf, now } = {}) {
  const [verb, ...rest] = argv;
  const opts = { env, ...(now ? { now: now() } : {}) };
  const needQueue = (q) => {
    if (!q) { write(err(`which queue?\n${WORK_USAGE}`)); return false; }
    if (!work.validQueueName(q)) { write(err(`not a queue name: ${JSON.stringify(q)} (letters, digits, . _ -)`)); return false; }
    return true;
  };
  const mustExist = (q) => {
    if (!needQueue(q)) return false;
    if (!work.queueExists(q, env)) { write(err(`no queue named ${q}: moshcode work ls`)); return false; }
    return true;
  };

  if (!verb || verb === "help" || verb === "--help" || verb === "-h") { write(WORK_USAGE); return verb ? EXIT.ok : EXIT.usage; }

  if (verb === "ls") {
    const { flags } = parseWorkArgs(rest, { json: "bool" });
    const rows = work.listQueues(env).map((q) => work.queueStatus(q, { env }));
    if (flags.json) { write(JSON.stringify(rows, null, 2)); return EXIT.ok; }
    if (!rows.length) { write(info(`no queues yet under ${work.workHome(env)}: moshcode work add <queue> "<prompt>" --verify "<cmd>"`)); return EXIT.ok; }
    for (const s of rows) {
      const c = s.counts;
      write(`${bone(s.queue.padEnd(24))} ${ash(`${c.pending} pending · ${c.claimed} working · ${c.done} done ·`)} ${c.inbox ? amber(`${c.inbox} inbox`) : ash("0 inbox")}`);
    }
    return EXIT.ok;
  }

  if (verb === "add") {
    const { flags, words, errors } = parseWorkArgs(rest, { verify: "string", cwd: "string", title: "string", "max-attempts": "number", file: "string", json: "bool" });
    if (errors.length) { for (const e of errors) write(err(e)); return EXIT.usage; }
    const [queue, ...prompt] = words;
    if (!needQueue(queue)) return EXIT.usage;
    let specs;
    if (flags.file) {
      try { specs = readTasksFile(flags.file); } catch (e) { write(err(`could not read ${flags.file}: ${e.message}`)); return EXIT.usage; }
      specs = specs.map((s) => ({ ...s, verify: s.verify || flags.verify, cwd: s.cwd || flags.cwd, maxAttempts: s.maxAttempts || flags["max-attempts"] }));
    } else {
      specs = [{ prompt: prompt.join(" "), verify: flags.verify, cwd: flags.cwd, title: flags.title, maxAttempts: flags["max-attempts"] }];
    }
    const results = specs.map((s) => ({ ...work.addTask(queue, s, opts), title: s.title || String(s.prompt || "").split("\n")[0] }));
    if (flags.json) { write(JSON.stringify(results, null, 2)); return results.every((r) => r.ok) ? EXIT.ok : EXIT.fail; }
    for (const r of results) {
      if (!r.ok) write(err(r.error));
      else write(r.added ? ok(`${r.id} queued in ${queue}`) : info(`${r.id} is already in ${queue} (${r.state})`));
    }
    return results.every((r) => r.ok) ? EXIT.ok : EXIT.fail;
  }

  if (verb === "from-tests") {
    const { flags, words, errors } = parseWorkArgs(rest, { cwd: "string", runner: "string", jobs: "number", timeout: "duration", "max-attempts": "number", json: "bool" });
    if (errors.length) { for (const e of errors) write(err(e)); return EXIT.usage; }
    const [queue, ...files] = words;
    if (!needQueue(queue)) return EXIT.usage;
    if (!flags.json) write(info(`running each test file on its own (${flags.runner || "node --test"}, ${flags.jobs || 8} at a time)`));
    const r = await work.queueFailingTests(queue, {
      cwd: flags.cwd, runner: flags.runner, files, jobs: flags.jobs, timeoutMs: flags.timeout, maxAttempts: flags["max-attempts"],
      env, ...(deps ? { deps } : {}), write: flags.json ? () => {} : write,
    });
    if (flags.json) { write(JSON.stringify(r, null, 2)); return EXIT.ok; }
    write(ok(`${r.scanned} file${r.scanned === 1 ? "" : "s"} run, ${r.failing} failing, ${r.added.length} new task${r.added.length === 1 ? "" : "s"} in ${queue}`));
    if (r.added.length) write(ash(`  next: moshcode work run ${queue} -n 4`));
    return EXIT.ok;
  }

  if (verb === "run") {
    const { flags, words, errors } = parseWorkArgs(rest, {
      workers: "number", engine: "string", timeout: "duration", "verify-timeout": "duration", limit: "number",
      setup: "string", "no-isolate": "bool", "no-precheck": "bool", json: "bool",
    }, { "-n": "--workers" });
    if (errors.length) { for (const e of errors) write(err(e)); return EXIT.usage; }
    const [queue] = words;
    if (!mustExist(queue)) return EXIT.usage;
    if (flags.engine && !resolveEngine(flags.engine)) { write(err(`no engine named ${JSON.stringify(flags.engine)}: one of ${Object.keys(ENGINES).join(", ")}`)); return EXIT.usage; }
    const result = await work.runWork({
      queue, workers: flags.workers || work.DEFAULT_WORKERS, engine: flags.engine || null,
      timeoutMs: flags.timeout || work.DEFAULT_TIMEOUT_MS, verifyTimeoutMs: flags["verify-timeout"] || work.DEFAULT_VERIFY_TIMEOUT_MS,
      limit: flags.limit || 0, setup: flags.setup || null, isolate: !flags["no-isolate"], precheck: !flags["no-precheck"],
    }, { write: flags.json ? () => {} : write, env, ...(deps ? { deps } : {}), ...(engineOf ? { engineOf } : {}), ...(now ? { now } : {}) });
    if (flags.json) { write(JSON.stringify(result, null, 2)); return result.ok ? EXIT.ok : EXIT.fail; }
    if (!result.status) { write(err(result.error)); return EXIT.fail; }
    write("");
    write(renderStatus(result.status));
    write(ash(`  fleet: moshcode fleet log --swarm ${result.swarm}`));
    return result.ok ? EXIT.ok : EXIT.fail;
  }

  if (verb === "status") {
    const { flags, words } = parseWorkArgs(rest, { json: "bool" });
    if (!mustExist(words[0])) return EXIT.usage;
    const s = work.queueStatus(words[0], { env });
    write(flags.json ? JSON.stringify(s, null, 2) : renderStatus(s));
    return EXIT.ok;
  }

  if (verb === "inbox") {
    const { flags, words } = parseWorkArgs(rest, { json: "bool" });
    if (!mustExist(words[0])) return EXIT.usage;
    const items = work.listTasks(words[0], "inbox", env);
    if (flags.json) { write(JSON.stringify(items, null, 2)); return EXIT.ok; }
    if (!items.length) { write(ok(`the inbox of ${words[0]} is empty`)); return EXIT.ok; }
    for (const t of items) {
      const last = t.attempts[t.attempts.length - 1];
      write(`${amber(t.id)} ${bone(t.title)}`);
      write(`  ${ash(t.inbox?.reason || "")}${t.inbox?.tree ? ash(`  tree ${t.inbox.tree}`) : ""}`);
      if (last?.verifyTail) for (const l of last.verifyTail.split("\n").slice(-4)) write(`  ${ash("│")} ${l}`);
    }
    write(ash(`\n  moshcode work show ${words[0]} <id> · moshcode work retry ${words[0]} <id> · moshcode work drop ${words[0]} <id>`));
    return EXIT.ok;
  }

  if (verb === "show") {
    const { flags, words } = parseWorkArgs(rest, { json: "bool" });
    if (!mustExist(words[0])) return EXIT.usage;
    const found = words[1] ? work.findTask(words[0], words[1], env) : null;
    if (!found) { write(err(`no task ${words[1] || "(none given)"} in ${words[0]}`)); return EXIT.fail; }
    if (flags.json) { write(JSON.stringify(found, null, 2)); return EXIT.ok; }
    const t = found.task;
    write(`${bone(t.id)} ${ash(found.state)}  ${t.title}`);
    write(ash(`  cwd ${t.cwd}`));
    write(ash(`  verify ${t.verify}`));
    if (t.inbox) write(warn(t.inbox.reason));
    for (const a of [...(t.history || []), ...t.attempts]) {
      write(`  ${a.verifyExit === 0 ? acid("✓") : amber("✗")} attempt ${a.n} ${ash(`${a.engine} exit ${a.engineExit} · verify exit ${a.verifyExit} · ${a.started}`)}`);
      if (a.summary) write(`    ${a.summary.split("\n").slice(0, 6).join("\n    ")}`);
    }
    if (t.result?.patch) write(ash(`  patch ${t.result.patch} (${t.result.files.length} file${t.result.files.length === 1 ? "" : "s"})${t.result.applied ? `, applied ${t.result.applied}` : ""}`));
    return EXIT.ok;
  }

  if (verb === "retry") {
    const { flags, words } = parseWorkArgs(rest, { all: "bool" });
    const [queue, ...ids] = words;
    if (!mustExist(queue)) return EXIT.usage;
    if (!ids.length && !flags.all) { write(err("which tasks? ids, or --all")); return EXIT.usage; }
    const moved = work.retryTasks(queue, ids, { ...opts, all: Boolean(flags.all) });
    write(moved.length ? ok(`${moved.length} back in ${queue}: moshcode work run ${queue}`) : info("nothing in the inbox matched"));
    return EXIT.ok;
  }

  if (verb === "drop") {
    const [queue, ...ids] = rest;
    if (!mustExist(queue)) return EXIT.usage;
    if (!ids.length) { write(err("which tasks?")); return EXIT.usage; }
    const dropped = work.dropTasks(queue, ids, { env });
    write(dropped.length ? ok(`dropped ${dropped.join(", ")}`) : info("nothing dropped (a task being worked on cannot be)"));
    return dropped.length === ids.length ? EXIT.ok : EXIT.fail;
  }

  if (verb === "apply") {
    const { flags, words } = parseWorkArgs(rest, { "dry-run": "bool", json: "bool" });
    if (!mustExist(words[0])) return EXIT.usage;
    const r = await work.applyPatches(words[0], { env, dryRun: Boolean(flags["dry-run"]), write: flags.json ? () => {} : write, ...(deps ? { deps } : {}) });
    if (flags.json) { write(JSON.stringify(r, null, 2)); return r.ok ? EXIT.ok : EXIT.fail; }
    write(r.applied.length || r.conflicted.length
      ? (r.ok ? ok(`${r.applied.length} patch${r.applied.length === 1 ? "" : "es"} ${flags["dry-run"] ? "would apply" : "applied"}`) : warn(`${r.applied.length} applied, ${r.conflicted.length} to the inbox`))
      : info("no unapplied patches"));
    return r.ok ? EXIT.ok : EXIT.fail;
  }

  if (verb === "recover") {
    const { flags, words, errors } = parseWorkArgs(rest, { stale: "duration" });
    if (errors.length) { for (const e of errors) write(err(e)); return EXIT.usage; }
    if (!mustExist(words[0])) return EXIT.usage;
    const back = work.recoverClaims(words[0], { ...opts, staleMs: flags.stale ?? null });
    write(back.length ? ok(`${back.length} claim${back.length === 1 ? "" : "s"} back in the queue`) : info("every claim has a live worker"));
    return EXIT.ok;
  }

  write(err(`no work verb "${verb}"\n${WORK_USAGE}`));
  return EXIT.usage;
}
