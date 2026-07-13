// Central config. Reads .env (if present) with zero deps, then process.env wins.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Tiny .env loader — does not override anything already in the environment.
function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
loadEnv();

const origin = (process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 8080}`).replace(/\/+$/, "");
const rpID = new URL(origin).hostname;

export const config = {
  root: ROOT,
  env: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 8080),
  origin,
  // WebAuthn relying party = this host.
  rpID,
  rpName: "moshcode",
  sessionSecret: process.env.SESSION_SECRET || "dev-insecure-secret-change-me",
  db: {
    url: process.env.DATABASE_URL || "file:./data/local.db",
    authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
  },
  // Shared HMAC secret with the moshcode CLI for signed approval ingest.
  ingestSecret: process.env.MOSHCODE_WEBHOOK_SECRET || "",
  resend: {
    apiKey: process.env.RESEND_API_KEY || "",
    from: process.env.RESEND_FROM || "moshcode <notify@moshcode.sh>",
  },
  coinpay: {
    apiBase: (process.env.COINPAY_API_BASE || "https://coinpayportal.com").replace(/\/+$/, ""),
    businessId: process.env.COINPAY_BUSINESS_ID || "",
    webhookSecret: process.env.COINPAY_WEBHOOK_SECRET || "",
    oauth: {
      authorizeUrl: process.env.COINPAY_OAUTH_AUTHORIZE_URL || "",
      tokenUrl: process.env.COINPAY_OAUTH_TOKEN_URL || "",
      userinfoUrl: process.env.COINPAY_OAUTH_USERINFO_URL || "",
      clientId: process.env.COINPAY_OAUTH_CLIENT_ID || "",
      redirectUri: `${origin}/auth/coinpay/callback`,
      scope: process.env.COINPAY_OAUTH_SCOPE || "openid profile",
    },
  },
  get coinpayLoginEnabled() {
    return Boolean(this.coinpay.oauth.authorizeUrl && this.coinpay.oauth.clientId);
  },
  secure: (process.env.NODE_ENV || "development") === "production",
};
