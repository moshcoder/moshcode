// Named shortcuts for whatever you type at the mosh prompt.
//
// The pit is a prompt people sit at all day, and the things they retype are
// their own: `git status`, `pnpm -r test`, `/agents claude --resume`. Shell
// aliases can't help — the pit is not a shell, and `!git status` is exactly the
// keystrokes an alias is supposed to save. So the pit keeps its own.
//
// An alias is a name and a line. The line is a shell command unless it starts
// with `/`, in which case it is a pit command:
//
//   /alias set gs "git status"       → /gs   runs `$SHELL -c "git status"`
//   /alias set cc "/agents claude"   → /cc   opens claude autonomously
//
// Shell-by-default because that is what the prompt is mostly asked for, and the
// leading slash is already how the pit spells its own verbs — so the rule reads
// the same way the rest of the pit does rather than being a new convention.
//
// Anything the pit can dispatch is fair game as a value, which is what keeps
// this from needing to grow a type: a bookmarklet or a URL becomes an alias the
// day the pit gets a verb that opens one, with no change here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Owner-only, and for the same reason ~/.moshcode_history is: values are
 * whatever was typed, and people alias commands that carry tokens. */
const FILE_MODE = 0o600;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A value long enough to be a pasted mistake rather than a command. */
const MAX_VALUE = 4096;

/**
 * How many times one line may expand before the pit gives up.
 *
 * Aliases can name aliases (`/alias set st "/gs --short"`), which is useful and
 * also the one way to write a loop: two aliases naming each other would spin
 * the dispatch loop forever. Ten is far past any chain a person builds on
 * purpose.
 */
export const MAX_EXPANSIONS = 10;

/** Where the aliases live. Derived per call so tests can move $HOME. */
export function aliasFile() {
  return path.join(os.homedir(), ".moshcode", "aliases.json");
}

/**
 * Every alias, as a plain name → line map.
 *
 * A file that is missing, unreadable, or not the shape we wrote reads as "no
 * aliases" rather than throwing: this is called on the dispatch path for every
 * unrecognised command, and a hand-edited file with a stray comma must not take
 * the prompt down with it. Entries whose value is not a string are dropped for
 * the same reason.
 */
export function loadAliases() {
  let raw;
  try { raw = fs.readFileSync(aliasFile(), "utf8"); }
  catch { return {}; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return {}; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value.trim()) out[name.toLowerCase()] = value;
  }
  return out;
}

/** Write the map back, creating ~/.moshcode if this is the first alias. */
function saveAliases(aliases) {
  const file = aliasFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Sorted so the file reads like a list rather than like insertion order, and
  // so hand edits produce a small diff.
  const ordered = Object.fromEntries(Object.keys(aliases).sort().map((k) => [k, aliases[k]]));
  fs.writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`, { mode: FILE_MODE });
  // `mode` only applies at creation, so an existing file keeps whatever the
  // umask gave it. Tighten every write, the way the history file does.
  try { fs.chmodSync(file, FILE_MODE); } catch { /* best effort */ }
}

/** The name as it is stored, or "" for anything that cannot be one. */
export function normalizeName(name) {
  const clean = String(name ?? "").trim().toLowerCase().replace(/^\//, "");
  return NAME_RE.test(clean) ? clean : "";
}

/** One alias's line, or null. */
export function getAlias(name) {
  const key = normalizeName(name);
  if (!key) return null;
  const aliases = loadAliases();
  return Object.hasOwn(aliases, key) ? aliases[key] : null;
}

/**
 * Define an alias. Returns { ok, error, name, value, previous }.
 *
 * `isReserved` asks the pit whether a name is already its own — a command, an
 * engine, a tool. A predicate rather than a list because the dispatcher decides
 * that by resolving, aliases included, and a list copied out of the rosters
 * here would be a second answer that drifts from the first. A colliding name is
 * refused rather than shadowed: built-ins are checked first, so an alias named
 * `agents` would be silently dead, and a shortcut that does nothing is worse
 * than one that was never accepted.
 */
export function setAlias(name, value, { isReserved = () => false } = {}) {
  const key = normalizeName(name);
  if (!key) {
    return { ok: false, error: `"${name}" isn't a usable alias name — letters, digits, . _ - and it must start with a letter or digit` };
  }
  if (isReserved(key)) {
    return { ok: false, error: `/${key} is already a pit command, engine, or tool — pick another name` };
  }
  const line = String(value ?? "").trim();
  if (!line) return { ok: false, error: "an alias needs something to run" };
  if (line.includes("\n")) return { ok: false, error: "an alias is a single line" };
  if (line.length > MAX_VALUE) return { ok: false, error: `that value is ${line.length} characters — the cap is ${MAX_VALUE}` };

  const aliases = loadAliases();
  const previous = Object.hasOwn(aliases, key) ? aliases[key] : null;
  aliases[key] = line;
  try { saveAliases(aliases); }
  catch (e) { return { ok: false, error: `can't write ${aliasFile()}: ${e.message}` }; }
  return { ok: true, name: key, value: line, previous };
}

/** Forget one. Returns { ok, error, name, value }. */
export function removeAlias(name) {
  const key = normalizeName(name);
  const aliases = loadAliases();
  if (!key || !Object.hasOwn(aliases, key)) {
    return { ok: false, error: `no alias named "${String(name ?? "").replace(/^\//, "")}"` };
  }
  const value = aliases[key];
  delete aliases[key];
  try { saveAliases(aliases); }
  catch (e) { return { ok: false, error: `can't write ${aliasFile()}: ${e.message}` }; }
  return { ok: true, name: key, value };
}

/**
 * The line an alias becomes, with anything else the user typed appended.
 *
 * Appended rather than substituted, the way a shell alias behaves: `/gs -sb` is
 * `git status -sb`. `args` is the raw remainder of the typed line, not the
 * tokenized parts, so the user's own quoting survives into `$SHELL -c`.
 *
 * The `!` is what routes a bare value to the shell — the pit already reads a
 * leading `!` as "run this in $SHELL", so an alias does not need a second path
 * through it.
 */
export function expandAlias(value, args = "") {
  const line = `${String(value).trim()}${args ? ` ${args}` : ""}`;
  return /^[/!]/.test(line) ? line : `!${line}`;
}
