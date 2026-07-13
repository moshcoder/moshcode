// notify + human-in-the-loop approvals — talks to the approvals app (app.moshcode.sh).
//
// notify()/ask() POST the approval to the app's ingest endpoint with the user's
// API key; the app fans it out to the operator's channels (email/SMS/Slack/
// Telegram/push) and returns the approval id + link. ask() then long-polls the
// app until the human opens the link, reads the context, and submits a reply.
//
// Config (env): MOSHCODE_API (default https://app.moshcode.sh), MOSHCODE_API_KEY
// (from the app's Settings → API keys). MOSHCODE_WEBHOOK_SECRET optionally signs
// the ingest for defense in depth. The HTTP layer is injectable for tests.
import crypto from "node:crypto";
import { loadCreds } from "./auth.mjs";

// Prefer explicit env; otherwise fall back to `moshcode login` credentials, so a
// script Just Works after login without exporting anything.
const API = () => (process.env.MOSHCODE_API || loadCreds()?.api || "https://app.moshcode.sh").replace(/\/+$/, "");
const KEY = () => process.env.MOSHCODE_API_KEY || loadCreds()?.token || "";
const SECRET = () => process.env.MOSHCODE_WEBHOOK_SECRET || "";

function signHeaders(body) {
  const secret = SECRET();
  if (!secret) return {};
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return { "x-moshcode-signature": `t=${ts},v1=${sig}` };
}

/** POST an approval to the app. Returns { ok, id, url, delivered, charged, warning } or { ok:false }. */
export async function ingestApproval(payload, { fetchImpl = fetch } = {}) {
  if (!KEY()) return { ok: false, error: "not logged in" };
  const body = JSON.stringify(payload);
  let res;
  try {
    res = await fetchImpl(`${API()}/api/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY()}`, ...signHeaders(body) },
      body,
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  if (!res.ok) return { ok: false, status: res.status };
  const data = await res.json();
  return { ok: true, ...data };
}

/**
 * Long-poll the app for the human's submission to approval `id`.
 * Resolves with their response string once submitted, null on timeout/kill.
 */
export async function pollApproval(id, opts = {}) {
  const {
    fetchImpl = fetch,
    intervalMs = 3000,
    timeoutMs = 0, // 0 = wait forever
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  const url = `${API()}/api/approvals/${id}`;
  const headers = KEY() ? { authorization: `Bearer ${KEY()}` } : {};
  const start = now();
  for (;;) {
    let body = null;
    try {
      const res = await fetchImpl(url, { headers });
      if (res && res.ok) body = await res.json();
    } catch {
      body = null; // network hiccup — keep polling
    }
    if (body && body.status === "submitted") return body.response ?? "";
    if (body && body.status === "killed") return null;
    if (timeoutMs && now() - start >= timeoutMs) return null;
    await sleep(intervalMs);
  }
}
