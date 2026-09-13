// Engine settings defaults — the engine's own config, as moshcode would like
// to find it (the settings half of "the engine speaks for itself", PRD 0011).
//
// An engine's `settings` spec in engines.mjs names the file it reads and the
// keys moshcode wants in it. `moshcode install <engine>` applies them, and
// `moshcode engines defaults` shows, applies or removes them by hand. The
// first one written is Claude Code's ultracode: every substantive prompt
// becomes a workflow, workflows stay small, and no more than four agents run
// at once — the shape a herd wants from each of its sessions.
//
// THE SAME THREE RULES as src/herd-hooks.mjs, because it is the same file:
//
//   MERGE, NEVER CLOBBER. A key the operator set — to anything, including the
//   opposite of what we want — stays exactly as it is. Apply only ever fills a
//   hole. That makes these a floor under a fresh install, not a policy over an
//   old one, and it is why `status` reports "theirs" as a state and not a fault.
//
//   REMOVE ONLY WHAT IS OURS. A key whose value is still the one we wrote is
//   taken out; a key the operator has since changed is theirs now and stays.
//
//   REFUSE A FILE WE CANNOT PARSE. Overwriting it would take every hook, MCP
//   server and preference in it along with the mistake.
//
// Nested defaults (`env: { X: "4" }`) merge one leaf at a time: the operator's
// other env vars are untouched, and an `env` object we created is removed
// again only once it is empty.
import { ENGINES, resolveEngine } from "./engines.mjs";
import { existingMode, hookDiff, readJsonFile, writeJsonFile } from "./herd-hooks.mjs";
import { acid, amber, ash, err, info, ok } from "./ui.mjs";

const FILE_MODE = 0o600;

/** Engines that ship a settings spec, in table order. */
export function defaultableEngines() {
  return Object.entries(ENGINES).filter(([, engine]) => engine.settings?.defaults).map(([key]) => key);
}

/** Where this engine's settings live, resolved now (specs hold a function). */
export function settingsFile(engine) {
  const spec = ENGINES[engine]?.settings;
  if (!spec) return null;
  return typeof spec.file === "function" ? spec.file() : spec.file;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The spec's defaults as a flat list of leaves — `{ env: { X: "4" } }` is one
 * entry at path ["env", "X"], key "env.X". Merging leaf by leaf is what keeps
 * the operator's other env vars alone.
 */
export function defaultEntries(engine) {
  const spec = ENGINES[engine]?.settings;
  if (!spec?.defaults) return [];
  const out = [];
  const walk = (value, path) => {
    if (isPlainObject(value) && Object.keys(value).length) {
      for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
      return;
    }
    const key = path.join(".");
    out.push({ path, key, value, label: spec.labels?.[key] || key });
  };
  walk(spec.defaults, []);
  return out;
}

function getAt(object, path) {
  let cursor = object;
  for (const step of path) {
    if (!isPlainObject(cursor) || !Object.hasOwn(cursor, step)) return { present: false };
    cursor = cursor[step];
  }
  return { present: true, value: cursor };
}

function setAt(object, path, value) {
  let cursor = object;
  for (const step of path.slice(0, -1)) {
    if (!isPlainObject(cursor[step])) cursor[step] = {};
    cursor = cursor[step];
  }
  cursor[path[path.length - 1]] = value;
}

/** Delete a leaf, then any parent object the deletion left empty. */
function deleteAt(object, path) {
  const parents = [];
  let cursor = object;
  for (const step of path.slice(0, -1)) {
    if (!isPlainObject(cursor[step])) return;
    parents.push([cursor, step]);
    cursor = cursor[step];
  }
  delete cursor[path[path.length - 1]];
  for (let i = parents.length - 1; i >= 0; i--) {
    const [parent, step] = parents[i];
    if (isPlainObject(parent[step]) && !Object.keys(parent[step]).length) delete parent[step];
    else break;
  }
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What the file says right now, one row per default: `set` (ours), `theirs`
 * (present, some other value — the operator's, and respected), or `missing`.
 */
export function settingsStatus(engine, { file = settingsFile(engine) } = {}) {
  const spec = ENGINES[engine]?.settings;
  if (!spec?.defaults) return { engine, supported: false, file: null, entries: [] };
  const read = readJsonFile(file);
  if (!read.ok) {
    return { engine, supported: true, file, readable: false, error: String(read.error?.message || read.error), entries: [] };
  }
  const settings = read.data || {};
  const entries = defaultEntries(engine).map((entry) => {
    const have = getAt(settings, entry.path);
    const state = !have.present ? "missing" : same(have.value, entry.value) ? "set" : "theirs";
    return { key: entry.key, label: entry.label, want: entry.value, have: have.present ? have.value : undefined, state };
  });
  return {
    engine,
    supported: true,
    file,
    readable: true,
    present: read.present,
    // "Applied" means nothing is missing. A key the operator overrode counts:
    // they have an answer, and it is not our place to have a different one.
    applied: entries.every((e) => e.state !== "missing"),
    entries,
  };
}

/**
 * Fill the holes. `dryRun` computes everything and writes nothing, returning
 * the file as it would have been so the caller can show a diff.
 */
export function applyEngineSettings(engine, { file = settingsFile(engine), dryRun = false } = {}) {
  const spec = ENGINES[engine]?.settings;
  if (!spec?.defaults) {
    return { ok: false, engine, supported: false, error: new Error(`${engine} ships no settings defaults`) };
  }
  const read = readJsonFile(file);
  if (!read.ok) return { ok: false, engine, supported: true, file, error: read.error };

  const settings = read.data ?? {};
  const before = JSON.stringify(settings, null, 2);
  const changes = defaultEntries(engine).map((entry) => {
    const have = getAt(settings, entry.path);
    if (!have.present) { setAt(settings, entry.path, entry.value); return { key: entry.key, label: entry.label, change: "added" }; }
    return { key: entry.key, label: entry.label, change: same(have.value, entry.value) ? "unchanged" : "kept" };
  });
  const after = JSON.stringify(settings, null, 2);

  if (!dryRun && changes.some((c) => c.change === "added")) {
    try { writeJsonFile(file, settings, { mode: read.present ? existingMode(file) : FILE_MODE }); }
    catch (error) { return { ok: false, engine, supported: true, file, error }; }
  }
  return {
    ok: true, engine, supported: true, file, dryRun,
    changes,
    written: changes.filter((c) => c.change === "added").length,
    before, after,
  };
}

/** Take ours back out. A value the operator changed since is theirs and stays. */
export function removeEngineSettings(engine, { file = settingsFile(engine), dryRun = false } = {}) {
  const spec = ENGINES[engine]?.settings;
  if (!spec?.defaults) return { ok: false, engine, supported: false, error: new Error(`${engine} ships no settings defaults`) };
  const read = readJsonFile(file);
  if (!read.ok) return { ok: false, engine, supported: true, file, error: read.error };
  if (!read.present) return { ok: true, engine, supported: true, file, removed: 0, dryRun };

  const settings = read.data ?? {};
  const before = JSON.stringify(settings, null, 2);
  let removed = 0;
  for (const entry of defaultEntries(engine)) {
    const have = getAt(settings, entry.path);
    if (have.present && same(have.value, entry.value)) { deleteAt(settings, entry.path); removed++; }
  }
  const after = JSON.stringify(settings, null, 2);

  if (!dryRun && removed) {
    try { writeJsonFile(file, settings, { mode: existingMode(file) }); }
    catch (error) { return { ok: false, engine, supported: true, file, error }; }
  }
  return { ok: true, engine, supported: true, file, removed, dryRun, before, after };
}

/**
 * The one-liner `moshcode install <engine>` prints after a successful install:
 * what was applied, or nothing at all for an engine with no spec. Quiet on
 * purpose — an install that changed nothing about the engine's config reads
 * exactly as it did before.
 */
export function applyAfterInstall(engine, { write = console.log } = {}) {
  if (!defaultableEngines().includes(engine)) return null;
  const result = applyEngineSettings(engine);
  if (!result.ok) {
    write(`   ${engine} defaults not applied: ${result.error?.message || result.error} — moshcode engines defaults apply ${engine}`);
    return result;
  }
  const added = result.changes.filter((c) => c.change === "added");
  if (added.length) write(`   ${engine} defaults: ${added.map((c) => c.label).join(" · ")}  (${result.file})`);
  return result;
}

const USAGE = "usage: moshcode engines defaults [status|apply|remove] [<engine>|all] [--dry-run] [--json]";

/**
 * `moshcode engines defaults …` — status is the default verb, `all` the
 * default target. Shared by the CLI and the pit; `write` is console.log or the
 * pit's indenting wrapper.
 */
export async function enginesDefaults(argv = [], { write = console.log } = {}) {
  const positional = argv.filter((a) => !a.startsWith("-"));
  const dryRun = argv.includes("--dry-run");
  const json = argv.includes("--json");
  const supported = defaultableEngines();

  // `moshcode engines defaults claude` reads as status for claude; the verb
  // is optional and an engine name in its place should not be a usage error.
  let [verb = "status", target] = positional;
  if (!["status", "apply", "remove"].includes(verb)) {
    if (resolveEngine(verb) && !target) { target = verb; verb = "status"; }
    else { write(err(USAGE)); return 1; }
  }

  const targets = (() => {
    if (!target || target === "all") return supported;
    const resolved = resolveEngine(target);
    return resolved ? [resolved[0]] : [];
  })();

  if (!targets.length) {
    write(err(target ? `no engine named ${JSON.stringify(target)}` : "no engine in this release ships settings defaults"));
    if (target) write(info(`engines with defaults: ${supported.join(", ") || "none yet"}`));
    return 1;
  }

  if (verb === "status") {
    const rows = targets.map((engine) => settingsStatus(engine));
    if (json) { write(JSON.stringify(rows, null, 2)); return 0; }
    for (const row of rows) {
      if (!row.readable) { write(err(`${row.engine} — ${row.error}`)); continue; }
      const missing = row.entries.filter((e) => e.state === "missing").length;
      write(row.applied
        ? ok(`${row.engine} — defaults in place`)
        : info(`${row.engine} — ${missing} of ${row.entries.length} not set · moshcode engines defaults apply ${row.engine}`));
      write(ash(`  ${row.file}`));
      for (const e of row.entries) {
        const mark = e.state === "set" ? acid("✓") : e.state === "theirs" ? amber("~") : ash("·");
        const detail = e.state === "theirs" ? ash(`yours: ${JSON.stringify(e.have)}`) : ash(`→ ${JSON.stringify(e.want)}`);
        write(`  ${mark} ${e.label.padEnd(34)} ${detail}`);
      }
    }
    const unsupported = Object.keys(ENGINES).filter((k) => !supported.includes(k));
    if (unsupported.length && !target) write(info(`no defaults yet: ${unsupported.join(", ")}`));
    return 0;
  }

  const results = targets.map((engine) => (verb === "apply"
    ? applyEngineSettings(engine, { dryRun })
    : removeEngineSettings(engine, { dryRun })));

  if (json) {
    write(JSON.stringify(results.map((r) => ({
      engine: r.engine, ok: r.ok, file: r.file ?? settingsFile(r.engine), dryRun: Boolean(r.dryRun),
      ...(r.changes ? { changes: r.changes } : {}), ...(r.removed !== undefined ? { removed: r.removed } : {}),
      ...(r.error ? { error: String(r.error.message || r.error) } : {}),
    })), null, 2));
    return results.every((r) => r.ok) ? 0 : 1;
  }

  for (const result of results) {
    if (!result.ok) { write(err(`${result.engine} — ${result.error?.message || result.error}`)); continue; }
    if (dryRun) {
      const diff = hookDiff(result.before, result.after);
      write(info(`${result.engine} — ${result.file} (dry run)`));
      write(diff.split("\n").some((l) => l.startsWith("+") || l.startsWith("-")) ? diff : ash("  nothing would change"));
      continue;
    }
    if (verb === "apply") {
      const added = result.changes.filter((c) => c.change === "added");
      const kept = result.changes.filter((c) => c.change === "kept");
      write(added.length
        ? ok(`${result.engine} — ${added.length} default${added.length === 1 ? "" : "s"} applied (${added.map((c) => c.label).join(", ")})`)
        : ok(`${result.engine} — already in place`));
      if (kept.length) write(info(`left as you set them: ${kept.map((c) => c.key).join(", ")}`));
      if (added.length) write(ash(`  ${result.file} — takes effect on the engine's next start`));
    } else {
      write(result.removed
        ? ok(`${result.engine} — ${result.removed} default${result.removed === 1 ? "" : "s"} removed`)
        : info(`${result.engine} — nothing of ours was in there.`));
    }
  }
  return results.every((r) => r.ok) ? 0 : 1;
}
