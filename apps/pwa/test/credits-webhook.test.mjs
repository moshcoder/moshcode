import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { config } from "../src/config.mjs";
import { verifyCoinPayWebhookRequest } from "../src/lib/coinpay-webhook.mjs";

function reqFor({ signature = "", rawBody = "{}" } = {}) {
  return {
    rawBody,
    get(name) {
      return name.toLowerCase() === "x-coinpay-signature" ? signature : "";
    },
  };
}

function sign(rawBody, secret, ts = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  return `t=${ts},v1=${v1}`;
}

test("CoinPay webhooks fail closed when no secret is configured", () => {
  const previous = config.coinpay.webhookSecret;
  config.coinpay.webhookSecret = "";
  try {
    assert.deepEqual(verifyCoinPayWebhookRequest(reqFor()), {
      ok: false,
      status: 503,
      error: "coinpay webhook secret not configured",
    });
  } finally {
    config.coinpay.webhookSecret = previous;
  }
});

test("CoinPay webhooks require a valid HMAC signature", () => {
  const previous = config.coinpay.webhookSecret;
  config.coinpay.webhookSecret = "test-secret";
  const rawBody = JSON.stringify({ event: "paid", id: "pay_123" });
  try {
    assert.deepEqual(verifyCoinPayWebhookRequest(reqFor({ signature: "bad", rawBody })), {
      ok: false,
      status: 401,
      error: "bad signature",
    });
    assert.deepEqual(verifyCoinPayWebhookRequest(reqFor({ signature: sign(rawBody, "test-secret"), rawBody })), {
      ok: true,
    });
  } finally {
    config.coinpay.webhookSecret = previous;
  }
});
