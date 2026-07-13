// Fan an approval out to a user's enabled channels. Real providers:
//   email    → Resend
//   slack    → Slack incoming webhook (channel target = webhook URL)
//   telegram → Telegram bot sendMessage (channel target = chat id; needs bot token)
//   push     → Web Push (VAPID) to the user's subscribed devices
//   sms      → stubbed (wire a provider next)
// Returns the channel kinds that actually accepted.
import webpush from "web-push";
import { all, run } from "../db.mjs";
import { config } from "../config.mjs";
import { esc } from "./html.mjs";

if (config.push.vapidPublic && config.push.vapidPrivate) {
  webpush.setVapidDetails(config.push.subject, config.push.vapidPublic, config.push.vapidPrivate);
}

async function sendEmail(to, a) {
  if (!config.resend.apiKey) { console.log(`[email:stub] → ${to}: ${a.message}`); return true; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${config.resend.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: config.resend.from,
      to,
      subject: `moshcode needs you — ${a.message}`,
      html: `<div style="font-family:ui-monospace,monospace;background:#070806;color:#edf2e4;padding:24px;border-radius:12px">
        <p style="color:#a6ff1a;letter-spacing:.2em;text-transform:uppercase;font-size:12px">Approval requested</p>
        <h2 style="color:#edf2e4">${esc(a.message)}</h2>
        <p style="color:#969d85">${esc(a.script || "")}</p>
        <a href="${esc(a.url)}" style="display:inline-block;background:#a6ff1a;color:#0a1400;font-weight:700;padding:12px 18px;border-radius:8px;text-decoration:none">Open &amp; respond →</a>
        <p style="color:#5d6350;font-size:12px;margin-top:20px">no bugs, only features. 🤘</p></div>`,
    }),
  });
  if (!res.ok) { console.error(`resend ${res.status}`); return false; }
  return true;
}

async function sendSlack(webhookUrl, a) {
  if (!webhookUrl) { console.log(`[slack:stub] ${a.message}`); return false; }
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: `🤘 *moshcode needs you* — ${a.message}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `🤘 *moshcode needs you*\n*${a.message}*\n_${a.script || "moshscript"}_` } },
        { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open & respond →" }, url: a.url, style: "primary" }] },
      ],
    }),
  });
  return res.ok;
}

async function sendTelegram(chatId, a) {
  if (!config.telegram.botToken || !chatId) { console.log(`[telegram:stub] ${a.message}`); return false; }
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `🤘 *moshcode needs you*\n${a.message}\n${a.url}`,
      parse_mode: "Markdown",
    }),
  });
  return res.ok;
}

async function sendPush(user, a) {
  const subs = await all(`SELECT * FROM push_subscriptions WHERE user_id = ?`, [user.id]);
  if (!subs.length || !config.push.vapidPublic) { console.log(`[push:stub] ${a.message}`); return subs.length ? true : false; }
  const payload = JSON.stringify({ title: "moshcode needs you 🤘", body: a.message, url: a.url });
  let any = false;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      any = true;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await run(`DELETE FROM push_subscriptions WHERE id = ?`, [s.id]);
    }
  }
  return any;
}

// Deliver to enabled channels (optionally limited to `onlyKinds`); returns kinds
// that accepted, so the caller charges for real deliveries only.
export async function fanOut(user, approval, onlyKinds = null) {
  let channels = await all(`SELECT kind, target FROM channels WHERE user_id = ? AND enabled = 1`, [user.id]);
  if (onlyKinds) channels = channels.filter((c) => onlyKinds.includes(c.kind));
  const notified = [];
  for (const c of channels) {
    try {
      let ok = false;
      if (c.kind === "email") ok = await sendEmail(c.target || user.email, approval);
      else if (c.kind === "slack") ok = await sendSlack(c.target || config.slack.defaultWebhook, approval);
      else if (c.kind === "telegram") ok = await sendTelegram(c.target, approval);
      else if (c.kind === "push") ok = await sendPush(user, approval);
      else { console.log(`[${c.kind}:stub] ${approval.message}`); ok = true; } // sms/webhook
      if (ok) notified.push(c.kind);
    } catch (e) {
      console.error(`deliver ${c.kind} failed:`, e.message);
    }
  }
  return notified;
}
