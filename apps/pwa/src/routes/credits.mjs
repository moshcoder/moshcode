// Buy usage credits via CoinPay + confirm via webhook.
import { Router } from "express";
import { get, run } from "../db.mjs";
import { config } from "../config.mjs";
import { id } from "../lib/crypto.mjs";
import { grant } from "../lib/credits.mjs";
import { verifySignature } from "../lib/signature.mjs";
import { checkoutConfigured, checkoutEmail, createCheckoutSession, readWebhook } from "../lib/coinpay-checkout.mjs";
import { requireAuth } from "../lib/session.mjs";
import { settleNamePurchase, settleOfferPurchase, settleTldPurchase } from "../moshpit.mjs";

export const creditsRouter = Router();

// credit packs: { credits, usd }
export const PACKS = {
  starter: { credits: 1000, usd: 5 },
  pro: { credits: 5000, usd: 20 },
  pit: { credits: 15000, usd: 50 },
};

creditsRouter.post("/credits/buy", requireAuth, async (req, res) => {
  // Own properties only: PACKS is a plain object literal, so a pack name like
  // `constructor` or `toString` would otherwise resolve to something off
  // Object.prototype — truthy, so the starter fallback is skipped and the
  // payment goes out with no amount/credits.
  const pack = (req.body.pack && Object.hasOwn(PACKS, req.body.pack)) ? PACKS[req.body.pack] : PACKS.starter;
  if (!checkoutConfigured()) {
    // not wired yet: tell the user instead of failing silently
    return res.redirect("/settings?err=coinpay-not-configured");
  }
  const email = checkoutEmail(req);
  if (!email) return res.redirect("/settings?err=email-required-for-checkout");
  try {
    const ses = await createCheckoutSession({
      amountUsd: pack.usd,
      description: `moshcode credits: ${pack.credits.toLocaleString("en-US")}`,
      email,
      accountId: req.user.id,
      metadata: { kind: "credits", user_id: req.user.id, credits: pack.credits },
      successUrl: `${config.origin}/settings?bought=1`,
      cancelUrl: `${config.origin}/settings`,
    });
    // Keyed by the session id: the webhook carries it as checkout_session_id.
    await run(`INSERT INTO credit_purchases (id,user_id,credits,amount_usd,status,created_at) VALUES (?,?,?,?,?,?)`,
      [ses.id, req.user.id, pack.credits, pack.usd, "pending", Date.now()]);
    res.redirect(ses.url);
  } catch (e) {
    console.error("coinpay checkout failed:", e.message);
    res.redirect("/settings?err=coinpay-failed");
  }
});

// CoinPay confirms payment: settle whichever purchase row owns the session (or
// payment) id. The signature is required: an unsigned or mis-signed body is
// refused, and with no secret configured nothing is accepted at all.
creditsRouter.post("/webhooks/coinpay", async (req, res) => {
  const secret = config.coinpay.webhookSecret;
  if (!secret) return res.status(503).json({ error: "webhook not configured" });
  if (!verifySignature(req.get("x-coinpay-signature") || req.get("webhook-signature"), req.rawBody || "", secret)) {
    return res.status(401).json({ error: "bad signature" });
  }
  const evt = readWebhook(req.body);
  if (!evt.paid || !evt.refs.length) return res.json({ ok: true, settled: false });

  for (const payId of evt.refs) {
    // CoinPay is configured with a single webhook URL, so this endpoint is the
    // entry point for every kind of payment the app takes. A name purchase, an
    // ending, an accepted offer and a credit top-up are rows in different
    // tables; whichever one this id belongs to is the one that settles.
    await settleNamePurchase(payId).catch((e) => console.error("[moshpit] settle failed:", e.message));
    await settleTldPurchase(payId).catch((e) => console.error("[moshpit] tld settle failed:", e.message));
    await settleOfferPurchase(payId).catch((e) => console.error("[moshpit] offer settle failed:", e.message));

    const p = await get(`SELECT * FROM credit_purchases WHERE id = ? AND status = 'pending'`, [payId]);
    if (p) {
      // Claim the purchase atomically, the same way /cli/token claims auth
      // codes. CoinPay retries a webhook it never got an ack for, so two
      // deliveries of the same confirmation can be in flight at once; only the
      // first claim credits the ledger.
      const claimed = await run(
        `UPDATE credit_purchases SET status = 'cleared' WHERE id = ? AND status = 'pending'`, [payId]);
      if (claimed.rowsAffected) {
        await grant(p.user_id, p.credits, "topup.coinpay", { payment: payId, usd: p.amount_usd });
      }
    }
  }
  res.json({ ok: true, settled: true });
});
