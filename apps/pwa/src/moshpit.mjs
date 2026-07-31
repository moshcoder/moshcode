// The Moshpit TLD namespace -- `.moshpit`, `.eggs`, `.whatever`.
//
// Anyone can claim a TLD nobody holds; the operator of that TLD then owns
// everything under it. Ownership hangs off `users`, the same account
// `moshcode login` establishes.
//
// On authority: the `moshpit_tlds` row is a cache. `moshpit_tld_log` is the
// record. Allocating a unique name is an ordering problem, and ordering is what
// the log provides -- so the directory can be mirrored and served by anyone
// without a mirror being able to forge or seize a name, because the order is
// checkable rather than trusted.

import { get, all, run } from "./db.mjs";
import { normalizeTld, parseMoshpitName, tldRejection } from "./lib/moshpit-name.mjs";

export {
  RESERVED_TLDS, RESOLVE_MODES, normalizeTld, parseMoshpitName, tldRejection,
  normalizeMode, resolutionPreference,
} from "./lib/moshpit-name.mjs";

const COLS = `tld, user_id, owner_email, alias_of, created_at`;

export async function getTld(tld) {
  return get(`SELECT ${COLS} FROM moshpit_tlds WHERE tld = ?`, [tld]);
}

export async function listTlds(limit = 200) {
  return all(`SELECT ${COLS} FROM moshpit_tlds ORDER BY created_at DESC LIMIT ?`, [limit]);
}

export async function listTldsForUser(userId) {
  return all(`SELECT ${COLS} FROM moshpit_tlds WHERE user_id = ? ORDER BY created_at DESC`, [userId]);
}

/**
 * Claim a TLD. First writer wins.
 *
 * The PRIMARY KEY on `tld` is what actually decides a race -- checking "is it
 * free?" and then inserting would let two simultaneous claims both pass the
 * check. So the insert is the check, and a constraint violation is read as
 * "someone got there first" rather than as an error.
 *
 * `allowReserved` registers a name on the reserved list. Only for assigning one
 * of our own names to us; it is never reachable from the HTTP API, because the
 * reserved list exists precisely to stop that route.
 */
export async function registerTld({ tld: input, userId, ownerEmail = null, ownerKey = null, allowReserved = false }) {
  const tld = normalizeTld(input);
  if (!tld) return { ok: false, error: "not a valid TLD — letters, digits and dashes only, no dots" };

  const rejected = tldRejection(tld);
  if (rejected && !allowReserved) return { ok: false, error: rejected };

  try {
    await run(
      `INSERT INTO moshpit_tlds (tld, user_id, owner_email, owner_key, created_at) VALUES (?,?,?,?,?)`,
      [tld, userId, ownerEmail, ownerKey, Date.now()],
    );
  } catch {
    const existing = await getTld(tld);
    if (existing) return { ok: false, error: `.${tld} is already registered`, taken: true };
    return { ok: false, error: "could not register that TLD" };
  }

  // Written after the row lands, so the log never claims an allocation that did
  // not happen.
  await logAction(tld, userId, "register");

  const created = await getTld(tld);
  return created ? { ok: true, tld: created } : { ok: false, error: "registered but could not be read back" };
}

const logAction = (tld, userId, action) =>
  run(`INSERT INTO moshpit_tld_log (tld, user_id, action, at) VALUES (?,?,?,?)`, [tld, userId, action, Date.now()]);

/** The append-only allocation log -- the answer to "who claimed it first". */
export async function tldLog(limit = 500) {
  return all(`SELECT seq, tld, user_id, action, at FROM moshpit_tld_log ORDER BY seq ASC LIMIT ?`, [limit]);
}

/* ---- aliases ---- */

/**
 * Point one TLD at another: `.agentic` -> `.agent`, so `foo.agentic` resolves
 * to `foo.agent`.
 *
 * Both must be held by the same user. Aliasing a name you do not own would turn
 * this into a land-grab -- claim `.agent`, then absorb forty related words
 * without registering any of them -- and first-come-first-served would stop
 * meaning anything.
 *
 * Chains are rejected rather than followed. A TLD is either a target or an
 * alias, never both, which makes resolution a single hop and makes a cycle
 * impossible to construct in the first place, instead of something to detect at
 * read time forever after.
 */
export async function setAlias({ from: fromInput, to: toInput, userId }) {
  const from = normalizeTld(fromInput);
  const to = normalizeTld(toInput);
  if (!from || !to) return { ok: false, error: "not a valid TLD" };
  if (from === to) return { ok: false, error: "a TLD cannot point at itself" };

  const [source, target] = await Promise.all([getTld(from), getTld(to)]);
  if (!source) return { ok: false, error: `.${from} is not registered` };
  if (!target) return { ok: false, error: `.${to} is not registered` };
  if (source.user_id !== userId) return { ok: false, error: `you do not own .${from}` };
  if (target.user_id !== userId) return { ok: false, error: `you do not own .${to}` };
  if (target.alias_of) {
    return { ok: false, error: `.${to} already points at .${target.alias_of} — point at the destination instead` };
  }

  const pointedHere = await get(`SELECT tld FROM moshpit_tlds WHERE alias_of = ? LIMIT 1`, [from]);
  if (pointedHere) {
    return { ok: false, error: `.${pointedHere.tld} already points at .${from}, so it cannot point elsewhere itself` };
  }

  await run(`UPDATE moshpit_tlds SET alias_of = ? WHERE tld = ?`, [to, from]);
  await logAction(from, userId, `alias:${to}`);
  return { ok: true };
}

/** Stop pointing `.from` anywhere. */
export async function clearAlias(fromInput, userId) {
  const tld = normalizeTld(fromInput);
  if (!tld) return { ok: false, error: "not a valid TLD" };
  const existing = await getTld(tld);
  if (!existing) return { ok: false, error: `.${tld} is not registered` };
  if (existing.user_id !== userId) return { ok: false, error: `you do not own .${tld}` };

  await run(`UPDATE moshpit_tlds SET alias_of = NULL WHERE tld = ?`, [tld]);
  await logAction(tld, userId, "unalias");
  return { ok: true };
}

/* ---- exemptions ---- */

/** Is this name held back from its TLD's alias? */
export async function isExempt(tld, label) {
  const row = await get(`SELECT 1 AS hit FROM moshpit_alias_exempt WHERE tld = ? AND label = ? LIMIT 1`, [tld, label]);
  return Boolean(row);
}

export async function listExempt(tld) {
  const rows = await all(`SELECT label FROM moshpit_alias_exempt WHERE tld = ? ORDER BY label`, [tld]);
  return rows.map((r) => String(r.label));
}

/**
 * Hold `label.tld` back from `.tld`'s alias, so it keeps resolving to itself.
 *
 * Allowed even when no alias is set yet: an operator should be able to carve
 * out the names they intend to keep BEFORE pointing the TLD somewhere, rather
 * than having to redirect everyone first and repair it afterwards.
 */
export async function setExempt({ tld: tldInput, label: labelInput, userId }) {
  const owned = await ownedTldAndLabel(tldInput, labelInput, userId);
  if (!owned.ok) return owned;

  await run(`INSERT OR IGNORE INTO moshpit_alias_exempt (tld, label, user_id, created_at) VALUES (?,?,?,?)`,
    [owned.tld, owned.label, userId, Date.now()]);
  await logAction(owned.tld, userId, `exempt:${owned.label}`);
  return { ok: true };
}

/** Let `label.tld` follow the alias again. */
export async function clearExempt({ tld: tldInput, label: labelInput, userId }) {
  const owned = await ownedTldAndLabel(tldInput, labelInput, userId);
  if (!owned.ok) return owned;

  await run(`DELETE FROM moshpit_alias_exempt WHERE tld = ? AND label = ?`, [owned.tld, owned.label]);
  await logAction(owned.tld, userId, `unexempt:${owned.label}`);
  return { ok: true };
}

async function ownedTldAndLabel(tldInput, labelInput, userId) {
  const tld = normalizeTld(tldInput);
  const label = normalizeTld(labelInput);
  if (!tld || !label) return { ok: false, error: "not a valid name" };
  const owner = await getTld(tld);
  if (!owner) return { ok: false, error: `.${tld} is not registered` };
  if (owner.user_id !== userId) return { ok: false, error: `you do not own .${tld}` };
  return { ok: true, tld, label };
}

/* ---- resolution ---- */

/**
 * Resolve `foo.agentic` to `foo.agent`.
 *
 * The label is carried across rather than dropped: an alias redirects the
 * namespace, not the name. `.agentic` pointing at `.agent` means every name
 * under it keeps its own identity on the other side.
 */
export async function resolveMoshpitName(input) {
  const parsed = parseMoshpitName(input);
  if (!parsed) return null;
  const { label, tld } = parsed;
  const name = `${label}.${tld}`;

  const owner = await getTld(tld);
  if (!owner) return { name, resolved: name, aliased: false, registered: false };
  if (!owner.alias_of) return { name, resolved: name, aliased: false, registered: true };

  // An exempt name outranks the alias. Checked here rather than at write time
  // because the exemption has to survive the alias being repointed later.
  if (await isExempt(tld, label)) {
    return { name, resolved: name, aliased: false, registered: true, exempt: true };
  }

  return { name, resolved: `${label}.${owner.alias_of}`, aliased: true, registered: true };
}
