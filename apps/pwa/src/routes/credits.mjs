// Buy usage credits via CoinPay + confirm via webhook.
import { Router } from "express";
import { get, run } from "../db.mjs";
import { config } from "../config.mjs";
import { id } from "../lib/crypto.mjs";
import { grant } from "../lib/credits.mjs";
import { verifySignature } from "../lib/signature.mjs";
import { requireAuth } from "../lib/session.mjs";

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
  if (!config.coinpay.businessId) {
    // not wired yet — tell the user instead of failing silently
    return res.redirect("/settings?err=coinpay-not-configured");
  }
  try {
    const r = await fetch(`${config.coinpay.apiBase}/api/payments/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        business_id: config.coinpay.businessId,
        amount: pack.usd,
        currency: "USD",
        payment_method: "both",
        metadata: { app: "moshcode", user_id: req.user.id, credits: pack.credits },
        redirect_url: `${config.origin}/settings?bought=1`,
      }),
    });
    const pay = await r.json();
    const payId = pay.id || pay.payment_id;
    await run(`INSERT INTO credit_purchases (id,user_id,credits,amount_usd,status,created_at) VALUES (?,?,?,?,?,?)`,
      [payId, req.user.id, pack.credits, pack.usd, "pending", Date.now()]);
    res.redirect(pay.hosted_url || pay.url || `${config.coinpay.apiBase}/pay/${payId}`);
  } catch (e) {
    console.error("coinpay create failed:", e.message);
    res.redirect("/settings?err=coinpay-failed");
  }
});

// The status is the last segment of a dotted event name ("payment.confirmed"),
// so match it as a whole word. A bare substring test answers "does this name
// contain a success word anywhere" rather than "did the payment land": a
// negated status ends in one of them ("payment.unpaid" ends in "paid",
// "payment.unconfirmed" ends in "confirmed") and would grant the full credit
// pack for money that never arrived.
const CONFIRMED_EVENT = /(?:^|[.\-_/:])(?:confirmed|completed|paid)$/i;

// CoinPay confirms payment → credit the balance (idempotent on purchase id).
creditsRouter.post("/webhooks/coinpay", async (req, res) => {
  if (config.coinpay.webhookSecret && !verifySignature(req.get("x-coinpay-signature") || req.get("webhook-signature"), req.rawBody || "", config.coinpay.webhookSecret)) {
    return res.status(401).json({ error: "bad signature" });
  }
  const event = req.body?.type || req.body?.event;
  const payId = req.body?.data?.id || req.body?.payment_id || req.body?.id;
  if (event && CONFIRMED_EVENT.test(event) && payId) {
    const p = await get(`SELECT * FROM credit_purchases WHERE id = ? AND status = 'pending'`, [payId]);
    if (p) {
      // Claim the purchase atomically, the same way /cli/token claims auth
      // codes. The status check above is not enough on its own: CoinPay retries
      // a webhook it never got an ack for, so two deliveries of the same
      // confirmation can be in flight at once. Against a remote (network)
      // database both read "pending" before either UPDATE lands, and the pack
      // gets granted twice. Only the first claim credits the ledger.
      const claimed = await run(
        `UPDATE credit_purchases SET status = 'cleared' WHERE id = ? AND status = 'pending'`, [payId]);
      if (claimed.rowsAffected) {
        await grant(p.user_id, p.credits, "topup.coinpay", { payment: payId, usd: p.amount_usd });
      }
    }
  }
  res.json({ ok: true });
});
