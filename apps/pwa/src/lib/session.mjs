// Cookie sessions + auth middleware + CSRF (double-submit).
import { get, run } from "../db.mjs";
import { id, token, sign, unsign } from "./crypto.mjs";
import { config } from "../config.mjs";

const COOKIE = "mc_sess";
const CSRF = "mc_csrf";
const TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

function cookieOpts(extra = {}) {
  return { httpOnly: true, sameSite: "lax", secure: config.secure, path: "/", ...extra };
}

export async function createSession(res, userId) {
  const t = token();
  const now = Date.now();
  await run(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)`,
    [t, userId, now, now + TTL]);
  res.cookie(COOKIE, t, cookieOpts({ maxAge: TTL }));
}

export async function destroySession(req, res) {
  const t = req.cookies?.[COOKIE];
  if (t) await run(`DELETE FROM sessions WHERE token = ?`, [t]);
  res.clearCookie(COOKIE, cookieOpts());
}

// Attach req.user (or null) from the session cookie, and ensure a CSRF token.
export async function sessionMiddleware(req, res, next) {
  req.user = null;
  const t = req.cookies?.[COOKIE];
  if (t) {
    const row = await get(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
      [t, Date.now()]
    );
    if (row) req.user = row;
    else res.clearCookie(COOKIE, cookieOpts());
  }
  // double-submit CSRF token
  let csrf = req.cookies?.[CSRF];
  if (!csrf) { csrf = token(16); res.cookie(CSRF, csrf, cookieOpts({ httpOnly: false, maxAge: TTL })); }
  req.csrfToken = csrf;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) { setNext(res, req.originalUrl); return res.redirect("/"); }
  next();
}

// Remember where to go after login (safe local paths only), across any auth method.
export function setNext(res, pathname) {
  if (typeof pathname === "string" && pathname.startsWith("/") && !pathname.startsWith("//")) {
    res.cookie("mc_next", sign(pathname), cookieOpts({ maxAge: 1000 * 60 * 10 }));
  }
}
export function takeNext(req, res) {
  const p = unsign(req.cookies?.mc_next);
  if (req.cookies?.mc_next) res.clearCookie("mc_next", cookieOpts());
  return typeof p === "string" && p.startsWith("/") && !p.startsWith("//") ? p : null;
}

// CSRF guard for unsafe methods on browser (form) routes. API/webhooks are Bearer/HMAC.
export function csrfGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  // machine endpoints are Bearer/HMAC/PKCE-authenticated, not cookie sessions
  if (req.path.startsWith("/api/") || req.path.startsWith("/webhooks/") ||
      req.path === "/cli/token" || req.path.startsWith("/cli/device/")) return next();
  const sent = req.body?._csrf || req.get("x-csrf-token");
  if (!sent || sent !== req.cookies?.[CSRF]) return res.status(403).send("bad csrf token");
  next();
}

export const csrfInput = (req) => `<input type="hidden" name="_csrf" value="${req.csrfToken}">`;

// ---- ephemeral auth-ceremony state (webauthn challenge / oauth pkce) in signed cookies ----
export function setCeremony(res, name, value, ttlMs = 1000 * 60 * 5) {
  res.cookie(`mc_c_${name}`, sign({ v: value, exp: Date.now() + ttlMs }), cookieOpts({ maxAge: ttlMs }));
}
export function getCeremony(req, name) {
  const data = unsign(req.cookies?.[`mc_c_${name}`]);
  if (!data || data.exp < Date.now()) return null;
  return data.v;
}
export function clearCeremony(res, name) { res.clearCookie(`mc_c_${name}`, cookieOpts()); }
