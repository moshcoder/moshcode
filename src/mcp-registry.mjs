// What moshcode registered, so a NAME is enough to act on a server again.
//
// This file exists because of a gap the fan-out left behind. `mcp install`
// hands six engines a canonical spec and then forgets it, which is fine while
// the only verb is "register". The moment a verb takes a name there is nothing
// to resolve it against: test this one, list its resources, disable it, bring
// it back. Reading it back out of six config formats was the other
// option and it is the one prd/0003 explicitly rules out: moshcode drives each
// engine's own CLI and never parses or writes its config.
//
// So: ~/.moshcode/mcp.json, moshcode's own record of what moshcode did. Two
// things it is NOT, both worth saying out loud because the file looks like it
// might be either.
//
// It is not the source of truth. Each engine's config is. A server someone
// added with `claude mcp add` directly is real, works fine, and is not in here,
// which is why every name-addressed verb falls through to the catalog and to a
// bare URL before it gives up.
//
// It is not a credential store. A header value is a credential; it goes to the
// engines' own configs, which the user has already chosen to trust with it, and
// it never lands here. What this file keeps is the header NAME and, when the
// value came from the environment, the variable it came from. Enough to build
// the same request again, and nothing anyone can read a secret out of. Same rule
// src/mcp-catalog.mjs states for `env` and src/payments.mjs states for gateway
// keys. The file is still 0600, because the list of servers you talk to is
// nobody else's business on a shared box.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Current on-disk shape. Bumped only when a migration is actually needed. */
export const SCHEMA_VERSION = 1;

const EMPTY = { version: SCHEMA_VERSION, servers: {} };

/**
 * Where the record lives.
 *
 * Deliberately not under `MOSHCODE_HOME`: that variable means the directory
 * moshcode is *installed* in, so honouring it here would file a server list
 * inside the package. Same reasoning and same directory as src/aliases.mjs and
 * src/business-store.mjs. `MOSHCODE_MCP_FILE` moves it for tests.
 */
export function registryFile() {
  return process.env.MOSHCODE_MCP_FILE || path.join(os.homedir(), ".moshcode", "mcp.json");
}

/**
 * Read the record, or an empty one.
 *
 * Every failure reads as "nothing registered yet": missing, unreadable,
 * truncated by a crash mid-write, or hand-edited into something that is not an
 * object. These reads sit on command paths a person is waiting on, and a
 * SyntaxError thrown at somebody who typed `/mcp list` tells them nothing they
 * can act on, while an empty list does.
 */
export function loadRegistry() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(registryFile(), "utf8")); }
  catch { return structuredClone(EMPTY); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return structuredClone(EMPTY);
  const servers = parsed.servers && typeof parsed.servers === "object" && !Array.isArray(parsed.servers)
    ? parsed.servers
    : {};
  return { version: SCHEMA_VERSION, servers };
}

/**
 * Write it back atomically.
 *
 * Rename-over rather than write-in-place: two pits are a normal way to use
 * moshcode, and `/mcp disable a` in one while `/mcp install b` runs in the
 * other must not be able to leave the file half-written.
 */
function save(data) {
  const file = registryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: FILE_MODE });
  fs.renameSync(tmp, file);
}

/**
 * Strip a spec down to what is safe to keep.
 *
 * Headers become names. `Authorization: Bearer sk-live-…` is the single most
 * likely thing to be typed at this command and the single worst thing to write
 * to disk, so the value is dropped here rather than anywhere further out, where
 * a new call site could forget. `auth` records where a value came from when it
 * came from somewhere nameable (an environment variable), so `mcp test` can
 * rebuild the same request without ever having stored the secret.
 */
export function redactSpec(spec) {
  return {
    target: spec.target,
    args: [...(spec.args || [])],
    transport: spec.transport || null,
    // Environment PAIRS are values too. The names are the useful half and the
    // only half that is safe, exactly as the catalog already treats `env`.
    env: (spec.env || []).map(([key]) => key),
    headers: (spec.headers || []).map((h) => String(h).split(":")[0].trim()).filter(Boolean),
    ...(spec.auth ? { auth: { header: spec.auth.header, from: spec.auth.from } } : {}),
  };
}

/** Record a server moshcode just registered. Merges over any earlier entry. */
export function recordServer(name, spec, { engineScope = "user", engines = null } = {}) {
  const data = loadRegistry();
  const previous = data.servers[name] || {};
  data.servers[name] = {
    ...previous,
    ...redactSpec(spec),
    engineScope,
    engines,
    enabled: true,
    registeredAt: new Date().toISOString(),
  };
  save(data);
  return data.servers[name];
}

/** Forget a server entirely. Returns whether there was one. */
export function forgetServer(name) {
  const data = loadRegistry();
  if (!Object.hasOwn(data.servers, name)) return false;
  delete data.servers[name];
  save(data);
  return true;
}

/**
 * Mark a server enabled or disabled, keeping its spec either way.
 *
 * The spec surviving a disable is the whole point: `disable` deregisters the
 * server from every engine, and without a kept spec `enable` would have nothing
 * to register again and the word would be a one-way door.
 */
export function setServerEnabled(name, enabled) {
  const data = loadRegistry();
  const entry = data.servers[name];
  if (!entry) return null;
  entry.enabled = Boolean(enabled);
  entry.enabledAt = new Date().toISOString();
  save(data);
  return entry;
}

/** One server by name, or null. Own properties only. */
export function getServer(name) {
  if (!name) return null;
  const { servers } = loadRegistry();
  // `servers` comes from JSON.parse, so `constructor` and `__proto__` would
  // otherwise resolve to something off Object.prototype with no target.
  return Object.hasOwn(servers, name) ? { name, ...servers[name] } : null;
}

/** Every recorded server, name-sorted, for `/mcp list`. */
export function listServers() {
  const { servers } = loadRegistry();
  return Object.keys(servers).sort().map((name) => ({ name, ...servers[name] }));
}
