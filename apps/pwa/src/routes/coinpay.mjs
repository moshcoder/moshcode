// "Sign in with CoinPay" — OAuth 2.0 authorization-code + PKCE.
import { Router } from "express";
import crypto from "node:crypto";
import { config } from "../config.mjs";
import { token } from "../lib/crypto.mjs";
import { createSession, setCeremony, getCeremony, clearCeremony, takeNext } from "../lib/session.mjs";
import { userByCoinpay, createUserForCoinpay } from "../lib/users.mjs";

export const coinpayRouter = Router();

const b64url = (buf) => Buffer.from(buf).toString("base64url");

coinpayRouter.get("/auth/coinpay/start", (req, res) => {
  if (!config.coinpayLoginEnabled) return res.redirect("/?err=coinpay-not-configured");
  const state = token(16);
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  setCeremony(res, "cp", { state, verifier }, 1000 * 60 * 10);

  const u = new URL(config.coinpay.oauth.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", config.coinpay.oauth.clientId);
  u.searchParams.set("redirect_uri", config.coinpay.oauth.redirectUri);
  u.searchParams.set("scope", config.coinpay.oauth.scope);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  res.redirect(u.toString());
});

coinpayRouter.get("/auth/coinpay/callback", async (req, res) => {
  const ceremony = getCeremony(req, "cp");
  clearCeremony(res, "cp");
  if (!ceremony || req.query.state !== ceremony.state) return res.redirect("/?err=coinpay-state");
  if (!req.query.code) return res.redirect("/?err=coinpay-denied");

  try {
    const tokenRes = await fetch(config.coinpay.oauth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(req.query.code),
        redirect_uri: config.coinpay.oauth.redirectUri,
        client_id: config.coinpay.oauth.clientId,
        code_verifier: ceremony.verifier,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange ${tokenRes.status}`);
    const tok = await tokenRes.json();

    const infoRes = await fetch(config.coinpay.oauth.userinfoUrl, {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    if (!infoRes.ok) throw new Error(`userinfo ${infoRes.status}`);
    const info = await infoRes.json();
    const sub = String(info.sub || info.id || info.user_id || "");
    if (!sub) throw new Error("no subject in userinfo");

    let user = await userByCoinpay(sub);
    if (!user) user = await createUserForCoinpay(sub, info.name || info.username);
    await createSession(res, user.id);
    res.redirect(takeNext(req, res) || "/");
  } catch (e) {
    console.error("coinpay login failed:", e.message);
    res.redirect("/?err=coinpay-failed");
  }
});
