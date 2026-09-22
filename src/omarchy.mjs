// `moshcode omarchy` — the herd, on the Omarchy bar (PRD 0017).
//
// WHY THIS EXISTS. Everything moshcode knows about a running fleet is behind a
// prompt: `ps` says who is alive, `cost` says what it burns, `fleet tree` says
// who started whom. All three are true and none of them are on screen, so you
// find out what your machine is doing by deciding to ask. The expensive version
// of that was a dozen background jobs at ~$131/hour that nobody saw for hours.
// The common version is an agent sitting in `blocked`, holding a pane and a
// context window, having asked a question twenty minutes ago.
//
// Omarchy's bar takes third-party QML plugins, so the missing surface is a bar
// widget. This module is the half that runs here: `status` is the one snapshot
// the widget polls, and `validate` / `install` / `doctor` are what make the
// plugin shippable from a box that does not run Omarchy.
//
// THE CONSTRAINT THAT SHAPES ALL OF IT. An Omarchy plugin runs unsandboxed
// inside a shared, long-running Quickshell process. A widget that leaks a
// process per tick or throws on a bad parse does not break moshcode, it breaks
// the whole bar for whoever installed it. So `status` is read-only, bounded,
// cached, and it never exits non-zero for a condition the bar should render:
// "no herd", "no rates", "cost was slow" are all answers, not failures.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as fleet from "./openfleet.mjs";
import { acid, bone, dim, err, info, moshcodeVersion, ok, warn } from "./ui.mjs";

// The herd and cost module graphs are the expensive part of this process, and
// three of the four verbs never touch them: `validate` reads a manifest,
// `doctor` stats a few paths, `install` copies a directory. Only `status` pays,
// because only `status` is on the path the bar polls.
const loadCost = () => import("./cost.mjs");
const loadCostCli = () => import("./cost-cli.mjs");
const loadHerdCli = () => import("./herd-cli.mjs");

/** herd-cli's exit codes, repeated rather than imported, so the cheap verbs stay cheap. */
const EXIT = { matched: 0, usage: 1, timeout: 2, gone: 3, below: 4, infra: 5 };

/** The snapshot contract. The plugin renders a schema it knows and says so for anything newer. */
export const SCHEMA = 1;

/** The plugin's id, which is also its directory name under ~/.config/omarchy/plugins. */
export const PLUGIN_ID = "sh.moshcode.herd";

/** The windows the bar shows. The bar is one line; 4h and 8h belong in `moshcode cost`. */
export const BAR_WINDOW_KEYS = ["1m", "15m", "1h"];

/** How long a cost reading stays good, and how long a SLOW one stays good. */
const DEFAULT_TTL_MS = 5_000;
const SLOW_TTL_MS = 60_000;
/** Over this, the reading is slow enough that paying for it every `ttl` is the wrong trade. */
const DEFAULT_BUDGET_MS = 2_000;

/** The seven fields the marketplace requires of every manifest. */
export const REQUIRED_FIELDS = ["schemaVersion", "id", "name", "version", "kinds", "entryPoints", "description"];

/** Each kind and the entry point key it has to declare. */
export const KIND_ENTRY_POINTS = {
  "bar-widget": "barWidget",
  panel: "panel",
  overlay: "overlay",
  menu: "menu",
  service: "service",
  bar: "bar",
};

const USAGE = {
  omarchy: "usage: moshcode omarchy <status|validate|install|doctor> [--json]",
  status: "usage: moshcode omarchy status [--json] [--ttl <secs>] [--no-cache]",
  validate: "usage: moshcode omarchy validate [dir] [--json]",
  install: "usage: moshcode omarchy install [--link] [--json]",
  doctor: "usage: moshcode omarchy doctor [--json]",
};

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

/* ------------------------------------------------------------------ paths */

/** The plugin source that ships inside the package. */
export function pluginSource() {
  return fileURLToPath(new URL("../omarchy", import.meta.url));
}

/** Where Omarchy looks for third-party plugins. */
export function pluginsDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "omarchy", "plugins");
}

export function installedDir(env = process.env) {
  return path.join(pluginsDir(env), PLUGIN_ID);
}

/** The cost reading's cache. Its own file, because only the cost half is worth caching. */
export function cachePath() {
  return path.join(os.homedir(), ".moshcode", "herd", "omarchy-status.json");
}

/* --------------------------------------------------------------- snapshot */

function readCache(file = cachePath()) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeCache(value, file = cachePath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  } catch { /* a cache that cannot be written is a slower bar, not a broken one */ }
}

/**
 * The agents half: the same rows `moshcode ps --json` prints, trimmed to what a
 * bar can show. Trimmed rather than renamed — a person reading the panel and a
 * person reading `moshcode ps` have to be reading the same words.
 */
export function agentRows(rows) {
  return rows.map(({ name, engine, herd, state, blockedOn, fleet: f, swarm, member, approvals, cwd, age, alive, attached }) => ({
    name, engine, herd: herd || null, state, ...(blockedOn ? { blockedOn } : {}),
    fleet: f || null, swarm: swarm || null, member: member || null,
    approvals: approvals || "native", cwd, ageMs: age, alive: Boolean(alive), attached: attached || 0,
  }));
}

/** One count per state in the vocabulary, plus `live`. Absent states are 0, never missing. */
export function countStates(rows) {
  const counts = { working: 0, blocked: 0, done: 0, idle: 0, unknown: 0, gone: 0, live: 0 };
  for (const r of rows) {
    if (counts[r.state] === undefined) counts[r.state] = 0;
    counts[r.state] += 1;
    if (r.alive) counts.live += 1;
  }
  return counts;
}

/**
 * Blocked is the alert. It is the one state where the machine is spending a
 * pane and a context window on nothing at all, and the only state a human can
 * clear, so it is the reason the widget changes colour.
 */
export function alertsFor(rows, { now = Date.now() } = {}) {
  return rows
    .filter((r) => r.state === "blocked")
    .map((r) => ({
      kind: r.blockedOn ? `blocked:${r.blockedOn}` : "blocked",
      subject: r.name,
      engine: r.engine,
      ageMs: r.ageMs ?? null,
      since: r.ageMs == null ? null : new Date(now - r.ageMs).toISOString(),
    }));
}

/** The fleets half: one line per fleet, not the tree. The tree is `moshcode fleet tree`. */
export function fleetSummary(env = process.env) {
  try {
    const names = fleet.listFleets(env);
    const implicit = fleet.implicitFleet(env);
    const all = names.includes(implicit) ? names : [...names, implicit];
    return all.map((name) => {
      let records = [];
      try { records = fleet.listRecords(name, env); } catch { records = []; }
      const swarms = new Set(records.map((r) => r?.swarm).filter(Boolean));
      return {
        fleet: name,
        implicit: name === implicit,
        members: records.length,
        swarms: swarms.size,
      };
    }).filter((f) => f.members > 0 || f.implicit);
  } catch {
    return [];
  }
}

/**
 * The cost half, with its cache.
 *
 * Reading cost means reading transcripts, which is ~200ms of process boot on
 * this machine today and is not a promise about a machine with a year of them.
 * So: a fresh reading is served from `~/.moshcode/omarchy-status.json` until it
 * is `ttl` old; a reading that took longer than `budget` marks itself `slow` and
 * is held for a minute instead, because paying two seconds every five is the
 * wrong trade for a number that moves by cents. The bar is told which it got.
 */
export async function burnSnapshot({
  now = Date.now(), ttl = DEFAULT_TTL_MS, budget = DEFAULT_BUDGET_MS, cache = true,
  file = cachePath(), report = null, windows = null,
} = {}) {
  if (cache) {
    const held = readCache(file);
    const age = held?.at == null ? null : now - held.at;
    const good = held?.slow ? SLOW_TTL_MS : ttl;
    if (held && age != null && age >= 0 && age < good) {
      return { burn: held.burn ?? null, burnAgeMs: age, cached: true, slow: Boolean(held.slow), unpriced: held.unpriced ?? [] };
    }
  }
  const started = Date.now();
  try {
    // Only now does the cost half of the module graph get loaded: a cache hit
    // above returned without it.
    const { burn, BURN_WINDOWS } = await loadCost();
    const { costReport, parseWindow } = await loadCostCli();
    const run = report || costReport;
    const since = now - parseWindow("1h");
    const r = await run({ since });
    const rows = burn(r.runs, { now, windows: windows || BURN_WINDOWS.filter((w) => BAR_WINDOW_KEYS.includes(w.key)), since: null });
    const elapsed = Date.now() - started;
    const unpriced = [...new Set(rows.flatMap((row) => row.unpriced || []))];
    const slow = elapsed > budget;
    if (cache) writeCache({ at: now, burn: rows, elapsedMs: elapsed, slow, unpriced }, file);
    return { burn: rows, burnAgeMs: 0, cached: false, slow, elapsedMs: elapsed, unpriced };
  } catch (e) {
    // A cost reading that throws is a missing number, not a broken bar: serve
    // the last one we had, say how old it is, and mark the snapshot partial.
    const held = cache ? readCache(file) : null;
    return {
      burn: held?.burn ?? null,
      burnAgeMs: held?.at == null ? null : now - held.at,
      cached: Boolean(held),
      slow: Boolean(held?.slow),
      unpriced: held?.unpriced ?? [],
      partial: true,
      error: String(e?.message || e),
    };
  }
}

/**
 * The whole snapshot, in one process boot. This is the only thing the plugin
 * runs, and it never writes to the herd, the ledger or the fleet.
 */
export async function snapshot({
  now = Date.now(), env = process.env, ttl = DEFAULT_TTL_MS, budget = DEFAULT_BUDGET_MS,
  cache = true, roster = null, ...rest
} = {}) {
  const out = {
    schema: SCHEMA,
    generatedAt: new Date(now).toISOString(),
    moshcode: moshcodeVersion() || null,
    host: os.hostname(),
  };
  let rows = [];
  try {
    const read = roster || (await loadHerdCli()).roster;
    rows = agentRows(read());
  } catch (e) {
    out.partial = true;
    out.error = String(e?.message || e);
  }
  out.agents = rows;
  out.counts = countStates(rows);
  out.alerts = alertsFor(rows, { now });
  out.fleets = fleetSummary(env);

  const b = await burnSnapshot({ now, ttl, budget, cache, ...rest });
  out.burn = b.burn;
  out.burnAgeMs = b.burnAgeMs;
  out.burnCached = b.cached;
  if (b.slow) out.burnSlow = true;
  if (b.unpriced?.length) out.unpriced = b.unpriced;
  if (b.partial) { out.partial = true; out.error = out.error || b.error; }
  return out;
}

/* ------------------------------------------------------------- validation */

/**
 * The marketplace's documented checks, in JavaScript.
 *
 * Omarchy's own `omarchy plugin validate` is the authority and it is not on
 * this box (the dev machine is Ubuntu, with no omarchy, no quickshell and no
 * qmllint). This is the part that can run in CI anyway: it says the listing
 * will validate. It does not say the plugin works — only a real Omarchy install
 * and `qmllint` can say that, which is why `doctor` reports whether you are on
 * one.
 */
export function validatePlugin(dir = pluginSource()) {
  const errors = [];
  const warnings = [];
  let manifest = null;

  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, dir, manifest: null, errors: [`no manifest.json in ${dir}`], warnings };
  }
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return { ok: false, dir, manifest: null, errors: [`manifest.json is not valid JSON: ${e.message}`], warnings };
  }

  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] === undefined || manifest[field] === null || manifest[field] === "") {
      errors.push(`manifest is missing required field "${field}"`);
    }
  }
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) {
    warnings.push(`schemaVersion ${JSON.stringify(manifest.schemaVersion)} is not 1 — the documented contract is 1`);
  }
  if (typeof manifest.id === "string" && /^omarchy\./.test(manifest.id)) {
    errors.push(`id "${manifest.id}" is in the reserved omarchy.* namespace`);
  }
  if (typeof manifest.id === "string" && !manifest.id.includes(".")) {
    warnings.push(`id "${manifest.id}" is not namespaced — the documented form is like io.github.you.thing`);
  }
  if (typeof manifest.version === "string" && manifest.version.length > 64) {
    errors.push("version is longer than 64 characters");
  }

  const kinds = Array.isArray(manifest.kinds) ? manifest.kinds : [];
  if (Array.isArray(manifest.kinds) && !kinds.length) errors.push("kinds is empty");
  if (manifest.kinds !== undefined && !Array.isArray(manifest.kinds)) errors.push("kinds must be an array");
  const entryPoints = manifest.entryPoints && typeof manifest.entryPoints === "object" ? manifest.entryPoints : {};

  for (const kind of kinds) {
    const key = KIND_ENTRY_POINTS[kind];
    if (!key) { errors.push(`unknown kind "${kind}"`); continue; }
    if (!entryPoints[key]) errors.push(`kind "${kind}" declares no entryPoints.${key}`);
  }
  for (const key of Object.keys(entryPoints)) {
    const kind = Object.keys(KIND_ENTRY_POINTS).find((k) => KIND_ENTRY_POINTS[k] === key);
    if (!kind) { errors.push(`entryPoints.${key} matches no known kind`); continue; }
    if (!kinds.includes(kind)) errors.push(`entryPoints.${key} is declared but kind "${kind}" is not`);
  }

  // Every referenced file exists, as a safe relative path inside the plugin.
  const referenced = [...Object.values(entryPoints), ...(manifest.preview ? [manifest.preview] : [])].filter((v) => typeof v === "string");
  for (const rel of referenced) {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
      errors.push(`referenced file "${rel}" is not a safe relative path`);
      continue;
    }
    const target = path.join(dir, rel);
    if (!fs.existsSync(target)) errors.push(`referenced file "${rel}" does not exist`);
  }

  for (const rel of walk(dir)) {
    const full = path.join(dir, rel);
    let st = null;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) errors.push(`symlink in plugin directory: ${rel}`);
  }

  for (const nice of ["README.md", "LICENSE"]) {
    if (!fs.existsSync(path.join(dir, nice))) warnings.push(`no ${nice} — the marketplace asks for one`);
  }
  if (!fs.existsSync(path.join(dir, "preview.png"))) {
    warnings.push("no preview.png — the listing card will have no image");
  }

  return { ok: errors.length === 0, dir, manifest, errors, warnings };
}

/** Every path under `dir`, relative, without following symlinks. */
function walk(dir, prefix = "") {
  let entries = [];
  try { entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const rel = prefix ? path.join(prefix, e.name) : e.name;
    out.push(rel);
    if (e.isDirectory() && !e.isSymbolicLink()) out.push(...walk(dir, rel));
  }
  return out;
}

/* ------------------------------------------------------------------ doctor */

/**
 * PATH by hand, rather than a shelled-out `command -v`.
 *
 * A shell here would be a process spawn on a path the bar polls, and node's
 * own `shell: true` warns that argv is concatenated rather than escaped. A
 * directory read is cheaper than both and cannot be talked into running
 * anything.
 */
function which(bin, env = process.env) {
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && (st.mode & 0o111)) return full;
    } catch { /* next */ }
  }
  return null;
}

export function doctor(env = process.env) {
  const source = pluginSource();
  const installed = installedDir(env);
  const local = validatePlugin(source);
  let installedVersion = null;
  try { installedVersion = JSON.parse(fs.readFileSync(path.join(installed, "manifest.json"), "utf8")).version || null; } catch { /* not installed */ }
  const shellPath = env.OMARCHY_PATH ? path.join(env.OMARCHY_PATH, "shell") : null;
  return {
    omarchy: which("omarchy"),
    omarchyShell: which("omarchy-shell"),
    qmllint: which("qmllint"),
    omarchyPath: env.OMARCHY_PATH || null,
    shellDir: shellPath && fs.existsSync(shellPath) ? shellPath : null,
    pluginsDir: fs.existsSync(pluginsDir(env)) ? pluginsDir(env) : null,
    source,
    sourceValid: local.ok,
    sourceVersion: local.manifest?.version || null,
    installedDir: fs.existsSync(installed) ? installed : null,
    installedVersion,
    moshcode: moshcodeVersion() || null,
  };
}

/* ----------------------------------------------------------------- install */

/**
 * Copy the plugin into ~/.config/omarchy/plugins/<id> and ask the shell to
 * rescan. A copy rather than a symlink because the validator rejects symlinks
 * inside a plugin folder; `--link` is the development path and says so.
 */
export function install({ env = process.env, link = false, source = pluginSource(), now = Date.now() } = {}) {
  const check = validatePlugin(source);
  if (!check.ok) return { ok: false, errors: check.errors, target: null };
  const target = installedDir(env);
  const backups = [];
  if (fs.existsSync(target)) {
    // Never overwrite in place: the replaced directory is kept beside itself,
    // numbered, so a bad install is one `mv` from undone.
    let n = 1;
    let backup = `${target}.bak-${String(n).padStart(3, "0")}`;
    while (fs.existsSync(backup)) { n += 1; backup = `${target}.bak-${String(n).padStart(3, "0")}`; }
    fs.renameSync(target, backup);
    backups.push(backup);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (link) fs.symlinkSync(source, target);
  else fs.cpSync(source, target, { recursive: true, dereference: true });

  let rescan = null;
  if (which("omarchy-shell")) {
    const r = spawnSync("omarchy-shell", ["shell", "rescanPlugins"], { encoding: "utf8" });
    rescan = r.status === 0 ? "ok" : String(r.stderr || r.stdout || `exit ${r.status}`).trim();
  }
  return { ok: true, target, link, backups, rescan, at: new Date(now).toISOString(), version: check.manifest?.version || null };
}

/* -------------------------------------------------------------------- CLI */

function usd(v) {
  if (v == null) return "—";
  return v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
}

async function statusCommand(argv, { write }) {
  const { flags, errors } = parseArgs(argv, { valued: ["ttl"], flags: ["json", "no-cache"] });
  for (const e of errors) write(err(e));
  if (errors.length) { write(err(USAGE.status)); return EXIT.usage; }
  const ttl = flags.ttl ? Math.max(0, Number(flags.ttl) * 1000) : DEFAULT_TTL_MS;
  if (flags.ttl && !Number.isFinite(Number(flags.ttl))) { write(err("--ttl takes seconds")); return EXIT.usage; }
  const snap = await snapshot({ ttl, cache: !flags["no-cache"] });
  if (flags.json) { write(JSON.stringify(snap, null, 2)); return EXIT.matched; }

  const c = snap.counts;
  write(`  ${bone("agents")}  ${c.live} live · ${c.working} working · ${c.blocked} blocked · ${c.idle} idle`);
  const hour = (snap.burn || []).find((b) => b.key === "1h");
  write(`  ${bone("burn")}    ${usd(hour?.perHour)}/h over the last hour${snap.burnCached ? dim(" (cached)") : ""}${snap.burnSlow ? dim(" · slow") : ""}`);
  if (snap.unpriced?.length) write(warn(`no rate for ${snap.unpriced.join(", ")} — those tokens count toward nothing.`));
  for (const a of snap.alerts) {
    const mins = a.ageMs == null ? "?" : Math.round(a.ageMs / 60000);
    write(warn(`${a.subject} is ${a.kind} — ${mins}m`));
  }
  if (snap.partial) write(warn(`partial snapshot: ${snap.error}`));
  write(info(`the bar polls ${acid("moshcode omarchy status --json")} — ${acid("moshcode omarchy doctor")} says whether it can.`));
  return EXIT.matched;
}

function validateCommand(argv, { write }) {
  const { flags, positional, errors } = parseArgs(argv, { valued: [], flags: ["json"] });
  for (const e of errors) write(err(e));
  if (errors.length) { write(err(USAGE.validate)); return EXIT.usage; }
  const dir = positional[0] ? path.resolve(positional[0]) : pluginSource();
  const result = validatePlugin(dir);
  if (flags.json) { write(JSON.stringify(result, null, 2)); return result.ok ? EXIT.matched : EXIT.usage; }
  for (const e of result.errors) write(err(e));
  for (const w of result.warnings) write(warn(w));
  if (result.ok) {
    write(ok(`${result.manifest?.id || dir} validates (${result.manifest?.version || "no version"})`));
    write(info("this says the listing will validate, not that the plugin runs — that needs a real Omarchy box and qmllint."));
  }
  return result.ok ? EXIT.matched : EXIT.usage;
}

function installCommand(argv, { write }) {
  const { flags, errors } = parseArgs(argv, { valued: [], flags: ["json", "link"] });
  for (const e of errors) write(err(e));
  if (errors.length) { write(err(USAGE.install)); return EXIT.usage; }
  const result = install({ link: Boolean(flags.link) });
  if (flags.json) { write(JSON.stringify(result, null, 2)); return result.ok ? EXIT.matched : EXIT.usage; }
  if (!result.ok) { for (const e of result.errors) write(err(e)); return EXIT.usage; }
  for (const b of result.backups) write(info(`replaced directory kept at ${b}`));
  write(ok(`installed ${PLUGIN_ID} ${result.version} to ${result.target}${result.link ? " (symlinked)" : ""}`));
  if (result.rescan === "ok") write(info("asked the shell to rescan its plugins."));
  else if (result.rescan) write(warn(`rescan failed: ${result.rescan}`));
  else write(info(`no omarchy-shell here — on the Omarchy box run ${acid("omarchy-shell shell rescanPlugins")}.`));
  return EXIT.matched;
}

function doctorCommand(argv, { write }) {
  const { flags, errors } = parseArgs(argv, { valued: [], flags: ["json"] });
  for (const e of errors) write(err(e));
  if (errors.length) { write(err(USAGE.doctor)); return EXIT.usage; }
  const d = doctor();
  if (flags.json) { write(JSON.stringify(d, null, 2)); return EXIT.matched; }
  const line = (label, value, hint) => write(`  ${bone(label.padEnd(14))}${value ? acid(String(value)) : dim(hint || "not found")}`);
  line("omarchy", d.omarchy);
  line("omarchy-shell", d.omarchyShell);
  line("qmllint", d.qmllint, "not found — cannot lint QML here");
  line("OMARCHY_PATH", d.shellDir, "unset — qmllint needs -I $OMARCHY_PATH/shell");
  line("plugins dir", d.pluginsDir, `${pluginsDir()} (absent)`);
  line("plugin source", d.sourceValid ? `${d.source} (${d.sourceVersion})` : null, `${d.source} — invalid`);
  line("installed", d.installedVersion ? `${d.installedDir} (${d.installedVersion})` : null, "not installed");
  if (!d.omarchy) write(info("this box is not an Omarchy install: the CLI half works, the plugin cannot be run or linted here."));
  else if (!d.installedVersion) write(info(`install it with ${acid("moshcode omarchy install")}.`));
  else if (d.installedVersion !== d.sourceVersion) write(warn(`installed ${d.installedVersion} is not the shipped ${d.sourceVersion} — ${acid("moshcode omarchy install")} updates it.`));
  return EXIT.matched;
}

const VERBS = { status: statusCommand, validate: validateCommand, install: installCommand, doctor: doctorCommand };

export async function omarchyCommand(argv = [], { write = console.log } = {}) {
  const [verb, ...rest] = argv;
  if (!verb || verb === "--help" || verb === "help") {
    write(USAGE.omarchy);
    write("");
    write(`  ${bone("status")}    the snapshot the bar polls: agents, burn, alerts`);
    write(`  ${bone("validate")}  the marketplace's checks, runnable with no Omarchy installed`);
    write(`  ${bone("install")}   copy the plugin into ~/.config/omarchy/plugins and rescan`);
    write(`  ${bone("doctor")}    what is present here, and what that rules out`);
    return verb ? EXIT.matched : EXIT.usage;
  }
  const run = VERBS[verb];
  if (!run) { write(err(`unknown verb ${JSON.stringify(verb)}`)); write(err(USAGE.omarchy)); return EXIT.usage; }
  return run(rest, { write });
}
