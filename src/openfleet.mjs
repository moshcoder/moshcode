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
 * The once-marker a line takes before it is appended, so two writers that
 * both checked the ledger and found nothing cannot both append: a claude
 * pane's hook and the moshcode that started it race on `member.start`, and
 * `member.end` and `swarm.end` have the same check-then-append shape. The
 * marker is `fleets/<fleet>/marks/<event>.<id>`, created exclusively; on
 * EEXIST the line is not written and the caller hears "already". A `lost`
 * end takes `member.end.<id>.lost` instead, so the engine's or the spawner's
 * real end can still supersede it and takes the plain marker. logicsrc
 * writes the same paths. Null for an event that has no marker.
 */
export function markerFor(line) {
  const { event, member, swarm, state } = line || {};
  if (event === "member.start" && member) return `member.start.${member}`;
  if (event === "member.end" && member) return state === "lost" ? `member.end.${member}.lost` : `member.end.${member}`;
  if (event === "swarm.end" && swarm) return `swarm.end.${swarm}`;
  return null;
}

export function markPath(fleet, marker, env = process.env) {
  return path.join(fleetDir(fleet, env), "marks", marker);
}

/**
 * Take a once-marker. True when this call created it, false when another
 * writer already had. A marker that cannot be created for any other reason
 * (an unwritable home) counts as taken: the append that follows will say
 * whether the ledger is writable at all.
 */
export function claimOnce(fleet, marker, env = process.env) {
  const file = markPath(fleet, marker, env);
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return true;
  } catch (error) {
    return error?.code !== "EEXIST";
  }
}

/**
 * Append one line to this host's ledger, taking its once-marker first when
 * the event has one. Adds `at`, `fleet` and `host`; the caller passes
 * `event`, `by` and the event's own keys. Never throws: a lost ledger line
 * must not fail the swarm that was writing it. Returns `{ line, already }`:
 * the line as written, or null, and whether another writer got there first.
 */
export function appendOnce(fleet, line, { env = process.env, now = Date.now(), host: h = host(), once = true } = {}) {
  const { at, event, by, ...rest } = line || {};
  const written = { at: at || iso(now), event, fleet, host: h, by, ...rest };
  const marker = once ? markerFor(written) : null;
  if (marker && !claimOnce(fleet, marker, env)) return { line: null, already: true };
  try {
    ensureDir(fleetDir(fleet, env));
    const file = ledgerPath(fleet, env);
    fs.appendFileSync(file, `${JSON.stringify(written)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return { line: written, already: false };
  } catch { return { line: null, already: false }; }
}

/** appendOnce for a caller that only needs the line: the line as written, or null. */
export function append(fleet, line, options = {}) {
  return appendOnce(fleet, line, options).line;
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

/** An ISO time as epoch milliseconds, or null when it is not one. */
export const untilMs = (value) => {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : null;
};

/**
 * Key by key: a key `narrowing` carries replaces the one in `base` only when
 * it is narrower or equal. A merged ceiling never widens, whatever a ledger
 * line claims (rule 3): a spawn line saying `approvals: bypass` under a
 * native fleet is ignored here and refused by the engine that checks it.
 * Unknown keys ride through unchanged, as the spec keeps them.
 */
export function mergeCeiling(base = {}, narrowing = {}) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(narrowing || {})) {
    if (value === undefined || value === null) continue;
    if (!CEILING_KEYS.includes(key)) { out[key] = value; continue; }
    if (keyNarrower(key, value, out)) out[key] = value;
  }
  return out;
}

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
 * else `fleet.open`, else the implicit fleet's. Absent `depth` is 1 and
 * absent `hosts` is the host the line was written on. `opened` is true only
 * when a `fleet.open` line exists: a cap never opens a fleet. In an opened
 * fleet an absent `approvals` means native, whether the ceiling comes from
 * `fleet.open` or a later cap; a cap on the implicit fleet that names no
 * approvals leaves each root's own approvals in place, so the key stays
 * absent here and enters at the root in effectiveCeiling.
 */
export function fleetCeiling(lines, fleet, { host: h = host() } = {}) {
  const caps = findEvents(lines, "fleet.cap", { target: fleet });
  const open = findEvents(lines, "fleet.open").at(-1) || null;
  const opened = Boolean(open);
  const line = caps.at(-1) || open;
  if (!line) return { ceiling: { depth: 1, hosts: [h] }, opened: false, line: null };
  const c = line.ceiling || {};
  const ceiling = { ...c, depth: c.depth ?? 1, hosts: Array.isArray(c.hosts) ? c.hosts : [line.host || h] };
  if (opened && !ceiling.approvals) ceiling.approvals = "native";
  return { ceiling, opened, line };
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

/**
 * The root above a record: `parent` followed through record files, then
 * through `member.start` lines when a record is missing (it may have been
 * written on another host). Null when the chain breaks, which reads as
 * approvals native: nothing vouches for more.
 */
export function rootOf(fleet, record, { env = process.env, lines = readLedger(fleet, env) } = {}) {
  let current = record;
  const seen = new Set([record?.member]);
  while (current?.parent) {
    const parent = current.parent;
    if (seen.has(parent)) return null;
    seen.add(parent);
    const file = readMember(fleet, parent, env);
    if (file) { current = file; continue; }
    const start = claimedBy(lines, parent);
    if (!start) return null;
    current = { member: parent, approvals: start.approvals, parent: start.parent };
  }
  return current || null;
}

/** The approvals a root supplies to its subtree in the implicit fleet: its own, or native when orphan. */
export function rootApprovalsOf(root) {
  if (!root || root.orphan) return "native";
  return root.approvals === "bypass" ? "bypass" : "native";
}

/**
 * The effective ceiling at a point in the tree, in the order both sysop
 * tools use: the fleet's whole ceiling as the base (the latest fleet-target
 * cap, else `fleet.open`, else the implicit fleet's), then each `swarm.spawn`
 * narrowing on the path from the root swarm down to `swarm`, then the latest
 * `fleet.cap` for any swarm on that path, applied last so the sysop's word
 * wins over what a spawner wrote. Nothing in the merge widens. The copy in a
 * member's record is a snapshot and never an input here, so a later fleet
 * cap takes effect (rule 7). In the implicit fleet `approvals` enters at the
 * root, `rootApprovals`, unless a cap on the fleet named the key itself.
 */
export function effectiveCeiling(lines, fleet, { swarm = null, rootApprovals = null, host: h = host() } = {}) {
  const { ceiling: base, opened } = fleetCeiling(lines, fleet, { host: h });
  let ceiling = { ...base };
  if (!opened && ceiling.approvals === undefined && rootApprovals) ceiling.approvals = rootApprovals;
  const chain = swarmChain(lines, swarm);
  for (const spawn of chain) ceiling = mergeCeiling(ceiling, spawn.ceiling || {});
  for (const spawn of chain) {
    const cap = findEvents(lines, "fleet.cap", { target: spawn.swarm }).at(-1);
    if (cap) ceiling = mergeCeiling(ceiling, cap.ceiling || {});
  }
  return ceiling;
}

/**
 * The effective ceiling a member's record was, or would be, started under:
 * effectiveCeiling with the implicit fleet's root approvals resolved by
 * walking the parent chain to its root. A parentless record is its own root
 * and supplies its own approvals (never native by default); a broken chain
 * vouches for nothing and reads native.
 */
export function ceilingOf(fleet, record, { env = process.env, lines = readLedger(fleet, env), swarm = record?.swarm || null, host: h = host() } = {}) {
  const { opened } = fleetCeiling(lines, fleet, { host: h });
  const rootApprovals = record && !opened ? rootApprovalsOf(rootOf(fleet, record, { env, lines })) : null;
  return effectiveCeiling(lines, fleet, { swarm, rootApprovals, host: h });
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

/** Whether the herd's roster is the one that can hold a member of this engine. */
export function herdHolds(engine) {
  return /^moshcode\//.test(engine || "") || engine === "tmux";
}

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
        // `working` is the landing page's word for a claimed member with no
        // end line; the herd's finer states (idle, blocked) ride on `live`.
        state: end ? end.state : start ? "working" : "unclaimed",
        spend: spends.get(id) || null,
        live: null,
        herdState: null,
        lost: false,
        rosterOnly: false,
        swarms: [],
      };
    };
    for (const r of records) if (r?.member && !members.has(r.member)) members.set(r.member, node(r, null));
    for (const [id, s] of starts) if (!members.has(id)) members.set(id, node(null, s));

    // The herd roster can only hold a moshcode pane or a tmux target on this
    // host, so only such a member it no longer lists is lost; a claude-code
    // member, or a pane on another host, is nothing this roster can speak to.
    if (roster) {
      for (const m of members.values()) {
        if (!herdHolds(m.engine) || m.host !== h) continue;
        const row = roster.find((x) => x.name === m.session || x.name === m.member);
        if (row) {
          matched.add(row.name);
          m.live = Boolean(row.alive);
          m.herdState = row.state || null;
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
        started: null, end: null, state: row.state || (row.alive ? "working" : "gone"), spend: null, live: Boolean(row.alive), herdState: row.state || null,
        lost: false, rosterOnly: true, swarms: [],
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

/**
 * A swarm's task, quoted, clipped at 60 characters with ` ...`; bare when the
 * task carries a double quote of its own, as a command line does. The same
 * rule logicsrc's tree uses, so the two tools draw one swarm one way.
 */
function quoteTask(task, max = 60) {
  const text = String(task);
  const clipped = text.length > max ? `${text.slice(0, max - 4).trimEnd()} ...` : text;
  return clipped.includes('"') ? clipped : `"${clipped}"`;
}

/** A member row in three padded columns (label, title, engine) and the rest. */
function memberRow(m, h) {
  const marks = [m.state];
  if (m.approvals === "bypass") marks.push("[bypass]");
  if (m.orphan) marks.push("[orphan]");
  if (m.rosterOnly) marks.push("[roster]");
  if (m.live === false && m.state === "working") marks.push("[gone]");
  if (Array.isArray(m.owns) && m.owns.length) marks.push(`owns ${m.owns.join(",")}`);
  if (m.host && m.host !== h) marks.push(`@${m.host}`);
  if (m.spend) marks.push(`spent ${m.spend}`);
  return {
    label: m.session && m.session !== m.member ? `${m.member} (${m.session})` : String(m.member),
    title: m.title || (m.rosterOnly && m.cwd ? m.cwd : ""),
    engine: m.engine || "?",
    rest: marks.join("  "),
  };
}

function swarmRow(s) {
  const rest = [];
  if (s.end) rest.push(s.end.state);
  else if (s.state === "ended") rest.push("ended");
  else if (s.until) rest.push(`until ${hhmm(s.until)}`);
  else rest.push("running");
  if (s.spend) rest.push(`spent ${s.spend}`);
  if (s.missing) rest.push("[no swarm.spawn]");
  return {
    label: `swarm ${s.swarm}`,
    title: s.task ? quoteTask(s.task) : "",
    engine: `${s.members.length}${s.fan_out ? `/${s.fan_out}` : ""} member${s.members.length === 1 ? "" : "s"}`,
    rest: rest.join("  "),
  };
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

/**
 * The tree as text, in the shape of the spec's landing page: one fleet after
 * another, the label, title and engine columns padded per fleet so the state
 * column lines up, the way logicsrc's tree prints the same files.
 */
export function renderTree(model, { host: h = host() } = {}) {
  const lines = [];
  for (const f of model.fleets || []) {
    lines.push(fleetLabel(f));
    if (!f.nodes?.length) { lines.push("└─ (no members yet)"); continue; }
    const rows = [];
    const draw = (nodes, prefix) => {
      nodes.forEach((n, i) => {
        const last = i === nodes.length - 1;
        rows.push({ prefix: `${prefix}${last ? "└─ " : "├─ "}`, ...(n.kind === "swarm" ? swarmRow(n) : memberRow(n, h)) });
        const children = n.kind === "swarm" ? n.members : n.swarms;
        if (children?.length) draw(children, `${prefix}${last ? "   " : "│  "}`);
      });
    };
    draw(f.nodes, "");
    const labelWidth = Math.max(...rows.map((r) => r.prefix.length + r.label.length));
    const titleWidth = Math.max(...rows.map((r) => r.title.length));
    const engineWidth = Math.max(...rows.map((r) => r.engine.length));
    for (const r of rows) {
      const head = `${r.prefix}${r.label}`.padEnd(labelWidth);
      const title = titleWidth ? `  ${r.title.padEnd(titleWidth)}` : "";
      lines.push(`${head}${title}  ${r.engine.padEnd(engineWidth)}  ${r.rest}`.trimEnd());
    }
  }
  return lines.join("\n");
}
