// Fan an approval out to a user's enabled channels. Email goes via Resend; the
// other paid channels (SMS/Slack/Telegram) are stubbed for the PWA scaffold —
// wire their providers next. Returns the list of channel kinds actually notified.
import { all } from "../db.mjs";
import { config } from "../config.mjs";
import { esc } from "./html.mjs";

async function sendEmail(to, approval) {
  if (!config.resend.apiKey) { console.log(`[email:stub] → ${to}: ${approval.message}`); return true; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${config.resend.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: config.resend.from,
      to,
      subject: `moshcode needs you — ${approval.message}`,
      html: `<div style="font-family:ui-monospace,monospace;background:#070806;color:#edf2e4;padding:24px;border-radius:12px">
        <p style="color:#a6ff1a;letter-spacing:.2em;text-transform:uppercase;font-size:12px">Approval requested</p>
        <h2 style="color:#edf2e4">${esc(approval.message)}</h2>
        <p style="color:#969d85">${esc(approval.script || "")}</p>
        <a href="${esc(approval.url)}" style="display:inline-block;background:#a6ff1a;color:#0a1400;font-weight:700;padding:12px 18px;border-radius:8px;text-decoration:none">Open &amp; respond →</a>
        <p style="color:#5d6350;font-size:12px;margin-top:20px">no bugs, only features. 🤘</p>
      </div>`,
    }),
  });
  if (!res.ok) { console.error(`resend ${res.status}`); return false; }
  return true;
}

async function sendStub(kind, target, approval) {
  console.log(`[${kind}:stub] → ${target || "-"}: ${approval.message} ${approval.url}`);
  return true;
}

// Deliver to enabled channels (optionally limited to `onlyKinds`); returns the
// kinds that actually accepted, so the caller charges for real deliveries only.
export async function fanOut(user, approval, onlyKinds = null) {
  let channels = await all(`SELECT kind, target FROM channels WHERE user_id = ? AND enabled = 1`, [user.id]);
  if (onlyKinds) channels = channels.filter((c) => onlyKinds.includes(c.kind));
  const notified = [];
  for (const c of channels) {
    try {
      const ok = c.kind === "email"
        ? await sendEmail(c.target || user.email, approval)
        : await sendStub(c.kind, c.target, approval);
      if (ok) notified.push(c.kind);
    } catch (e) {
      console.error(`deliver ${c.kind} failed:`, e.message);
    }
  }
  return notified;
}
