// Cloud sync for the pit's own settings — `/save` and `/load`.
//
// The pit accumulates configuration the way a shell rc does: aliases you built
// up over months, herd rules you tuned for your agents. All of it lives under
// ~/.moshcode on one machine, which means a new laptop, a fresh container, or a
// reinstall starts from nothing and the pit feels like someone else's.
//
// `/save` pushes that configuration to your app.moshcode.sh account and `/load`
// brings it back down. Two verbs rather than a background daemon: settings are
// edited by a person, at a moment they can name, and a sync that runs on its own
// is a sync that overwrites something you meant to keep at a moment you can't.
//
// Three rules the rest of this file exists to enforce:
//
//   1. An allowlist, never a directory walk. ~/.moshcode also holds
//      credentials.json — the API token this very feature authenticates with —
//      plus live herd state and a package cache. A walk that gains a file gains
//      it silently; an allowlist has to be edited on purpose, in a diff someone
//      reviews. NEVER_SYNCED is asserted on top of it so the review can't slip.
//   2. The allowlist is checked again on the way *in*. The response is data from
//      the network, and a path in it is a path this process would write: without
//      the second check a bad snapshot spells `../../.ssh/authorized_keys` and
//      `/load` is a remote write primitive.
//   3. A revision, and refusal. Two machines both saving means one of them
//      loses; the pit says so and asks, rather than picking for you.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCreds } from "./auth.mjs";
import { engineStatus } from "./engines.mjs";
import { toolStatus } from "./tools.mjs";
import { ash, moshcodeVersion } from "./ui.mjs";

/** The snapshot shape this build writes and is willing to read. */
export const SNAPSHOT_VERSION = 1;

/** Owner-only, like everything else moshcode keeps under ~/.moshcode. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * One file at a time, and the whole snapshot. Generous for configuration —
 * aliases.json is a few hundred bytes — and small enough that a stray heredoc
 * pasted into a config file can't push a megabyte into your account, or arrive
 * from it.
 */
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024;

/**
 * What syncs, keyed by its path relative to ~/.moshcode.
 *
 * `json: true` means the file is parsed before it is sent and again before it is
 * written. A settings sync that faithfully copies a broken aliases.json to every
 * machine you own has taken one dead prompt and made it four.
 */
export const SYNCED_FILES = [
  { path: "aliases.json", json: true, label: "pit aliases" },
  { path: "herd/rules.json", json: true, label: "herd state rules" },
];

/**
 * Paths that must never appear in a snapshot, whichever direction it is moving.
 *
 * Redundant with the allowlist today, and deliberately so: this is the assertion
 * that survives someone adding a convenient-looking entry above. `credentials.json`
 * is the account token — syncing it to the account would hand every machine that
 * ran `/load` a credential it was never issued. `herd/sessions.json` is live
 * state pinned to one tmux server, `pkg/` is a binary cache, and `*.sock` /
 * `*.pid` describe processes on exactly one box.
 */
export const NEVER_SYNCED = [
  "credentials.json",
  "sync.json",
  "herd/sessions.json",
  "herd/hook.json",
];

/** True for a path this build is willing to read or write. */
export function isSyncable(relative) {
  const name = String(relative ?? "");
  if (NEVER_SYNCED.includes(name)) return false;
  if (name.startsWith("pkg/")) return false;
  return SYNCED_FILES.some((f) => f.path === name);
}

export function moshcodeDir(home = os.homedir()) {
  return path.join(home, ".moshcode");
}

/**
 * Where the last sync is remembered: the revision we agreed with the server and
 * the digest of the files as they were at that moment.
 *
 * That digest is the whole mechanism behind "you have local changes". Without it
 * `/load` can tell that local and remote differ but not *why* — and "differ" is
 * both "someone else saved from another machine" and "you edited this file five
 * minutes ago", which want opposite answers.
 */
export function markerPath(home = os.homedir()) {
  return path.join(moshcodeDir(home), "sync.json");
}

export function loadMarker(home = os.homedir()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath(home), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch { return null; }
}

export function saveMarker(marker, home = os.homedir()) {
  const file = markerPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  fs.writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`, { mode: FILE_MODE });
  try { fs.chmodSync(file, FILE_MODE); } catch { /* best effort */ }
}

/**
 * The digest of a set of files, over their names and contents.
 *
 * Canonical by construction — names sorted, every field framed by a NUL and
 * preceded by its byte length — so the same files digest the same on every
 * machine regardless of the order they were read in, and no content can be
 * arranged to look like a different file list. NUL rather than a space because a
 * space appears in file contents and a NUL does not appear in text config at
 * all.
 *
 * The app computes the same digest over the same bytes
 * (apps/pwa/src/routes/settings-sync.mjs). Both sides pin the value for a fixed
 * input in their tests, because two implementations of one hash that quietly
 * disagree is a comparison that silently stops meaning anything.
 */
export function digestFiles(files) {
  const hash = crypto.createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    const content = String(files[name]?.content ?? "");
    hash.update(`${name}\0${Buffer.byteLength(content)}\0${content}\0`);
  }
  return hash.digest("hex");
}

/** Engines and tools this machine has, by name. Informational, never applied. */
function installedHere() {
  const names = (rows) => rows.filter((r) => r.installed).map((r) => r.key).sort();
  try {
    return { engines: names(engineStatus()), tools: names(toolStatus()) };
  } catch { return { engines: [], tools: [] }; }
}

/**
 * Read the local settings into a snapshot.
 *
 * Returns `{ snapshot, included, skipped }`. A file that is missing is simply
 * absent — most people have never written herd/rules.json — while one that is
 * present and unusable (too big, not the JSON it claims to be) is reported so
 * the reason is visible rather than looking like it synced.
 */
export function collectSnapshot({
  home = os.homedir(),
  hostname = os.hostname(),
  version = moshcodeVersion(),
  installed = installedHere(),
} = {}) {
  const dir = moshcodeDir(home);
  const files = {};
  const included = [];
  const skipped = [];
  let total = 0;

  for (const entry of SYNCED_FILES) {
    const file = path.join(dir, entry.path);
    let content;
    try { content = fs.readFileSync(file, "utf8"); }
    catch { continue; } // not here — nothing to say about it
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_FILE_BYTES) {
      skipped.push({ path: entry.path, reason: `${bytes} bytes — the cap is ${MAX_FILE_BYTES}` });
      continue;
    }
    if (entry.json) {
      try { JSON.parse(content); }
      catch { skipped.push({ path: entry.path, reason: "not valid JSON — fix it locally first" }); continue; }
    }
    if (total + bytes > MAX_TOTAL_BYTES) {
      skipped.push({ path: entry.path, reason: "the snapshot is already at its size cap" });
      continue;
    }
    total += bytes;
    files[entry.path] = { content };
    included.push({ path: entry.path, bytes, label: entry.label });
  }

  const snapshot = {
    version: SNAPSHOT_VERSION,
    host: String(hostname || "").slice(0, 60) || null,
    moshcode: version || null,
    installed,
    files,
  };
  return { snapshot, included, skipped };
}

/**
 * Check a snapshot that came off the network before anything is written.
 *
 * Returns `{ ok, error, files, rejected }`. Rejection is per-file and reported
 * rather than fatal: a newer moshcode that syncs one more file must not make
 * `/load` unusable on this one, so an unknown name is dropped with its reason
 * and the files this build does understand still land.
 */
export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { ok: false, error: "the saved settings are not a snapshot", files: {}, rejected: [] };
  }
  if (Number(snapshot.version) > SNAPSHOT_VERSION) {
    return {
      ok: false,
      files: {},
      rejected: [],
      error: `these settings were saved by a newer moshcode (snapshot v${snapshot.version}) — run \`moshcode upgrade\` first`,
    };
  }
  const raw = snapshot.files;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "the snapshot carries no files", files: {}, rejected: [] };
  }

  const files = {};
  const rejected = [];
  let total = 0;
  for (const [name, value] of Object.entries(raw)) {
    // Every reason a name can be refused, in one place. `isSyncable` is the
    // allowlist; the checks around it catch the shapes that never reach it —
    // an absolute path, a traversal, a non-string body.
    if (typeof name !== "string" || !name || name !== path.posix.normalize(name)
        || path.posix.isAbsolute(name) || name.includes("..") || name.includes("\\")) {
      rejected.push({ path: String(name), reason: "not a settings path" });
      continue;
    }
    if (!isSyncable(name)) { rejected.push({ path: name, reason: "this moshcode does not sync that file" }); continue; }
    const content = value?.content;
    if (typeof content !== "string") { rejected.push({ path: name, reason: "no contents" }); continue; }
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_FILE_BYTES) { rejected.push({ path: name, reason: `${bytes} bytes — the cap is ${MAX_FILE_BYTES}` }); continue; }
    if (total + bytes > MAX_TOTAL_BYTES) { rejected.push({ path: name, reason: "past the snapshot size cap" }); continue; }
    const entry = SYNCED_FILES.find((f) => f.path === name);
    if (entry?.json) {
      try { JSON.parse(content); }
      catch { rejected.push({ path: name, reason: "not valid JSON — refusing to write it" }); continue; }
    }
    total += bytes;
    files[name] = { content };
  }
  return { ok: true, error: null, files, rejected };
}

/**
 * What `/load` would do, file by file: `new`, `changed` or `same`.
 *
 * Computed before anything is written so --dry-run and the real thing report the
 * same plan, and so "nothing to do" is an answer rather than four no-op writes.
 */
export function planApply(files, { home = os.homedir() } = {}) {
  const dir = moshcodeDir(home);
  return Object.keys(files).sort().map((name) => {
    let current = null;
    try { current = fs.readFileSync(path.join(dir, name), "utf8"); } catch { /* absent */ }
    const content = files[name].content;
    return {
      path: name,
      action: current === null ? "new" : current === content ? "same" : "changed",
      bytes: Buffer.byteLength(content),
    };
  });
}

/** Write the snapshot's files. Returns the plan, with `written` marked. */
export function applyFiles(files, { home = os.homedir() } = {}) {
  const dir = moshcodeDir(home);
  const plan = planApply(files, { home });
  for (const item of plan) {
    if (item.action === "same") continue;
    const file = path.join(dir, item.path);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
    // Written beside the target and renamed over it: a settings file truncated
    // by a full disk halfway through a write is a prompt that no longer starts.
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, files[item.path].content, { mode: FILE_MODE });
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, FILE_MODE); } catch { /* best effort */ }
    item.written = true;
  }
  return plan;
}

/**
 * Which local files have drifted from the last sync.
 *
 * Names, not a boolean, because that list is the message: "aliases.json changed
 * since you last saved" is actionable and "local and remote differ" is not.
 */
export function localDrift({ home = os.homedir() } = {}) {
  const marker = loadMarker(home);
  const { snapshot } = collectSnapshot({ home, installed: { engines: [], tools: [] } });
  const digest = digestFiles(snapshot.files);
  if (!marker?.digest) return { known: false, drifted: true, digest, files: Object.keys(snapshot.files).sort() };
  if (marker.digest === digest) return { known: true, drifted: false, digest, files: [] };
  const before = marker.files && typeof marker.files === "object" ? marker.files : null;
  const files = before
    ? [...new Set([...Object.keys(before), ...Object.keys(snapshot.files)])]
      .filter((name) => (before[name] ?? null) !== fileDigest(snapshot.files[name]))
      .sort()
    : Object.keys(snapshot.files).sort();
  return { known: true, drifted: true, digest, files };
}

/** Per-file digest, so the marker can name which file moved rather than just that one did. */
function fileDigest(entry) {
  if (!entry || typeof entry.content !== "string") return null;
  return crypto.createHash("sha256").update(entry.content).digest("hex");
}

/** The marker to write after a successful push or pull. */
export function markerFor({ revision, digest, files, host = os.hostname(), api }) {
  return {
    revision: Number(revision),
    digest,
    at: Date.now(),
    host: String(host || "").slice(0, 60) || null,
    api: api || null,
    files: Object.fromEntries(Object.keys(files).sort().map((name) => [name, fileDigest(files[name])])),
  };
}

/* ------------------------------------------------------------------ transport */

const DEFAULT_API = "https://app.moshcode.sh";

function endpoint(creds) {
  return (process.env.MOSHCODE_API || creds?.api || DEFAULT_API).replace(/\/+$/, "");
}

/**
 * A request against the settings API, with every failure turned into a value.
 *
 * `{ ok, status, body, error }`. The callers here print a line and set an exit
 * code; a thrown network error inside the pit's dispatch loop would take the
 * prompt down instead, which is a lost session over a dropped wifi connection.
 */
async function request(method, route, { creds, body = null, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${endpoint(creds)}${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${creds?.token}`,
      },
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON — reported as a status */ }
    return { ok: res.ok, status: res.status, body: parsed, error: null };
  } catch (e) {
    const aborted = e?.name === "AbortError";
    return { ok: false, status: 0, body: null, error: aborted ? "the app did not answer in time" : "could not reach the app" };
  } finally {
    clearTimeout(timer);
  }
}

export const pushSnapshot = (snapshot, { ifRevision = null, ...opts }) =>
  request("PUT", "/api/settings", { ...opts, body: { snapshot, ifRevision } });

export const pullSnapshot = (opts) => request("GET", "/api/settings", opts);

export const listRevisions = (opts) => request("GET", "/api/settings/revisions", opts);

/* ------------------------------------------------------------------- commands */

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function whenever(at) {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(at)) / 1000));
  if (!Number.isFinite(seconds)) return "at an unknown time";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** The flags both verbs share, plus whatever the caller adds. */
function parseFlags(argv, allowed) {
  const flags = new Set();
  const unknown = [];
  for (const arg of argv) {
    const name = String(arg);
    if (allowed.includes(name)) flags.add(name);
    else unknown.push(name);
  }
  return { flags, unknown };
}

const notLoggedIn = (write) => {
  write("not logged in — run `/login` (or `moshcode login`) first");
  write("   settings sync stores your configuration on your app.moshcode.sh account");
};

/**
 * `/save` — push the local settings to the account.
 *
 * Returns an exit code, the convention every other command module here uses, so
 * `moshcode save` in a script can be tested for having worked.
 */
export async function saveCommand(argv = [], {
  home = os.homedir(),
  creds = loadCreds(),
  fetchImpl = fetch,
  write = (line) => console.log(line),
  hostname = os.hostname(),
  version = moshcodeVersion(),
  installed = installedHere(),
} = {}) {
  const { flags, unknown } = parseFlags(argv, ["--dry-run", "--force", "--json"]);
  if (unknown.length) {
    write(`unknown option ${unknown[0]} — usage: save [--dry-run] [--force] [--json]`);
    return 1;
  }
  const json = flags.has("--json");
  const emit = (value) => { write(JSON.stringify(value, null, 2)); };

  const { snapshot, included, skipped } = collectSnapshot({ home, hostname, version, installed });
  const digest = digestFiles(snapshot.files);

  if (!included.length) {
    if (json) emit({ status: "nothing_to_save", files: [], skipped });
    else {
      write("nothing to save yet — the pit has no settings on this machine");
      write('   make one first: `/alias set gs "git status"`');
      for (const s of skipped) write(`   skipped ${s.path} — ${s.reason}`);
    }
    return 0;
  }

  if (!creds?.token) {
    if (json) emit({ status: "not_logged_in", files: included });
    else notLoggedIn(write);
    return 1;
  }

  const marker = loadMarker(home);
  if (flags.has("--dry-run")) {
    if (json) emit({ status: "dry_run", digest, revision: marker?.revision ?? null, files: included, skipped });
    else {
      write(`would save ${plural(included.length, "file")} to ${endpoint(creds)}:`);
      for (const f of included) write(`   ${f.path}  ${ash(`${f.bytes}b · ${f.label}`)}`);
      for (const s of skipped) write(`   skipped ${s.path} — ${s.reason}`);
    }
    return 0;
  }

  // "Nothing changed" is the account's answer, not this machine's guess. The app
  // recognises a byte-identical snapshot and hands back the revision it already
  // holds without inserting one, so an unchanged `/save` still costs no history —
  // and a machine whose local marker has gone stale (someone deleted the saved
  // settings from the web) finds out instead of insisting it is up to date.
  const res = await pushSnapshot(snapshot, {
    creds,
    fetchImpl,
    // The revision we last agreed on. The server refuses the write if it has
    // moved on, which is the whole conflict story: another machine saved, and
    // this push would erase it silently.
    ifRevision: flags.has("--force") ? null : (Number.isFinite(Number(marker?.revision)) ? Number(marker.revision) : null),
  });

  if (res.status === 409) {
    const theirs = res.body?.revision;
    if (json) emit({ status: "conflict", revision: theirs ?? null, mine: marker?.revision ?? null });
    else if (Number(theirs) === 0) {
      // Not a race: the account's saved settings were deleted (the web page's
      // "forget"), so there is nothing to lose and nothing to load.
      write(`the account has no saved settings — this machine last saw revision ${marker?.revision ?? "none"}`);
      write("   `/save --force` to save this machine's settings as the new revision 1");
    } else {
      write(`another machine saved first — the account is at revision ${theirs ?? "?"}, this one last saw ${marker?.revision ?? "none"}`);
      write("   `/load` to take theirs, or `/save --force` to overwrite it with this machine's settings");
    }
    return 1;
  }
  if (res.status === 401) {
    if (json) emit({ status: "expired" });
    else write("the app rejected this machine's credentials — run `/login` again");
    return 1;
  }
  if (!res.ok || !res.body?.revision) {
    if (json) emit({ status: "failed", error: res.error, http: res.status || null });
    else write(`could not save: ${res.error || `the app returned ${res.status}`}`);
    return 1;
  }

  saveMarker(markerFor({
    revision: res.body.revision,
    digest,
    files: snapshot.files,
    host: hostname,
    api: endpoint(creds),
  }), home);

  if (res.body.unchanged) {
    if (json) emit({ status: "unchanged", revision: res.body.revision, digest, files: included, skipped });
    else write(`already saved — revision ${res.body.revision} holds these exact files${res.body.savedAt ? `, from ${whenever(res.body.savedAt)}` : ""}`);
    return 0;
  }

  if (json) {
    emit({ status: "saved", revision: res.body.revision, digest, files: included, skipped });
    return 0;
  }
  write(`saved ${plural(included.length, "file")} to ${creds.email || "your account"} ${ash(`(revision ${res.body.revision})`)}`);
  for (const f of included) write(`   ${f.path}  ${ash(f.label)}`);
  for (const s of skipped) write(`   skipped ${s.path} — ${s.reason}`);
  write(ash("   on another machine: `/login` then `/load`"));
  return 0;
}

/** `/load` — bring the account's settings down onto this machine. */
export async function loadCommand(argv = [], {
  home = os.homedir(),
  creds = loadCreds(),
  fetchImpl = fetch,
  write = (line) => console.log(line),
  hostname = os.hostname(),
  installed = installedHere(),
} = {}) {
  const { flags, unknown } = parseFlags(argv, ["--dry-run", "--force", "--json"]);
  if (unknown.length) {
    write(`unknown option ${unknown[0]} — usage: load [--dry-run] [--force] [--json]`);
    return 1;
  }
  const json = flags.has("--json");
  const emit = (value) => { write(JSON.stringify(value, null, 2)); };

  if (!creds?.token) {
    if (json) emit({ status: "not_logged_in" });
    else notLoggedIn(write);
    return 1;
  }

  const res = await pullSnapshot({ creds, fetchImpl });
  if (res.status === 404) {
    if (json) emit({ status: "empty" });
    else {
      write("nothing saved to this account yet");
      write("   run `/save` on the machine whose settings you want, then `/load` here");
    }
    return 1;
  }
  if (res.status === 401) {
    if (json) emit({ status: "expired" });
    else write("the app rejected this machine's credentials — run `/login` again");
    return 1;
  }
  if (!res.ok) {
    if (json) emit({ status: "failed", error: res.error, http: res.status || null });
    else write(`could not load: ${res.error || `the app returned ${res.status}`}`);
    return 1;
  }

  const { ok: valid, error, files, rejected } = validateSnapshot(res.body?.snapshot);
  if (!valid) {
    if (json) emit({ status: "invalid", error });
    else write(`could not load: ${error}`);
    return 1;
  }
  const plan = planApply(files, { home });
  const changes = plan.filter((p) => p.action !== "same");
  const revision = res.body?.revision ?? null;
  const from = res.body?.snapshot?.host || res.body?.host || null;

  // Local edits that were never saved. Overwriting them is exactly what `/load`
  // is for on a fresh machine and exactly what it must not do on a working one,
  // and only the person at the prompt knows which this is.
  const drift = localDrift({ home });
  const clobbers = drift.drifted
    ? changes.filter((c) => c.action === "changed" && (!drift.known || drift.files.includes(c.path)))
    : [];
  if (clobbers.length && !flags.has("--force") && !flags.has("--dry-run")) {
    if (json) emit({ status: "local_changes", revision, files: clobbers.map((c) => c.path) });
    else {
      write(`${plural(clobbers.length, "local file")} changed since this machine last synced:`);
      for (const c of clobbers) write(`   ${c.path}`);
      write("   `/save` to keep them, `/load --force` to replace them, `/load --dry-run` to see the difference");
    }
    return 1;
  }

  if (flags.has("--dry-run")) {
    if (json) emit({ status: "dry_run", revision, from, plan, rejected });
    else {
      write(changes.length
        ? `revision ${revision} from ${from || "another machine"} would change ${plural(changes.length, "file")}:`
        : `revision ${revision} from ${from || "another machine"} matches this machine — nothing to do`);
      for (const item of plan) write(`   ${item.action.padEnd(8)} ${item.path}`);
      for (const r of rejected) write(`   ignored  ${r.path} — ${r.reason}`);
      if (clobbers.length) {
        write(`   ${plural(clobbers.length, "file")} would replace local changes — a plain \`/load\` will ask for --force`);
      }
    }
    return 0;
  }

  if (!changes.length) {
    // Still write the marker: the files match, so this machine *is* at that
    // revision, and recording it is what lets the next `/save` push without
    // being told it might be clobbering someone.
    saveMarker(markerFor({ revision, digest: digestFiles(files), files, host: hostname, api: endpoint(creds) }), home);
    if (json) emit({ status: "unchanged", revision, files: [] });
    else write(`already at revision ${revision} — nothing to change`);
    return 0;
  }

  let applied;
  try { applied = applyFiles(files, { home }); }
  catch (e) {
    if (json) emit({ status: "failed", error: String(e.message || e) });
    else write(`could not write the settings: ${String(e.message || e)}`);
    return 1;
  }

  saveMarker(markerFor({ revision, digest: digestFiles(files), files, host: hostname, api: endpoint(creds) }), home);

  const written = applied.filter((p) => p.written);
  if (json) {
    emit({ status: "loaded", revision, from, files: written.map((w) => w.path), rejected });
    return 0;
  }
  write(`loaded revision ${revision}${from ? ` from ${from}` : ""} — ${plural(written.length, "file")} written`);
  for (const item of written) write(`   ${item.action === "new" ? "added   " : "replaced"} ${item.path}`);
  for (const r of rejected) write(`   ignored  ${r.path} — ${r.reason}`);

  // Names only, and only the missing ones. The snapshot records what the source
  // machine had installed because that is most of what makes a pit feel like
  // yours — but installing an engine is a download and a shell script, so this
  // is a sentence, not an action.
  const theirs = res.body?.snapshot?.installed || {};
  const missing = [
    ...(theirs.engines || []).filter((n) => !(installed.engines || []).includes(n)),
    ...(theirs.tools || []).filter((n) => !(installed.tools || []).includes(n)),
  ];
  if (missing.length) {
    write(ash(`   that machine also had ${missing.join(", ")} — \`/install <name>\` to match it`));
  }
  return 0;
}
