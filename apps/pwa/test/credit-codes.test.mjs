// Credit codes + scarce invites (src/lib/credit-codes.mjs, src/routes/invites.mjs).
//
// Boots the real routers against a throwaway file database; skips cleanly when
// the PWA dependencies are not installed.
import assert from "node:assert/strict";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = { express: require("express"), cookieParser: require("cookie-parser") };
  require("@profullstack/redeem-credits");
} catch {
  deps = null;
}
const skip = !deps && "apps/pwa deps not installed";

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-codes-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
process.env.INVITE_BONUS_CREDITS = "250";
delete process.env.RESEND_API_KEY;

const CSRF = "test-csrf-token";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { authRouter } = await import("../src/routes/auth.mjs");
  const { pagesRouter } = await import("../src/routes/pages.mjs");
  const { invitesRouter, refMiddleware } = await import("../src/routes/invites.mjs");
  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(refMiddleware);
  app.use(csrfGuard);
  app.use(authRouter);
  app.use(invitesRouter);
  app.use(pagesRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = await import("../src/db.mjs");
  const codes = await import("../src/lib/credit-codes.mjs");
  const invites = await import("../src/routes/invites.mjs");
  return { server, base, db, codes, invites };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(async () => {
  if (!booted) return;
  const { server, db, codes } = await booted;
  server.close();
  await codes.closeCodeStores();
  db.db.close?.();
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ }
});

/** A tiny cookie-jar browser. */
function browser(base) {
  const jar = new Map([["mc_csrf", CSRF]]);
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  async function req(method, url, form) {
    const res = await fetch(base + url, {
      method,
      redirect: "manual",
      headers: { cookie: cookie(), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? new URLSearchParams({ _csrf: CSRF, ...form }).toString() : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
    return { status: res.status, location: res.headers.get("location"), text: await res.text() };
  }
  return { jar, get: (u) => req("GET", u), post: (u, f) => req("POST", u, f) };
}

async function signup(base, email, extra = {}) {
  const b = browser(base);
  const r = await b.post("/auth/register", { email, password: "correct-horse", ...extra });
  assert.equal(r.status, 302, r.text);
  return { b, r };
}

const ledgerRows = async (db, userId, reason) =>
  db.all(`SELECT delta, source FROM credit_ledger WHERE user_id = ? AND reason = ?`, [userId, reason]);
const userId = async (db, email) => (await db.get(`SELECT id FROM users WHERE email = ?`, [email])).id;

test("a code redeems once into credit_ledger; a second redeem is refused", { skip }, async () => {
  const { base, db, codes } = await app();
  const minted = await codes.mintCode({ credits: 1000, label: "test" });
  assert.match(minted.code, /^MC-/);
  const { b } = await signup(base, "redeemer@moshtest.dev");
  const uid = await userId(db, "redeemer@moshtest.dev");

  const first = await b.post("/credits/redeem", { code: minted.code.toLowerCase().replace(/-/g, " ") });
  assert.equal(first.location, "/settings?redeemed=1000");
  const again = await b.post("/credits/redeem", { code: minted.code });
  assert.equal(again.location, "/settings?code_err=already_redeemed");
  const rows = await ledgerRows(db, uid, "code.redeem");
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].delta), 1000);
  assert.equal(rows[0].source, `code:${minted.id}`);

  const page = await b.get("/settings?redeemed=1000");
  assert.match(page.text, /Have a code\?/);
  assert.match(page.text, /\+1,000 credits/);

  // A second account cannot use a single-use code.
  const { b: other } = await signup(base, "other@moshtest.dev");
  const used = await other.post("/credits/redeem", { code: minted.code });
  assert.equal(used.location, "/settings?code_err=used_up");
});

test("grantOnce is idempotent on (user, source)", { skip }, async () => {
  const { base, db, codes } = await app();
  await signup(base, "grant@moshtest.dev");
  const uid = await userId(db, "grant@moshtest.dev");
  assert.equal(await codes.grantOnce(uid, 5, "test.grant", "test:1"), true);
  assert.equal(await codes.grantOnce(uid, 5, "test.grant", "test:1"), false);
  assert.equal((await ledgerRows(db, uid, "test.grant")).length, 1);
});

test("the redeem API takes an API key, never a cookie", { skip }, async () => {
  const { base, db, codes } = await app();
  const { b } = await signup(base, "api@moshtest.dev");
  const cookieOnly = await b.post("/api/credits/redeem", { code: "MC-0000-0000-0000-0000" });
  assert.equal(cookieOnly.status, 401);

  const uid = await userId(db, "api@moshtest.dev");
  const { createApiKey } = await import("../src/lib/apikey.mjs");
  const { plaintext } = await createApiKey(uid, "test");
  const minted = await codes.mintCode({ credits: 42 });
  const call = (code) => fetch(`${base}/api/credits/redeem`, {
    method: "POST", headers: { authorization: `Bearer ${plaintext}`, "content-type": "application/json" }, body: JSON.stringify({ code }),
  });
  const ok = await call(minted.code);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.credits, 42);
  const bad = await call("MC-ZZZZ-ZZZZ-ZZZZ-ZZZZ");
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "invalid");
});

async function inviterWithInvite(base, db, email, { ageHours = 48 } = {}) {
  const { b } = await signup(base, email);
  const uid = await userId(db, email);
  await db.run(`UPDATE users SET created_at = ? WHERE id = ?`, [Date.now() - ageHours * 3_600_000, uid]);
  const made = await b.post("/invites", { note: "for a friend" });
  assert.equal(made.location, "/invites");
  const page = await b.get("/invites");
  const code = /\/i\/(INV-[0-9A-Z-]+)/.exec(page.text)?.[1];
  assert.ok(code, "the new invite link is shown once");
  return { b, uid, code };
}

test("an invite: landing page, sign-up, email confirmation pays both sides once", { skip }, async () => {
  const { base, db, invites } = await app();
  const inviter = await inviterWithInvite(base, db, "inviter@moshtest.dev");

  const guest = browser(base);
  const landing = await guest.get(`/i/${inviter.code}`);
  assert.equal(landing.status, 200);
  assert.match(landing.text, /name="invite" value="INV-/);
  assert.ok(guest.jar.has("mc_invite"), "the invite rides in a cookie too");

  const reg = await guest.post("/auth/register", { email: "invitee@moshtest.dev", password: "correct-horse", invite: inviter.code });
  assert.equal(reg.location, "/invites");
  const invitee = await userId(db, "invitee@moshtest.dev");
  const row = await db.get(`SELECT * FROM invite_bonuses WHERE invitee_id = ?`, [invitee]);
  assert.equal(row.status, "pending");
  assert.equal((await ledgerRows(db, invitee, "invite.bonus")).length, 0, "nothing paid before the email is confirmed");

  // The emailed link works from any browser: no session needed.
  const link = invites.confirmLink(base, invitee).replace(base, "");
  const phone = browser(base);
  const confirmed = await phone.get(link);
  assert.equal(confirmed.status, 200);
  assert.match(confirmed.text, /each got 250 credits/);
  await phone.get(link); // a second click pays nothing more

  const mine = await ledgerRows(db, invitee, "invite.bonus");
  const theirs = await ledgerRows(db, inviter.uid, "invite.bonus");
  assert.equal(mine.length, 1);
  assert.equal(theirs.length, 1);
  assert.equal(Number(mine[0].delta), 250);
  assert.equal(Number(theirs[0].delta), 250);

  // The invite is spent.
  const late = await browser(base).post("/auth/register", { email: "late@moshtest.dev", password: "correct-horse", invite: inviter.code });
  assert.equal(late.location, "/invites?invite_err=used");
});

test("invite bonuses are refused for the same mailbox, a too-new inviter and a throwaway domain", { skip }, async () => {
  const { base, db } = await app();
  const a = await inviterWithInvite(base, db, "dave.smith@gmail.com");
  await browser(base).post("/auth/register", { email: "davesmith+alt@gmail.com", password: "correct-horse", invite: a.code });
  const r1 = await db.get(`SELECT status, reason FROM invite_bonuses WHERE inviter_id = ?`, [a.uid]);
  assert.deepEqual({ ...r1 }, { status: "refused", reason: "same_mailbox" });

  const young = await inviterWithInvite(base, db, "young@moshtest.dev", { ageHours: 1 });
  await browser(base).post("/auth/register", { email: "friend@moshtest.dev", password: "correct-horse", invite: young.code });
  const r2 = await db.get(`SELECT status, reason FROM invite_bonuses WHERE inviter_id = ?`, [young.uid]);
  assert.equal(r2.reason, "inviter_too_new");

  const c = await inviterWithInvite(base, db, "c@moshtest.dev");
  await browser(base).post("/auth/register", { email: "x@mailinator.com", password: "correct-horse", invite: c.code });
  const r3 = await db.get(`SELECT status, reason FROM invite_bonuses WHERE inviter_id = ?`, [c.uid]);
  assert.equal(r3.reason, "disposable_domain");
});

test("one accepted invite per account", { skip }, async () => {
  const { base, db, codes } = await app();
  const a = await inviterWithInvite(base, db, "one@moshtest.dev");
  const b = await inviterWithInvite(base, db, "two@moshtest.dev");
  await browser(base).post("/auth/register", { email: "target@moshtest.dev", password: "correct-horse", invite: a.code });
  const target = await db.get(`SELECT * FROM users WHERE email = ?`, ["target@moshtest.dev"]);
  const second = await codes.acceptInvite(b.code, target);
  assert.deepEqual(second, { ok: false, reason: "already_invited" });
});

test("a signed-in visitor on /i/<code> is told invites are for new accounts", { skip }, async () => {
  const { base, db } = await app();
  const a = await inviterWithInvite(base, db, "landing@moshtest.dev");
  const page = await a.b.get(`/i/${a.code}`);
  assert.match(page.text, /invites are for new accounts/);
  const bogus = await browser(base).get("/i/not-a-code");
  assert.equal(bogus.status, 404);
});

test("?ref= is remembered first-touch and attributed at sign-up", { skip }, async () => {
  const { base, db, codes } = await app();
  await signup(base, "affiliate@moshtest.dev");
  const affId = await userId(db, "affiliate@moshtest.dev");
  const aff = await codes.getAffiliates();
  const ref = await aff.affiliateCode(affId);
  const v = browser(base);
  await v.get(`/?ref=${ref}`);
  await v.get(`/?ref=SOMEONEELSE`);
  assert.equal(v.jar.get("referral_code"), ref);
  await v.post("/auth/register", { email: "referred@moshtest.dev", password: "correct-horse" });
  assert.equal(await aff.affiliateOf(await userId(db, "referred@moshtest.dev")), affId);
});
