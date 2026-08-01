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

import { db, get, all, run } from "./db.mjs";
import { normalizeTarget } from "./lib/moshpit-gateway.mjs";
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

export {
  RESERVED_TLDS, RESOLVE_MODES, MAX_BULK_TLDS, BULK_CHUNK, BULK_TIME_BUDGET_MS, shortCount, DEFAULT_TLD_PRICE_USD, MAX_CHILD_PRICE_USD, CHILD_PRICE_USD, ENDING_PRICE_USD, normalizeLabel, normalizeTld, parseMoshpitName,
  parseTldList, tldRejection, normalizeMode, resolutionPreference, STARTER_LABELS, suggestedLabels,
} from "./lib/moshpit-name.mjs";

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
  const label = normalizeLabel(labelInput);
  if (!tld || !label) return { ok: false, error: "not a valid name" };
  const owner = await getTld(tld);
  if (!owner) return { ok: false, error: `.${tld} is not registered` };
  if (owner.user_id !== userId) return { ok: false, error: `you do not own .${tld}` };
  return { ok: true, tld, label };
}

/* ---- names under a TLD ---- */

const NAME_COLS = `tld, label, user_id, target, created_at`;

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
export async function registerName({ tld: tldInput, label: labelInput, userId, target = null }) {
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

  try {
    await run(`INSERT INTO moshpit_names (tld, label, user_id, target, created_at) VALUES (?,?,?,?,?)`,
      [tld, label, userId, dest.target, Date.now()]);
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

/* ---- buying and renewing an ending ---- */

/** A term is a year. Ten is the ceiling PRD 0005 R6 puts on one checkout. */
export const TERM_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_TERM_YEARS = 10;

const TLD_COLS_FULL = `tld, user_id, owner_email, alias_of, price_usd, term_started_at, expires_at, created_at`;

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
export async function quoteTld({ tld: tldInput, buyerId, years = 1, now = Date.now() }) {
  const tld = normalizeTld(tldInput);
  if (!tld) return { ok: false, error: "not a valid TLD — letters, digits and dashes only, no dots" };

  const why = tldRejection(tld);
  if (why) return { ok: false, error: why };

  const term = Number(years);
  if (!Number.isInteger(term) || term < 1 || term > MAX_TERM_YEARS) {
    return { ok: false, error: `a term is 1 to ${MAX_TERM_YEARS} years` };
  }

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

  return { ok: true, tld, years: term, priceUsd: Math.round(ENDING_PRICE_USD * term * 100) / 100 };
}

/** What it costs to keep one you hold. */
export async function quoteRenewal({ tld: tldInput, userId, years = 1 }) {
  const tld = normalizeTld(tldInput);
  if (!tld) return { ok: false, error: "not a valid TLD" };

  const term = Number(years);
  if (!Number.isInteger(term) || term < 1 || term > MAX_TERM_YEARS) {
    return { ok: false, error: `a term is 1 to ${MAX_TERM_YEARS} years` };
  }

  const owner = await getTldWithTerm(tld);
  if (!owner) return { ok: false, error: `.${tld} is not registered` };
  if (owner.user_id !== userId) return { ok: false, error: `you do not own .${tld}` };

  return { ok: true, tld, years: term, priceUsd: Math.round(ENDING_PRICE_USD * term * 100) / 100, expiresAt: owner.expires_at };
}

export async function openTldPurchase({ paymentId, tld, userId, amountUsd, years = 1, kind = "register", now = Date.now() }) {
  await run(
    `INSERT INTO moshpit_tld_purchases (id, tld, user_id, amount_usd, kind, status, years, created_at, reserved_until)
     VALUES (?,?,?,?,?, 'pending', ?,?,?)`,
    [paymentId, tld, userId, amountUsd, kind, years, now, now + RESERVATION_MS],
  );
}

/**
 * Hand over a paid-for ending, or extend one. Idempotent on the payment id.
 *
 * The claim is a conditional UPDATE for the same reason every other settlement
 * here uses one: CoinPay retries a webhook it never got an ack for, so two
 * deliveries can be in flight at once and both read 'pending' before either
 * write lands.
 *
 * A renewal never shortens a term. It extends from whichever is later — the
 * current expiry or now — so renewing early adds to what is left rather than
 * throwing it away, and renewing late does not backdate the new term into the
 * past. PRD 0005 R7.
 */
export async function settleTldPurchase(paymentId, now = Date.now()) {
  const p = await get(`SELECT * FROM moshpit_tld_purchases WHERE id = ? AND status = 'pending'`, [paymentId]);
  if (!p) return { ok: false, error: "no pending purchase for that payment" };

  const claimed = await run(
    `UPDATE moshpit_tld_purchases SET status = 'settling' WHERE id = ? AND status = 'pending'`, [paymentId]);
  if (!claimed.rowsAffected) return { ok: false, error: "already settled" };

  const span = TERM_MS * (p.years || 1);

  if (p.kind === "renew") {
    const owner = await getTldWithTerm(p.tld);
    if (!owner || owner.user_id !== p.user_id) {
      await run(`UPDATE moshpit_tld_purchases SET status = 'refund_due' WHERE id = ?`, [paymentId]);
      console.error(`[moshpit] .${p.tld} left ${p.user_id} before renewal ${paymentId} settled — refund due`);
      return { ok: false, error: "ending changed hands before the renewal settled", refundDue: true };
    }
    const from = Math.max(owner.expires_at || 0, now);
    await run(`UPDATE moshpit_tlds SET expires_at = ? WHERE tld = ? AND user_id = ?`,
      [from + span, p.tld, p.user_id]);
    await run(`UPDATE moshpit_tld_purchases SET status = 'cleared' WHERE id = ?`, [paymentId]);
    await logAction(p.tld, p.user_id, `renew:${p.years}y`);
    return { ok: true, tld: p.tld, userId: p.user_id, expiresAt: from + span, renewed: true };
  }

  try {
    await run(
      `INSERT INTO moshpit_tlds (tld, user_id, owner_email, owner_key, created_at, term_started_at, expires_at)
       VALUES (?,?,?,?,?,?,?)`,
      [p.tld, p.user_id, null, null, now, now, now + span],
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
  return { ok: true, tld: p.tld, userId: p.user_id, expiresAt: now + span };
}

export async function listTldPurchases(userId, limit = 50) {
  return all(
    `SELECT id, tld, amount_usd, kind, years, status, created_at FROM moshpit_tld_purchases
     WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit],
  );
}

/**
 * Is this ending inside its term?
 *
 * A NULL expiry is not expired. Every ending claimed before terms existed has
 * one, and treating "no term recorded" as "term ended" would expire a few
 * hundred namespaces that nobody agreed to put on a clock.
 */
export function isExpired(tld, now = Date.now()) {
  return Boolean(tld?.expires_at) && tld.expires_at <= now;
}
