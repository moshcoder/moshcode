// Email/password auth + the sign-in page (which also hosts passkey + CoinPay buttons).
import { Router } from "express";
import { page, footer, esc } from "../lib/html.mjs";
import { csrfInput, createSession, destroySession, takeNext } from "../lib/session.mjs";
import { hashPassword, verifyPassword } from "../lib/crypto.mjs";
import { createUserWithPassword, userByEmail } from "../lib/users.mjs";
import { dashboardHandler } from "./pages.mjs";
import { config } from "../config.mjs";

export const authRouter = Router();

function authPage(req, { error = "", mode = "in" } = {}) {
  const body = `
  <main class="wrap" style="max-width:440px;padding-top:8vh">
    <a class="brand" href="/" style="justify-content:center;font-size:1.5rem;margin-bottom:6px"><span class="mark">M</span>MOSHCODE<span class="app">app</span></a>
    <p class="label" style="text-align:center;margin-bottom:26px">Stay in the loop</p>
    <div class="card"><div class="card-body">
      ${error ? `<div class="notice err">${esc(error)}</div>` : ""}
      <form method="post" action="/auth/${mode === "up" ? "register" : "login"}">
        ${csrfInput(req)}
        <label class="field"><span>Email</span>
          <input type="email" name="email" autocomplete="username" required placeholder="you@example.com" value="${esc(req.query.email || "")}"></label>
        <label class="field"><span>Password</span>
          <input type="password" name="password" autocomplete="${mode === "up" ? "new-password" : "current-password"}" required minlength="8" placeholder="8+ characters"></label>
        <button class="btn acid block" type="submit">${mode === "up" ? "Create account" : "Sign in"}</button>
      </form>
      <p class="mono" style="text-align:center;font-size:.74rem;margin:14px 0 0">
        ${mode === "up"
          ? `Already mosh? <a class="acid" href="/?mode=in">Sign in</a>`
          : `New here? <a class="acid" href="/?mode=up">Create account</a>`}
      </p>

      <div class="divider">or</div>

      <button class="btn block" type="button" id="passkey-btn" style="margin-bottom:10px">🔑 Continue with a passkey</button>
      ${config.coinpayLoginEnabled
        ? `<a class="btn block" href="/auth/coinpay/start">◆ Continue with CoinPay</a>`
        : `<button class="btn block" type="button" disabled title="Set COINPAY_OAUTH_* to enable">◆ Continue with CoinPay</button>`}
      <p id="passkey-msg" class="mono faint" style="font-size:.72rem;text-align:center;margin:12px 0 0"></p>
    </div></div>
  </main>${footer}
  <script src="/vendor/simplewebauthn-browser.umd.js"></script>
  <script src="/passkey.js"></script>`;
  return page({ title: "moshcode ▸ sign in", body });
}

authRouter.get("/", (req, res) => {
  if (req.user) {
    const next = takeNext(req, res);
    if (next) return res.redirect(next);
    return dashboardHandler(req, res); // dashboard lives at the root
  }
  res.type("html").send(authPage(req, { mode: req.query.mode === "up" ? "up" : "in" }));
});

authRouter.post("/auth/register", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.type("html").send(authPage(req, { mode: "up", error: "Enter a valid email." }));
  if (password.length < 8) return res.type("html").send(authPage(req, { mode: "up", error: "Password must be at least 8 characters." }));
  if (await userByEmail(email)) return res.type("html").send(authPage(req, { mode: "up", error: "That email already has an account — sign in." }));
  const user = await createUserWithPassword(email, hashPassword(password));
  await createSession(res, user.id);
  res.redirect(takeNext(req, res) || "/");
});

authRouter.post("/auth/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = await userByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.type("html").send(authPage(req, { mode: "in", error: "Wrong email or password." }));
  }
  await createSession(res, user.id);
  res.redirect(takeNext(req, res) || "/");
});

authRouter.post("/auth/logout", async (req, res) => {
  await destroySession(req, res);
  res.redirect("/");
});
