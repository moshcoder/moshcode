import { config } from "../config.mjs";
import { verifySignature } from "./signature.mjs";

export function verifyCoinPayWebhookRequest(req) {
  if (!config.coinpay.webhookSecret) {
    return { ok: false, status: 503, error: "coinpay webhook secret not configured" };
  }
  const signature = req.get("x-coinpay-signature") || req.get("webhook-signature");
  if (!verifySignature(signature, req.rawBody || "", config.coinpay.webhookSecret)) {
    return { ok: false, status: 401, error: "bad signature" };
  }
  return { ok: true };
}
