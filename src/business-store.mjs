// Where the business layer keeps its records.
//
// moshcode already knows what your agents are doing; the business layer is the
// half that knows *who it is for* and *what it costs*. That is two different
// kinds of file, so it is two files:
//
//   ~/.moshcode/business.json   clients, teams, rates, gateways, invoices
//   ~/.moshcode/timers.json     the running timer and the entries it has closed
//
// Split because they are written at different rates and for different reasons.
// business.json is configuration — edited by hand often enough that it has to
// stay readable, and small enough that rewriting it whole costs nothing.
// timers.json is a ledger that grows every time somebody stops a timer, and a
// half-written ledger must never be able to take the config down with it.
//
// Neither file is a secret store. A client's phone number lives here; a Stripe
// key does not — see src/payments.mjs for where those go instead. The files are
// still 0600, because a client list is nobody else's business on a shared box.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Current on-disk shape. Bumped only when a migration is actually needed. */
export const SCHEMA_VERSION = 1;

const EMPTY_BUSINESS = { version: SCHEMA_VERSION, clients: {}, teams: {}, rates: {}, payments: {}, invoices: {} };
const EMPTY_TIMERS = { version: SCHEMA_VERSION, active: null, entries: [] };

/**
 * The config directory, derived per call so tests can move $HOME.
 *
 * Deliberately not `MOSHCODE_HOME`: that variable already means the directory
 * moshcode is *installed* in — install.sh exports it and src/upgrade.mjs reads
 * it — so honouring it here would file a client list inside the package on any
 * machine that has it set. Same path src/aliases.mjs uses.
 */
export function moshcodeDir() {
  return path.join(os.homedir(), ".moshcode");
}

export function businessFile() {
  return process.env.MOSHCODE_BUSINESS_FILE || path.join(moshcodeDir(), "business.json");
}

export function timersFile() {
  return process.env.MOSHCODE_TIMERS_FILE || path.join(moshcodeDir(), "timers.json");
}

/**
 * Read a JSON file, or the given default.
 *
 * Every failure reads as "nothing recorded yet": missing, unreadable, truncated
 * by a crash mid-write, or hand-edited into something that is not an object.
 * These files are read on command paths a person is sitting in front of, and
 * throwing a SyntaxError at somebody who wanted `/timer status` tells them
 * nothing they can act on. `/client list` on an empty list does.
 */
function readJson(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch { return structuredClone(fallback); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return structuredClone(fallback); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return structuredClone(fallback);
  return { ...structuredClone(fallback), ...parsed };
}

/**
 * Write a JSON file atomically.
 *
 * Rename-over rather than write-in-place: two pits are a normal way to use
 * moshcode, and `/timer off` in one while `/client set` runs in the other must
 * not be able to leave either file half-written. The temp file is created in
 * the same directory so the rename stays on one filesystem.
 */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: FILE_MODE });
  fs.renameSync(tmp, file);
}

export function loadBusiness() {
  const data = readJson(businessFile(), EMPTY_BUSINESS);
  // A hand edit that empties one section must not make every reader defensive.
  for (const key of ["clients", "teams", "rates", "payments", "invoices"]) {
    if (!data[key] || typeof data[key] !== "object" || Array.isArray(data[key])) data[key] = {};
  }
  return data;
}

export function saveBusiness(data) {
  writeJson(businessFile(), { ...data, version: SCHEMA_VERSION });
  return data;
}

/** Read, mutate, write — the shape every business verb wants. Returns fn's result. */
export function updateBusiness(fn) {
  const data = loadBusiness();
  const result = fn(data);
  saveBusiness(data);
  return result;
}

export function loadTimers() {
  const data = readJson(timersFile(), EMPTY_TIMERS);
  if (!Array.isArray(data.entries)) data.entries = [];
  if (data.active && typeof data.active !== "object") data.active = null;
  return data;
}

export function saveTimers(data) {
  writeJson(timersFile(), { ...data, version: SCHEMA_VERSION });
  return data;
}

export function updateTimers(fn) {
  const data = loadTimers();
  const result = fn(data);
  saveTimers(data);
  return result;
}

/**
 * A stable handle for a name: "Acme Inc." → "acme-inc".
 *
 * Ids are derived rather than random because they are typed constantly —
 * `/timer on acme`, `/billing acme` — and a name is what a person remembers.
 * Collisions are the caller's problem to report; this only does the transform.
 */
export function slugify(name) {
  return String(name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Short, sortable, collision-resistant enough for a personal ledger.
 *
 * Time-prefixed so `/timer log` reads in order even after a hand edit, and so
 * an id carries a hint of when it was made. Not a UUID: these are meant to be
 * retyped (`/timer rm k3f9a2`).
 */
export function newId(prefix = "", now = Date.now()) {
  const stamp = now.toString(36);
  const noise = Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, "0");
  return `${prefix}${stamp.slice(-5)}${noise}`;
}
