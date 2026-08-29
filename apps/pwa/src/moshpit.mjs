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

import { randomBytes } from "node:crypto";

import { config } from "./config.mjs";
import { db, get, all, run } from "./db.mjs";
import { normalizeFeedKind, normalizeFeedUrl } from "./lib/feed.mjs";
import {
  createGuardAlias,
  deleteGuardAlias,
  guardMailConfigured,
  updateGuardAlias,
} from "./lib/forwardemail.mjs";
import {
  CONTACT_VISIBILITY,
  DEFAULT_VISIBILITY,
  mintGuardToken,
  normalizeContactEmail,
  normalizeVisibility,
  publishedContact,
} from "./lib/moshpit-contact.mjs";
import { contentOut, MAX_ITEMS_PER_NAME, normalizeContent, normalizeSlug } from "./lib/moshpit-content.mjs";
import { normalizeTarget } from "./lib/moshpit-gateway.mjs";
import {
  MAX_LINKS_PER_USER,
  mintCode,
  normalizeCode,
  normalizeLinkUrl,
} from "./lib/moshpit-links.mjs";
import {
  BULK_CHUNK,
  BULK_TIME_BUDGET_MS,
  ENDING_PRICE_USD,
  MAX_BULK_TLDS,
  MAX_CHILD_PRICE_USD,
  normalizeLabel,
  normalizeTld,
  parseMoshpitName,
  parseTldList,
  tldRejection,
} from "./lib/moshpit-name.mjs";
import {
  effectiveTarget,
  normalizeRecord,
  normalizeRecordType,
  recordConflict,
} from "./lib/moshpit-records.mjs";
import {
  TWIN_UNLINK_LEAD_MS,
  clearnetTwins,
  moshpitNameForTwin,
  normalizeDomain,
  twinIsLive,
  twinProof,
  twinProofMatches,
  twinProofName,
} from "./lib/moshpit-twin.mjs";

export {
  RESERVED_TLDS, RESOLVE_MODES, MAX_BULK_TLDS, BULK_CHUNK, BULK_TIME_BUDGET_MS, shortCount, DEFAULT_TLD_PRICE_USD, MAX_CHILD_PRICE_USD, CHILD_PRICE_USD, ENDING_PRICE_USD, normalizeLabel, normalizeTld, parseMoshpitName,
  parseTldList, tldRejection, normalizeMode, resolutionPreference, STARTER_LABELS, suggestedLabels,
} from "./lib/moshpit-name.mjs";

export {
  DEFAULT_TTL, MAX_PRIORITY, MAX_TTL, MAX_TXT_BYTES, MIN_TTL, RECORD_HELP, RECORD_TYPES,
  effectiveTarget, isMoshpitTarget, normalizeRecord, normalizeRecordType, zoneLine,
} from "./lib/moshpit-records.mjs";

export {
  CONTENT_KINDS, MAX_GALLERY, MAX_ITEMS_PER_NAME, MAX_NAV, NAV_KINDS, POST_KINDS,
  navFor, normalizeContent, normalizeSlug, postsFor,
} from "./lib/moshpit-content.mjs";

export {
  TWIN_PRICE_USD, TWIN_PROOF_HOST, TWIN_TLDS, TWIN_UNLINK_LEAD_MS,
  clearnetTwin, clearnetTwins, moshpitNameForTwin, normalizeDomain, normalizeTwinToken,
  parseTwinProof, twinIsLive, twinProof, twinProofMatches, twinProofName,
} from "./lib/moshpit-twin.mjs";

export {
  CONTACT_VISIBILITY, DEFAULT_VISIBILITY,
  guardAddress, isGuardToken, mintGuardToken, normalizeContactEmail, normalizeVisibility, publishedContact,
} from "./lib/moshpit-contact.mjs";

/**
 * The largest number this column will accept.
 *
 * Not a policy cap. What an ending's names cost is the operator's call -- the
 * defaults ($2 a name, $5 an ending) are a starting point, not a ceiling, and
 * an ending somebody wants seven figures for is their business. This exists
 * only so a fat finger or a hostile client cannot park Infinity, a NaN or 1e300
 * in a column that later gets charged.
 *
 * It replaced a $1,000,000 bound, which was low enough to be a policy decision
 * nobody had made.
 */
export const MAX_LISTING_PRICE_USD = 1_000_000_000;

const COLS = `tld, user_id, owner_email, alias_of, price_usd, created_at`;

export async function getTld(tld) {
  return get(`SELECT ${COLS} FROM moshpit_tlds WHERE tld = ?`, [tld]);
}

/**
 * The endings everyone holds, newest first.
 *
 * Ordered by `created_at DESC, tld` for the same reason `listTldsForUser` is: a
 * bulk claim writes one timestamp across every ending in it, so `created_at`
 * alone is not a total order. Without the tiebreak a page boundary landing
 * inside a batch shows one ending twice and skips another — which is invisible
 * until someone pages, and is why this could not simply be paged as it stood.
 */
export async function listTlds({ limit = 200, offset = 0 } = {}) {
  return all(
    `SELECT ${COLS} FROM moshpit_tlds ORDER BY created_at DESC, tld LIMIT ? OFFSET ?`,
    [limit, offset],
  );
}

/** How many endings exist -- so a caller can see there are more than it got. */
export async function countTlds() {
  const row = await get(`SELECT COUNT(*) AS n FROM moshpit_tlds`);
  return Number(row?.n ?? 0);
}

/**
 * The endings one account holds.
 *
 * `limit`/`offset` page it. They are optional because the JSON API hands the
 * whole list back and a list of strings costs nothing -- it is /pit that cannot
 * afford it, because every ending it draws brings a form per name with it.
 *
 * Ordered by `created_at DESC, tld` rather than `created_at DESC` alone. A bulk
 * claim writes one timestamp across every ending in it, so `created_at` is not
 * a total order, and a page boundary landing inside a tie would show the same
 * ending twice on one page and skip another entirely.
 */
export async function listTldsForUser(userId, { limit = null, offset = 0 } = {}) {
  const page = limit === null ? "" : ` LIMIT ? OFFSET ?`;
  const args = limit === null ? [userId] : [userId, limit, offset];
  return all(`SELECT ${COLS} FROM moshpit_tlds WHERE user_id = ? ORDER BY created_at DESC, tld${page}`, args);
}

/** How many endings the account holds -- for the pager, which needs the total. */
export async function countTldsForUser(userId) {
  const row = await get(`SELECT COUNT(*) AS n FROM moshpit_tlds WHERE user_id = ?`, [userId]);
  return Number(row?.n ?? 0);
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

/**
 * The append-only allocation log -- the answer to "who claimed it first".
 *
 * `since` is a seq and it is exclusive, because that is the only piece of state
 * a mirror actually has: the last entry it stored. "Everything after 41" is the
 * whole of the question, and answering it needs the server to remember nothing
 * about who is asking -- which is what makes the log mirrorable by anyone
 * rather than by whoever we have set up as a replica.
 *
 * Ordering is by seq and never by `at`. Two entries can share a millisecond,
 * and a reader that sorts on the clock would put them in a different order than
 * the writer did -- at which point two mirrors of the same log disagree about
 * who claimed a name first, which is the one thing this table exists to settle.
 */
export async function tldLog({ since = 0, limit = 500 } = {}) {
  const after = Number.isInteger(since) && since > 0 ? since : 0;
  return all(
    `SELECT seq, tld, user_id, action, at FROM moshpit_tld_log WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
    [after, limit],
  );
}

/** How many entries the log holds -- so a page of it can say that it is one. */
export async function countTldLog() {
  const row = await get(`SELECT COUNT(*) AS n FROM moshpit_tld_log`);
  return Number(row?.n ?? 0);
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
  const label = normalizeLabel(labelInput);
  if (!tld || !label) return { ok: false, error: "not a valid name" };
  const owner = await getTld(tld);
  if (!owner) return { ok: false, error: `.${tld} is not registered` };
  if (owner.user_id !== userId) return { ok: false, error: `you do not own .${tld}` };
  return { ok: true, tld, label };
}

/* ---- names under a TLD ---- */

const NAME_COLS = `tld, label, user_id, target, feed_url, feed_kind, created_at`;

export async function getName(tld, label) {
  return get(`SELECT ${NAME_COLS} FROM moshpit_names WHERE tld = ? AND label = ?`, [tld, label]);
}

export async function listNames(tld, limit = 500) {
  return all(`SELECT ${NAME_COLS} FROM moshpit_names WHERE tld = ? ORDER BY label LIMIT ?`, [tld, limit]);
}

/**
 * How many names live under an ending.
 *
 * /pit draws a handful of them per ending and has to say how many it is not
 * drawing -- "12 shown" with no total reads as "you have 12 names".
 */
export async function countNames(tld) {
  const row = await get(`SELECT COUNT(*) AS n FROM moshpit_names WHERE tld = ?`, [tld]);
  return Number(row?.n ?? 0);
}

/**
 * Every registered name, for the sitemap.
 *
 * Bounded because a sitemap has a hard 50k-URL ceiling and this has to stay one
 * file; past the limit the tail is dropped rather than paged, which is the
 * right trade while the namespace is far below it.
 */
export async function listAllNames(limit = 20_000) {
  return all(`SELECT tld, label FROM moshpit_names ORDER BY tld, label LIMIT ?`, [limit]);
}

/**
 * The labels people actually take, most-used first.
 *
 * What to suggest under an empty ending is a question the registry can already
 * answer better than a list written up front: `www` and `docs` earn their place
 * by being taken under other endings, not by someone guessing they would be.
 *
 * Counted across every ending rather than near-by ones, because the signal is
 * "this is what a name is for", which does not vary by ending — and an ending
 * with neighbours worth copying is exactly the one that has names already.
 */
export async function popularLabels(limit = 40) {
  const rows = await all(
    `SELECT label, COUNT(*) AS uses FROM moshpit_names GROUP BY label ORDER BY uses DESC, label LIMIT ?`,
    [limit],
  );
  return rows.map((r) => r.label);
}

export async function listNamesForUser(userId) {
  return all(`SELECT ${NAME_COLS} FROM moshpit_names WHERE user_id = ? ORDER BY tld, label`, [userId]);
}

/**
 * Register `label.tld`.
 *
 * Only the TLD's operator may do this. Holding `.eggs` is what buys you the
 * namespace under it -- if anyone could mint `blue.eggs`, owning the TLD would
 * mean nothing, and the "sell anything.yourthing" model would have no seller.
 * Opening a TLD up to public registration is a per-TLD decision that belongs to
 * its operator, so it is a future flag on the TLD rather than the default here.
 *
 * Registration is on the TLD as written, not on what it aliases to. A name has
 * to live somewhere definite; minting it through an alias would silently create
 * it under a different TLD than the one asked for, and repointing the alias
 * later would strand it.
 */
export async function registerName({ tld: tldInput, label: labelInput, userId, target = null, feed = null, feedKind = null }) {
  const tld = normalizeTld(tldInput);
  const label = normalizeLabel(labelInput);
  if (!tld || !label) return { ok: false, error: "not a valid name — letters, digits and dashes only" };

  const owner = await getTld(tld);
  if (!owner) return { ok: false, error: `.${tld} is not registered` };
  if (owner.user_id !== userId) return { ok: false, error: `you do not own .${tld}` };

  // Checked on the way in, not only on the way out. A target that fails is a
  // name that looks minted and serves nothing, and the owner finds out from a
  // visitor rather than from the form they typed it into.
  const dest = normalizeTarget(target);
  if (!dest.ok) return { ok: false, error: dest.error };

  // Same reasoning as the target, one field over: a feed URL that will never
  // parse is a name that looks like a site and shows an error to everyone who
  // visits it. Rejected at the form, not discovered by a reader.
  const stream = normalizeFeedUrl(feed);
  if (!stream.ok) return { ok: false, error: stream.error };
  const layout = normalizeFeedKind(feedKind);
  if (!layout.ok) return { ok: false, error: layout.error };

  try {
    await run(
      `INSERT INTO moshpit_names (tld, label, user_id, target, feed_url, feed_kind, created_at) VALUES (?,?,?,?,?,?,?)`,
      [tld, label, userId, dest.target, stream.feed, layout.kind, Date.now()],
    );
  } catch {
    const existing = await getName(tld, label);
    if (existing) return { ok: false, error: `${label}.${tld} is already registered`, taken: true };
    return { ok: false, error: "could not register that name" };
  }

  await logAction(tld, userId, `name:${label}`);
  return { ok: true, name: await getName(tld, label) };
}

/** Point an existing name somewhere else. */
export async function setNameTarget({ tld: tldInput, label: labelInput, userId, target }) {
  const owned = await ownedName(tldInput, labelInput, userId);
  if (!owned.ok) return owned;
  const dest = normalizeTarget(target);
  if (!dest.ok) return { ok: false, error: dest.error };
  await run(`UPDATE moshpit_names SET target = ? WHERE tld = ? AND label = ?`,
    [dest.target, owned.tld, owned.label]);
  await logAction(owned.tld, userId, `retarget:${owned.label}`);
  return { ok: true };
}

/**
 * Point a name at a feed, or take the feed off it.
 *
 * Separate from setNameTarget rather than another argument on it, because the
 * two answer different questions and owners set them at different times: a
 * target is "I run a server", a feed is "I publish somewhere else". A name may
 * carry both, and which one a visitor gets is decided at read time by /n/ —
 * the server wins, because an owner who has stood one up did not do it so we
 * could show them a feed instead.
 *
 * An empty feed clears the row's feed and its layout together. Leaving a
 * `feed_kind` behind on a name with no feed is a setting for a page that no
 * longer exists, and it would silently apply to whatever feed came next.
 */
export async function setNameFeed({ tld: tldInput, label: labelInput, userId, feed, kind = null }) {
  const owned = await ownedName(tldInput, labelInput, userId);
  if (!owned.ok) return owned;

  const stream = normalizeFeedUrl(feed);
  if (!stream.ok) return { ok: false, error: stream.error };
  const layout = normalizeFeedKind(kind);
  if (!layout.ok) return { ok: false, error: layout.error };

  await run(`UPDATE moshpit_names SET feed_url = ?, feed_kind = ? WHERE tld = ? AND label = ?`,
    [stream.feed, stream.feed ? layout.kind : null, owned.tld, owned.label]);
  await logAction(owned.tld, userId, `${stream.feed ? "feed" : "unfeed"}:${owned.label}`);
  return { ok: true, feed: stream.feed, kind: stream.feed ? layout.kind : null };
}

/** Give the name back. */
export async function releaseName({ tld: tldInput, label: labelInput, userId }) {
  const owned = await ownedName(tldInput, labelInput, userId);
  if (!owned.ok) return owned;
  // Keys go with the name. Deleted explicitly rather than left to the foreign
  // key, because SQLite only enforces those with `PRAGMA foreign_keys = ON`
  // and nothing here sets it — so a cascade that looks declared would not fire,
  // and whoever registered the name next would inherit the previous holder's
  // published keys.
  await run(`DELETE FROM moshpit_name_pins WHERE tld = ? AND label = ?`, [owned.tld, owned.label]);
  // Records go with the name for the same reason, and it matters more: an
  // inherited MX would route the next holder's mail to the last one's server.
  await run(`DELETE FROM moshpit_records WHERE tld = ? AND label = ?`, [owned.tld, owned.label]);
  // And the twin, which matters most of the three. It names a domain the
  // departing holder registered and still controls, so inheriting one would
  // point the next holder's visitors at a stranger's website under their own
  // name — and hand that stranger a proof record they can revoke at will.
  await run(`DELETE FROM moshpit_twins WHERE tld = ? AND label = ?`, [owned.tld, owned.label]);
  // And the contact, which is the one with a live consequence outside this
  // database. Its guard address forwards mail at our domain to the person
  // giving the name up; inheriting it would deliver the next holder's mail --
  // an offer for the name, an abuse report about it -- to the last one. The
  // alias is torn down at the mail host first, because deleting only the row
  // would leave that forwarding in place with nothing left that knows how to
  // stop it.
  await revokeContactAlias(await getContactPrivate(owned.tld, owned.label));
  await run(`DELETE FROM moshpit_contacts WHERE tld = ? AND label = ?`, [owned.tld, owned.label]);
  await run(`DELETE FROM moshpit_names WHERE tld = ? AND label = ?`, [owned.tld, owned.label]);
  await logAction(owned.tld, userId, `unname:${owned.label}`);
  return { ok: true };
}

async function ownedName(tldInput, labelInput, userId) {
  const tld = normalizeTld(tldInput);
  const label = normalizeLabel(labelInput);
  if (!tld || !label) return { ok: false, error: "not a valid name" };
  const existing = await getName(tld, label);
  if (!existing) return { ok: false, error: `${label}.${tld} is not registered` };
  if (existing.user_id !== userId) return { ok: false, error: `you do not own ${label}.${tld}` };
  return { ok: true, tld, label };
}

/* ---- selling names under a TLD ---- */

/**
 * Put a TLD up for sale, or take it down (`null`).
 *
 * Minting under someone's namespace without their say-so is exactly what the
 * registry exists to prevent, so being open for business is an explicit act by
 * the operator rather than a default. A price of null means closed, and every
 * TLD that existed before this feature starts there.
 */
export async function setTldPrice({ tld: tldInput, userId, priceUsd }) {
  const tld = normalizeTld(tldInput);
  if (!tld) return { ok: false, error: "not a valid TLD" };
  const owner = await getTld(tld);
  if (!owner) return { ok: false, error: `.${tld} is not registered` };
  if (owner.user_id !== userId) return { ok: false, error: `you do not own .${tld}` };

  let price = null;
  if (priceUsd !== null && priceUsd !== undefined && String(priceUsd).trim() !== "") {
    price = Number(priceUsd);
    // NaN/Infinity would be stored verbatim and then charged; a negative or
    // zero price would let anyone drain the namespace for free.
    if (!Number.isFinite(price) || price <= 0) return { ok: false, error: "price must be a positive number" };
    // Not capped at MAX_CHILD_PRICE_USD on purpose, and the forms no longer
    // pretend otherwise: $2 is what a new ending defaults to, not the most it
    // may charge. PRD 0005 R3's annual cap arrives with terms, renewals and the
    // ledger; this column already carries prices set before any cap existed.
    if (price > MAX_LISTING_PRICE_USD) return { ok: false, error: "price is implausibly large" };
    price = Math.round(price * 100) / 100;
  }

  await run(`UPDATE moshpit_tlds SET price_usd = ? WHERE tld = ?`, [price, tld]);
  await logAction(tld, userId, price === null ? "unlist" : `list:${price}`);
  return { ok: true, tld, priceUsd: price };
}

/**
 * TLDs somebody else holds. `forSale` narrows to the ones actually buyable.
 *
 * `tld` breaks the tie for the same reason it does in listTldsForUser: a bulk
 * claim shares one timestamp, and paging through a partial order loses rows.
 */
export async function listTldsNotOwnedBy(userId, { forSale = false, limit = 200, offset = 0 } = {}) {
  const sql = `SELECT tld, user_id, owner_email, alias_of, price_usd, created_at
               FROM moshpit_tlds
               WHERE user_id IS NOT ?${forSale ? " AND price_usd IS NOT NULL" : ""}
               ORDER BY price_usd IS NULL, created_at DESC, tld LIMIT ? OFFSET ?`;
  return all(sql, [userId ?? "", limit, offset]);
}

/** How many endings somebody else holds -- the Theirs pager needs the total. */
export async function countTldsNotOwnedBy(userId, { forSale = false } = {}) {
  const row = await get(
    `SELECT COUNT(*) AS n FROM moshpit_tlds
     WHERE user_id IS NOT ?${forSale ? " AND price_usd IS NOT NULL" : ""}`,
    [userId ?? ""],
  );
  return Number(row?.n ?? 0);
}

/**
 * Which half of the namespace a search is looking at.
 *
 * The filter sits inside a tab, so it searches what that tab shows: Yours means
 * yours, Theirs means everybody else's. A filter that returned rows the panel
 * underneath it cannot display would be worse than no filter.
 */
const searchScope = (scope, userId) =>
  scope === "mine" ? { where: " AND user_id = ?", args: [userId ?? ""] }
  : scope === "theirs" ? { where: " AND user_id IS NOT ?", args: [userId ?? ""] }
  : { where: "", args: [] };

/**
 * Endings matching a LIKE pattern from tldQuery().
 *
 * `exact` sorts a dead-on hit to the top and shorter names above longer ones,
 * so typing `eggs` puts `.eggs` above `.eggsalad` instead of burying it in
 * alphabetical order.
 *
 * The name count comes back on the same row rather than one query per result:
 * this runs on every keystroke, and N+1 on a keyup handler is how a filter box
 * becomes the next thing that makes the page unusable.
 */
export async function searchTlds(like, { scope = "all", userId = null, exact = "", limit = 20, offset = 0 } = {}) {
  const s = searchScope(scope, userId);
  return all(
    `SELECT t.tld, t.user_id, t.owner_email, t.alias_of, t.price_usd, t.created_at,
            (SELECT COUNT(*) FROM moshpit_names n WHERE n.tld = t.tld) AS name_count
     FROM moshpit_tlds t
     WHERE t.tld LIKE ?${s.where.replace(/user_id/g, "t.user_id")}
     ORDER BY t.tld = ? DESC, length(t.tld), t.tld
     LIMIT ? OFFSET ?`,
    [like, ...s.args, exact, limit, offset],
  );
}

/** How many endings match — the pager needs a total the window cannot give it. */
export async function countSearchTlds(like, { scope = "all", userId = null } = {}) {
  const s = searchScope(scope, userId);
  const row = await get(
    `SELECT COUNT(*) AS n FROM moshpit_tlds WHERE tld LIKE ?${s.where}`,
    [like, ...s.args],
  );
  return Number(row?.n ?? 0);
}

/**
 * Endings pointing at this one.
 *
 * The inverse of `alias_of`, which was only ever asked as "does anything point
 * here" before a repoint. An ending's page wants the list: `.seo → .rank` is a
 * real relationship and the only way to find it was to read every other row.
 */
export async function listAliasesTo(tld, limit = 100) {
  return all(
    `SELECT tld, user_id, owner_email, alias_of, price_usd, created_at
     FROM moshpit_tlds WHERE alias_of = ? ORDER BY tld LIMIT ?`,
    [normalizeTld(tld) || "", limit],
  );
}

export async function getTldWithPrice(tld) {
  return get(`SELECT tld, user_id, owner_email, alias_of, price_usd, created_at FROM moshpit_tlds WHERE tld = ?`, [tld]);
}

/** How long a checkout holds a name against other buyers. */
export const RESERVATION_MS = 30 * 60 * 1000;

/**
 * Is this name buyable right now, and for how much?
 *
 * Checked before taking money and again before handing the name over, because
 * the gap between those two is exactly where someone else's purchase lands.
 */
export async function quoteName({ tld: tldInput, label: labelInput, buyerId, now = Date.now() }) {
  const tld = normalizeTld(tldInput);
  const label = normalizeLabel(labelInput);
  if (!tld || !label) return { ok: false, error: "not a valid name" };

  const owner = await getTldWithPrice(tld);
  if (!owner) return { ok: false, error: `.${tld} is not registered` };
  if (owner.user_id === buyerId) return { ok: false, error: `you own .${tld} — mint names under it for free` };
  if (owner.price_usd === null || owner.price_usd === undefined) {
    return { ok: false, error: `.${tld} is not for sale` };
  }
  if (await getName(tld, label)) return { ok: false, error: `${label}.${tld} is already taken`, taken: true };

  const held = await get(
    `SELECT id FROM moshpit_name_purchases
     WHERE tld = ? AND label = ? AND status = 'pending' AND reserved_until > ? LIMIT 1`,
    [tld, label, now],
  );
  if (held) return { ok: false, error: `${label}.${tld} is in someone's checkout right now — try again shortly`, taken: true };

  return { ok: true, tld, label, priceUsd: owner.price_usd, sellerId: owner.user_id };
}

/** Record a checkout so the webhook can settle it. */
export async function openNamePurchase({ paymentId, tld, label, userId, amountUsd, now = Date.now() }) {
  await run(
    `INSERT INTO moshpit_name_purchases (id, tld, label, user_id, amount_usd, status, created_at, reserved_until)
     VALUES (?,?,?,?,?, 'pending', ?, ?)`,
    [paymentId, tld, label, userId, amountUsd, now, now + RESERVATION_MS],
  );
}

/**
 * Hand over a paid-for name. Idempotent on the payment id.
 *
 * The claim is a conditional UPDATE for the same reason the credit ledger uses
 * one: CoinPay retries a webhook it never got an ack for, so two deliveries can
 * be in flight at once and both read 'pending' before either write lands.
 *
 * If the name went to someone else in the meantime the buyer is owed a refund.
 * That is money against a name they cannot have, so it is recorded as
 * `refund_due` and logged rather than quietly dropped.
 */
export async function settleNamePurchase(paymentId) {
  const p = await get(`SELECT * FROM moshpit_name_purchases WHERE id = ? AND status = 'pending'`, [paymentId]);
  if (!p) return { ok: false, error: "no pending purchase for that payment" };

  const claimed = await run(
    `UPDATE moshpit_name_purchases SET status = 'settling' WHERE id = ? AND status = 'pending'`, [paymentId]);
  if (!claimed.rowsAffected) return { ok: false, error: "already settled" };

  try {
    await run(`INSERT INTO moshpit_names (tld, label, user_id, target, created_at) VALUES (?,?,?,?,?)`,
      [p.tld, p.label, p.user_id, null, Date.now()]);
  } catch {
    await run(`UPDATE moshpit_name_purchases SET status = 'refund_due' WHERE id = ?`, [paymentId]);
    console.error(`[moshpit] ${p.label}.${p.tld} was taken before payment ${paymentId} settled — refund due to ${p.user_id}`);
    return { ok: false, error: "name was taken before payment settled", refundDue: true };
  }

  await run(`UPDATE moshpit_name_purchases SET status = 'cleared' WHERE id = ?`, [paymentId]);
  await logAction(p.tld, p.user_id, `bought:${p.label}`);
  return { ok: true, tld: p.tld, label: p.label, userId: p.user_id };
}

export async function listNamePurchases(userId, limit = 50) {
  return all(
    `SELECT id, tld, label, amount_usd, status, created_at FROM moshpit_name_purchases
     WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [userId, limit]);
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
  if (!owner) return { name, resolved: name, aliased: false, registered: false, name_registered: false, target: null };

  // Where the name ends up: itself, unless the TLD points elsewhere and this
  // name is not held back from that alias. Exemption is checked at read time,
  // not write time, so it survives the alias being repointed later.
  const aliased = Boolean(owner.alias_of) && !(await isExempt(tld, label));
  const resolvedTld = aliased ? owner.alias_of : tld;
  const resolved = `${label}.${resolvedTld}`;

  // The name is looked up on the TLD it actually resolves to -- that is the one
  // whose operator mints names there, so it is the only place the answer can
  // legitimately come from.
  const entry = await getName(resolvedTld, label);

  return {
    name,
    resolved,
    aliased,
    // `registered` has always meant "the TLD is claimed", which is what decides
    // whether the pit has any authority over this name at all. Kept as-is so
    // existing resolvers do not change behaviour.
    registered: true,
    ...(Boolean(owner.alias_of) && !aliased ? { exempt: true } : {}),
    name_registered: Boolean(entry),
    target: entry?.target ?? null,
    // Carried alongside the target rather than folded into it. A resolver
    // answering AAAA has no use for a feed and ignores these; /n/ is the caller
    // that turns them into a page, and it needs both to decide which it serves.
    feed: entry?.feed_url ?? null,
    feed_kind: entry?.feed_kind ?? null,
  };
}

/* ---- the keys a name may present ---- */

const PIN_COLS = `tld, label, pin, kind, note, user_id, created_at`;

export const PIN_KINDS = ["tls", "mtp"];

/**
 * A pin is SHA-256 over a SubjectPublicKeyInfo, base64 — always 32 bytes, so
 * always 44 characters ending in one '='. Checked rather than trusted, because
 * a malformed pin is indistinguishable in effect from a key that simply never
 * matches: the connection fails, and nothing anywhere says why.
 */
export function isPin(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  return Buffer.from(value, "base64").length === 32;
}

export function normalizePinKind(value) {
  const kind = String(value ?? "").trim().toLowerCase();
  return PIN_KINDS.includes(kind) ? kind : null;
}

export async function listPins(tldInput, labelInput, kind = null) {
  const tld = normalizeTld(tldInput);
  const label = normalizeLabel(labelInput);
  if (!tld || !label) return [];
  return kind
    ? all(`SELECT ${PIN_COLS} FROM moshpit_name_pins WHERE tld = ? AND label = ? AND kind = ?
           ORDER BY created_at DESC`, [tld, label, kind])
    : all(`SELECT ${PIN_COLS} FROM moshpit_name_pins WHERE tld = ? AND label = ?
           ORDER BY kind, created_at DESC`, [tld, label]);
}

/**
 * The keys a client should accept for `scrambled.eggs`.
 *
 * Aliases are followed first. When `.agentic` points at `.agent`, a client
 * asking about `foo.agentic` connects to whatever serves `foo.agent`, so the
 * keys that matter are the ones published there. Answering with the typed
 * name's own pins would refuse every working connection.
 *
 * Returns null when the pit has no authority over the name at all — an
 * unclaimed TLD is not a Moshpit name, and saying "no key published" about
 * `example.com` would invite a client to treat clearnet as merely unpinned.
 */
export async function pinsForName(input, kind = null) {
  const resolution = await resolveMoshpitName(input);
  if (!resolution || !resolution.registered) return null;

  const parsed = parseMoshpitName(resolution.resolved);
  if (!parsed) return null;

  return {
    name: resolution.name,
    resolved: resolution.resolved,
    tld: parsed.tld,
    label: parsed.label,
    name_registered: resolution.name_registered,
    target: resolution.target,
    pins: await listPins(parsed.tld, parsed.label, kind),
  };
}

/** Publish a key for a name you hold. */
export async function addPin({ tld: tldInput, label: labelInput, pin, kind: kindInput, note = null, userId }) {
  const owned = await ownedName(tldInput, labelInput, userId);
  if (!owned.ok) return owned;

  if (!isPin(pin)) {
    return { ok: false, error: "pin must be base64 SHA-256 over a SubjectPublicKeyInfo (44 characters)" };
  }
  const kind = normalizePinKind(kindInput);
  if (!kind) return { ok: false, error: `kind must be one of ${PIN_KINDS.join(", ")}` };

  // The same pin under a second kind is a mistake worth naming. Ignoring it
  // would leave the operator sure they published an `mtp` key while every
  // client is still told it is `tls`.
  const existing = await get(
    `SELECT kind FROM moshpit_name_pins WHERE tld = ? AND label = ? AND pin = ?`,
    [owned.tld, owned.label, pin],
  );
  if (existing && existing.kind !== kind) {
    return { ok: false, error: `that pin is already published for ${owned.label}.${owned.tld} as ${existing.kind}`, taken: true };
  }
  if (existing) return { ok: true };

  const trimmed = typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : null;
  await run(
    `INSERT INTO moshpit_name_pins (${PIN_COLS}) VALUES (?,?,?,?,?,?,?)`,
    [owned.tld, owned.label, pin, kind, trimmed, userId, Date.now()],
  );
  await logAction(owned.tld, userId, `pin:add:${owned.label}:${kind}`);
  return { ok: true };
}

/**
 * Withdraw a key.
 *
 * Removing the last pin of a kind is allowed. It leaves the name with no key
 * published, which clients treat as a refusal rather than as permission — so
 * this is how a compromised key is taken out of service, and refusing it on the
 * grounds that it breaks connections would be refusing the point.
 */
export async function removePin({ tld: tldInput, label: labelInput, pin, userId }) {
  const owned = await ownedName(tldInput, labelInput, userId);
  if (!owned.ok) return owned;

  const result = await run(
    `DELETE FROM moshpit_name_pins WHERE tld = ? AND label = ? AND pin = ?`,
    [owned.tld, owned.label, pin],
  );
  if (!result.rowsAffected) return { ok: false, error: "that pin is not published for this name" };

  await logAction(owned.tld, userId, `pin:remove:${owned.label}`);
  return { ok: true };
}

/* ---- the DNS records a name publishes ---- */

const RECORD_COLS = `tld, label, type, value, ttl, priority, user_id, created_at`;

/**
 * Records ordered the way a zone file reads: addresses, then the alias, then
 * mail by preference, then text. Not by created_at — the order a set of records
 * was typed in says nothing about how it should be read back, and an owner
 * comparing the tab against their notes is reading a zone, not a history.
 */
const RECORD_ORDER = `CASE type WHEN 'AAAA' THEN 0 WHEN 'CNAME' THEN 1 WHEN 'MX' THEN 2 ELSE 3 END,
                      COALESCE(priority, 0), value`;

export async function listRecords(tldInput, labelInput) {
  const tld = normalizeTld(tldInput);
  const label = normalizeLabel(labelInput);
  if (!tld || !label) return [];
  return all(`SELECT ${RECORD_COLS} FROM moshpit_records WHERE tld = ? AND label = ?
              ORDER BY ${RECORD_ORDER}`, [tld, label]);
}

/**
 * The records a resolver should answer with for `scrambled.eggs`.
 *
 * Aliases are followed first, for the reason pinsForName follows them: when
 * `.agentic` points at `.agent`, a client asking about `foo.agentic` is served
 * by whatever serves `foo.agent`, so the records that matter are the ones
 * published there. Answering with the typed name's own records would send mail
 * to a host the operator repointed away from months ago.
 *
 * Null when the pit has no authority over the name at all.
 */
export async function recordsForName(input) {
  const resolution = await resolveMoshpitName(input);
  if (!resolution || !resolution.registered) return null;

  const parsed = parseMoshpitName(resolution.resolved);
  if (!parsed) return null;

  return {
    name: resolution.name,
    resolved: resolution.resolved,
    tld: parsed.tld,
    label: parsed.label,
    name_registered: resolution.name_registered,
    target: resolution.target,
    records: await listRecords(parsed.tld, parsed.label),
  };
}

/**
 * Publish a record on a name you hold.
 *
 * Validation is in lib/moshpit-records.mjs and the conflict rules with it, so
 * this is ownership, the write, and the one thing neither could know: whether
 * the name already carries something the new record cannot sit beside.
 *
 * Re-adding a record that is already there succeeds and changes nothing but its
 * TTL. A form that answers "already published" to a person who just asked for
 * exactly what is already true has made them read an error to learn they got
 * what they wanted.
 */
export async function addRecord({ tld: tldInput, label: labelInput, type, value, ttl, priority, userId }) {
  const owned = await ownedName(tldInput, labelInput, userId);
  if (!owned.ok) return owned;

  const name = `${owned.label}.${owned.tld}`;
  const checked = normalizeRecord({ type, value, ttl, priority, name });
  if (!checked.ok) return checked;
  const record = checked.record;

  const existing = await listRecords(owned.tld, owned.label);
  const conflict = recordConflict(record, existing);
  if (conflict) return { ok: false, error: conflict };

  const already = existing.find((r) => r.type === record.type && r.value === record.value);
  if (already) {
    // The primary key is (tld, label, type, value), so the same record with a
    // new TTL or priority is an edit rather than a second row — which is what
    // the owner means by typing it again with a different number.
    if (already.ttl === record.ttl && (already.priority ?? null) === record.priority) return { ok: true, record: already };
    await run(`UPDATE moshpit_records SET ttl = ?, priority = ? WHERE tld = ? AND label = ? AND type = ? AND value = ?`,
      [record.ttl, record.priority, owned.tld, owned.label, record.type, record.value]);
    await logAction(owned.tld, userId, `record:edit:${owned.label}:${record.type}`);
    return { ok: true, record: { ...already, ttl: record.ttl, priority: record.priority } };
  }

  await run(`INSERT INTO moshpit_records (${RECORD_COLS}) VALUES (?,?,?,?,?,?,?,?)`,
    [owned.tld, owned.label, record.type, record.value, record.ttl, record.priority, userId, Date.now()]);
  await logAction(owned.tld, userId, `record:add:${owned.label}:${record.type}`);

  // Keep "points at" in step with the records, in the one direction that cannot
  // surprise anyone: a name with no target that just published its first
  // address now has one. Everything downstream — the bridge, the DoH server,
  // the /n/ gateway — reads that column and nothing else, so without this a
  // name with a perfectly good AAAA record would still resolve to the parking
  // page. Never the other way: an owner who typed a target is not overruled by
  // a record they added afterwards.
  if (!(await getName(owned.tld, owned.label))?.target) {
    const target = effectiveTarget(null, await listRecords(owned.tld, owned.label));
    if (target) await run(`UPDATE moshpit_names SET target = ? WHERE tld = ? AND label = ?`, [target, owned.tld, owned.label]);
  }

  return { ok: true, record };
}

/**
 * Withdraw a record.
 *
 * Identified by (type, value) rather than by a row id: that is the pair a
 * person can read off the row they are looking at, and it is what the API's
 * callers have — a synthetic id would have to be looked up first by a client
 * that already knows exactly which record it means.
 */
export async function removeRecord({ tld: tldInput, label: labelInput, type, value, userId }) {
  const owned = await ownedName(tldInput, labelInput, userId);
  if (!owned.ok) return owned;

  const wanted = normalizeRecordType(type);
  if (!wanted) return { ok: false, error: "not a record type this registry publishes" };

  const before = await listRecords(owned.tld, owned.label);
  const match = before.find((r) => r.type === wanted && r.value === String(value ?? "").trim().toLowerCase())
    // TXT is the one type whose value is not lowercased on the way in, so it is
    // the one that has to be matched as written.
    || before.find((r) => r.type === wanted && r.value === String(value ?? "").trim());
  if (!match) return { ok: false, error: "that record is not published on this name" };

  await run(`DELETE FROM moshpit_records WHERE tld = ? AND label = ? AND type = ? AND value = ?`,
    [owned.tld, owned.label, match.type, match.value]);
  await logAction(owned.tld, userId, `record:remove:${owned.label}:${match.type}`);

  // The mirror of addRecord: a target this registry set from a record follows
  // that record out. A target the owner typed stays, because they typed it.
  const entry = await getName(owned.tld, owned.label);
  if (entry?.target && entry.target === match.value) {
    const target = effectiveTarget(null, await listRecords(owned.tld, owned.label));
    await run(`UPDATE moshpit_names SET target = ? WHERE tld = ? AND label = ?`, [target, owned.tld, owned.label]);
  }

  return { ok: true };
}

/**
 * The names on the DNS Records tab: yours, optionally filtered, one page worth.
 *
 * Every name you hold, not only the ones that already have records — the tab
 * exists to add the first record to a name, and a list that only showed names
 * with records would be empty for exactly the people who need it.
 *
 * The record count comes back with the row so the list can say which names have
 * something published without a query per name; the records themselves are
 * fetched for the window only, by listRecordsForNames.
 */
export async function listRecordNames(userId, { like = null, exact = "", limit = 25, offset = 0 } = {}) {
  const where = like
    ? `n.user_id = ? AND (n.label || '.' || n.tld) LIKE ?`
    : `n.user_id = ?`;
  const params = like ? [userId, like] : [userId];
  return all(
    `SELECT n.tld, n.label, n.target,
            (SELECT COUNT(*) FROM moshpit_records r WHERE r.tld = n.tld AND r.label = n.label) AS record_count
     FROM moshpit_names n
     WHERE ${where}
     ORDER BY CASE WHEN (n.label || '.' || n.tld) = ? THEN 0 ELSE 1 END, n.tld, n.label
     LIMIT ? OFFSET ?`,
    [...params, exact || "", limit, offset],
  );
}

export async function countRecordNames(userId, { like = null } = {}) {
  const row = like
    ? await get(`SELECT COUNT(*) AS n FROM moshpit_names WHERE user_id = ? AND (label || '.' || tld) LIKE ?`, [userId, like])
    : await get(`SELECT COUNT(*) AS n FROM moshpit_names WHERE user_id = ?`, [userId]);
  return row?.n ?? 0;
}

/**
 * Records for a page of names, in one query.
 *
 * Returns a Map keyed `label.tld`. The alternative is a query per name, which
 * is what the pit's earlier pages did with names-per-ending and is why /pit
 * needed a page budget in the first place.
 */
export async function listRecordsForNames(names = []) {
  const found = new Map();
  if (!names.length) return found;
  const keys = names.map((n) => `${n.label}.${n.tld}`);
  const placeholders = keys.map(() => "?").join(",");
  const rows = await all(
    `SELECT ${RECORD_COLS} FROM moshpit_records WHERE (label || '.' || tld) IN (${placeholders})
     ORDER BY ${RECORD_ORDER}`,
    keys,
  );
  for (const row of rows) {
    const key = `${row.label}.${row.tld}`;
    if (!found.has(key)) found.set(key, []);
    found.get(key).push(row);
  }
  return found;
}

/* ---- what a name publishes here ---- */

const CONTENT_COLS = `tld, label, slug, kind, title, body, url, media, section, nav, position,
  published_at, user_id, created_at, updated_at`;

/** Everything a name has published, drafts included. Ordering is the renderer's job. */
export async function listContent(tldInput, labelInput) {
  const tld = normalizeTld(tldInput);
  const label = normalizeLabel(labelInput);
  if (!tld || !label) return [];
  const rows = await all(
    `SELECT ${CONTENT_COLS} FROM moshpit_content WHERE tld = ? AND label = ?
     ORDER BY published_at DESC, updated_at DESC`,
    [tld, label],
  );
  return rows.map(contentOut);
}

export async function countContent(tldInput, labelInput) {
  const tld = normalizeTld(tldInput);
  const label = normalizeLabel(labelInput);
  if (!tld || !label) return 0;
  const row = await get(`SELECT COUNT(*) AS n FROM moshpit_content WHERE tld = ? AND label = ?`, [tld, label]);
  return row?.n ?? 0;
}

/** One item, by its slug. */
export async function getContent(tldInput, labelInput, slugInput) {
  const tld = normalizeTld(tldInput);
  const label = normalizeLabel(labelInput);
  const slug = normalizeSlug(slugInput);
  if (!tld || !label || !slug) return null;
  const row = await get(
    `SELECT ${CONTENT_COLS} FROM moshpit_content WHERE tld = ? AND label = ? AND slug = ?`,
    [tld, label, slug],
  );
  return contentOut(row);
}

/**
 * What a name publishes, for a name as it was typed.
 *
 * Aliases followed, like every other read: `.agentic` pointing at `.agent`
 * means one site reachable by two names, and content filed under one of them
 * has to be found from the other or half the network's names go blank.
 */
export async function contentForName(input) {
  const resolution = await resolveMoshpitName(input);
  if (!resolution?.name_registered) return null;
  const parsed = parseMoshpitName(resolution.resolved);
  if (!parsed) return null;
  return listContent(parsed.tld, parsed.label);
}

/**
 * Publish one item, creating it or replacing it.
 *
 * Upsert rather than insert-or-fail, because the caller is a webhook. Anything
 * firing over HTTP retries — on a timeout it never saw the answer to, on a
 * redeploy, on a queue redelivery — and a publish endpoint that makes a second
 * copy every time is one that fills a site with duplicates the first time a
 * network blips. The slug is the identity, so the same call twice is the same
 * post twice, which is to say once.
 *
 * `created_at` survives an update. It is when the thing was first published,
 * which is not something a later edit gets to rewrite.
 */
export async function putContent({ tld: tldInput, label: labelInput, userId, item: input, now = Date.now() }) {
  const owned = await ownedName(tldInput, labelInput, userId);
  if (!owned.ok) return owned;

  const normalized = normalizeContent(input, { now });
  if (!normalized.ok) return normalized;
  const item = normalized.item;

  // Bounded per name. Checked before the write and only for a slug that is not
  // already there, so editing an existing item still works on a full site --
  // otherwise hitting the cap would lock an owner out of fixing what is in it.
  const existing = await get(`SELECT slug, created_at FROM moshpit_content WHERE tld = ? AND label = ? AND slug = ?`,
    [owned.tld, owned.label, item.slug]);
  if (!existing) {
    const count = await countContent(owned.tld, owned.label);
    if (count >= MAX_ITEMS_PER_NAME) {
      return { ok: false, error: `${owned.label}.${owned.tld} already holds ${MAX_ITEMS_PER_NAME} items` };
    }
  }

  await run(
    `INSERT INTO moshpit_content
       (tld, label, slug, kind, title, body, url, media, section, nav, position, published_at, user_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (tld, label, slug) DO UPDATE SET
       kind = excluded.kind, title = excluded.title, body = excluded.body, url = excluded.url,
       media = excluded.media, section = excluded.section, nav = excluded.nav,
       position = excluded.position, published_at = excluded.published_at, updated_at = excluded.updated_at`,
    [
      owned.tld, owned.label, item.slug, item.kind, item.title, item.body, item.url, item.media,
      item.section, item.nav, item.position, item.published_at, userId,
      existing?.created_at ?? now, now,
    ],
  );

  return {
    ok: true,
    created: !existing,
    item: await getContent(owned.tld, owned.label, item.slug),
  };
}

/** Take one item back down. */
export async function deleteContent({ tld: tldInput, label: labelInput, userId, slug: slugInput }) {
  const owned = await ownedName(tldInput, labelInput, userId);
  if (!owned.ok) return owned;
  const slug = normalizeSlug(slugInput);
  if (!slug) return { ok: false, error: "not a valid slug" };
  const existing = await getContent(owned.tld, owned.label, slug);
  if (!existing) return { ok: false, error: `${owned.label}.${owned.tld} has nothing at "${slug}"`, missing: true };
  await run(`DELETE FROM moshpit_content WHERE tld = ? AND label = ? AND slug = ?`, [owned.tld, owned.label, slug]);
  return { ok: true, slug };
}

/** How many items each of these names has published, for a listing. */
export async function countContentForNames(names = []) {
  const counts = new Map();
  if (!names.length) return counts;
  const keys = names.map((n) => `${n.label}.${n.tld}`);
  const placeholders = keys.map(() => "?").join(",");
  const rows = await all(
    `SELECT tld, label, COUNT(*) AS n FROM moshpit_content
     WHERE (label || '.' || tld) IN (${placeholders}) GROUP BY tld, label`,
    keys,
  );
  for (const row of rows) counts.set(`${row.label}.${row.tld}`, row.n);
  return counts;
}

/* ---- claiming a list of endings at once ---- */

/**
 * Claim every ending in a pasted list.
 *
 * One at a time, not in parallel. `moshpit_tld_log` is the record of who
 * claimed what first, and a batch that interleaves its writes makes that
 * ordering meaningless for the endings inside it. Sequential is also the
 * difference between one slow request and a burst that trips rate limits at
 * the database.
 *
 * Partial success is the normal outcome, not the error case: any real list has
 * a few names someone already holds. Every ending is attempted and reported on
 * — the caller gets what landed and what did not, rather than a stop at the
 * first collision with the rest silently unattempted.
 */
export async function registerTlds({
  input, userId, ownerEmail = null, limit = MAX_BULK_TLDS, priceUsd = null, aliasOf = null,
  chunkSize = BULK_CHUNK,
}) {
  const { entries, skipped } = parseTldList(input, limit);

  const claimed = [];
  const mine = [];
  const taken = [];
  const rejected = [];
  const settingsFailed = [];
  const names = [];
  const namesMine = [];
  const namesTaken = [];
  const namesRejected = [];

  // Validation first, in memory. A reserved or malformed ending never needs a
  // round trip to be refused, and filtering here keeps the batches below to
  // things that can actually land.
  const candidates = [];
  const nameCandidates = [];
  for (const entry of entries) {
    const tld = normalizeTld(entry.tld);
    if (!tld) { rejected.push({ tld: entry.tld, error: "not a valid TLD — letters, digits and dashes only, no dots" }); continue; }
    const why = tldRejection(tld);
    if (why) { rejected.push({ tld, error: why }); continue; }

    if (entry.label) {
      const label = normalizeLabel(entry.label);
      if (!label) {
        namesRejected.push({ tld: `${entry.label}.${tld}`, error: "not a valid name — letters, digits and dashes only" });
        continue;
      }
      nameCandidates.push({ tld, label });
      continue;
    }

    candidates.push({ ...entry, tld });
  }

  // A name has nowhere to live until its ending exists, so the endings the
  // pasted names imply are claimed alongside the ones pasted outright. Pasting
  // `blue.eggs` when you hold nothing means you wanted `.eggs` too — the
  // alternative is refusing the line and making the operator paste the halves
  // in two passes, in the right order, to get the same result.
  //
  // Implied or explicit, a claim is a claim: these land in `claimed` and are
  // reported like any other, because quietly acquiring an ending someone did
  // not read themselves asking for is the one outcome worth being loud about.
  const wanted = new Set(candidates.map((c) => c.tld));
  for (const { tld } of nameCandidates) {
    if (wanted.has(tld)) continue;
    wanted.add(tld);
    candidates.push({ tld, aliasOf: null, priceUsd: null });
  }

  const at = Date.now();

  for (const chunk of chunksOf(candidates, chunkSize)) {
    // One round trip for the whole chunk. `INSERT OR IGNORE` cannot fail on a
    // name someone already holds, so the batch never rolls back on a
    // collision, and rowsAffected says which of them landed — which is exactly
    // the claimed/taken split, without a SELECT per ending.
    const inserted = await db.batch(
      chunk.map((c) => ({
        sql: `INSERT OR IGNORE INTO moshpit_tlds (tld, user_id, owner_email, owner_key, created_at) VALUES (?,?,?,?,?)`,
        args: [c.tld, userId, ownerEmail, null, at],
      })),
      "write",
    );

    const landed = [];
    const collided = [];
    chunk.forEach((c, i) => (inserted[i].rowsAffected ? landed : collided).push(c));

    // Who holds the ones that collided — one query for all of them, so that
    // "already yours" stays distinguishable from "someone else has it" without
    // costing a lookup each.
    if (collided.length) {
      const owners = await all(
        `SELECT tld, user_id FROM moshpit_tlds WHERE tld IN (${collided.map(() => "?").join(",")})`,
        collided.map((c) => c.tld),
      );
      const byTld = new Map(owners.map((row) => [row.tld, row.user_id]));
      for (const c of collided) (byTld.get(c.tld) === userId ? mine : taken).push(c.tld);
    }

    if (!landed.length) continue;
    claimed.push(...landed.map((c) => c.tld));

    // Price and alias fold into a single UPDATE per ending rather than the
    // read-check-write setTldPrice does: ownership was just established by the
    // INSERT above, so re-reading the row to confirm it would be asking a
    // question already answered.
    const updates = [];
    for (const c of landed) {
      const price = normalizePrice(c.priceUsd ?? priceUsd);
      const alias = normalizeTld(c.aliasOf ?? aliasOf);
      if (price === undefined) { settingsFailed.push({ tld: c.tld, error: "price must be a positive number" }); continue; }
      const target = alias && alias !== c.tld ? alias : null;
      if (price === null && !target) continue;
      updates.push({
        sql: `UPDATE moshpit_tlds SET price_usd = COALESCE(?, price_usd), alias_of = COALESCE(?, alias_of) WHERE tld = ? AND user_id = ?`,
        args: [price, target, c.tld, userId],
      });
    }

    const logs = landed.map((c) => ({
      sql: `INSERT INTO moshpit_tld_log (tld, user_id, action, at) VALUES (?,?,?,?)`,
      args: [c.tld, userId, "register", at],
    }));

    if (updates.length || logs.length) await db.batch([...updates, ...logs], "write");
  }

  // Names last, once every ending above has settled. `registerName` re-checks
  // ownership rather than trusting the loop: an ending in this batch may have
  // gone to someone else a moment ago, and "you do not own .agent" is the
  // honest report for a name under it — not the "no dots allowed" that the
  // parser used to give, which described the paste rather than the problem.
  for (const { tld, label } of nameCandidates) {
    const full = `${label}.${tld}`;
    const result = await registerName({ tld, label, userId });
    if (result.ok) { names.push(full); continue; }
    if (result.taken) {
      const existing = await getName(tld, label);
      (existing && existing.user_id === userId ? namesMine : namesTaken).push(full);
      continue;
    }
    namesRejected.push({ tld: full, error: result.error });
  }

  return {
    claimed, mine, taken, rejected, settingsFailed,
    names, namesMine, namesTaken, namesRejected,
    skipped, remaining: [], attempted: entries.length,
  };
}

function* chunksOf(list, size) {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}

/** null = leave alone, undefined = refuse, a number = set it. */
function normalizePrice(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0 || price > MAX_LISTING_PRICE_USD) return undefined;
  return Math.round(price * 100) / 100;
}

/** One line fit for a flash message: what landed, what did not, and why. */
export function summarizeBulkClaim(result, limit = MAX_BULK_TLDS) {
  const show = (list, n = 6) =>
    list.slice(0, n).map((t) => `.${t}`).join(", ") + (list.length > n ? ` +${list.length - n} more` : "");

  // The single-ending case says the plain thing. "claimed 1 — .eggs." is what a
  // batch report looks like, and the commonest path through this page is one
  // ending typed into one box.
  // A name is shown as written — `blue.eggs`, not `.blue.eggs` — because the
  // leading dot belongs to an ending and putting one on a name would spell it
  // as something you cannot claim.
  const showNames = (list, n = 6) =>
    list.slice(0, n).join(", ") + (list.length > n ? ` +${list.length - n} more` : "");

  const nameCount = result.names?.length || 0;
  const quiet = !result.mine.length && !result.taken.length && !result.rejected.length
    && !result.settingsFailed?.length && !result.skipped && !result.remaining?.length
    && !result.namesMine?.length && !result.namesTaken?.length && !result.namesRejected?.length;

  const onlyClaimed = quiet && result.claimed.length === 1 && !nameCount;
  if (onlyClaimed) return `.${result.claimed[0]} is yours.`;

  // The same plain sentence for the other half. Claiming `.eggs` on the way to
  // `blue.eggs` is one intention, so it reads as one result rather than as a
  // claim report with a name bolted to it.
  if (quiet && nameCount === 1 && result.claimed.length <= 1) return `${result.names[0]} is yours.`;

  const parts = [];
  if (result.claimed.length) parts.push(`claimed ${result.claimed.length} — ${show(result.claimed)}`);
  if (nameCount) parts.push(`registered ${nameCount} — ${showNames(result.names)}`);
  if (result.mine.length) parts.push(`${result.mine.length} already yours`);
  if (result.namesMine?.length) parts.push(`${result.namesMine.length} name${result.namesMine.length > 1 ? "s" : ""} already yours`);
  if (result.namesTaken?.length) parts.push(`${result.namesTaken.length} name${result.namesTaken.length > 1 ? "s" : ""} taken by someone else (${showNames(result.namesTaken)})`);
  if (result.namesRejected?.length) {
    const reasons = result.namesRejected.slice(0, 3).map((r) => `${r.tld} — ${r.error}`).join("; ");
    parts.push(`${result.namesRejected.length} name${result.namesRejected.length > 1 ? "s" : ""} rejected (${reasons}${result.namesRejected.length > 3 ? "; …" : ""})`);
  }
  if (result.taken.length) parts.push(`${result.taken.length} taken by someone else (${show(result.taken)})`);
  if (result.rejected.length) {
    // The reason matters more than the count here: "reserved" and "too short"
    // need different fixes, and a bare number tells you neither.
    const reasons = result.rejected.slice(0, 3).map((r) => `.${r.tld} — ${r.error}`).join("; ");
    parts.push(`${result.rejected.length} rejected (${reasons}${result.rejected.length > 3 ? "; …" : ""})`);
  }
  if (result.settingsFailed?.length) {
    const first = result.settingsFailed[0];
    parts.push(`${result.settingsFailed.length} claimed but not configured (.${first.tld} — ${first.error})`);
  }
  // The leftovers are the actionable part, so they say what to do rather than
  // just how many there were.
  const left = (result.remaining?.length || 0) + (result.skipped || 0);
  if (left) parts.push(`${left} not attempted — paste them again to carry on`);

  return parts.length ? parts.join(". ") + "." : "nothing to claim — paste one ending per line.";
}

/* ---- buying an ending ---- */

/**
 * Endings are sold once and held for good.
 *
 * They used to carry a one-year term with renewals, per PRD 0005 §5. That is
 * withdrawn: $5 buys `.eggs` outright, $2 buys a name under one, and neither
 * ever comes up for renewal. The prices are unchanged -- what changed is that
 * they are paid once.
 *
 * The reason is not generosity, it is what the namespace is for. A name that
 * lapses is a name somebody else can catch, and the whole pitch here is that
 * you can finally have the clean name instead of the hyphenated one you settled
 * for. An annual invoice with a drop date attached is the thing people are
 * trying to get away from, and selling it back to them undoes the pitch.
 *
 * The term columns are gone (migration 016). The purchase ledger keeps its
 * `kind` and `years` columns, because those record what was actually sold at
 * the time and a financial record is not something to rewrite after the fact.
 */
const TLD_COLS_FULL = `tld, user_id, owner_email, alias_of, price_usd, created_at`;

export async function getTldWithTerm(tld) {
  return get(`SELECT ${TLD_COLS_FULL} FROM moshpit_tlds WHERE tld = ?`, [tld]);
}

/**
 * What it costs to take an unclaimed ending.
 *
 * Quoted rather than assumed, and the same call the checkout makes, so an offer
 * shown anywhere is one the next click can honour. Every refusal names itself:
 * reserved, already held, and "you already own it" are three different answers
 * and a single "unavailable" would be none of them.
 */
export async function quoteTld({ tld: tldInput, buyerId, now = Date.now() }) {
  const tld = normalizeTld(tldInput);
  if (!tld) return { ok: false, error: "not a valid TLD — letters, digits and dashes only, no dots" };

  const why = tldRejection(tld);
  if (why) return { ok: false, error: why };

  const owner = await getTldWithTerm(tld);
  if (owner) {
    if (owner.user_id === buyerId) return { ok: false, error: `.${tld} is already yours`, taken: true };
    return { ok: false, error: `.${tld} is already registered`, taken: true };
  }

  // Someone else's open checkout holds it. The UNIQUE constraint is still the
  // real arbiter at settlement; this only stops two people paying at once.
  const held = await get(
    `SELECT id FROM moshpit_tld_purchases
     WHERE tld = ? AND status = 'pending' AND reserved_until > ? LIMIT 1`,
    [tld, now],
  );
  if (held) return { ok: false, error: `.${tld} is in someone's checkout right now — try again shortly`, taken: true };

  // Not multiplied by anything. There is one price and one purchase, and a
  // quote that still carried a term would be an offer the checkout cannot make.
  return { ok: true, tld, priceUsd: ENDING_PRICE_USD };
}

/**
 * Open a checkout for an ending.
 *
 * `kind` and `years` are written as the constants they now always are rather
 * than dropped from the INSERT: the columns are the ledger's, and a row that
 * left them NULL would be indistinguishable from one written before they
 * existed. Every ending sold from here on is one registration, held for good.
 */
export async function openTldPurchase({ paymentId, tld, userId, amountUsd, now = Date.now() }) {
  await run(
    `INSERT INTO moshpit_tld_purchases (id, tld, user_id, amount_usd, kind, status, years, created_at, reserved_until)
     VALUES (?,?,?,?, 'register', 'pending', 1, ?,?)`,
    [paymentId, tld, userId, amountUsd, now, now + RESERVATION_MS],
  );
}

/**
 * Hand over a paid-for ending. Idempotent on the payment id.
 *
 * The claim is a conditional UPDATE for the same reason every other settlement
 * here uses one: CoinPay retries a webhook it never got an ack for, so two
 * deliveries can be in flight at once and both read 'pending' before either
 * write lands.
 *
 * A 'renew' row can no longer be created, but one may still arrive here: a
 * checkout opened before endings went lifetime can settle after. It is honoured
 * as what the buyer was actually promised -- they hold the ending, and it now
 * holds for good -- rather than refused for naming a kind this code no longer
 * sells. Refusing it would take money for nothing.
 */
export async function settleTldPurchase(paymentId, now = Date.now()) {
  const p = await get(`SELECT * FROM moshpit_tld_purchases WHERE id = ? AND status = 'pending'`, [paymentId]);
  if (!p) return { ok: false, error: "no pending purchase for that payment" };

  const claimed = await run(
    `UPDATE moshpit_tld_purchases SET status = 'settling' WHERE id = ? AND status = 'pending'`, [paymentId]);
  if (!claimed.rowsAffected) return { ok: false, error: "already settled" };

  if (p.kind === "renew") {
    const owner = await getTldWithTerm(p.tld);
    if (!owner || owner.user_id !== p.user_id) {
      await run(`UPDATE moshpit_tld_purchases SET status = 'refund_due' WHERE id = ?`, [paymentId]);
      console.error(`[moshpit] .${p.tld} left ${p.user_id} before renewal ${paymentId} settled — refund due`);
      return { ok: false, error: "ending changed hands before the renewal settled", refundDue: true };
    }
    // Nothing to extend any more. The ending is already theirs for good.
    await run(`UPDATE moshpit_tld_purchases SET status = 'cleared' WHERE id = ?`, [paymentId]);
    await logAction(p.tld, p.user_id, `renew:lifetime`);
    return { ok: true, tld: p.tld, userId: p.user_id, renewed: true, lifetime: true };
  }

  try {
    await run(
      `INSERT INTO moshpit_tlds (tld, user_id, owner_email, owner_key, created_at)
       VALUES (?,?,?,?,?)`,
      [p.tld, p.user_id, null, null, now],
    );
  } catch {
    // Claimed by someone else between checkout and confirmation. Real money
    // against something the buyer cannot have, so it is recorded, not dropped.
    await run(`UPDATE moshpit_tld_purchases SET status = 'refund_due' WHERE id = ?`, [paymentId]);
    console.error(`[moshpit] .${p.tld} was taken before payment ${paymentId} settled — refund due to ${p.user_id}`);
    return { ok: false, error: "ending was taken before payment settled", refundDue: true };
  }

  await run(`UPDATE moshpit_tld_purchases SET status = 'cleared' WHERE id = ?`, [paymentId]);
  await logAction(p.tld, p.user_id, `bought:.${p.tld}`);
  return { ok: true, tld: p.tld, userId: p.user_id, lifetime: true };
}

export async function listTldPurchases(userId, limit = 50) {
  return all(
    `SELECT id, tld, amount_usd, kind, years, status, created_at FROM moshpit_tld_purchases
     WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit],
  );
}

/**
 * Kept, and it always answers no.
 *
 * Endings do not expire any more. This stays as a named answer rather than
 * being deleted because "does this ending still belong to its holder" is a
 * question callers are entitled to keep asking -- the CLI, the DNS bridge and
 * the resolvers all reasonably might -- and the honest reply is now a permanent
 * no rather than a missing export that fails at import time.
 */
export function isExpired() {
  return false;
}

/* ---- short links: /f/<code> ---- */

const LINK_COLS = `code, url, user_id, name, hits, last_hit_at, created_at`;

function linkOut(row) {
  if (!row) return null;
  return {
    code: row.code,
    url: row.url,
    name: row.name ?? null,
    hits: row.hits ?? 0,
    last_hit_at: row.last_hit_at ?? null,
    created_at: row.created_at,
  };
}

/** One link, by its code. The read every redirect makes. */
export async function getLink(codeInput) {
  const code = normalizeCode(codeInput);
  if (!code) return null;
  return linkOut(await get(`SELECT ${LINK_COLS} FROM moshpit_links WHERE code = ?`, [code]));
}

/** What an account has minted, newest first. */
export async function listLinks(userId, { limit = 100, offset = 0 } = {}) {
  const rows = await all(
    `SELECT ${LINK_COLS} FROM moshpit_links WHERE user_id = ?
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [userId, limit, offset],
  );
  return rows.map(linkOut);
}

export async function countLinks(userId) {
  const row = await get(`SELECT COUNT(*) AS n FROM moshpit_links WHERE user_id = ?`, [userId]);
  return row?.n ?? 0;
}

/**
 * Mint a short link, or hand back the one this account already has.
 *
 * Idempotent on (user, url) because the caller is a person at a prompt who
 * cannot see what they minted last week. `/shorten` on a URL twice returning
 * two codes would mean two sets of hit counts for one destination and a slow
 * drift where the code on the sticker is not the code in the list. Handing back
 * the existing one is also what makes the command safe to retry after a
 * timeout.
 *
 * A collision on the code is retried rather than surfaced: 7 characters of a
 * 31-symbol alphabet collide rarely, and when they do the honest fix is another
 * draw, not an error the person at the prompt can do anything about.
 */
export async function createLink({
  url: urlInput, userId, name: nameInput = null, base = null, now = Date.now(),
  attempts = 5, mint = mintCode,
}) {
  const normalized = normalizeLinkUrl(urlInput, { base });
  if (!normalized.ok) return normalized;
  const url = normalized.url;

  // Scoping to a name is optional, but claiming one you do not hold is not:
  // a link listed under someone else's name is a link that borrows their
  // reputation for wherever it points.
  let name = null;
  if (nameInput) {
    const parsed = parseMoshpitName(nameInput);
    if (!parsed) return { ok: false, error: `not a moshpit name: ${nameInput}` };
    const owned = await ownedName(parsed.tld, parsed.label, userId);
    if (!owned.ok) return owned;
    name = `${owned.label}.${owned.tld}`;
  }

  const existing = await get(
    `SELECT ${LINK_COLS} FROM moshpit_links WHERE user_id = ? AND url = ? ORDER BY created_at LIMIT 1`,
    [userId, url],
  );
  if (existing) return { ok: true, created: false, link: linkOut(existing) };

  // Checked here rather than in the route so every caller is bounded, and only
  // for a URL that is not already shortened -- hitting the cap should not stop
  // an account from getting back the code it already minted.
  const count = await countLinks(userId);
  if (count >= MAX_LINKS_PER_USER) {
    return { ok: false, error: `this account already holds ${MAX_LINKS_PER_USER} short links` };
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const code = mint();
    try {
      await run(
        `INSERT INTO moshpit_links (code, url, user_id, name, hits, last_hit_at, created_at)
         VALUES (?,?,?,?,0,NULL,?)`,
        [code, url, userId, name, now],
      );
      return { ok: true, created: true, link: { code, url, name, hits: 0, last_hit_at: null, created_at: now } };
    } catch (error) {
      // Only a taken code is worth another draw. Anything else -- a dropped
      // connection, a missing table -- would loop `attempts` times and report
      // the wrong cause, so it is rethrown on the first go.
      if (!/UNIQUE|constraint/i.test(String(error?.message || ""))) throw error;
    }
  }
  return { ok: false, error: "could not mint a free code — try again" };
}

/**
 * Follow a code: the URL, or null.
 *
 * The hit count is bumped in the same statement that reads nothing back, and
 * the redirect does not wait on it — see the route. A visitor should not spend
 * a round trip to the database on a number nobody reads in real time.
 */
export async function bumpLink(codeInput, now = Date.now()) {
  const code = normalizeCode(codeInput);
  if (!code) return;
  await run(`UPDATE moshpit_links SET hits = hits + 1, last_hit_at = ? WHERE code = ?`, [now, code]);
}

/** Take a link down. Only its owner can. */
export async function deleteLink({ code: codeInput, userId }) {
  const code = normalizeCode(codeInput);
  if (!code) return { ok: false, error: "not a valid code", missing: true };
  const existing = await get(`SELECT ${LINK_COLS} FROM moshpit_links WHERE code = ?`, [code]);
  if (!existing) return { ok: false, error: `no short link at /f/${code}`, missing: true };
  if (existing.user_id !== userId) return { ok: false, error: `/f/${code} is not yours` };
  await run(`DELETE FROM moshpit_links WHERE code = ?`, [code]);
  return { ok: true, code };
}

/* ---- the clearnet twin ---- */

const TWIN_COLS = `tld, label, domain, status, token, expires_at, verified_at, user_id, created_at`;

/**
 * The longest term a twin's expiry may be set to.
 *
 * ICANN caps a domain registration at ten years, so a date beyond that is not a
 * long registration, it is a typo or a client sending milliseconds where it
 * meant seconds. Accepting it would park a twin that never lapses on our clock
 * and defeat the lead time entirely.
 */
const MAX_TWIN_TERM_MS = 11 * 365 * 24 * 60 * 60 * 1000;

/** Read TXT records for a name. Replaceable, so verification is testable without DNS. */
async function resolveTxtRecords(hostname) {
  const { resolveTxt } = await import("node:dns/promises");
  return resolveTxt(hostname);
}

export async function getTwin(tldInput, labelInput) {
  const tld = normalizeTld(tldInput);
  const label = normalizeLabel(labelInput);
  if (!tld || !label) return null;
  return get(`SELECT ${TWIN_COLS} FROM moshpit_twins WHERE tld = ? AND label = ?`, [tld, label]);
}

/**
 * The clearnet domain a client should send someone to for `scrambled.eggs`.
 *
 * Aliases are followed first, for the same reason pins follow them: when
 * `.agentic` points at `.agent`, whatever serves `foo.agent` is what a visitor
 * actually reaches, so its twin is the one that leads somewhere. Answering with
 * the typed name's own twin would hand out a domain nobody is serving.
 *
 * Only a live twin is returned -- verified, and not inside the lead time before
 * its registration lapses. A pending claim is a domain the registry has no
 * evidence anyone controls, and handing that out would be worse than handing
 * out nothing: the caller cannot tell an unproven answer from a proven one.
 */
export async function twinForName(input, now = Date.now()) {
  const resolution = await resolveMoshpitName(input);
  if (!resolution || !resolution.registered) return null;
  const parsed = parseMoshpitName(resolution.resolved);
  if (!parsed) return null;

  const twin = await getTwin(parsed.tld, parsed.label);
  return twinIsLive(twin, now) ? twin : null;
}

/**
 * Why this domain cannot stand for this name, or null when it can.
 *
 * The interesting rule is the last one. A twin's stem is computable in both
 * directions without a lookup -- that is the property the whole design leans
 * on, because it lets a client holding only `blue-eggs.net` name the pit name
 * it belongs to for free. Letting `red-eggs.net` back `blue.eggs` would break
 * exactly that: the computation says `red.eggs`, the published proof says
 * `blue.eggs`, and any client trusting the cheap answer is sent somewhere its
 * owner never pointed it.
 *
 * A domain whose stem is not a twin shape at all is fine, and deliberately so.
 * Somebody who already owns `financialadvisors.com` should be able to back
 * `financial.advisors` with it; there is no computation to contradict.
 */
function twinDomainRejection(domain, name) {
  if (!domain) return "not a valid domain";
  const computed = moshpitNameForTwin(domain);
  if (computed && computed !== name) {
    return `${domain} reads as the twin of ${computed}, not ${name} — a client computing the name from the domain would be sent to the wrong one`;
  }
  return null;
}

/**
 * Start backfilling a name: record the domain and issue the challenge.
 *
 * Does not verify. Verification is a second, separate call because the record
 * has to be published between the two, and an API that made you guess how long
 * to wait before retrying a single combined call would be a worse version of
 * the same two steps.
 *
 * Replacing a twin that is already live is refused unless asked for
 * explicitly. One twin per name is the rule that makes a twin worth anything,
 * so pointing a name at a new domain necessarily takes it off the clearnet
 * until the new one proves itself -- brief, recoverable, and not something to
 * do by accident on the way to fixing a typo.
 */
export async function claimTwin({ tld: tldInput, label: labelInput, domain: domainInput, userId, expiresAt = null, replace = false, now = Date.now() }) {
  const owned = await ownedName(tldInput, labelInput, userId);
  if (!owned.ok) return owned;
  const name = `${owned.label}.${owned.tld}`;

  const domain = normalizeDomain(domainInput);
  const rejection = twinDomainRejection(domain, name);
  if (rejection) return { ok: false, error: rejection };

  const expiry = normalizeTwinExpiry(expiresAt, now);
  if (expiry.error) return { ok: false, error: expiry.error };

  const current = await getTwin(owned.tld, owned.label);
  if (current && twinIsLive(current, now) && current.domain !== domain && !replace) {
    return {
      ok: false,
      error: `${name} is already backfilled by ${current.domain} — replacing it takes the name off the clearnet until the new domain verifies`,
      replaceable: true,
      current: current.domain,
    };
  }

  // Checked before the challenge is issued rather than left to the unique index
  // at verify time. Both stop it, but only this one stops it before the buyer
  // has published a TXT record that was never going to be accepted.
  const taken = await get(
    `SELECT tld, label FROM moshpit_twins WHERE domain = ? AND status = 'verified' AND NOT (tld = ? AND label = ?)`,
    [domain, owned.tld, owned.label],
  );
  if (taken) return { ok: false, error: `${domain} already backfills ${taken.label}.${taken.tld}`, taken: true };

  // A fresh token per claim, including a re-claim of the same domain. Reusing
  // the old one would let a proof published for a claim that was since given up
  // silently satisfy a new one.
  const token = randomBytes(16).toString("hex");
  await run(
    `INSERT INTO moshpit_twins (${TWIN_COLS}) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT (tld, label) DO UPDATE SET
       domain = excluded.domain, status = 'pending', token = excluded.token,
       expires_at = excluded.expires_at, verified_at = NULL, user_id = excluded.user_id`,
    [owned.tld, owned.label, domain, "pending", token, expiry.value, null, userId, now],
  );
  await logAction(owned.tld, userId, `twin:claim:${owned.label}`);

  return {
    ok: true,
    name,
    domain,
    token,
    // Everything the owner needs to publish, rather than the pieces to assemble.
    // The record is one string typed into one registrar form, and handing back
    // its parts is how it gets typed in wrong.
    proof: { host: twinProofName(domain), type: "TXT", value: twinProof({ name, token }) },
  };
}

/**
 * Check the proof and, if it is there, start serving the twin.
 *
 * The DNS lookup is injectable because the alternative is a test suite that
 * either talks to the real internet or does not cover the only part of this
 * worth covering.
 *
 * A lookup that fails is reported as a lookup that failed, separately from a
 * lookup that succeeded and found nothing. They call for opposite responses --
 * wait and retry, versus go and fix your record -- and collapsing them into one
 * message is how somebody spends an afternoon re-typing a record that was
 * always correct.
 */
export async function verifyTwin({ tld: tldInput, label: labelInput, userId, resolveTxt = resolveTxtRecords, now = Date.now() }) {
  const owned = await ownedName(tldInput, labelInput, userId);
  if (!owned.ok) return owned;
  const name = `${owned.label}.${owned.tld}`;

  const twin = await getTwin(owned.tld, owned.label);
  if (!twin) return { ok: false, error: `${name} has no twin claimed` };

  const host = twinProofName(twin.domain);
  let records;
  try {
    records = await resolveTxt(host);
  } catch (e) {
    // ENODATA/ENOTFOUND mean the lookup worked and there is nothing there,
    // which is a missing record rather than a broken resolver.
    if (e?.code === "ENODATA" || e?.code === "ENOTFOUND" || e?.code === "NXDOMAIN") records = [];
    else return { ok: false, error: `could not read TXT for ${host}: ${e?.code || e?.message || "lookup failed"}`, retryable: true };
  }

  if (!twinProofMatches(records, { name, token: twin.token })) {
    return {
      ok: false,
      error: `no matching proof at ${host} — DNS changes can take a few minutes to publish`,
      retryable: true,
      proof: { host, type: "TXT", value: twinProof({ name, token: twin.token }) },
    };
  }

  try {
    await run(
      `UPDATE moshpit_twins SET status = 'verified', verified_at = ? WHERE tld = ? AND label = ?`,
      [now, owned.tld, owned.label],
    );
  } catch {
    // The partial unique index on verified domains. Someone else proved this
    // domain between the claim and now, which is a race with a real answer
    // rather than an internal error to log and swallow.
    return { ok: false, error: `${twin.domain} was verified against another name first`, taken: true };
  }

  await logAction(owned.tld, userId, `twin:verify:${owned.label}`);
  return { ok: true, name, domain: twin.domain, verified_at: now, expires_at: twin.expires_at };
}

/**
 * Record when the registration lapses, so the link can be dropped ahead of it.
 *
 * Null clears it, meaning "serve indefinitely". That is the honest default for
 * a domain its holder brought and renews elsewhere: the pit cannot learn the
 * date, and inventing one would take a live twin down on a guess.
 */
export async function setTwinExpiry({ tld: tldInput, label: labelInput, userId, expiresAt, now = Date.now() }) {
  const owned = await ownedName(tldInput, labelInput, userId);
  if (!owned.ok) return owned;

  const expiry = normalizeTwinExpiry(expiresAt, now);
  if (expiry.error) return { ok: false, error: expiry.error };

  const result = await run(
    `UPDATE moshpit_twins SET expires_at = ? WHERE tld = ? AND label = ?`,
    [expiry.value, owned.tld, owned.label],
  );
  if (!result.rowsAffected) return { ok: false, error: `${owned.label}.${owned.tld} has no twin claimed` };
  return { ok: true, expires_at: expiry.value };
}

function normalizeTwinExpiry(input, now) {
  if (input === null || input === undefined || input === "") return { value: null };
  const at = typeof input === "number" ? input : Date.parse(String(input));
  if (!Number.isFinite(at)) return { error: "expiry must be a timestamp" };
  if (at <= now) return { error: "expiry is in the past" };
  if (at > now + MAX_TWIN_TERM_MS) return { error: "expiry is further out than a domain registration can run" };
  return { value: Math.round(at) };
}

/** Stop backfilling a name. */
export async function removeTwin({ tld: tldInput, label: labelInput, userId }) {
  const owned = await ownedName(tldInput, labelInput, userId);
  if (!owned.ok) return owned;
  const result = await run(`DELETE FROM moshpit_twins WHERE tld = ? AND label = ?`, [owned.tld, owned.label]);
  if (!result.rowsAffected) return { ok: false, error: `${owned.label}.${owned.tld} has no twin claimed` };
  await logAction(owned.tld, userId, `twin:remove:${owned.label}`);
  return { ok: true };
}

export async function listTwinsForUser(userId) {
  return all(`SELECT ${TWIN_COLS} FROM moshpit_twins WHERE user_id = ? ORDER BY created_at DESC`, [userId]);
}

/**
 * Verified twins that are about to stop being served, soonest first.
 *
 * What a renewal nag reads. The window is measured against the moment the pit
 * drops the link, not against the registrar's date, because that is when the
 * owner's name actually goes dark and it is the deadline they need told.
 */
export async function expiringTwins({ within = 30 * 24 * 60 * 60 * 1000, now = Date.now(), limit = 500 } = {}) {
  return all(
    `SELECT ${TWIN_COLS} FROM moshpit_twins
     WHERE status = 'verified' AND expires_at IS NOT NULL AND expires_at - ? <= ?
     ORDER BY expires_at ASC LIMIT ?`,
    [TWIN_UNLINK_LEAD_MS, now + within, limit],
  );
}

/** The twins worth offering for a name that has none, minus any already spoken for. */
export async function availableTwins(input) {
  const candidates = clearnetTwins(input);
  if (!candidates.length) return [];
  const rows = await all(
    `SELECT domain FROM moshpit_twins WHERE status = 'verified' AND domain IN (${candidates.map(() => "?").join(",")})`,
    candidates,
  );
  const taken = new Set(rows.map((r) => r.domain));
  return candidates.filter((d) => !taken.has(d));
}

/* ---- how to reach the holder ---- */

/**
 * A contact is the consented half of a WHOIS.
 *
 * The registry used to publish `owner_email` for every ending to anyone who
 * asked, which gave holders no say and still left most names unreachable. This
 * replaces it with something the holder opts into: they say where they read
 * mail, the registry publishes `<token>@moshcode.sh`, and the real address
 * never appears in a response, a page or the log.
 *
 * Storage only. The rules live in lib/moshpit-contact.mjs and the mail host in
 * lib/forwardemail.mjs; what this file owns is the order things happen in --
 * which matters, because two of the three steps can fail independently.
 */
const CONTACT_COLS =
  `tld, label, user_id, email, visibility, guard_token, alias_status, alias_id, alias_error, alias_synced_at, created_at, updated_at`;

/**
 * The raw row, real address included. Never hand this to a route that renders.
 *
 * Named `getContactPrivate` rather than `getContact` so that reaching for the
 * one that leaks is a deliberate act with the word in front of you. What a
 * visitor may see comes from publishedContact(), which takes this row and
 * returns an address or nothing.
 */
export async function getContactPrivate(tld, label = "") {
  return get(`SELECT ${CONTACT_COLS} FROM moshpit_contacts WHERE tld = ? AND label = ?`, [tld, label]);
}

/**
 * What to show a visitor asking how to reach `label.tld`, or null.
 *
 * No fallback to the ending's contact when a name has none, and that is the
 * whole point rather than an omission. Names under a priced ending are sold to
 * other people -- showing the ending operator's address on a name they do not
 * hold would route a buyer's mail, a bug report, or an abuse complaint to the
 * wrong person entirely, and do it while looking authoritative.
 */
export async function publicContactFor(tld, label = "") {
  return publishedContact(await getContactPrivate(tld, label), config.forwardEmail.domain);
}

/** Ownership for both shapes a contact comes in: a name, or the ending itself. */
async function ownedContactScope(tldInput, labelInput, userId) {
  const raw = String(labelInput ?? "").trim();
  if (raw) return ownedName(tldInput, raw, userId);

  const tld = normalizeTld(tldInput);
  if (!tld) return { ok: false, error: "not a valid ending" };
  const owner = await getTld(tld);
  if (!owner) return { ok: false, error: `.${tld} is not registered` };
  if (owner.user_id !== userId) return { ok: false, error: `you do not own .${tld}` };
  return { ok: true, tld, label: "" };
}

/** How a contact reads in the allocation log -- the ending, never the address. */
const contactLogLabel = (label) => (label ? `contact:${label}` : "contact");

/**
 * The alias is enabled at the mail host exactly when the guard address is the
 * thing being published.
 *
 * A `public` or `none` contact keeps its token -- see the migration on why the
 * address has to survive being taken down -- but the address stops forwarding,
 * and a sender gets a 550 rather than silence. Keeping it live while the
 * registry advertises something else would leave a forwarding address in
 * service that the holder believes they have turned off.
 */
const aliasWanted = (visibility) => visibility === "guard";

/**
 * Record where a holder reads mail, and make the guard address match.
 *
 * Written first, synced second, and deliberately in that order. The holder's
 * intent is the durable fact; the alias at the mail host is a copy of it that
 * can fail, time out, or not exist yet because no API key is configured. If the
 * sync loses, the row still says what they asked for and `alias_status` says
 * the address is not ready -- which publishes nothing and can be retried. The
 * reverse order would lose the intent on a network blip.
 */
export async function setContact({ tld: tldInput, label: labelInput, userId, email, visibility = DEFAULT_VISIBILITY }) {
  const owned = await ownedContactScope(tldInput, labelInput, userId);
  if (!owned.ok) return owned;

  const address = normalizeContactEmail(email);
  if (!address) return { ok: false, error: "that does not look like an email address" };
  const shown = normalizeVisibility(visibility);
  if (!shown) return { ok: false, error: `visibility must be one of ${CONTACT_VISIBILITY.join(", ")}` };

  const existing = await getContactPrivate(owned.tld, owned.label);
  // Reused when there is one. Minting a fresh token on every edit would change
  // the published address every time a holder corrected a typo in their own.
  const token = existing?.guard_token ?? mintGuardToken();
  const now = Date.now();

  await run(
    `INSERT INTO moshpit_contacts
       (tld, label, user_id, email, visibility, guard_token, alias_status, alias_id, alias_error, alias_synced_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (tld, label) DO UPDATE SET
       email = excluded.email,
       visibility = excluded.visibility,
       -- Rewritten, not left alone. ownedContactScope has already established
       -- that the caller holds this name, so if the stored owner disagrees the
       -- row is stale and the caller is right -- and leaving it would list
       -- somebody else's contact on the previous holder's /pit/contact page.
       user_id = excluded.user_id,
       updated_at = excluded.updated_at`,
    [
      owned.tld, owned.label, userId, address, shown, token,
      existing?.alias_status ?? "pending",
      existing?.alias_id ?? null,
      existing?.alias_error ?? null,
      existing?.alias_synced_at ?? null,
      existing?.created_at ?? now,
      now,
    ],
  );

  await logAction(owned.tld, userId, contactLogLabel(owned.label));
  const sync = await syncContactAlias(owned.tld, owned.label);
  return { ok: true, contact: await getContactPrivate(owned.tld, owned.label), sync };
}

/**
 * Make the mail host agree with the row.
 *
 * Idempotent and safe to call again, because it is called from three places
 * that cannot coordinate: an edit, a retry the holder asks for, and the sweep.
 * Everything it learns goes back onto the row, including failure -- an error
 * nobody records is one the holder cannot see the reason for.
 */
export async function syncContactAlias(tld, label = "") {
  const row = await getContactPrivate(tld, label);
  if (!row) return { ok: false, error: "no contact recorded" };

  // Nothing to sync against. The row keeps whatever status it had rather than
  // being marked failed: "no mail host configured" is a fact about this
  // deployment, not about the holder's contact, and writing `failed` would show
  // them an error for something they cannot fix.
  if (!guardMailConfigured()) return { ok: false, skipped: true, error: "mail host not configured" };

  const wanted = aliasWanted(row.visibility);
  const result = row.alias_id
    ? await updateGuardAlias({ id: row.alias_id, recipient: row.email, isEnabled: wanted })
    // Created even when the holder chose `public` or `none`, then immediately
    // disabled. The token is already published as this contact's identity, and
    // minting the alias lazily would mean the address does not exist on the day
    // they switch to `guard` and expect it to work.
    : await createGuardAlias({
        token: row.guard_token,
        recipient: row.email,
        isEnabled: wanted,
        description: `moshpit contact for ${label ? `${label}.${tld}` : `.${tld}`}`,
      });

  const now = Date.now();
  if (!result.ok) {
    await run(
      `UPDATE moshpit_contacts SET alias_status = 'failed', alias_error = ?, alias_synced_at = ? WHERE tld = ? AND label = ?`,
      [result.error ?? "mail host refused", now, tld, label],
    );
    return result;
  }

  await run(
    `UPDATE moshpit_contacts SET alias_status = 'live', alias_id = ?, alias_error = NULL, alias_synced_at = ? WHERE tld = ? AND label = ?`,
    [result.id ?? row.alias_id, now, tld, label],
  );
  return { ok: true };
}

/** The retry a holder reaches for after the mail host was down. */
export async function retryContactAlias({ tld: tldInput, label: labelInput, userId }) {
  const owned = await ownedContactScope(tldInput, labelInput, userId);
  if (!owned.ok) return owned;
  const sync = await syncContactAlias(owned.tld, owned.label);
  return sync.ok ? { ok: true } : { ok: false, error: sync.error ?? "could not reach the mail host" };
}

/**
 * Take the contact off the name entirely.
 *
 * The alias is destroyed at the host before the row goes, and the row goes
 * either way. An alias left behind is the failure that matters here: it is a
 * live forwarding address at our domain, pointing at a person who has asked to
 * stop being contacted, that nothing left in the database remembers how to
 * revoke. Keeping the row on a failed delete would be worse -- the holder asked
 * to be gone -- so it is logged loudly instead.
 */
export async function removeContact({ tld: tldInput, label: labelInput, userId }) {
  const owned = await ownedContactScope(tldInput, labelInput, userId);
  if (!owned.ok) return owned;
  const row = await getContactPrivate(owned.tld, owned.label);
  if (!row) return { ok: false, error: "no contact to remove" };

  await revokeContactAlias(row);
  await run(`DELETE FROM moshpit_contacts WHERE tld = ? AND label = ?`, [owned.tld, owned.label]);
  await logAction(owned.tld, userId, `un${contactLogLabel(owned.label)}`);
  return { ok: true };
}

/**
 * Destroy one contact's alias at the mail host.
 *
 * Shared by removal and by a name changing hands, because they are the same
 * requirement seen from two directions: after this, mail to that address must
 * reach nobody. Never throws -- both callers are deleting a row whatever
 * happens, and an exception here would leave the row and the alias both alive.
 */
async function revokeContactAlias(row) {
  if (!row?.alias_id || !guardMailConfigured()) return;
  try {
    const result = await deleteGuardAlias({ id: row.alias_id });
    if (!result.ok) {
      console.error(`moshpit contact: alias ${row.alias_id} not revoked — ${result.error}`);
    }
  } catch (e) {
    console.error(`moshpit contact: alias ${row.alias_id} not revoked — ${e?.message ?? e}`);
  }
}

/** Every contact a holder has, for the /pit page to draw. */
export async function listContactsForUser(userId) {
  return all(`SELECT ${CONTACT_COLS} FROM moshpit_contacts WHERE user_id = ? ORDER BY tld, label`, [userId]);
}

/**
 * Contacts whose alias never made it to the mail host.
 *
 * What a reconcile sweep reads. `pending` is mostly the window between this
 * shipping and an API key being set; `failed` is the mail host having been down
 * at the wrong moment. Both are fixed by calling syncContactAlias again, and
 * neither fixes itself.
 */
export async function unsyncedContacts(limit = 200) {
  return all(
    `SELECT ${CONTACT_COLS} FROM moshpit_contacts WHERE alias_status IN ('pending','failed') ORDER BY updated_at LIMIT ?`,
    [limit],
  );
}
