// OpenFleet (logicsrc.com/docs/openfleet, 0.1): the record an agent session
// carries about where it sits, and the ledger a human reads it from.
//
// This is the minimal IO moshcode needs as a member engine and a sysop tool:
// one JSON record per member under `$OPENFLEET_HOME/fleets/<fleet>/members/`,
// one append-only ledger per fleet per host beside it, the ceiling merge, and
// the fold that turns both into the tree `moshcode fleet tree` draws. Nothing
// here talks to tmux or a model; swarm.mjs and fleet-cli.mjs do that.
//
// `$OPENFLEET_HOME` is read on every call, like herdDir(), so a test isolates
// itself with a mkdtemp and one env var. Files are 0600 and directories 0700:
// a record names a working directory and a ledger names what an agent tried,
// and neither is anyone else's business on a shared box. Neither ever holds a
// credential.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { slugifyName } from "./herd.mjs";

export const OPENFLEET_VERSION = "0.1";

/** The keys a ceiling may carry, in the order the spec lists them. */
export const CEILING_KEYS = ["approvals", "budget", "depth", "fan_out", "hosts", "until"];

/** How a member may end. One end line counts, except `lost`, which a real one supersedes. */
export const END_STATES = ["done", "failed", "stopped", "budget", "timeout", "lost"];

/** The engine strings the spec names. moshcode writes the `moshcode/<engine>` ones. */
export const ENGINE_STRINGS = ["claude-code", "moshcode/claude", "moshcode/codex", "moshcode/deepseek", "moshcode/kimi", "claude-p", "tmux"];

/* ------------------------------------------------------------ where it lives */

export function home(env = process.env) {
  return env.OPENFLEET_HOME || path.join(os.homedir(), ".openfleet");
}

export function host() {
  return os.hostname();
}

function username(env = process.env) {
  try { return os.userInfo().username; }
  catch { return env.USER || env.USERNAME || "user"; }
}

/** `<user>@<host>`: the fleet a member belongs to when none was opened, and its sysop. */
export function implicitFleet(env = process.env) {
  return `${username(env)}@${host()}`;
}

/** The implicit fleet's ceiling: depth 1, this host, and no fleet-level approvals. */
export function implicitCeiling() {
  return { depth: 1, hosts: [host()] };
}

/** ISO 8601 UTC to the second, the way every example in the spec is written. */
export function iso(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function fleetsDir(env = process.env) {
  return path.join(home(env), "fleets");
}

export function fleetDir(fleet, env = process.env) {
  return path.join(fleetsDir(env), String(fleet));
}

export function recordPath(fleet, member, env = process.env) {
  return path.join(fleetDir(fleet, env), "members", `${member}.json`);
}

export function ledgerPath(fleet, env = process.env) {
  return path.join(fleetDir(fleet, env), "ledger.jsonl");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Every fleet with a directory under the home, opened or implicit. */
export function listFleets(env = process.env) {
  try {
    return fs.readdirSync(fleetsDir(env), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

/** The fleet the account's next root member joins, from `$OPENFLEET_HOME/current`. */
export function currentFleet(env = process.env) {
  try {
    const value = fs.readFileSync(path.join(home(env), "current"), "utf8").trim();
    return value || null;
  } catch { return null; }
}

export function writeCurrent(fleet, env = process.env) {
  try {
    ensureDir(home(env));
    const file = path.join(home(env), "current");
    fs.writeFileSync(file, `${fleet}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return true;
  } catch { return false; }
}

/* ---------------------------------------------------------------- the record */

/**
 * Write a member's record. Refuses to overwrite: the record is written once,
 * before the member starts, and never changes after `member.start` (rule 7).
 * `wx` makes the refusal atomic rather than a check followed by a write.
 */
export function writeRecord(record, { env = process.env } = {}) {
  const file = recordPath(record.fleet, record.member, env);
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, path: file, error };
  }
}

/** A record by path. Null when absent or unreadable; unknown keys are kept. */
export function readRecord(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

export function readMember(fleet, member, env = process.env) {
  return readRecord(recordPath(fleet, member, env));
}

/** Every record under a fleet, in file order. */
export function listRecords(fleet, env = process.env) {
  const dir = path.join(fleetDir(fleet, env), "members");
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); }
  catch { return []; }
  return names.map((n) => readRecord(path.join(dir, n))).filter(Boolean);
}

/* ---------------------------------------------------------------- the ledger */

/**
 * Every ledger under a fleet: this host's `ledger.jsonl` and any
 * `ledger.<host>.jsonl` copied in from another. Readers merge them by `at`.
 */
export function ledgerPaths(fleet, env = process.env) {
  const dir = fleetDir(fleet, env);
  try {
    return fs.readdirSync(dir)
      .filter((n) => /^ledger(\.[^/]+)?\.jsonl$/.test(n))
      .sort()
      .map((n) => path.join(dir, n));
  } catch { return []; }
}

/**
 * Append one line to this host's ledger. Adds `at`, `fleet` and `host`; the
 * caller passes `event`, `by` and the event's own keys. Never throws: a lost
 * ledger line must not fail the swarm that was writing it. Returns the line as
 * written, or null.
 */
export function append(fleet, line, { env = process.env, now = Date.now(), host: h = host() } = {}) {
  const { at, event, by, ...rest } = line || {};
  const written = { at: at || iso(now), event, fleet, host: h, by, ...rest };
  try {
    ensureDir(fleetDir(fleet, env));
    const file = ledgerPath(fleet, env);
    fs.appendFileSync(file, `${JSON.stringify(written)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return written;
  } catch { return null; }
}

const atMs = (line) => {
  const t = Date.parse(line?.at || "");
  return Number.isFinite(t) ? t : 0;
};

/** Every line of every ledger under a fleet, merged and sorted by `at` (stable). */
export function readLedger(fleet, env = process.env) {
  const lines = [];
  for (const file of ledgerPaths(fleet, env)) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); }
    catch { continue; }
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && parsed.event) lines.push(parsed);
      } catch { /* a torn line is skipped, never fatal */ }
    }
  }
  return lines
    .map((line, i) => ({ line, i }))
    .sort((a, b) => atMs(a.line) - atMs(b.line) || a.i - b.i)
    .map(({ line }) => line);
}

/** The lines of one event whose keys match `where`. */
export function findEvents(lines, event, where = {}) {
  return (lines || []).filter((l) => l.event === event && Object.entries(where).every(([k, v]) => l[k] === v));
}

/** Whether the fleet's ledger holds an event matching `where`. */
export function hasEvent(fleet, event, where = {}, env = process.env) {
  return findEvents(readLedger(fleet, env), event, where).length > 0;
}

/** The `member.start` that claimed a record, or null when it is unclaimed. */
export function claimedBy(lines, member) {
  return findEvents(lines, "member.start", { member })[0] || null;
}

/**
 * The end line that counts for a member: the first written, except `lost`,
 * which the engine's or the spawner's own end supersedes whenever it arrives.
 */
export function endOf(lines, member) {
  const ends = findEvents(lines, "member.end", { member });
  return ends.find((l) => l.state !== "lost") || ends[0] || null;
}

/**
 * A swarm's end state from its members' end lines: `done` when every member
 * ended `done`, else the first of failed, stopped, budget, timeout found among
 * them. Members that only went `lost`, or no members at all, are a failure.
 */
export function swarmEndState(ends) {
  const states = (ends || []).map((l) => (typeof l === "string" ? l : l?.state)).filter(Boolean);
  if (states.length && states.every((s) => s === "done")) return "done";
  return states.find((s) => ["failed", "stopped", "budget", "timeout"].includes(s)) || "failed";
}

/* --------------------------------------------------------------- the ceiling */

/** `"20 USD"` or `"5000 tokens"` as a number and its unit, or null. */
export function parseBudget(value) {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s+(\S+)\s*$/.exec(String(value ?? ""));
  return m ? { amount: Number(m[1]), unit: m[2] } : null;
}

/** Key by key: every key `narrowing` carries replaces the one in `base`. */
export function mergeCeiling(base = {}, narrowing = {}) {
  const out = { ...(base || {}) };
  for (const key of CEILING_KEYS) {
    if (narrowing && narrowing[key] !== undefined && narrowing[key] !== null) out[key] = narrowing[key];
  }
  return out;
}

const untilMs = (value) => {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : null;
};

/**
 * Is one key of `narrowing` narrower than, or equal to, the same key of `base`?
 * Absent in base means uncapped for budget, fan_out, hosts and until; native
 * for approvals; 1 for depth.
 */
function keyNarrower(key, wanted, base) {
  if (wanted === undefined || wanted === null) return true;
  const allowed = base?.[key];
  switch (key) {
    case "approvals":
      return wanted === "native" || allowed === "bypass";
    case "budget": {
      if (allowed === undefined) return true;
      const w = parseBudget(wanted), a = parseBudget(allowed);
      return Boolean(w && a && w.unit === a.unit && w.amount <= a.amount);
    }
    case "depth":
      return Number(wanted) <= Number(allowed ?? 1);
    case "fan_out":
      return allowed === undefined || Number(wanted) <= Number(allowed);
    case "hosts":
      return !Array.isArray(allowed) || (Array.isArray(wanted) && wanted.every((h) => allowed.includes(h)));
    case "until": {
      if (allowed === undefined) return true;
      const w = untilMs(wanted), a = untilMs(allowed);
      return w !== null && a !== null && w <= a;
    }
    default:
      return true;
  }
}

/** Every key `narrowing` carries is narrower than, or equal to, `base`'s. */
export function isNarrower(narrowing = {}, base = {}) {
  return CEILING_KEYS.every((key) => keyNarrower(key, narrowing?.[key], base));
}

/**
 * The keys of `wanted` that actually narrow `base`: what a spawner writes in
 * its `swarm.spawn`. A key that would widen, or that equals what is inherited,
 * is left out, because a spawner never widens and an inherited key is not
 * written twice.
 */
export function narrowingOf(wanted = {}, base = {}) {
  const out = {};
  for (const key of CEILING_KEYS) {
    const value = wanted?.[key];
    if (value === undefined || value === null) continue;
    if (!keyNarrower(key, value, base)) continue;
    const inherited = base?.[key];
    if (inherited !== undefined && JSON.stringify(inherited) === JSON.stringify(value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Would `wanted` exceed `allowed`? The first key that does, as
 * `{ key, wanted, allowed }` for a `ceiling.refuse` line, or null.
 *
 * `wanted` carries what a member or a swarm asks for: `approvals`, `depth`,
 * `fan_out` (how many members the swarm holds), `hosts` (where they run),
 * `until` (a deadline it would set) and `budget`. `now` is checked against an
 * `until` already in force. An `approvals` key absent from `allowed` is
 * unconstrained here; whoever built `allowed` resolves the absent-means-native
 * rule for an opened fleet (see fleetCeiling).
 */
export function checkCeiling(wanted = {}, allowed = {}, { now = Date.now() } = {}) {
  const w = wanted || {}, a = allowed || {};
  if (w.approvals === "bypass" && a.approvals !== undefined && a.approvals !== "bypass") {
    return { key: "approvals", wanted: "bypass", allowed: a.approvals };
  }
  if (w.depth !== undefined && Number(w.depth) > Number(a.depth ?? 1)) {
    return { key: "depth", wanted: Number(w.depth), allowed: Number(a.depth ?? 1) };
  }
  if (w.fan_out !== undefined && a.fan_out !== undefined && Number(w.fan_out) > Number(a.fan_out)) {
    return { key: "fan_out", wanted: Number(w.fan_out), allowed: Number(a.fan_out) };
  }
  const hosts = Array.isArray(w.hosts) ? w.hosts : w.host ? [w.host] : null;
  if (hosts && Array.isArray(a.hosts) && hosts.some((h) => !a.hosts.includes(h))) {
    return { key: "hosts", wanted: hosts, allowed: a.hosts };
  }
  if (a.until !== undefined) {
    const deadline = untilMs(a.until);
    if (deadline !== null && now >= deadline) return { key: "until", wanted: iso(now), allowed: a.until };
    const asked = untilMs(w.until);
    if (deadline !== null && asked !== null && asked > deadline) return { key: "until", wanted: w.until, allowed: a.until };
  }
  if (w.budget !== undefined && a.budget !== undefined) {
    const wb = parseBudget(w.budget), ab = parseBudget(a.budget);
    if (wb && ab && wb.unit === ab.unit && wb.amount > ab.amount) return { key: "budget", wanted: w.budget, allowed: a.budget };
  }
  return null;
}

/**
 * A fleet's whole ceiling: the latest `fleet.cap` whose target is the fleet,
 * else `fleet.open`, else the implicit fleet's. An opened fleet's absent keys
 * are resolved the way the spec reads them (approvals native, depth 1, hosts
 * the host the line was written on); the implicit fleet carries no approvals
 * key at all, because each root member supplies its own.
 */
export function fleetCeiling(lines, fleet, { host: h = host() } = {}) {
  const caps = findEvents(lines, "fleet.cap", { target: fleet });
  const open = findEvents(lines, "fleet.open");
  const line = caps.at(-1) || open.at(-1) || null;
  if (!line) return { ceiling: { depth: 1, hosts: [h] }, opened: false, line: null };
  const c = line.ceiling || {};
  return {
    ceiling: { ...c, approvals: c.approvals || "native", depth: c.depth ?? 1, hosts: Array.isArray(c.hosts) ? c.hosts : [line.host || h] },
    opened: true,
    line,
  };
}

/** The `swarm.spawn` lines from the top-most ancestor down to `swarm`. */
export function swarmChain(lines, swarm) {
  const spawns = new Map(findEvents(lines, "swarm.spawn").map((l) => [l.swarm, l]));
  const chain = [];
  const seen = new Set();
  let id = swarm;
  while (id && spawns.has(id) && !seen.has(id)) {
    seen.add(id);
    const spawn = spawns.get(id);
    chain.unshift(spawn);
    id = spawn.parent_swarm || null;
  }
  return chain;
}

/** The record at the top of a member's parent chain, or the deepest one readable. */
export function rootOf(fleet, record, env = process.env) {
  let current = record;
  const seen = new Set();
  while (current?.parent && !seen.has(current.parent)) {
    seen.add(current.parent);
    const parent = readMember(fleet, current.parent, env);
    if (!parent) break;
    current = parent;
  }
  return current || null;
}

/**
 * The effective ceiling at a point in the tree: the fleet's, merged key by key
 * with each `swarm.spawn` on the path down to `swarm`, with the latest
 * `fleet.cap` for any swarm on that path applied after its spawn. In the
 * implicit fleet `approvals` enters at the root: `rootApprovals`, or the
 * record's own ceiling when the caller has one and no chain to rebuild from.
 */
export function effectiveCeiling(lines, fleet, { swarm = null, rootApprovals = null, record = null, host: h = host() } = {}) {
  const { ceiling: base, opened } = fleetCeiling(lines, fleet, { host: h });
  let ceiling = { ...base };
  if (!opened) {
    if (record?.ceiling) ceiling = { ...record.ceiling };
    if (rootApprovals) ceiling.approvals = rootApprovals;
  }
  for (const spawn of swarmChain(lines, swarm)) {
    ceiling = mergeCeiling(ceiling, spawn.ceiling || {});
    const cap = findEvents(lines, "fleet.cap", { target: spawn.swarm }).at(-1);
    if (cap) ceiling = mergeCeiling(ceiling, cap.ceiling || {});
  }
  return ceiling;
}

/**
 * The effective ceiling a member's record was, or would be, started under:
 * effectiveCeiling with the implicit fleet's root approvals resolved. In the
 * implicit fleet approvals enter at the root: when the walk up the parent
 * chain reaches it, its own flags decide; when a record on the way up is
 * missing, the ceiling copied into this record is the best remaining witness.
 */
export function ceilingOf(fleet, record, { env = process.env, lines = readLedger(fleet, env), swarm = record?.swarm || null, host: h = host() } = {}) {
  const { opened } = fleetCeiling(lines, fleet, { host: h });
  let rootApprovals = null;
  if (record && !opened) {
    const root = rootOf(fleet, record, env);
    rootApprovals = root && !root.parent
      ? (root.orphan ? "native" : root.approvals || "native")
      : record.ceiling?.approvals || record.approvals || "native";
  }
  return effectiveCeiling(lines, fleet, { swarm, rootApprovals, record, host: h });
}

/* ---------------------------------------------------------------- the caller */

/**
 * Where this process sits: its own record from `OPENFLEET_RECORD`, else the
 * fleet `OPENFLEET_FLEET` names, else `current`, else the implicit fleet.
 * `agent` is the test the human-only verbs make: `OPENFLEET_MEMBER` present.
 */
export function context(env = process.env) {
  const recordFile = env.OPENFLEET_RECORD || null;
  const record = recordFile ? readRecord(recordFile) : null;
  const fleet = record?.fleet || env.OPENFLEET_FLEET || currentFleet(env) || implicitFleet(env);
  const lines = readLedger(fleet, env);
  const { opened, line: opener } = fleetCeiling(lines, fleet);
  const sysop = record?.sysop || opener?.sysop || implicitFleet(env);
  const member = record?.member || env.OPENFLEET_MEMBER || null;
  const swarm = record?.swarm || env.OPENFLEET_SWARM || null;
  const ceiling = ceilingOf(fleet, record, { env, lines, swarm });
  return {
    home: home(env),
    fleet,
    sysop,
    opened,
    record,
    recordPath: recordFile,
    member,
    swarm,
    depth: Number(record?.depth ?? 0),
    ceiling,
    agent: Boolean(env.OPENFLEET_MEMBER),
    by: member || "sysop",
  };
}

/* ------------------------------------------------------------------ the ids */

/**
 * `<slug of the task, at most 23 chars, leading letter>-<HHMM UTC>`, the form
 * the spec recommends: `create-two-0541`. Short enough that `<swarm>-<n>` still
 * fits the herd's NAME_RE, since the member id is also the pane name.
 */
export function swarmId(task, { name = null, now = Date.now() } = {}) {
  const slug = slugifyName(name || task).slice(0, 23).replace(/-+$/, "") || "task";
  const d = new Date(now);
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${slug}-${hhmm}`;
}

/* ----------------------------------------------------------------- the fold */

/** Sum spend strings of matching units; "12 USD + 5000 tokens" when they differ. */
export function sumSpend(values) {
  const totals = new Map();
  for (const v of values) {
    const b = parseBudget(v);
    if (!b) continue;
    totals.set(b.unit, (totals.get(b.unit) || 0) + b.amount);
  }
  return totals.size ? [...totals.entries()].map(([unit, amount]) => `${Number(amount.toFixed(6))} ${unit}`).join(" + ") : null;
}

/**
 * Records and ledgers, folded into the tree a sysop tool draws.
 *
 * `fleets` is `[{ fleet, lines, records }]`; `roster` is the herd's roster
 * (`[{ name, engine, state, alive, approvals, cwd }]`, engine already spelled
 * `moshcode/<engine>`) or null when none was read. With a roster, a recorded
 * moshcode member the roster no longer lists reads `lost` and is flagged so the
 * caller can write that end line, and a roster session with no record is drawn
 * as a root member of the implicit fleet marked as coming from the roster.
 *
 * Swarms hang under the member that spawned them, or under the fleet when the
 * sysop started one by hand; members hang under their swarm.
 */
export function fold({ fleets = [], roster = null, host: h = host(), implicit = implicitFleet(), now = Date.now() } = {}) {
  const byFleet = new Map();
  for (const f of fleets) byFleet.set(f.fleet, f);

  const matched = new Set();
  const out = [];
  for (const { fleet, lines = [], records = [] } of byFleet.values()) {
    const open = findEvents(lines, "fleet.open").at(-1) || null;
    const { ceiling } = fleetCeiling(lines, fleet, { host: h });
    const sysop = open?.sysop || records.find((r) => r.sysop)?.sysop || fleet;

    const spawns = new Map();
    for (const l of findEvents(lines, "swarm.spawn")) if (!spawns.has(l.swarm)) spawns.set(l.swarm, l);
    const swarmEnds = new Map();
    for (const l of findEvents(lines, "swarm.end")) if (!swarmEnds.has(l.swarm)) swarmEnds.set(l.swarm, l);
    const starts = new Map();
    for (const l of findEvents(lines, "member.start")) if (!starts.has(l.member)) starts.set(l.member, l);
    const spends = new Map();
    for (const l of findEvents(lines, "member.spend")) if (l.total) spends.set(l.member, l.total);

    const members = new Map();
    const node = (r, s) => {
      const id = r?.member || s?.member;
      const end = endOf(lines, id);
      const start = s || starts.get(id) || null;
      return {
        kind: "member",
        member: id,
        session: r?.session || start?.session || null,
        title: r?.piece?.title || start?.piece?.title || null,
        task: r?.task || null,
        engine: r?.engine || start?.engine || null,
        host: r?.host || start?.host || h,
        cwd: r?.cwd || start?.cwd || null,
        depth: Number(r?.depth ?? start?.depth ?? 0),
        parent: r?.parent || start?.parent || null,
        swarm: r?.swarm || start?.swarm || null,
        approvals: r?.approvals || start?.approvals || "native",
        owns: r?.piece?.owns || start?.piece?.owns || null,
        orphan: Boolean(r?.orphan),
        recorded: Boolean(r),
        claimed: Boolean(start),
        started: start?.at || r?.started || null,
        end,
        state: end ? end.state : start ? "running" : "unclaimed",
        spend: spends.get(id) || null,
        live: null,
        lost: false,
        rosterOnly: false,
        swarms: [],
      };
    };
    for (const r of records) if (r?.member && !members.has(r.member)) members.set(r.member, node(r, null));
    for (const [id, s] of starts) if (!members.has(id)) members.set(id, node(null, s));

    if (roster) {
      for (const m of members.values()) {
        if (!(/^moshcode\//.test(m.engine || "") || m.engine === "tmux")) continue;
        const row = roster.find((x) => x.name === m.session || x.name === m.member);
        if (row) {
          matched.add(row.name);
          m.live = Boolean(row.alive);
          if (!m.end && m.claimed && row.state) m.state = row.state;
        } else if (m.claimed && !m.end) {
          m.state = "lost";
          m.lost = true;
        }
      }
    }

    const swarmNodes = new Map();
    for (const [id, spawn] of spawns) {
      const effective = effectiveCeiling(lines, fleet, { swarm: id, host: h });
      const end = swarmEnds.get(id) || null;
      swarmNodes.set(id, {
        kind: "swarm", swarm: id, task: spawn.task || null, by: spawn.by || null, parent_swarm: spawn.parent_swarm || null,
        ceiling: spawn.ceiling || {}, fan_out: effective.fan_out ?? null, until: effective.until ?? null,
        pieces: Array.isArray(spawn.pieces) ? spawn.pieces.length : 0,
        end, state: end ? end.state : "running", at: spawn.at || null, missing: false, members: [], spend: null,
      });
    }
    for (const m of members.values()) {
      if (m.swarm && !swarmNodes.has(m.swarm)) {
        swarmNodes.set(m.swarm, {
          kind: "swarm", swarm: m.swarm, task: m.task, by: m.parent || null, parent_swarm: null, ceiling: {}, fan_out: null, until: null,
          pieces: 0, end: swarmEnds.get(m.swarm) || null, state: swarmEnds.get(m.swarm)?.state || "running", at: null, missing: true, members: [], spend: null,
        });
      }
    }
    // Dated nodes in time order, undated ones (a swarm nobody spawned in this
    // ledger) after them, ties by id.
    const stamp = (n) => String(n.started || n.at || "\uffff");
    const byStart = (a, b) => stamp(a).localeCompare(stamp(b)) || String(a.member || a.swarm).localeCompare(String(b.member || b.swarm));
    for (const s of swarmNodes.values()) {
      const order = (spawns.get(s.swarm)?.pieces || []).map((p) => p.member);
      s.members = [...members.values()].filter((m) => m.swarm === s.swarm)
        .sort((a, b) => {
          const ia = order.indexOf(a.member), ib = order.indexOf(b.member);
          if (ia >= 0 || ib >= 0) return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
          return byStart(a, b);
        });
      s.spend = sumSpend(s.members.map((m) => m.spend).filter(Boolean));
      if (!s.end && s.members.length && s.members.every((m) => m.end)) s.state = "ended";
    }
    const top = [];
    for (const s of [...swarmNodes.values()].sort(byStart)) {
      const spawner = s.by && s.by !== "sysop" ? members.get(s.by) : null;
      if (spawner) spawner.swarms.push(s);
      else top.push(s);
    }
    const roots = [...members.values()].filter((m) => !m.swarm).sort(byStart);
    out.push({
      fleet, sysop, implicit: !open, ceiling,
      nodes: [...roots, ...top],
      refusals: findEvents(lines, "ceiling.refuse"),
      spend: sumSpend([...members.values()].map((m) => m.spend).filter(Boolean)),
      budget: ceiling.budget ?? null,
    });
  }

  // A roster session with no record is a root member of the implicit fleet,
  // which exists on disk only once something recorded is in it; here it is
  // drawn either way, so an unaware engine still renders as a tree (rule 12).
  const unrecorded = (roster || []).filter((row) => !matched.has(row.name));
  if (unrecorded.length) {
    let impl = out.find((f) => f.fleet === implicit);
    if (!impl) {
      impl = { fleet: implicit, sysop: implicit, implicit: true, ceiling: { depth: 1, hosts: [h] }, nodes: [], refusals: [], spend: null, budget: null };
      out.push(impl);
    }
    for (const row of unrecorded) {
      impl.nodes.push({
        kind: "member", member: row.name, session: row.name, title: null, task: null, engine: row.engine || null, host: h, cwd: row.cwd || null,
        depth: 0, parent: null, swarm: null, approvals: row.approvals || "native", owns: null, orphan: false, recorded: false, claimed: false,
        started: null, end: null, state: row.state || (row.alive ? "running" : "gone"), spend: null, live: Boolean(row.alive), lost: false, rosterOnly: true, swarms: [],
      });
    }
  }

  out.sort((a, b) => (a.fleet === implicit ? -1 : b.fleet === implicit ? 1 : a.fleet.localeCompare(b.fleet)));
  return { at: iso(now), host: h, fleets: out };
}

/* --------------------------------------------------------------- the render */

const hhmm = (value) => {
  const t = untilMs(value);
  if (t === null) return String(value);
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

const clipText = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 3)}...` : String(s));

function memberLabel(m, h) {
  const parts = [m.session && m.session !== m.member ? `${m.member} (${m.session})` : m.member];
  if (m.title) parts.push(m.title);
  else if (m.rosterOnly && m.cwd) parts.push(m.cwd);
  if (m.engine) parts.push(m.engine);
  if (m.host && m.host !== h) parts.push(`@${m.host}`);
  parts.push(m.state);
  if (m.approvals === "bypass") parts.push("[bypass]");
  if (Array.isArray(m.owns) && m.owns.length) parts.push(`owns ${m.owns.join(",")}`);
  if (m.orphan) parts.push("[orphan]");
  if (m.rosterOnly) parts.push("[roster]");
  if (m.spend) parts.push(`spent ${m.spend}`);
  return parts.join("  ");
}

function swarmLabel(s) {
  const parts = [`swarm ${s.swarm}`];
  if (s.task) parts.push(`"${clipText(s.task, 40)}"`);
  parts.push(`${s.members.length}${s.fan_out ? `/${s.fan_out}` : ""} member${s.members.length === 1 ? "" : "s"}`);
  if (s.end) parts.push(s.end.state);
  else if (s.state === "ended") parts.push("ended");
  else if (s.until) parts.push(`until ${hhmm(s.until)}`);
  else parts.push("running");
  if (s.spend) parts.push(`spent ${s.spend}`);
  if (s.missing) parts.push("[no swarm.spawn]");
  return parts.join("  ");
}

function fleetLabel(f) {
  const c = f.ceiling || {};
  const bits = [f.implicit ? "implicit fleet" : "fleet", `sysop ${f.sysop}`];
  if (c.approvals) bits.push(`approvals ${c.approvals}`);
  bits.push(`depth ${c.depth ?? 1}`);
  if (c.fan_out) bits.push(`fan_out ${c.fan_out}`);
  if (Array.isArray(c.hosts)) bits.push(`hosts ${c.hosts.join(",")}`);
  if (c.until) bits.push(`until ${hhmm(c.until)}`);
  if (c.budget) bits.push(`${f.spend ? `spent ${f.spend} of ` : "budget "}${c.budget}`);
  else if (f.spend) bits.push(`spent ${f.spend}`);
  return `${f.fleet}  (${bits.join(", ")})`;
}

/** The tree as text, in the shape of the spec's landing page. */
export function renderTree(model, { host: h = host() } = {}) {
  const lines = [];
  const draw = (nodes, prefix) => {
    nodes.forEach((n, i) => {
      const last = i === nodes.length - 1;
      lines.push(`${prefix}${last ? "└─ " : "├─ "}${n.kind === "swarm" ? swarmLabel(n) : memberLabel(n, h)}`);
      const children = n.kind === "swarm" ? n.members : n.swarms;
      if (children?.length) draw(children, `${prefix}${last ? "   " : "│  "}`);
    });
  };
  for (const f of model.fleets || []) {
    lines.push(fleetLabel(f));
    if (f.nodes?.length) draw(f.nodes, "");
    else lines.push("└─ (no members yet)");
  }
  return lines.join("\n");
}
