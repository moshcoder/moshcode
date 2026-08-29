// Central config. Reads .env (if present) with zero deps, then process.env wins.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Tiny .env loader — does not override anything already in the environment.
// The value group is lazy on purpose: a greedy `(.*)` eats the whitespace the
// trailing `\s*` is there to drop, so `KEY=secret ` exports the trailing space
// as part of the secret, and `KEY="secret" ` never gets unquoted at all.
export function loadEnv(file = path.join(ROOT, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
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

function readPort(value = process.env.PORT) {
  const raw = value === undefined || value === null || String(value).trim() === "" ? "8080" : String(value).trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`PORT must be a decimal integer, got ${JSON.stringify(value)}`);
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be between 0 and 65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

const port = readPort();
const origin = (process.env.PUBLIC_ORIGIN || `http://localhost:${port}`).trim().replace(/\/+$/, "");
const rpID = new URL(origin).hostname;

// The pit answers on its own host as well as the app's, and both serve byte
// identical pages. Which host a name's page belongs to is a separate question
// from where WebAuthn and the OAuth callback live, so it gets its own setting
// rather than riding on `origin` — pointing rpID at the pit would invalidate
// every passkey already registered.
const pitOrigin = (process.env.PIT_ORIGIN || origin).trim().replace(/\/+$/, "");

export const config = {
  root: ROOT,
  env: process.env.NODE_ENV || "development",
  port,
  origin,
  /** Canonical public home of the namespace — /pit and /n/<name>. */
  pitOrigin,
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
    from: process.env.RESEND_FROM || "moshcode <notify@moshcoding.com>",
  },
  // The mail host behind a name's guard address: `<token>@moshcode.sh` forwards
  // to whatever the holder reads, so the real address is never published.
  //
  // The domain is separate from `origin` and `pitOrigin` on purpose. Those two
  // are where the registry answers HTTP; this is where it answers mail, and the
  // two need not be the same host -- moving the pit to another origin must not
  // silently invalidate every contact address already printed on a page.
  forwardEmail: {
    apiKey: process.env.FORWARDEMAIL_API_KEY || "",
    apiBase: (process.env.FORWARDEMAIL_API_BASE || "https://api.forwardemail.net").replace(/\/+$/, ""),
    domain: (process.env.MOSHPIT_GUARD_DOMAIN || "moshcode.sh").trim().toLowerCase(),
  },
  push: {
    vapidPublic: process.env.VAPID_PUBLIC || "",
    vapidPrivate: process.env.VAPID_PRIVATE || "",
    subject: process.env.VAPID_SUBJECT || "mailto:anthony@profullstack.com",
  },
  telegram: { botToken: process.env.TELEGRAM_BOT_TOKEN || "" },
  slack: { defaultWebhook: process.env.SLACK_WEBHOOK_URL || "" },
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
  /**
   * Whether a guard address can be minted right now.
   *
   * False is a working state, not a broken one: contacts are still recorded,
   * they are simply not published until there is a mail host to forward them.
   */
  get guardMailEnabled() {
    return Boolean(this.forwardEmail.apiKey && this.forwardEmail.domain);
  },
  get coinpayLoginEnabled() {
    return Boolean(this.coinpay.oauth.authorizeUrl && this.coinpay.oauth.clientId);
  },
  secure: (process.env.NODE_ENV || "development") === "production",
};
