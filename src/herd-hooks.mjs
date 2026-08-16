// Engine lifecycle hooks — the herd's tier-1 state, installed (PRD 0011 R1–R2).
//
// PRD 0009 built the mechanism and never plugged anything into it. `moshcode
// herd report` has existed since the herd did; it beats the screen, it is
// TTL-bounded, and on a default install nothing ever called it. So every
// session was classified by regex against a screen capture, and every engine
// release was a chance for the roster to start lying — a weakness
// src/herd-state.mjs documents about itself in its own header.
//
// This is the other end of that socket. `herd hooks install claude` writes
// Claude Code's own lifecycle hooks so the engine reports its state directly,
// and the roster starts reading `authority: hook`.
//
// THREE RULES, all of them about not being a bad guest in someone's config:
//
//   MERGE, NEVER CLOBBER. The file we write is the user's, and it is the file
//   their other hooks live in. Install extends it; remove takes out only the
//   entries whose command is ours, and leaves empty structure behind only when
//   it was already there.
//
//   A HOOK MUST NEVER BREAK AN ENGINE. The command is guarded so that outside a
//   herd session — no MOSHCODE_HERD_NAME — it does nothing and exits 0, and so
//   that a box without moshcode on PATH gets the same silence rather than a
//   failing hook on every turn. Degrading to today's screen rules is fine;
//   degrading below today is not.
//
//   THE SCREEN RULES STAY. A hook that a schema change quietly breaks falls back
//   to exactly what the herd did before it, which is why engines.mjs keeps its
//   `state` patterns alongside the new `hooks` spec rather than replacing them.
import fs from "node:fs";
import path from "node:path";

import { ENGINES } from "./engines.mjs";

/** Engines that ship a hook spec, in table order. */
export function hookableEngines() {
  return Object.entries(ENGINES).filter(([, engine]) => engine.hooks).map(([key]) => key);
}

/**
 * The shell command one hook runs.
 *
 * Every clause is load-bearing:
 *   `[ -n "$MOSHCODE_HERD_NAME" ]` — outside the herd this hook is a no-op. The
 *      engine is used by hand far more often than it is used in a herd.
 *   `command -v moshcode` — a machine where moshcode was uninstalled must not
 *      get a failing hook on every turn of an engine that still works.
 *   `>/dev/null 2>&1` — a status report has nothing to say to the operator; its
 *      whole output belongs in the roster, not in the middle of a session.
 *   `; exit 0` — whatever happened above, the engine carries on.
 */
export function hookCommand(state) {
  return `[ -n "$MOSHCODE_HERD_NAME" ] && command -v moshcode >/dev/null 2>&1 `
    + `&& moshcode herd report "$MOSHCODE_HERD_NAME" ${state} >/dev/null 2>&1; exit 0`;
}

/**
 * Is this hook entry one of ours?
 *
 * Matched on the command text rather than on a marker field we invent, because
 * the file's schema belongs to the engine: an unknown key is something the
 * engine is entitled to reject, and a hook config it rejects is worse than no
 * hook at all. The command is a string we wrote, so it is a marker already.
 */
export function isOurs(entry) {
  return typeof entry?.command === "string" && /\bmoshcode herd report\b/.test(entry.command);
}

const HOOK_FILE_MODE = 0o600;

function readJsonFile(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return { ok: true, present: false, data: {} };
    return { ok: false, present: true, error };
  }
  if (!text.trim()) return { ok: true, present: true, data: {} };
  try { return { ok: true, present: true, data: JSON.parse(text) }; }
  catch (error) {
    // Refusing is the whole point. A settings file we cannot parse is one we
    // cannot merge into, and overwriting it would take every other hook, MCP
    // server and preference in it with us.
    return { ok: false, present: true, error: new Error(`${file} is not valid JSON (${error.message}) — fix it and re-run`) };
  }
}

function writeJsonFile(file, data, { mode = HOOK_FILE_MODE } = {}) {
  const body = `${JSON.stringify(data, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Write-then-rename: a crash mid-write on the engine's own settings file
  // would otherwise leave it truncated, which is the one failure that costs
  // more than the feature is worth.
  const tmp = `${file}.moshcode-${process.pid}`;
  fs.writeFileSync(tmp, body, { mode });
  fs.renameSync(tmp, file);
}

/** The mode an existing file already has, so an install does not tighten it. */
function existingMode(file) {
  try { return fs.statSync(file).mode & 0o777; }
  catch { return HOOK_FILE_MODE; }
}

/** Where this engine's hooks live, resolved now (specs hold a function). */
export function hookFile(engine) {
  const spec = ENGINES[engine]?.hooks;
  if (!spec) return null;
  return typeof spec.file === "function" ? spec.file() : spec.file;
}

// ---------------------------------------------------------------------------
// The claude-settings format
// ---------------------------------------------------------------------------
//
// { "hooks": { "<Event>": [ { "hooks": [ { "type": "command", "command": … } ] } ] } }
//
// The outer array is matcher groups. Stop, Notification and UserPromptSubmit
// take no matcher, so ours is a group of one hook with no matcher key — an
// empty `matcher` would be a claim about tool names for events that have none.

function ensureArray(object, key) {
  if (!Array.isArray(object[key])) object[key] = [];
  return object[key];
}

/**
 * Add (or refresh) our entry for one event. Returns what changed, so the caller
 * can tell "installed 3" from "already installed" without diffing twice.
 */
function mergeEvent(settings, event, command) {
  const hooks = (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks))
    ? settings.hooks
    : (settings.hooks = {});
  const groups = ensureArray(hooks, event);

  for (const group of groups) {
    const entries = Array.isArray(group?.hooks) ? group.hooks : null;
    if (!entries) continue;
    const at = entries.findIndex(isOurs);
    if (at < 0) continue;
    if (entries[at].command === command) return "unchanged";
    // Ours, but not the current text — an upgrade that changed the command, or
    // a hand-edit. Replacing beats appending a second copy that fires twice.
    entries[at] = { type: "command", command };
    return "updated";
  }
  groups.push({ hooks: [{ type: "command", command }] });
  return "added";
}

/** Take our entries back out, leaving structure we did not create alone. */
function pruneEvent(settings, event) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || !Array.isArray(hooks[event])) return 0;
  let removed = 0;
  const groups = [];
  for (const group of hooks[event]) {
    if (!Array.isArray(group?.hooks)) { groups.push(group); continue; }
    const before = group.hooks.length;
    const kept = group.hooks.filter((entry) => !isOurs(entry));
    removed += before - kept.length;
    // A group that held only our hook goes with it; one that held someone
    // else's stays, with theirs intact.
    if (!kept.length && before) continue;
    groups.push({ ...group, hooks: kept });
  }
  if (groups.length) hooks[event] = groups;
  else delete hooks[event];
  if (!Object.keys(hooks).length) delete settings.hooks;
  return removed;
}

/** What is installed for one engine right now. */
export function hooksStatus(engine, { file = hookFile(engine) } = {}) {
  const spec = ENGINES[engine]?.hooks;
  if (!spec) return { engine, supported: false, file: null, events: [] };
  const read = readJsonFile(file);
  if (!read.ok) {
    return { engine, supported: true, file, readable: false, error: String(read.error?.message || read.error), events: [] };
  }
  const settings = read.data || {};
  const events = spec.events.map(({ event, state, label }) => {
    const want = hookCommand(state);
    const groups = Array.isArray(settings.hooks?.[event]) ? settings.hooks[event] : [];
    const found = groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])).filter(isOurs);
    if (!found.length) return { event, label: label || event, state, installed: false };
    // "Installed, but not the command this version writes" is its own answer:
    // it is how a spec change after an upgrade shows up, and `install` fixes it.
    return { event, label: label || event, state, installed: true, current: found.some((h) => h.command === want) };
  });
  return {
    engine,
    supported: true,
    file,
    readable: true,
    present: read.present,
    installed: events.every((e) => e.installed && e.current),
    partial: events.some((e) => e.installed) && !events.every((e) => e.installed && e.current),
    events,
  };
}

/**
 * Write this engine's hooks. `dryRun` computes everything and writes nothing,
 * returning the file as it would have been so the caller can show a diff.
 */
export function installHooks(engine, { file = hookFile(engine), dryRun = false } = {}) {
  const spec = ENGINES[engine]?.hooks;
  if (!spec) {
    return { ok: false, engine, supported: false, error: new Error(`${engine} ships no hook spec — its sessions stay on the screen rules`) };
  }
  const read = readJsonFile(file);
  if (!read.ok) return { ok: false, engine, supported: true, file, error: read.error };

  const before = JSON.stringify(read.data ?? {}, null, 2);
  const settings = read.data ?? {};
  const changes = spec.events.map(({ event, state, label }) => ({ event, label: label || event, state, change: mergeEvent(settings, event, hookCommand(state)) }));
  const after = JSON.stringify(settings, null, 2);

  if (!dryRun) {
    try { writeJsonFile(file, settings, { mode: read.present ? existingMode(file) : HOOK_FILE_MODE }); }
    catch (error) { return { ok: false, engine, supported: true, file, error }; }
  }
  return {
    ok: true, engine, supported: true, file, dryRun,
    changes,
    written: changes.filter((c) => c.change !== "unchanged").length,
    before, after,
  };
}

/** Take them out again. Only ever removes commands this module wrote. */
export function removeHooks(engine, { file = hookFile(engine), dryRun = false } = {}) {
  const spec = ENGINES[engine]?.hooks;
  if (!spec) return { ok: false, engine, supported: false, error: new Error(`${engine} ships no hook spec`) };
  const read = readJsonFile(file);
  if (!read.ok) return { ok: false, engine, supported: true, file, error: read.error };
  if (!read.present) return { ok: true, engine, supported: true, file, removed: 0, dryRun };

  const settings = read.data ?? {};
  const before = JSON.stringify(settings, null, 2);
  let removed = 0;
  // Every event the spec knows about, plus any event that still carries one of
  // ours from an older spec — otherwise `remove` after an upgrade would leave
  // the hook the previous version installed firing forever.
  const events = new Set([
    ...spec.events.map((e) => e.event),
    ...Object.keys(settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}),
  ]);
  for (const event of events) removed += pruneEvent(settings, event);
  const after = JSON.stringify(settings, null, 2);

  if (!dryRun && removed) {
    try { writeJsonFile(file, settings, { mode: existingMode(file) }); }
    catch (error) { return { ok: false, engine, supported: true, file, error }; }
  }
  return { ok: true, engine, supported: true, file, removed, dryRun, before, after };
}

/**
 * A unified diff of the two JSON snapshots an install/remove produced.
 *
 * Hand-rolled and deliberately dumb — a line is context, an addition, or a
 * removal, decided by whether the other side has it at the same place. What
 * `--dry-run` needs is "show me what you are about to do to my settings file",
 * and for a JSON object printed at two-space indent that is what this gives.
 */
export function hookDiff(before = "", after = "") {
  const a = String(before).split("\n");
  const b = String(after).split("\n");
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; continue; }
    const laterInB = b.indexOf(a[i] ?? " ", j);
    const laterInA = a.indexOf(b[j] ?? " ", i);
    if (i >= a.length || (laterInB >= 0 && (laterInA < 0 || laterInB - j <= laterInA - i))) {
      out.push(`+ ${b[j]}`); j++;
    } else {
      out.push(`- ${a[i]}`); i++;
    }
  }
  return out.join("\n");
}
