// Credit codes and scarce invites, on top of the credit ledger this app already keeps.
//
//   @profullstack/redeem-credits  mints and redeems hashed MC-XXXX-... codes
//   @profullstack/affiliates      invites (3 each, single use, 30 days) + ?ref= links
//
// There is one balance: credit_ledger. The modules keep their own tables (codes,
// redemptions, invites), but a code never becomes a second balance. A redemption
// writes one row into credit_ledger keyed on (user_id, source), with a unique index
// behind it, so the same grant can never land twice however often it is retried.
//
// Production is Postgres: the modules get a node-postgres pool on DATABASE_URL
// (sslmode handled the way libsql-pg does it, so dev2's self-signed cert works).
// On a file: database (development, tests) they get a synchronous SQLite handle on
// a sidecar file next to it: @libsql/client is async and cannot be shared.
import path from "node:path";
import { Credits, postgresStore as creditsPg, sqliteStore as creditsSqlite } from "@profullstack/redeem-credits";
import { Affiliates, postgresStore as affPg, sqliteStore as affSqlite } from "@profullstack/affiliates";
import { DB_URL, isPostgres, get, run } from "../db.mjs";
import { config } from "../config.mjs";
import { id } from "./crypto.mjs";
import { balance } from "./credits.mjs";

export const UNIT = "credits";
export const CODE_PREFIX = "MC";
// redeem-credits' default table prefix is credit_, which would land its ledger on
// top of this app's own credit_ledger.
const CREDITS_TABLES = "redeem_";

/** Credits each side gets for an accepted, confirmed invite. Decision for the operator. */
export const inviteBonus = () => intEnv("INVITE_BONUS_CREDITS", 100);
/** An inviter younger than this earns nothing for an invite (hours). */
export const inviterMinAgeHours = () => intEnv("INVITE_MIN_INVITER_AGE_HOURS", 24);
/** At most this many invite bonuses per inviter in 30 days. */
export const inviterMonthlyCap = () => intEnv("INVITE_MONTHLY_CAP", 10);
export const INVITE_QUOTA = 3;

function intEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

let modules = null;

async function sqliteHandle() {
  const file = path.resolve(config.root, DB_URL.slice("file:".length));
  const sidecar = `${file}.codes.sqlite`;
  if (globalThis.Bun) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(sidecar);
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(sidecar);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

async function load() {
  if (isPostgres) {
    const { default: pg } = await import("pg");
    const { connectionSettings } = await import("@profullstack/libsql-pg");
    const pool = new pg.Pool({ ...connectionSettings(DB_URL), max: 4, application_name: "moshcode-credit-codes" });
    pool.on("error", () => { /* idle connection dropped; the next query reconnects */ });
    return {
      credits: new Credits(creditsPg(pool, { prefix: CREDITS_TABLES })),
      affiliates: new Affiliates(affPg(pool), { defaultQuota: INVITE_QUOTA }),
      close: () => pool.end(),
    };
  }
  const db = await sqliteHandle();
  return {
    credits: new Credits(creditsSqlite(db, { prefix: CREDITS_TABLES })),
    affiliates: new Affiliates(affSqlite(db), { defaultQuota: INVITE_QUOTA }),
    close: () => db.close(),
  };
}

async function mods() {
  modules ??= load().catch((error) => { modules = null; throw error; });
  return modules;
}

export const getCredits = async () => (await mods()).credits;
export const getAffiliates = async () => (await mods()).affiliates;
export async function closeCodeStores() {
  if (!modules) return;
  const m = await modules.catch(() => null);
  modules = null;
  await m?.close?.();
}

/**
 * Add `amount` credits to the ledger exactly once per (user, source).
 * Returns true when this call wrote the row, false when it was already there.
 */
export async function grantOnce(userId, amount, reason, source, meta = null) {
  const r = await run(
    `INSERT INTO credit_ledger (id, user_id, delta, reason, meta, created_at, source)
     VALUES (?,?,?,?,?,?,?) ON CONFLICT (user_id, source) DO NOTHING`,
    [id(), userId, Math.abs(amount), reason, meta ? JSON.stringify(meta) : null, Date.now(), source],
  );
  return r.rowsAffected > 0;
}

export const REDEEM_MESSAGES = {
  invalid: "That code does not exist. Check it and try again.",
  expired: "That code has expired.",
  used_up: "That code has already been used.",
  already_redeemed: "You already redeemed that code.",
  revoked: "That code was withdrawn.",
  unsupported: "That code is not for moshcode credits.",
};

/** Redeem a code into the user's ledger. { ok, credits, balance } or { ok:false, reason }. */
export async function redeemCode(code, userId) {
  const raw = String(code || "").trim();
  if (!raw || raw.length > 64) return { ok: false, reason: "invalid" };
  const credits = await getCredits();
  const r = await credits.redeem(raw, userId);
  if (!r.ok) return r;
  if (r.grant.unit !== UNIT) return { ok: false, reason: "unsupported" };
  const amount = Math.max(0, Math.floor(Number(r.grant.amount) || 0));
  // The redemption stands even if this write fails; a retry answers already_redeemed,
  // so the grant is re-attempted here, idempotently, before giving up.
  await grantOnce(userId, amount, "code.redeem", `code:${r.codeId}`, { code_id: r.codeId });
  return { ok: true, credits: amount, codeId: r.codeId, balance: await balance(userId) };
}

/** Mint a one-off code worth `credits`. Returns the plaintext once. */
export async function mintCode({ credits: amount, label = "", max = 1, expiresInDays = null, createdBy = "" }) {
  const n = Math.floor(Number(amount));
  if (!Number.isSafeInteger(n) || n <= 0 || n > 10_000_000) throw new Error("credits must be a positive whole number");
  const maxRedemptions = Math.floor(Number(max) || 1);
  if (maxRedemptions < 1 || maxRedemptions > 100_000) throw new Error("max must be between 1 and 100000");
  const days = expiresInDays == null || expiresInDays === "" ? null : Number(expiresInDays);
  if (days !== null && !(days > 0)) throw new Error("expiresInDays must be positive");
  const credits = await getCredits();
  return credits.mint({
    grant: { unit: UNIT, amount: n },
    label: String(label || "").slice(0, 120),
    maxRedemptions,
    expiresAt: days ? Date.now() + days * 86_400_000 : null,
    prefix: CODE_PREFIX,
    createdBy: String(createdBy || "").slice(0, 120),
  });
}

// ---------------------------------------------------------------- invites --

// Throwaway mailboxes. Short on purpose: a stale scraped list refuses real people.
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com", "10minutemail.com",
  "10minutemail.net", "yopmail.com", "trashmail.com", "dispostable.com", "getnada.com", "maildrop.cc",
  "temp-mail.org", "tempmail.com", "throwawaymail.com", "fakeinbox.com", "mailnesia.com", "mytemp.email",
  "spam4.me", "byom.de", "discard.email", "example.com", "example.org", "example.net",
]);

export const emailDomain = (email) => String(email || "").toLowerCase().split("@")[1] || "";
export const isDisposable = (email) => DISPOSABLE.has(emailDomain(email));

/** One key per mailbox: drops +tags everywhere and dots on Gmail. */
export function emailDedupeKey(email) {
  const [local = "", domain = ""] = String(email || "").toLowerCase().split("@");
  const bare = local.split("+")[0];
  const canonical = domain === "gmail.com" || domain === "googlemail.com" ? bare.replace(/\./g, "") : bare;
  const dom = domain === "googlemail.com" ? "gmail.com" : domain;
  return `${canonical}@${dom}`;
}

/** The invite code shape: INV-XXXX-XXXX-XXXX (case, spaces and dashes forgiven). */
export function looksLikeInvite(code) {
  return /^INV[-\s]?[0-9A-Z]{4}[-\s]?[0-9A-Z]{4}[-\s]?[0-9A-Z]{4}$/i.test(String(code || "").trim());
}

/**
 * Accept an invite for an account that was created by this very request.
 *
 * The invite itself is consumed (one per account, module-enforced). The bonus is
 * decided here and recorded in invite_bonuses; when the gates pass it waits for the
 * invitee to confirm their email (`confirmInviteBonus`). Returns the bonus row.
 */
export async function acceptInvite(code, invitee) {
  const aff = await getAffiliates();
  const r = await aff.redeemInvite(String(code || ""), invitee.id);
  if (!r.ok) return { ok: false, reason: r.reason };
  const inviter = await get(`SELECT id, email, created_at FROM users WHERE id = ?`, [r.inviterId]);
  let status = "pending";
  let reason = null;
  if (!inviter) { status = "refused"; reason = "inviter_gone"; }
  else if (!invitee.email) { status = "refused"; reason = "no_email"; }
  else if (isDisposable(invitee.email)) { status = "refused"; reason = "disposable_domain"; }
  else if (inviter.email && emailDedupeKey(inviter.email) === emailDedupeKey(invitee.email)) { status = "refused"; reason = "same_mailbox"; }
  else if (Date.now() - Number(inviter.created_at) < inviterMinAgeHours() * 3_600_000) { status = "refused"; reason = "inviter_too_new"; }
  await run(
    `INSERT INTO invite_bonuses (invitee_id, inviter_id, invite_id, email, status, reason, credits, created_at, decided_at)
     VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (invitee_id) DO NOTHING`,
    [invitee.id, r.inviterId, r.inviteId, invitee.email || null, status, reason, 0, Date.now(), status === "pending" ? null : Date.now()],
  );
  return { ok: true, inviterId: r.inviterId, inviteId: r.inviteId, status, reason };
}

/**
 * Pay a pending invite bonus once the invitee has confirmed their email.
 * Both sides get inviteBonus() credits, exactly once. Returns the outcome.
 */
export async function confirmInviteBonus(inviteeId) {
  const row = await get(`SELECT * FROM invite_bonuses WHERE invitee_id = ?`, [inviteeId]);
  if (!row) return { ok: false, reason: "no_invite" };
  if (row.status === "paid") return { ok: true, already: true, credits: Number(row.credits) };
  if (row.status !== "pending") return { ok: false, reason: row.reason || row.status };
  const since = Date.now() - 30 * 86_400_000;
  const paid = await get(
    `SELECT COUNT(*) AS n FROM invite_bonuses WHERE inviter_id = ? AND status = 'paid' AND decided_at >= ?`,
    [row.inviter_id, since],
  );
  const amount = inviteBonus();
  if (Number(paid?.n || 0) >= inviterMonthlyCap()) {
    await run(`UPDATE invite_bonuses SET status = 'refused', reason = 'inviter_monthly_cap', decided_at = ? WHERE invitee_id = ? AND status = 'pending'`,
      [Date.now(), inviteeId]);
    return { ok: false, reason: "inviter_monthly_cap" };
  }
  // Claim the row first, the way the CoinPay webhook claims a purchase: two clicks
  // on the same link race here and only one of them pays.
  const claimed = await run(
    `UPDATE invite_bonuses SET status = 'paid', credits = ?, decided_at = ? WHERE invitee_id = ? AND status = 'pending'`,
    [amount, Date.now(), inviteeId],
  );
  if (!claimed.rowsAffected) return confirmInviteBonus(inviteeId);
  if (amount > 0) {
    const meta = { invite_id: row.invite_id };
    await grantOnce(row.invitee_id, amount, "invite.bonus", `invite:${row.invite_id}:invitee`, meta);
    await grantOnce(row.inviter_id, amount, "invite.bonus", `invite:${row.invite_id}:inviter`, meta);
  }
  return { ok: true, credits: amount };
}

export const INVITE_REASONS = {
  invalid: "That invite code does not exist.",
  expired: "That invite has expired.",
  used: "That invite has already been used.",
  self: "You cannot use your own invite.",
  revoked: "That invite was withdrawn.",
  already_invited: "This account was already invited by someone else.",
};

export const BONUS_REASONS = {
  inviter_gone: "the inviting account no longer exists",
  no_email: "the account has no email to confirm",
  disposable_domain: "throwaway mailboxes do not earn invite credits",
  same_mailbox: "the invite came from the same mailbox",
  inviter_too_new: "the inviting account was too new",
  inviter_monthly_cap: "the inviter has had their invite credits for this month",
  no_invite: "there is no invite on this account",
};
