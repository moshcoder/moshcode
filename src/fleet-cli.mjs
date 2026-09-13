// `moshcode fleet`: the OpenFleet sysop tool for this engine (PRD 0016).
//
// Five verbs over `$OPENFLEET_HOME`, the same five `logicsrc fleet` offers over
// the same files: `open` and `cap` are the sysop's alone, `tree`, `stop` and
// `log` are anyone's within reach. The test is the environment: a process that
// carries OPENFLEET_MEMBER is an agent, and an agent never opens a fleet, never
// sets a ceiling, and stops only what it spawned.
//
// Same shape as herd-cli: one verb table, `--json` on every verb, and no
// second API. What this tool can end is what this engine runs: a moshcode pane
// goes through herdKill; a Claude Code job through `claude stop`; a `claude -p`
// through its pid. Anything else is reported, never faked.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { EXIT, herdKill, roster as herdRoster } from "./herd-cli.mjs";
import { herdDir, slugifyName } from "./herd.mjs";
import * as fleet from "./openfleet.mjs";
import { acid, amber, ash, bone, dim, err, info, ok, warn } from "./ui.mjs";

/** The exit a refused open, cap or stop returns. logicsrc fleet uses the same number. */
export const REFUSED = 4;

const USAGE = {
  open: 'usage: moshcode fleet open [name] [--approvals native|bypass] [--budget "20 USD"] [--depth 2] [--fan-out 4] [--hosts a,b] [--until 2h] [--sysop <url>] [--json]',
  cap: "usage: moshcode fleet cap <fleet|swarm> [--approvals native|bypass] [--budget <amt>] [--depth <n>] [--fan-out <n>] [--hosts a,b] [--until <dur>] [--json]",
  tree: "usage: moshcode fleet tree [fleet] [--json]",
  stop: "usage: moshcode fleet stop <member|swarm> | --fleet <fleet> [--json]",
  log: "usage: moshcode fleet log [fleet] [--since 1h] [--member <id>] [--swarm <id>] [--json]",
};

/* ----------------------------------------------------------------- parsing */

/** `--key value`, `--key=value`, bare `--flag`, and the positionals. */
function parseArgs(argv, { valued = [], flags: known = [] } = {}) {
  const flags = {};
  const positional = [];
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith("--") || a === "--") { positional.push(a); continue; }
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (valued.includes(key)) {
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined) errors.push(`--${key} needs a value`);
      else flags[key] = String(value);
    } else if (known.includes(key) && eq < 0) {
      flags[key] = true;
    } else {
      errors.push(`unknown flag ${a}`);
    }
  }
  return { flags, positional, errors };
}

function parseDurationMs(raw) {
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(String(raw || "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return { ms: n, s: n * 1000, m: n * 60000, h: n * 3600000, d: n * 86400000 }[m[2] || "s"];
}

/** `2h` from now, or an ISO 8601 time as given. Null when it is neither. */
function untilFrom(raw, now) {
  const ms = parseDurationMs(raw);
  if (ms !== null) return fleet.iso(now + ms);
  const t = Date.parse(String(raw || ""));
  return Number.isFinite(t) ? fleet.iso(t) : null;
}

/** The ceiling keys the flags name, validated. Only the keys given. */
function ceilingFromFlags(flags, { now }) {
  const ceiling = {};
  const errors = [];
  if (flags.approvals !== undefined) {
    if (!["native", "bypass"].includes(flags.approvals)) errors.push("--approvals is native or bypass");
    else ceiling.approvals = flags.approvals;
  }
  if (flags.budget !== undefined) {
    if (!fleet.parseBudget(flags.budget)) errors.push('--budget is "<amount> <unit>", like "20 USD" or "5000 tokens"');
    else ceiling.budget = flags.budget.trim();
  }
  for (const [flag, key] of [["depth", "depth"], ["fan-out", "fan_out"]]) {
    if (flags[flag] === undefined) continue;
    const n = Number(flags[flag]);
    if (!Number.isInteger(n) || n < 0) errors.push(`--${flag} is a whole number`);
    else ceiling[key] = n;
  }
  if (flags.hosts !== undefined) {
    const hosts = flags.hosts.split(",").map((h) => h.trim()).filter(Boolean);
    if (!hosts.length) errors.push("--hosts names at least one host");
    else ceiling.hosts = hosts;
  }
  if (flags.until !== undefined) {
    const until = untilFrom(flags.until, now);
    if (!until) errors.push("--until is a duration like 2h, or an ISO 8601 time");
    else ceiling.until = until;
  }
  return { ceiling, errors };
}

function describeCeiling(c = {}) {
  const parts = [];
  for (const key of fleet.CEILING_KEYS) {
    if (c[key] === undefined) continue;
    parts.push(`${key} ${Array.isArray(c[key]) ? c[key].join(",") : c[key]}`);
  }
  return parts.join(", ") || "inherited";
}

const clip = (s, n) => (String(s ?? "").length > n ? `${String(s).slice(0, n - 3)}...` : String(s ?? ""));

/** The sentence a human-only verb answers an agent with, or null for a human. */
function agentRefusal(env, verb) {
  if (!env.OPENFLEET_MEMBER) return null;
  return `${verb} is the sysop's verb: this process is member ${env.OPENFLEET_MEMBER}${env.OPENFLEET_FLEET ? ` of fleet ${env.OPENFLEET_FLEET}` : ""}, and an agent never ${verb === "open" ? "opens a fleet" : "sets a ceiling"}.`;
}

/* --------------------------------------------------------------- the world */

/**
 * The herd's roster, or null when its manifest cannot be read. Null matters:
 * a member is marked lost only by a roster that could hold it and does not,
 * and a manifest that is missing or torn says nothing about any pane.
 */
function liveRoster() {
  try { JSON.parse(fs.readFileSync(path.join(herdDir(), "sessions.json"), "utf8")); }
  catch { return null; }
  return herdRoster().map((s) => ({
    name: s.name, engine: `moshcode/${s.engine}`, state: s.state, alive: s.alive, approvals: s.approvals || "native",
    cwd: s.cwd, fleet: s.fleet || null, swarm: s.swarm || null, member: s.member || null,
  }));
}

async function liveKill(name) {
  const code = await herdKill([name], { write: () => {} });
  return code === EXIT.matched ? { ok: true } : { ok: false, error: "no such session" };
}

function liveExec(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.error) return { ok: false, error: r.error.message };
  return r.status === 0 ? { ok: true } : { ok: false, error: String(r.stderr || r.stdout || `exit ${r.status}`).trim() };
}

function liveSignal(pid) {
  try { process.kill(pid, "SIGTERM"); return { ok: true }; }
  catch (error) { return { ok: false, error: error.message }; }
}

/** Every fleet on disk, read once, as fold() wants it. */
function loadFleets(env, only = null) {
  const names = only ? [only] : fleet.listFleets(env);
  return names.map((f) => ({ fleet: f, lines: fleet.readLedger(f, env), records: fleet.listRecords(f, env) }));
}

function* walkMembers(nodes) {
  for (const n of nodes || []) {
    if (n.kind === "member") { yield n; yield* walkMembers(n.swarms); }
    else yield* walkMembers(n.members);
  }
}

function* walkSwarms(nodes) {
  for (const n of nodes || []) {
    if (n.kind === "swarm") { yield n; yield* walkSwarms(n.members); }
    else yield* walkSwarms(n.swarms);
  }
}

/** Where an id lives: `{ kind: "fleet"|"swarm"|"member", fleet, node }`, or null. */
function locate(id, model, env) {
  if (fleet.listFleets(env).includes(id)) return { kind: "fleet", fleet: id, node: model.fleets.find((f) => f.fleet === id) || null };
  for (const f of model.fleets) {
    for (const s of walkSwarms(f.nodes)) if (s.swarm === id) return { kind: "swarm", fleet: f.fleet, node: s };
  }
  for (const f of model.fleets) {
    for (const m of walkMembers(f.nodes)) if (m.member === id || m.session === id) return { kind: "member", fleet: f.fleet, node: m };
  }
  return null;
}

/* ---------------------------------------------------------------- stopping */

const HEX8 = /^[0-9a-f]{8}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The job id `claude stop` takes for a claude-code member: the member id when
 * it is a background job's 8-hex id, else the first eight characters of the
 * record's session when that is a session UUID (a job's id is its session
 * id's first eight). An interactive session is its own UUID with no job id,
 * and nothing this tool runs can end it.
 */
export function claudeJobId(m) {
  if (HEX8.test(String(m.member || ""))) return m.member;
  const session = String(m.session || "");
  if (HEX8.test(session)) return session;
  if (UUID.test(session) && session !== m.member) return session.slice(0, 8);
  return null;
}

/**
 * End one member through its own engine, and write its end line under its
 * once-marker. Returns what happened; never throws. A member that never
 * started gets nothing. A member its engine's roster could hold and no
 * longer lists, with no end line from anyone, is `lost`, so the ledger closes
 * rather than hangs; one the engine still has but could not end is reported
 * and left open, because an end line the engine did not honour is a lie.
 */
async function stopMember(m, fleetId, state, o) {
  const { env, now, host } = o;
  const by = env.OPENFLEET_MEMBER || "sysop";
  if (m.end && m.end.state !== "lost") return { member: m.member, outcome: "already-ended", state: m.end.state };
  if (!m.claimed && !m.rosterOnly) return { member: m.member, outcome: "never-started" };
  const session = m.session || m.member;
  let ended;
  if (m.rosterOnly || fleet.herdHolds(m.engine)) ended = await o.kill(session);
  else if (m.engine === "claude-code") {
    const job = claudeJobId(m);
    ended = job ? o.exec("claude", ["stop", job]) : { ok: false, error: "an interactive claude-code session has no job id: end it from its own terminal" };
  } else if (m.engine === "claude-p") ended = Number.isInteger(Number(session)) ? o.signal(Number(session)) : { ok: false, error: "no pid in the record" };
  else ended = { ok: false, error: `no engine to stop it through (${m.engine || "unknown"})` };
  if (m.rosterOnly) return { member: m.member, outcome: ended.ok ? "stopped" : "failed", error: ended.error || null };
  if (ended.ok) {
    const { already } = fleet.appendOnce(fleetId, { event: "member.end", by, member: m.member, state }, { env, now: now(), host });
    if (already) return { member: m.member, outcome: "already-ended", state: fleet.endOf(fleet.readLedger(fleetId, env), m.member)?.state || state };
    return { member: m.member, outcome: "stopped", state };
  }
  if (m.end) return { member: m.member, outcome: "already-ended", state: m.end.state };
  const roster = fleet.herdHolds(m.engine) && m.host === host ? o.roster() : null;
  if (roster && !roster.some((r) => r.name === session)) {
    fleet.appendOnce(fleetId, { event: "member.end", by, member: m.member, state: "lost" }, { env, now: now(), host });
    return { member: m.member, outcome: "lost", state: "lost" };
  }
  return { member: m.member, outcome: "failed", error: ended.error || "could not stop it" };
}

/**
 * Write a swarm's end line, once, and only when every member that started
 * has an end line that counts and every nested swarm has ended: a swarm.end
 * says the whole unit is over, so a member whose engine would not let go
 * leaves the swarm open and reported rather than closed over a running
 * session. `state` is the end the caller is writing, used when no member
 * ever started; otherwise the members' end lines decide.
 */
function closeSwarm(s, fleetId, state, o, out) {
  const { env, now, host } = o;
  const by = env.OPENFLEET_MEMBER || "sysop";
  const lines = fleet.readLedger(fleetId, env);
  if (fleet.findEvents(lines, "swarm.end", { swarm: s.swarm }).length) { out.swarms.push({ swarm: s.swarm, state: "already-ended" }); return; }
  const started = s.members.filter((m) => m.claimed && !m.rosterOnly);
  const missing = started.filter((m) => !fleet.endOf(lines, m.member)).map((m) => m.member);
  const open = s.members.flatMap((m) => m.swarms).filter((n) => !fleet.findEvents(lines, "swarm.end", { swarm: n.swarm }).length).map((n) => n.swarm);
  if (missing.length || open.length) { out.swarms.push({ swarm: s.swarm, state: "open", missing, nested: open }); return; }
  const ends = started.map((m) => fleet.endOf(lines, m.member));
  const { line, already } = fleet.appendOnce(fleetId, { event: "swarm.end", by, swarm: s.swarm, state: started.length ? fleet.swarmEndState(ends) : state }, { env, now: now(), host });
  out.swarms.push({ swarm: s.swarm, state: already ? "already-ended" : line?.state || null });
}

/**
 * End a swarm as one unit (rule 11): nested swarms first, each with its own
 * swarm.end, then the members through their engines, then this swarm's end
 * line, written only when none exists and every member has ended.
 */
async function stopSwarm(s, fleetId, state, o, out) {
  for (const m of s.members) for (const nested of m.swarms) await stopSwarm(nested, fleetId, state, o, out);
  for (const m of s.members) out.members.push(await stopMember(m, fleetId, state, o));
  closeSwarm(s, fleetId, state, o, out);
}

/**
 * Rule 6, run by `tree` since the sysop runs it: a working member whose
 * effective ceiling's `until` has passed is stopped through its engine with
 * `member.end` timeout, and every working member under a swarm or fleet whose
 * summed `member.spend`, in the budget's unit, has reached the budget is
 * stopped with `member.end` budget. A swarm a stop touched gets its swarm.end
 * once it is complete, deepest first. Returns what happened.
 */
async function enforceCeilings(model, o) {
  const { env, now, host } = o;
  const out = { members: [], swarms: [] };
  const working = (m) => m.claimed && !m.end && !m.rosterOnly && !m.lost;
  const overBudget = (budget, members) => {
    const cap = fleet.parseBudget(budget);
    if (!cap) return false;
    const spent = members.map((m) => fleet.parseBudget(m.spend)).filter((b) => b && b.unit === cap.unit).reduce((sum, b) => sum + b.amount, 0);
    return spent >= cap.amount;
  };
  for (const f of model.fleets) {
    const lines = fleet.readLedger(f.fleet, env);
    const touched = new Set();
    const stop = async (m, state, over) => {
      const result = await stopMember(m, f.fleet, state, o);
      if (result.outcome === "stopped" || result.outcome === "lost") m.end = { state: result.state };
      out.members.push({ ...result, over });
      for (const s of walkSwarms(f.nodes)) if (s.members.includes(m)) touched.add(s);
    };
    // Deepest members first, as a stop on a swarm ends nested swarms first.
    for (const m of [...walkMembers(f.nodes)].reverse()) {
      if (!working(m)) continue;
      const effective = fleet.ceilingOf(f.fleet, fleet.readMember(f.fleet, m.member, env), { env, lines, swarm: m.swarm, host });
      const deadline = Date.parse(effective.until || "");
      if (Number.isFinite(deadline) && now() >= deadline) await stop(m, "timeout", "until");
    }
    for (const s of walkSwarms(f.nodes)) {
      const members = [...walkMembers(s.members)].reverse();
      if (!overBudget(fleet.effectiveCeiling(lines, f.fleet, { swarm: s.swarm, host }).budget, members)) continue;
      for (const m of members) if (working(m)) await stop(m, "budget", "budget");
    }
    const everyone = [...walkMembers(f.nodes)].reverse();
    if (overBudget(f.ceiling?.budget, everyone)) for (const m of everyone) if (working(m)) await stop(m, "budget", "budget");
    // Deepest first, so a parent sees its nested swarm's end line.
    for (const s of [...walkSwarms(f.nodes)].reverse()) if (touched.has(s)) closeSwarm(s, f.fleet, "stopped", o, out);
  }
  return out;
}

/** May an agent stop this target? Only a swarm it spawned, or anything under one. */
function withinReach(caller, target, model) {
  const swarms = new Map();
  const members = new Map();
  for (const f of model.fleets) {
    for (const s of walkSwarms(f.nodes)) swarms.set(s.swarm, s);
    for (const m of walkMembers(f.nodes)) members.set(m.member, m);
  }
  let swarm = target.kind === "swarm" ? target.node.swarm : target.node.swarm || null;
  const seen = new Set();
  while (swarm && !seen.has(swarm)) {
    seen.add(swarm);
    const s = swarms.get(swarm);
    if (!s) return false;
    if (s.by === caller) return true;
    swarm = members.get(s.by)?.swarm || null;
  }
  return false;
}

function reportStops(out, { write, json }) {
  if (json) { write(JSON.stringify(out, null, 2)); return; }
  const why = (m) => (m.over === "until" ? " (past its until)" : m.over === "budget" ? " (over budget)" : m.over ? ` (above the ceiling on ${m.over})` : "");
  for (const m of out.members) {
    if (m.outcome === "stopped") write(ok(`${bone(m.member)} stopped${m.state && m.state !== "stopped" ? ` as ${m.state}` : ""}${why(m)}`));
    else if (m.outcome === "lost") write(warn(`${m.member} was already gone: marked lost`));
    else if (m.outcome === "already-ended") write(dim(`${m.member} had already ended (${m.state})`));
    else if (m.outcome === "never-started") write(dim(`${m.member} never started: nothing to end`));
    else write(err(`${m.member}: ${m.error}`));
  }
  for (const s of out.swarms) {
    if (s.state === "already-ended") write(dim(`swarm ${s.swarm} had already ended`));
    else if (s.state === "open") write(warn(`swarm ${s.swarm} left open: no end line yet for ${[...(s.missing || []), ...(s.nested || []).map((n) => `swarm ${n}`)].join(", ")}`));
    else write(ok(`swarm ${bone(s.swarm)} ended ${s.state}`));
  }
}

/* ------------------------------------------------------------------ verbs */

async function fleetOpen(argv, o) {
  const { write, env, now, host } = o;
  const refusal = agentRefusal(env, "open");
  if (refusal) { write(err(refusal)); return REFUSED; }
  const { flags, positional, errors } = parseArgs(argv, { valued: ["approvals", "budget", "depth", "fan-out", "hosts", "until", "sysop", "name"], flags: ["json"] });
  const { ceiling, errors: bad } = ceilingFromFlags(flags, { now: now() });
  for (const e of [...errors, ...bad]) write(err(e));
  if (errors.length || bad.length) { write(err(USAGE.open)); return EXIT.usage; }

  // `<name>-<yyyymmdd>`, the form the spec recommends, and never a name an
  // existing fleet already has on this box.
  const stamp = fleet.iso(now()).slice(0, 10).replace(/-/g, "");
  const name = slugifyName(flags.name || positional[0] || "fleet");
  let id = `${name}-${stamp}`;
  for (let n = 2; fleet.listFleets(env).includes(id); n++) id = `${name}-${stamp}-${n}`;
  const sysop = flags.sysop || o.implicit;
  const line = fleet.append(id, { event: "fleet.open", by: "sysop", sysop, ceiling }, { env, now: now(), host });
  if (!line) { write(err(`could not write ${fleet.ledgerPath(id, env)}`)); return EXIT.infra; }
  fleet.writeCurrent(id, env);
  if (flags.json) { write(JSON.stringify({ fleet: id, sysop, ceiling, current: true, ledger: fleet.ledgerPath(id, env) }, null, 2)); return EXIT.matched; }
  write(id);
  write(info(`sysop ${sysop} · ceiling ${describeCeiling(ceiling)} · new root members join it: ${acid("moshcode fleet tree")}`));
  return EXIT.matched;
}

async function fleetCap(argv, o) {
  const { write, env, now, host } = o;
  const refusal = agentRefusal(env, "cap");
  if (refusal) { write(err(refusal)); return REFUSED; }
  const { flags, positional, errors } = parseArgs(argv, { valued: ["approvals", "budget", "depth", "fan-out", "hosts", "until", "fleet"], flags: ["json"] });
  const { ceiling, errors: bad } = ceilingFromFlags(flags, { now: now() });
  for (const e of [...errors, ...bad]) write(err(e));
  const target = positional[0];
  if (errors.length || bad.length || !target) { write(err(USAGE.cap)); return EXIT.usage; }

  const model = fleet.fold({ fleets: loadFleets(env, flags.fleet || null), roster: o.roster(), host, implicit: o.implicit, now: now() });
  const found = locate(target, model, env);
  if (!found || found.kind === "member") { write(err(`no fleet or swarm named ${JSON.stringify(target)}: ${acid("moshcode fleet tree")}`)); return EXIT.gone; }
  const fleetId = found.fleet;
  if (found.kind === "swarm") {
    if (!Object.keys(ceiling).length) { write(err("cap on a swarm narrows at least one key")); write(err(USAGE.cap)); return EXIT.usage; }
    const current = fleet.effectiveCeiling(fleet.readLedger(fleetId, env), fleetId, { swarm: target, host });
    if (!fleet.isNarrower(ceiling, current)) {
      write(err(`cap narrows a running swarm and never widens it: ${describeCeiling(ceiling)} is not within ${describeCeiling(current)}`));
      return EXIT.usage;
    }
  }
  fleet.append(fleetId, { event: "fleet.cap", by: "sysop", target, ceiling }, { env, now: now(), host });

  // Members already above the new ceiling are stopped, each with its end line:
  // a bypass member under a now-native ceiling, a member on a now-forbidden
  // host, one deeper than the tree now allows.
  const lines = fleet.readLedger(fleetId, env);
  const fresh = fleet.fold({ fleets: [{ fleet: fleetId, lines, records: fleet.listRecords(fleetId, env) }], roster: o.roster(), host, implicit: o.implicit, now: now() });
  const scope = found.kind === "fleet" ? fresh.fleets[0]?.nodes || [] : [[...walkSwarms(fresh.fleets[0]?.nodes || [])].find((s) => s.swarm === target)].filter(Boolean);
  const out = { target, kind: found.kind, fleet: fleetId, ceiling, members: [], swarms: [] };
  for (const m of walkMembers(scope)) {
    if (!m.claimed || m.end || m.rosterOnly) continue;
    const effective = fleet.ceilingOf(fleetId, fleet.readMember(fleetId, m.member, env), { env, lines, swarm: m.swarm, host });
    const over = fleet.checkCeiling({ approvals: m.approvals, depth: m.depth, hosts: [m.host] }, effective, { now: now() });
    if (!over) continue;
    const stopped = await stopMember(m, fleetId, "stopped", o);
    out.members.push({ ...stopped, over: over.key });
  }
  if (flags.json) { write(JSON.stringify(out, null, 2)); return EXIT.matched; }
  write(ok(`${found.kind} ${bone(target)} capped: ${describeCeiling(ceiling)}`));
  reportStops(out, { write, json: false });
  return EXIT.matched;
}

async function fleetTree(argv, o) {
  const { write, env, now, host } = o;
  const { flags, positional, errors } = parseArgs(argv, { valued: ["fleet"], flags: ["json"] });
  for (const e of errors) write(err(e));
  if (errors.length) { write(err(USAGE.tree)); return EXIT.usage; }
  const only = flags.fleet || positional[0] || null;
  const implicit = o.implicit;
  if (only && only !== implicit && !fleet.listFleets(env).includes(only)) { write(err(`no fleet named ${JSON.stringify(only)} under ${fleet.home(env)}`)); return EXIT.gone; }
  const model = fleet.fold({ fleets: loadFleets(env, only), roster: o.roster(), host, implicit, now: now() });
  if (only) model.fleets = model.fleets.filter((f) => f.fleet === only);
  // A recorded moshcode member the roster no longer lists, with no end line
  // from anyone, is lost: the tool writes that line, under the lost marker a
  // real end may still supersede, so the tree stops saying "working" about a
  // pane that is not there (spec, `tree`).
  const by = env.OPENFLEET_MEMBER || "sysop";
  for (const f of model.fleets) {
    for (const m of walkMembers(f.nodes)) {
      if (!m.lost) continue;
      const { line } = fleet.appendOnce(f.fleet, { event: "member.end", by, member: m.member, state: "lost" }, { env, now: now(), host });
      if (line) m.end = line;
    }
  }
  // Rule 6: the sysop runs tree, so tree is where the clock and the budget
  // are enforced. What it stopped is reported after the tree.
  const enforced = await enforceCeilings(model, o);
  for (const f of model.fleets) {
    for (const m of walkMembers(f.nodes)) {
      const hit = enforced.members.find((r) => r.member === m.member && (r.outcome === "stopped" || r.outcome === "lost"));
      if (hit) { m.state = hit.state; m.lost = hit.state === "lost"; }
    }
    for (const s of walkSwarms(f.nodes)) {
      const hit = enforced.swarms.find((r) => r.swarm === s.swarm && r.state && r.state !== "open" && r.state !== "already-ended");
      if (hit) s.state = hit.state;
    }
  }
  if (enforced.members.length) model.enforced = enforced;
  if (flags.json) { write(JSON.stringify(model, null, 2)); return EXIT.matched; }
  if (!model.fleets.length) {
    write(info(`no fleet yet under ${fleet.home(env)}: ${acid("moshcode fleet open")} opens one, ${acid("moshcode swarm")} records its members in the implicit fleet ${bone(implicit)}.`));
    return EXIT.matched;
  }
  for (const line of fleet.renderTree(model, { host }).split("\n")) write(line);
  if (enforced.members.length) reportStops(enforced, { write, json: false });
  return EXIT.matched;
}

async function fleetStop(argv, o) {
  const { write, env } = o;
  const { flags, positional, errors } = parseArgs(argv, { valued: ["fleet"], flags: ["json"] });
  for (const e of errors) write(err(e));
  const target = positional[0] || null;
  if (errors.length || (!target && !flags.fleet)) { write(err(USAGE.stop)); return EXIT.usage; }
  const caller = env.OPENFLEET_MEMBER || null;
  const model = fleet.fold({ fleets: loadFleets(env), roster: o.roster(), host: o.host, implicit: o.implicit, now: o.now() });
  const out = { target: target || flags.fleet, members: [], swarms: [] };

  if (flags.fleet && !target) {
    if (caller) { write(err(`stop --fleet is the sysop's: this process is member ${caller}, and an agent stops only the swarms it spawned.`)); return REFUSED; }
    const f = model.fleets.find((x) => x.fleet === flags.fleet);
    if (!f) { write(err(`no fleet named ${JSON.stringify(flags.fleet)}`)); return EXIT.gone; }
    for (const n of f.nodes) {
      if (n.kind === "swarm") await stopSwarm(n, f.fleet, "stopped", o, out);
      else {
        for (const s of n.swarms) await stopSwarm(s, f.fleet, "stopped", o, out);
        out.members.push(await stopMember(n, f.fleet, "stopped", o));
      }
    }
    reportStops(out, { write, json: Boolean(flags.json) });
    return out.members.some((m) => m.outcome === "failed") ? EXIT.gone : EXIT.matched;
  }

  const found = locate(target, model, env);
  if (!found || found.kind === "fleet") { write(err(`no member or swarm named ${JSON.stringify(target)}: ${acid("moshcode fleet tree")}`)); return EXIT.gone; }
  if (caller && !withinReach(caller, found, model)) {
    write(err(`${target} is outside what member ${caller} spawned: an agent stops only a swarm it started, or a member under one.`));
    return REFUSED;
  }
  if (found.kind === "swarm") await stopSwarm(found.node, found.fleet, "stopped", o, out);
  else {
    for (const s of found.node.swarms) await stopSwarm(s, found.fleet, "stopped", o, out);
    out.members.push(await stopMember(found.node, found.fleet, "stopped", o));
  }
  reportStops(out, { write, json: Boolean(flags.json) });
  // The one member asked for was never there to stop: not found, as logicsrc says.
  const nothing = found.kind === "member" && out.members.at(-1)?.outcome === "never-started";
  return out.members.some((m) => m.outcome === "failed") || nothing ? EXIT.gone : EXIT.matched;
}

function describeLine(l) {
  const c = (x) => describeCeiling(x || {});
  switch (l.event) {
    case "fleet.open": return `${l.fleet} sysop ${l.sysop} · ${c(l.ceiling)}`;
    case "fleet.cap": return `${l.target} · ${c(l.ceiling)}`;
    case "swarm.spawn": return `${l.swarm} "${clip(l.task, 50)}" · ${(l.pieces || []).length} piece${(l.pieces || []).length === 1 ? "" : "s"}${Object.keys(l.ceiling || {}).length ? ` · ${c(l.ceiling)}` : ""}${l.parent_swarm ? ` · under ${l.parent_swarm}` : ""}`;
    case "member.start": return `${l.member}${l.session && l.session !== l.member ? ` (${l.session})` : ""} · ${l.engine || "?"}${l.approvals === "bypass" ? " · bypass" : ""}${l.piece?.title ? ` · ${l.piece.title}` : ""}${l.piece?.owns?.length ? ` · owns ${l.piece.owns.join(",")}` : ""}`;
    case "member.spend": return `${l.member} · ${l.amount}${l.total ? ` (total ${l.total})` : ""}`;
    case "member.end": return `${l.member} · ${l.state}${l.total ? ` · ${l.total}` : ""}${l.summary ? ` · ${clip(String(l.summary).replace(/\s+/g, " "), 80)}` : ""}`;
    case "swarm.end": return `${l.swarm} · ${l.state}${l.verdict ? ` · ${l.verdict.length} verdict${l.verdict.length === 1 ? "" : "s"}` : ""}${l.summary ? ` · ${clip(String(l.summary).replace(/\s+/g, " "), 80)}` : ""}`;
    case "ceiling.refuse": return `${l.member ? `${l.member} · ` : ""}${l.action} refused on ${l.key}: wanted ${JSON.stringify(l.wanted)}, allowed ${JSON.stringify(l.allowed)}`;
    default: return "";
  }
}

const paintEvent = (event) => {
  if (event === "ceiling.refuse") return amber(event);
  if (event.endsWith(".end")) return ash(event);
  if (event === "swarm.spawn" || event === "member.start") return acid(event);
  return bone(event);
};

async function fleetLog(argv, o) {
  const { write, env, now } = o;
  const { flags, positional, errors } = parseArgs(argv, { valued: ["since", "member", "swarm", "fleet"], flags: ["json"] });
  for (const e of errors) write(err(e));
  if (errors.length) { write(err(USAGE.log)); return EXIT.usage; }
  const only = flags.fleet || positional[0] || null;
  let since = null;
  if (flags.since !== undefined) {
    const ms = parseDurationMs(flags.since);
    since = ms !== null ? now() - ms : Date.parse(flags.since);
    if (!Number.isFinite(since)) { write(err("--since is a duration like 1h, or an ISO 8601 time")); return EXIT.usage; }
  }
  const fleets = loadFleets(env, only);
  // A member's end line names no swarm, so `--swarm` needs the membership
  // the records and start lines hold.
  const swarmOf = new Map();
  const lines = [];
  for (const f of fleets) {
    for (const r of f.records) if (r.member && r.swarm) swarmOf.set(r.member, r.swarm);
    for (const l of f.lines) {
      if (l.event === "member.start" && l.member && l.swarm) swarmOf.set(l.member, l.swarm);
      lines.push(l);
    }
  }
  lines.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  const shown = lines.filter((l) => {
    if (since !== null && (Date.parse(l.at) || 0) < since) return false;
    if (flags.member && l.member !== flags.member && l.by !== flags.member) return false;
    if (flags.swarm && l.swarm !== flags.swarm && l.target !== flags.swarm && swarmOf.get(l.member) !== flags.swarm) return false;
    return true;
  });
  if (flags.json) { for (const l of shown) write(JSON.stringify(l)); return EXIT.matched; }
  if (!shown.length) { write(info("nothing in the ledger matches.")); return EXIT.matched; }
  const manyFleets = new Set(shown.map((l) => l.fleet)).size > 1;
  for (const l of shown) {
    write(`${dim(l.at)}  ${paintEvent(l.event).padEnd(14 + (paintEvent(l.event).length - l.event.length))}  ${ash(`by ${l.by}`)}  ${describeLine(l)}${manyFleets ? dim(`  [${l.fleet}]`) : ""}`);
  }
  return EXIT.matched;
}

/* --------------------------------------------------------------- dispatch */

const VERBS = { open: fleetOpen, cap: fleetCap, tree: fleetTree, stop: fleetStop, log: fleetLog };

export async function fleetCommand(argv = [], { write = console.log, ...deps } = {}) {
  const o = {
    write, env: process.env, now: () => Date.now(), host: fleet.host(),
    roster: liveRoster, kill: liveKill, exec: liveExec, signal: liveSignal,
    ...deps,
  };
  // The implicit fleet is injectable so a test's seeded `<user>@<host>` is
  // the one the roster-only rows file under, on any box.
  o.implicit = deps.implicit || fleet.implicitFleet(o.env);
  const [verb, ...rest] = argv;
  if (!verb || verb.startsWith("--")) return fleetTree(argv, o);
  const run = VERBS[verb];
  if (!run) {
    write(err(`unknown fleet verb ${JSON.stringify(verb)}`));
    write(info(`verbs: ${Object.keys(VERBS).join(", ")}`));
    return EXIT.usage;
  }
  return run(rest, o);
}
