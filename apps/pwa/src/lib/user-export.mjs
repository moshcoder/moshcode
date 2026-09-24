// The operator's user export: who signed up, with what, and when.
//
// Deliberately narrow. The query below names the columns it reads, and the two
// secrets on the users row (password_hash, coinpay_sub) are only ever asked
// about as "is it set", never selected. A `SELECT *` here would put a password
// hash one refactor away from a CSV on somebody's laptop.
import { all } from "../db.mjs";
import { config } from "../config.mjs";

/** Column order of the CSV, and of each JSON row. The CLI relies on it. */
export const EXPORT_COLUMNS = ["email", "display_name", "created_at", "id", "signup_method"];

/** Is this account an operator? Only an allowlisted email is. */
export function isAdmin(user, allow = config.adminEmails) {
  const email = String(user?.email || "").trim().toLowerCase();
  return Boolean(email) && allow.has(email);
}

/**
 * How the account was created, from what the row carries.
 *
 * CoinPay first: a CoinPay account never has a password, and its email (when
 * it has one) was added later. Then password, which only the email form sets.
 * An account with neither was created by a passkey ceremony; "unknown" is for
 * a row that has none of the three, which should not exist but would otherwise
 * be reported as something it is not.
 */
export function signupMethod({ has_coinpay, has_password, has_passkey }) {
  if (Number(has_coinpay)) return "coinpay";
  if (Number(has_password)) return "password";
  if (Number(has_passkey)) return "passkey";
  return "unknown";
}

/**
 * One CSV field. Quoted when it has to be, and a display name that starts like
 * a spreadsheet formula gets a leading apostrophe: names are typed by strangers,
 * and this file is exactly the kind that gets opened in a spreadsheet.
 */
export function csvField(value, { neutralize = false } = {}) {
  let s = value === null || value === undefined ? "" : String(value);
  if (neutralize && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows (objects keyed by EXPORT_COLUMNS, plus any extra columns) to CSV text. */
export function toCsv(rows, columns = EXPORT_COLUMNS) {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvField(row[c], { neutralize: c === "display_name" })).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Every account with an email, oldest first, plus counts of the ones without.
 *
 * `{ users: [{ email, display_name, created_at, id, signup_method }], counts }`
 * where created_at is ISO 8601. Accounts without an email are counted, by
 * signup method, and never listed: there is nothing on them to export.
 */
export async function exportUsers() {
  const rows = await all(
    `SELECT u.id, u.email, u.display_name, u.created_at,
            CASE WHEN u.password_hash IS NOT NULL AND u.password_hash <> '' THEN 1 ELSE 0 END AS has_password,
            CASE WHEN u.coinpay_sub IS NOT NULL AND u.coinpay_sub <> '' THEN 1 ELSE 0 END AS has_coinpay,
            CASE WHEN EXISTS (SELECT 1 FROM webauthn_credentials w WHERE w.user_id = u.id) THEN 1 ELSE 0 END AS has_passkey
       FROM users u
      ORDER BY u.created_at ASC, u.id ASC`,
  );
  const users = [];
  const withoutEmail = { total: 0, password: 0, passkey: 0, coinpay: 0, unknown: 0 };
  for (const r of rows) {
    const method = signupMethod(r);
    const email = String(r.email ?? "").trim();
    if (!email) {
      withoutEmail.total += 1;
      withoutEmail[method] += 1;
      continue;
    }
    const created = Number(r.created_at);
    users.push({
      email,
      display_name: r.display_name ?? "",
      created_at: Number.isFinite(created) ? new Date(created).toISOString() : "",
      id: r.id,
      signup_method: method,
    });
  }
  return {
    users,
    counts: { total: rows.length, with_email: users.length, without_email: withoutEmail.total, without_email_by_method: withoutEmail },
  };
}
