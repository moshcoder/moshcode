// notify + human-in-the-loop approvals.
//
// notify() pings moshcoding.com (which fans out to the operator's channels —
// email / SMS / Telegram / Slack / any configured webhook) and hands back an
// approval link on moshcode.sh. ask() goes further: it posts the same ping, then
// BLOCKS until the human opens moshcode.sh/approve/:id, reads the context, types
// instructions, and hits submit — resolving with whatever they wrote. That reply
// is what lets an unattended `while (alive)` loop pause for a human and resume.
//
// The HTTP layer is injectable (fetchImpl / sleep / now) so the flow is unit
// tested without a live server or real clock.
import crypto from "node:crypto";

const API = (process.env.MOSHCODE_API || "https://moshcoding.com").replace(/\/+$/, "");
const SITE = (process.env.MOSHCODE_SITE || "https://app.moshcode.sh").replace(/\/+$/, "");
const WEBHOOK_URL = process.env.MOSHCODE_WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.MOSHCODE_WEBHOOK_SECRET || "";

/** Signs "<ts>.<body>" like the CoinPay/Standard-Webhooks scheme. */
function signedHeaders(body) {
  const headers = { "content-type": "application/json" };
  if (WEBHOOK_SECRET) {
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${ts}.${body}`).digest("hex");
    headers["x-moshcode-signature"] = `t=${ts},v1=${sig}`;
  }
  return headers;
}

/** The page a human opens to approve/instruct a paused script. */
export function approvalUrl(id) {
  return `${SITE}/approve/${id}`;
}

/** A fresh approval id. */
export function newApprovalId() {
  return crypto.randomUUID();
}

/**
 * Deliver a moshscript event to moshcoding.com (+ any configured webhook). The
 * receivers fan it out to the operator's channels. Returns per-target results.
 */
export async function deliver(type, data, { fetchImpl = fetch } = {}) {
  const body = JSON.stringify({ type, data, source: "moshcode" });
  const post = (url, label) =>
    fetchImpl(url, { method: "POST", headers: signedHeaders(body), body })
      .then((r) => ({ target: label, ok: r.ok, status: r.status }))
      .catch((e) => ({ target: label, ok: false, error: String(e) }));

  const targets = [post(`${API}/api/webhooks/moshcode`, "moshcoding")];
  if (WEBHOOK_URL) targets.push(post(WEBHOOK_URL, "webhook"));
  return Promise.all(targets);
}

/**
 * Long-poll moshcode.sh for the human's submission to approval `id`.
 * Resolves with their response string once submitted, or null on timeout.
 */
export async function pollApproval(id, opts = {}) {
  const {
    fetchImpl = fetch,
    intervalMs = 3000,
    timeoutMs = 0, // 0 = wait forever
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  const url = `${API}/api/approvals/${id}`;
  const start = now();
  for (;;) {
    let body = null;
    try {
      const res = await fetchImpl(url);
      if (res && res.ok) body = await res.json();
    } catch {
      body = null; // network hiccup — keep polling
    }
    if (body && body.status === "submitted") return body.response ?? "";
    if (timeoutMs && now() - start >= timeoutMs) return null;
    await sleep(intervalMs);
  }
}
