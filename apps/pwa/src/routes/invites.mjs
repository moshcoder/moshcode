// Credit codes ("Have a code?") and scarce invites.
//
//   GET  /redeem[?code=]              the redeem form (signed in)
//   POST /credits/redeem              form post from /redeem and /settings
//   POST /api/credits/redeem          { code } with Authorization: Bearer mck_... (API key only)
//   GET  /invites                     your 3 invites, your ?ref= link, your own invite's status
//   POST /invites                     make an invite (shown once)
//   POST /invites/:id/revoke          withdraw an unused invite
//   POST /invites/confirm/resend      re-send the invite confirmation email
//   GET  /i/confirm?t=                confirm the email an invited account signed up with: pays the bonus
//   GET  /i/:code                     invite landing: sign-up form carrying the code
//   GET|POST /api/admin/credit-codes  operators (ADMIN_EMAILS): list / mint
//   POST /api/admin/credit-codes/:id/revoke
//
// Codes only ever add credits to credit_ledger. Nothing here touches the Moshpit
// registry, name sales or ending sales.
import { Router } from "express";
import { get, all } from "../db.mjs";
import { config } from "../config.mjs";
import { page, footer, appBar, esc } from "../lib/html.mjs";
import { requireAuth, csrfInput, setCeremony, getCeremony, clearCeremony, setNext } from "../lib/session.mjs";
import { sign, unsign } from "../lib/crypto.mjs";
import { balance } from "../lib/credits.mjs";
import { bearer, userForApiKey } from "../lib/apikey.mjs";
import { requireAdmin } from "./admin.mjs";
import {
  getAffiliates, getCredits, redeemCode, mintCode, confirmInviteBonus, looksLikeInvite,
  inviteBonus, INVITE_REASONS, BONUS_REASONS, REDEEM_MESSAGES, UNIT,
} from "../lib/credit-codes.mjs";

export const invitesRouter = Router();

export const INVITE_COOKIE = "mc_invite";
export const REF_COOKIE = "referral_code"; // @profullstack/referrals' cookie name, shared fleet-wide
const INVITE_TTL = 1000 * 60 * 60 * 24 * 30;
const CONFIRM_TTL = 1000 * 60 * 60 * 24 * 14;

const cookieOpts = (extra = {}) => ({ httpOnly: true, sameSite: "lax", secure: config.secure, path: "/", ...extra });

/**
 * Where links in pages and emails point. PUBLIC_ORIGIN when it is a real host;
 * the request's own host otherwise, never localhost on a live box.
 */
export function publicOrigin(req) {
  if (!/\/\/(localhost|127\.0\.0\.1)(:|$)/.test(config.origin)) return config.origin;
  const host = req.get("host");
  return host ? `${req.protocol}://${host}` : config.origin;
}

// ------------------------------------------------------------------ redeem --

function redeemForm(req, code = "") {
  return `<form method="post" action="/credits/redeem" style="display:flex;gap:10px;flex-wrap:wrap;margin:0">${csrfInput(req)}
    <input name="code" value="${esc(code)}" placeholder="MC-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" required maxlength="64" style="flex:1;min-width:220px;text-transform:uppercase">
    <button class="btn acid">Redeem</button>
  </form>`;
}

/** The "Have a code?" card, shared by /settings and /redeem. */
export function redeemCard(req, code = "") {
  return `<div class="card" style="margin-bottom:22px"><div class="card-head"><span class="h">Have a code?</span><a class="pill" href="/invites">invites</a></div>
    <div class="card-body">
      <p class="dim mono" style="font-size:.78rem;margin-top:0">A credit code adds moshcode credits to your balance. Each code works once per account.</p>
      ${redeemForm(req, code)}
    </div></div>`;
}

invitesRouter.get("/redeem", (req, res, next) => {
  if (!req.user) { setNext(res, req.originalUrl); return res.redirect("/?mode=up"); }
  next();
}, async (req, res) => {
  const bal = await balance(req.user.id);
  const code = String(req.query.code || "").slice(0, 64);
  const body = `${appBar(req.user, bal, req.csrfToken)}
  <main class="wrap" style="max-width:640px;padding-top:30px">
    <h1 style="font-size:1.5rem;margin-bottom:20px">Redeem a code</h1>
    ${redeemCard(req, code)}
  </main>${footer}`;
  res.type("html").send(page({ title: "moshcode ▸ redeem", body }));
});

invitesRouter.post("/credits/redeem", requireAuth, async (req, res) => {
  const r = await redeemCode(req.body.code, req.user.id);
  if (!r.ok) return res.redirect(`/settings?code_err=${encodeURIComponent(r.reason)}`);
  res.redirect(`/settings?redeemed=${r.credits}`);
});

// API key only. A cookie session is not accepted here: /api/ is outside the CSRF
// guard, so a cookie would let any page post a code into a signed-in visitor.
invitesRouter.post("/api/credits/redeem", async (req, res, next) => {
  try {
    const key = bearer(req);
    const user = key ? await userForApiKey(key) : null;
    if (!user) return res.status(401).json({ error: "send an API key: Authorization: Bearer mck_..." });
    const r = await redeemCode(req.body?.code, user.id);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.reason, message: REDEEM_MESSAGES[r.reason] || r.reason });
    res.json({ ok: true, unit: UNIT, credits: r.credits, balance: r.balance });
  } catch (error) { next(error); }
});

// ----------------------------------------------------------------- invites --

const fmtDate = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 10) : "");

invitesRouter.get("/invites", requireAuth, async (req, res) => {
  const uid = req.user.id;
  const aff = await getAffiliates();
  const [bal, quota, invites, affCode, mine] = await Promise.all([
    balance(uid),
    aff.quota(uid),
    aff.invites(uid),
    aff.affiliateCode(uid),
    get(`SELECT * FROM invite_bonuses WHERE invitee_id = ?`, [uid]),
  ]);
  const origin = publicOrigin(req);
  const fresh = getCeremony(req, "newinvite");
  const bonus = inviteBonus();
  const q = req.query;
  const notice = q.invite_err ? `<div class="notice err">${esc(INVITE_REASONS[q.invite_err] || "That invite could not be used.")}</div>`
    : q.resent ? `<div class="notice ok">Confirmation email sent. Check your inbox.</div>`
    : q.err ? `<div class="notice err">${esc(String(q.err).replace(/-/g, " ").slice(0, 80))}</div>` : "";

  let mineHtml = "";
  if (mine) {
    const status = mine.status === "paid"
      ? `<span class="acid">confirmed</span>: you and your inviter each got ${Number(mine.credits).toLocaleString()} credits.`
      : mine.status === "pending"
        ? `waiting on your email confirmation. Open the link we sent to ${esc(mine.email || "your email")} and you both get ${bonus.toLocaleString()} credits.
           <form method="post" action="/invites/confirm/resend" style="margin:10px 0 0">${csrfInput(req)}<button class="btn" style="padding:5px 12px;font-size:.72rem">Re-send the email</button></form>`
        : `accepted, no credits: ${esc(BONUS_REASONS[mine.reason] || mine.reason || "not eligible")}.`;
    mineHtml = `<div class="card" style="margin-bottom:22px"><div class="card-head"><span class="h">Your invite</span></div>
      <div class="card-body dim mono" style="font-size:.8rem">Someone invited you. Status: ${status}</div></div>`;
  }

  const rows = invites.length ? invites.map((i) => {
    const state = i.usedBy ? `<span class="acid">used ${fmtDate(i.usedAt)}</span>`
      : i.revokedAt ? `<span class="faint">withdrawn</span>`
      : i.expiresAt && i.expiresAt <= Date.now() ? `<span class="faint">expired</span>`
      : `open until ${fmtDate(i.expiresAt)}`;
    const revoke = !i.usedBy && !i.revokedAt && !(i.expiresAt && i.expiresAt <= Date.now())
      ? `<form method="post" action="/invites/${esc(i.id)}/revoke" style="margin:0">${csrfInput(req)}<button class="btn danger" style="padding:5px 10px;font-size:.72rem">withdraw</button></form>` : "";
    return `<div style="display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)" class="mono">
      <span style="flex:1;font-size:.8rem">${esc(i.note || "invite")} <span class="faint">${fmtDate(i.createdAt)}</span> · ${state}</span>${revoke}</div>`;
  }).join("") : `<div class="faint mono" style="font-size:.78rem;padding:6px 0">no invites made yet</div>`;

  const body = `${appBar(req.user, bal, req.csrfToken)}
  <main class="wrap" style="max-width:720px;padding-top:30px">
    <h1 style="font-size:1.5rem;margin-bottom:8px">Invites</h1>
    <p class="dim mono" style="font-size:.8rem;margin:0 0 20px">You get ${quota.total} invites. Each one works once, for a new account, for 30 days.
      When your invitee confirms their email, you each get ${bonus.toLocaleString()} credits.</p>
    ${notice}
    ${fresh ? `<div class="notice ok">Your new invite link. Copy it now: only you will ever see it, and it is not shown again.
      <div class="mono" style="margin-top:9px;word-break:break-all"><b>${esc(`${origin}/i/${fresh}`)}</b></div>
      <form method="post" action="/invites/hide" style="margin:9px 0 0">${csrfInput(req)}<button class="btn" style="padding:5px 12px;font-size:.72rem">Done</button></form></div>` : ""}
    ${mineHtml}
    <div class="card" style="margin-bottom:22px"><div class="card-head"><span class="h">Your invites</span><span class="pill ${quota.left ? "on" : ""}">${quota.left} of ${quota.total} left</span></div>
      <div class="card-body">
        ${rows}
        ${quota.left ? `<form method="post" action="/invites" style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">${csrfInput(req)}
          <input name="note" placeholder="who is it for? (only you see this)" maxlength="80" style="flex:1;min-width:200px">
          <button class="btn acid">Make an invite</button></form>` : `<p class="faint mono" style="font-size:.74rem;margin-bottom:0">All your invites are spoken for.</p>`}
      </div></div>
    <div class="card"><div class="card-head"><span class="h">Your link</span></div>
      <div class="card-body">
        <p class="dim mono" style="font-size:.78rem;margin-top:0">An open link for posts and profiles. Sign-ups through it are recorded as yours; it carries no credits.</p>
        <div class="mono" style="word-break:break-all"><b>${esc(`${origin}/?ref=${affCode}`)}</b></div>
      </div></div>
  </main>${footer}`;
  res.type("html").send(page({ title: "moshcode ▸ invites", body }));
});

invitesRouter.post("/invites", requireAuth, async (req, res) => {
  try {
    const aff = await getAffiliates();
    const invite = await aff.createInvite(req.user.id, String(req.body.note || "").trim().slice(0, 80));
    setCeremony(res, "newinvite", invite.code, 1000 * 60 * 10);
    res.redirect("/invites");
  } catch (e) {
    res.redirect(`/invites?err=${encodeURIComponent(/no invites left/i.test(e.message) ? "no-invites-left" : "could-not-make-invite")}`);
  }
});

invitesRouter.post("/invites/hide", requireAuth, (req, res) => {
  clearCeremony(res, "newinvite");
  res.redirect("/invites");
});

invitesRouter.post("/invites/:id/revoke", requireAuth, async (req, res) => {
  const aff = await getAffiliates();
  const mine = (await aff.invites(req.user.id)).find((i) => i.id === req.params.id);
  if (mine && !mine.usedBy) await aff.revokeInvite(mine.id);
  res.redirect("/invites");
});

/** The signed link that confirms an invited account's email. */
export function confirmLink(origin, inviteeId, now = Date.now()) {
  return `${origin}/i/confirm?t=${encodeURIComponent(sign({ k: "invite-confirm", u: inviteeId, exp: now + CONFIRM_TTL }))}`;
}

export async function sendInviteConfirmation(req, invitee) {
  if (!invitee?.email) return false;
  const link = confirmLink(publicOrigin(req), invitee.id);
  const bonus = inviteBonus();
  if (!config.resend.apiKey) { console.log(`[email:stub] invite confirm → ${invitee.email}: ${link}`); return true; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${config.resend.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: config.resend.from,
      to: invitee.email,
      subject: "moshcode: confirm your email to collect your invite credits",
      text: `Someone invited you to moshcode. Confirm this is your email and you both get ${bonus} credits:\n\n${link}\n\nThe link works for 14 days, in any browser. If you did not sign up, ignore this.`,
      html: `<div style="font-family:ui-monospace,monospace;background:#070806;color:#edf2e4;padding:24px;border-radius:12px">
        <p style="color:#a6ff1a;letter-spacing:.2em;text-transform:uppercase;font-size:12px">You were invited</p>
        <p>Confirm this is your email and you and your inviter each get <b>${bonus}</b> moshcode credits.</p>
        <a href="${esc(link)}" style="display:inline-block;background:#a6ff1a;color:#0a1400;font-weight:700;padding:12px 18px;border-radius:8px;text-decoration:none">Confirm my email</a>
        <p style="color:#5d6350;font-size:12px;margin-top:20px">Works for 14 days, in any browser. Did not sign up? Ignore this.</p></div>`,
    }),
  }).catch((e) => ({ ok: false, status: e.message }));
  if (!res.ok) console.error(`[invites] confirmation email failed: ${res.status}`);
  return res.ok;
}

invitesRouter.post("/invites/confirm/resend", requireAuth, async (req, res) => {
  const row = await get(`SELECT status FROM invite_bonuses WHERE invitee_id = ?`, [req.user.id]);
  if (row?.status !== "pending") return res.redirect("/invites");
  // One email per two minutes per browser is plenty for a person and dull for a script.
  if (getCeremony(req, "resent")) return res.redirect("/invites?err=wait-a-minute-and-try-again");
  setCeremony(res, "resent", 1, 1000 * 60 * 2);
  await sendInviteConfirmation(req, req.user);
  res.redirect("/invites?resent=1");
});

function messagePage(req, title, html) {
  const body = `<main class="wrap" style="max-width:520px;padding-top:10vh">
    <a class="brand" href="/" style="justify-content:center;font-size:1.5rem;margin-bottom:22px"><span class="mark">M</span>MOSHCODE<span class="app">app</span></a>
    <div class="card"><div class="card-body">${html}</div></div>
  </main>${footer}`;
  return page({ title: `moshcode ▸ ${title}`, body });
}

invitesRouter.get("/i/confirm", async (req, res) => {
  const data = unsign(String(req.query.t || ""));
  if (!data || data.k !== "invite-confirm" || !data.u || !(data.exp > Date.now())) {
    return res.status(400).type("html").send(messagePage(req, "invite", `<div class="notice err">That confirmation link is not valid, or it expired.</div>
      <p class="dim mono" style="font-size:.8rem">Signed in? <a class="acid" href="/invites">Send a fresh one</a>.</p>`));
  }
  const r = await confirmInviteBonus(String(data.u));
  const html = r.ok
    ? `<div class="notice ok">Email confirmed.${r.already ? "" : ` You and your inviter each got ${Number(r.credits).toLocaleString()} credits.`}</div>
       <a class="btn acid block" href="/">Open moshcode</a>`
    : `<div class="notice err">Email confirmed, but this invite earns no credits: ${esc(BONUS_REASONS[r.reason] || r.reason)}.</div>
       <a class="btn block" href="/">Open moshcode</a>`;
  res.type("html").send(messagePage(req, "invite", html));
});

invitesRouter.get("/i/:code", (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  if (!looksLikeInvite(code)) {
    return res.status(404).type("html").send(messagePage(req, "invite", `<div class="notice err">That is not an invite link.</div><a class="btn block" href="/">Open moshcode</a>`));
  }
  if (req.user) {
    return res.type("html").send(messagePage(req, "invite", `<p class="mono">You already have an account, so this invite is not for you: invites are for new accounts.</p>
      <p class="dim mono" style="font-size:.8rem">Pass the link on to whoever it was meant for.</p><a class="btn block" href="/invites">Your invites</a>`));
  }
  // Kept on the form (works in this browser now) and in a cookie (survives a
  // detour through the sign-in page). The bonus itself is tied to the account,
  // so confirming the email later works from any browser or phone.
  res.cookie(INVITE_COOKIE, sign({ c: code }), cookieOpts({ maxAge: INVITE_TTL }));
  const bonus = inviteBonus();
  const html = `<p class="label" style="margin-top:0">You were invited</p>
    <p class="mono" style="font-size:.86rem">Someone wanted you in the pit. Make an account with your email; once you confirm it you both get <b class="acid">${bonus.toLocaleString()}</b> credits on top of the sign-up credits.</p>
    <form method="post" action="/auth/register">${csrfInput(req)}
      <input type="hidden" name="invite" value="${esc(code)}">
      <label class="field"><span>Email</span><input type="email" name="email" autocomplete="username" required placeholder="you@example.com"></label>
      <label class="field"><span>Password</span><input type="password" name="password" autocomplete="new-password" required minlength="8" placeholder="8+ characters"></label>
      <button class="btn acid block" type="submit">Create account</button>
    </form>
    <p class="faint mono" style="font-size:.72rem;margin:12px 0 0">Invite <span class="mono">${esc(code)}</span>. Already have an account? <a class="acid" href="/?mode=in">Sign in</a> (invites are for new accounts only).</p>`;
  res.type("html").send(messagePage(req, "you're invited", html));
});

/** The invite code a sign-up is carrying: the form field first, then the cookie. */
export function inviteFromRequest(req) {
  const fromBody = String(req.body?.invite || "").trim();
  if (fromBody && looksLikeInvite(fromBody)) return fromBody.toUpperCase();
  const c = unsign(req.cookies?.[INVITE_COOKIE]);
  return c?.c && looksLikeInvite(c.c) ? c.c : null;
}

export const clearInvite = (res) => res.clearCookie(INVITE_COOKIE, cookieOpts());

// ----------------------------------------------------------- ?ref= links --

const REF_RE = /^[A-Za-z0-9_-]{4,40}$/;

/** First touch wins: a ?ref= on any page is remembered for 30 days, never overwritten. */
export function refMiddleware(req, res, next) {
  const ref = req.method === "GET" ? req.query?.ref : null;
  if (typeof ref === "string" && REF_RE.test(ref) && !req.cookies?.[REF_COOKIE]) {
    res.cookie(REF_COOKIE, ref, cookieOpts({ maxAge: INVITE_TTL }));
  }
  next();
}

/** Record who referred a brand-new account. Never throws: sign-up must not fail on it. */
export async function attributeSignup(req, userId) {
  const ref = req.cookies?.[REF_COOKIE];
  if (!ref || !REF_RE.test(ref)) return;
  try { await (await getAffiliates()).attribute(ref, userId); } catch (e) { console.error("[invites] attribution failed:", e.message); }
}

// ------------------------------------------------------------------- admin --

invitesRouter.get("/api/admin/credit-codes", requireAdmin, async (_req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json({ codes: await (await getCredits()).list() });
  } catch (e) { next(e); }
});

invitesRouter.post("/api/admin/credit-codes", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const minted = await mintCode({ credits: b.credits, label: b.label, max: b.max, expiresInDays: b.expiresInDays, createdBy: req.adminUser.email });
    console.log(`[admin] ${req.adminUser.email} minted credit code ${minted.id} (${minted.grant.amount} credits, max ${minted.maxRedemptions})`);
    res.set("Cache-Control", "no-store");
    res.json({ ...minted, url: `${publicOrigin(req)}/redeem?code=${encodeURIComponent(minted.code)}` });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

invitesRouter.post("/api/admin/credit-codes/:id/revoke", requireAdmin, async (req, res) => {
  try {
    await (await getCredits()).revoke(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

/** For the operator's export / tests: every invite bonus decision on an inviter. */
export const bonusesFor = (inviterId) => all(`SELECT * FROM invite_bonuses WHERE inviter_id = ? ORDER BY created_at DESC`, [inviterId]);
