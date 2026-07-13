// Dashboard (/app) + account settings (/settings).
import { Router } from "express";
import { get, all, run } from "../db.mjs";
import { id } from "../lib/crypto.mjs";
import { page, footer, appBar, esc } from "../lib/html.mjs";
import { requireAuth, csrfInput } from "../lib/session.mjs";
import { balance, ledger, CHANNEL_COST } from "../lib/credits.mjs";
import { createApiKey, listApiKeys, revokeApiKey } from "../lib/apikey.mjs";
import { PACKS } from "./credits.mjs";
import { config } from "../config.mjs";

export const pagesRouter = Router();

const timeago = (ts) => {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// ---------- dashboard ----------
// The dashboard lives at the root (/) when signed in; also reachable at /dashboard.
export async function dashboardHandler(req, res) {
  const uid = req.user.id;
  const [bal, pending, resolved, led] = await Promise.all([
    balance(uid),
    all(`SELECT * FROM approvals WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC`, [uid]),
    all(`SELECT * FROM approvals WHERE user_id = ? AND status != 'pending' ORDER BY submitted_at DESC LIMIT 6`, [uid]),
    ledger(uid),
  ]);

  const pendingHtml = pending.length ? pending.map((a) => `
    <a class="q-row" href="/approve/${a.id}" style="display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;padding:15px 16px;border-bottom:1px solid var(--line)">
      <span class="beat" style="background:var(--warn)"></span>
      <div><div style="font-weight:700">${esc(a.message)}</div>
        <div class="mono faint" style="font-size:.72rem;margin-top:2px">${esc(a.script || "moshscript")} · ${a.kind}()</div></div>
      <div class="mono dim" style="font-size:.72rem;text-align:right">${timeago(a.created_at)}<br><span class="acid">respond →</span></div>
    </a>`).join("")
    : `<div class="card-body dim mono" style="font-size:.82rem">nothing waiting — the pit is quiet. Wire <span class="acid">ask()</span> into a .mosh script and it'll show up here.</div>`;

  const resolvedHtml = resolved.length ? resolved.map((a) => `
    <div style="display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line)" class="mono" >
      <span class="${a.status === "killed" ? "" : "acid"}" style="${a.status === "killed" ? "color:var(--danger)" : ""}">${a.status === "killed" ? "✕" : "✓"}</span>
      <span class="dim" style="font-size:.8rem"><b style="color:var(--text)">${esc(a.message)}</b>${a.response ? ` → “${esc(a.response)}”` : ""}</span>
      <span class="faint" style="font-size:.74rem">${a.submitted_at ? timeago(a.submitted_at) : ""}</span>
    </div>`).join("")
    : `<div class="card-body faint mono" style="font-size:.8rem">no history yet.</div>`;

  const ledgerHtml = led.map((l) => `
    <div style="display:grid;grid-template-columns:1fr auto;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)" class="mono">
      <span class="dim" style="font-size:.76rem">${esc(l.reason)}</span>
      <span style="font-variant-numeric:tabular-nums;color:${l.delta >= 0 ? "var(--acid)" : "var(--warn)"}">${l.delta >= 0 ? "+" : ""}${l.delta}</span>
    </div>`).join("") || `<div class="faint mono" style="font-size:.78rem;padding:8px 0">no activity yet</div>`;

  const body = `${appBar(req.user, bal)}
  <div class="strip" style="border-bottom:1px solid var(--line);background:var(--bg-tint)"><div class="wrap" style="display:flex;gap:16px;padding:11px 0;font-family:var(--mono);font-size:.76rem;color:var(--dim);flex-wrap:wrap">
    <span style="color:var(--text)"><span class="beat"></span> ${pending.length} waiting on you</span>
    <span class="faint">·</span><span>balance ${bal.toLocaleString()} cr</span>
    <span class="faint">·</span><span class="acid">#moshing</span>
  </div></div>
  <main class="wrap" style="padding:26px 0 40px"><div class="grid">
    <div class="col">
      <div>
        <div class="section-title"><h2>Needs you</h2><span class="count">${pending.length} paused</span></div>
        <div class="card">${pendingHtml}</div>
      </div>
      <div>
        <div class="section-title"><h2>Moshed</h2><span class="label" style="letter-spacing:.16em">recent</span></div>
        <div class="card">${resolvedHtml}</div>
      </div>
    </div>
    <div class="col">
      <div class="card">
        <div class="card-head"><span class="h">Credits</span><span class="pill on">prepaid</span></div>
        <div class="card-body">
          <div style="display:flex;align-items:baseline;gap:9px"><span style="font-family:var(--sans);font-weight:800;font-size:2.4rem;letter-spacing:-.03em;font-variant-numeric:tabular-nums">${bal.toLocaleString()}</span><span class="mono dim" style="font-size:.82rem">credits</span></div>
          <form method="post" action="/credits/buy" style="margin-top:14px">${csrfInput(req)}
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${Object.entries(PACKS).map(([k, p]) => `<button class="btn ${k === "pro" ? "acid" : ""}" name="pack" value="${k}">${p.credits.toLocaleString()}·$${p.usd}</button>`).join("")}
            </div>
            <div class="faint mono" style="font-size:.7rem;margin-top:8px">pay with CoinPay — crypto or card</div>
          </form>
          <div style="margin-top:16px;border-top:1px solid var(--line)">${ledgerHtml}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><span class="h">Channels</span><a class="pill" href="/settings">manage</a></div>
        <div class="card-body">
          <p class="dim mono" style="font-size:.8rem;margin-top:0">where your pings land — email, Slack, Telegram, SMS, push. Configure in <a class="acid" href="/settings">settings</a>.</p>
          <button class="btn block" id="push-btn" data-vapid="${esc(config.push.vapidPublic)}" style="margin-top:6px">🔔 Enable push on this device</button>
        </div>
      </div>
    </div>
  </div></main>${footer}
  <script src="/push.js"></script>`;
  res.type("html").send(page({ title: "moshcode ▸ dashboard", body }));
}

pagesRouter.get("/dashboard", requireAuth, dashboardHandler);
pagesRouter.get("/app", (req, res) => res.redirect(301, "/")); // legacy → root

// ---------- settings ----------
const CHANNEL_KINDS = ["push", "email", "slack", "telegram", "sms", "webhook"];

pagesRouter.get("/settings", requireAuth, async (req, res) => {
  const uid = req.user.id;
  const [bal, chans, keys] = await Promise.all([
    balance(uid),
    all(`SELECT * FROM channels WHERE user_id = ?`, [uid]),
    listApiKeys(uid),
  ]);
  const byKind = Object.fromEntries(chans.map((c) => [c.kind, c]));
  const newKey = req.query.key ? String(req.query.key) : "";
  const err = req.query.err ? String(req.query.err) : "";

  const chanRows = CHANNEL_KINDS.map((kind) => {
    const c = byKind[kind] || { enabled: 0, target: "" };
    const cost = CHANNEL_COST[kind];
    return `<div style="display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)">
      <label style="display:flex;align-items:center;gap:8px;min-width:120px;margin:0"><input type="checkbox" name="on_${kind}" ${c.enabled ? "checked" : ""} style="width:auto"> <span class="mono" style="text-transform:uppercase;font-size:.72rem;letter-spacing:.1em">${kind}</span></label>
      ${kind === "push" ? `<span class="faint mono" style="font-size:.72rem;flex:1">this device</span>` : `<input name="target_${kind}" value="${esc(c.target || "")}" placeholder="${kind === "email" ? "you@example.com" : kind === "webhook" ? "https://…" : kind === "sms" ? "+1…" : "@handle / #channel"}" style="flex:1">`}
      <span class="mono ${cost === 0 ? "acid" : "dim"}" style="font-size:.72rem;min-width:44px;text-align:right">${cost === 0 ? "free" : cost + " cr"}</span>
    </div>`;
  }).join("");

  const keysHtml = keys.length ? keys.map((k) => `
    <div style="display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)" class="mono">
      <span style="flex:1">${esc(k.name)} <span class="faint">${esc(k.prefix)}…</span></span>
      <form method="post" action="/settings/apikeys/${k.id}/delete" style="margin:0">${csrfInput(req)}<button class="btn danger" style="padding:5px 10px;font-size:.72rem">revoke</button></form>
    </div>`).join("") : `<div class="faint mono" style="font-size:.78rem;padding:6px 0">no keys yet</div>`;

  const body = `${appBar(req.user, bal)}
  <main class="wrap" style="max-width:720px;padding-top:30px">
    <h1 style="font-size:1.5rem;margin-bottom:20px">Settings</h1>
    ${err ? `<div class="notice err">${esc(err.replace(/-/g, " "))}</div>` : ""}
    ${newKey ? `<div class="notice ok">New API key (copy it now — shown once):<br><b class="mono" style="word-break:break-all">${esc(newKey)}</b></div>` : ""}

    <div class="card" style="margin-bottom:22px"><div class="card-head"><span class="h">Channels · where pings land</span></div>
      <div class="card-body"><form method="post" action="/settings/channels">${csrfInput(req)}
        ${chanRows}
        <button class="btn acid" style="margin-top:16px">Save channels</button>
      </form></div>
    </div>

    <div class="card" style="margin-bottom:22px"><div class="card-head"><span class="h">API keys · for the moshcode CLI</span></div>
      <div class="card-body">
        <p class="dim mono" style="font-size:.78rem;margin-top:0">Point the CLI at this app: <span class="acid">MOSHCODE_API=${esc(config.origin)}</span> and send <span class="acid">Authorization: Bearer &lt;key&gt;</span>.</p>
        ${keysHtml}
        <form method="post" action="/settings/apikeys" style="margin-top:14px;display:flex;gap:10px">${csrfInput(req)}
          <input name="name" placeholder="key name (e.g. laptop)" style="flex:1">
          <button class="btn">Create key</button>
        </form>
      </div>
    </div>
  </main>${footer}`;
  res.type("html").send(page({ title: "moshcode ▸ settings", body }));
});

pagesRouter.post("/settings/channels", requireAuth, async (req, res) => {
  const uid = req.user.id;
  const existing = Object.fromEntries((await all(`SELECT * FROM channels WHERE user_id = ?`, [uid])).map((c) => [c.kind, c]));
  for (const kind of CHANNEL_KINDS) {
    const enabled = req.body[`on_${kind}`] ? 1 : 0;
    const target = kind === "push" ? null : String(req.body[`target_${kind}`] || "").trim() || null;
    if (existing[kind]) {
      await run(`UPDATE channels SET enabled = ?, target = ? WHERE id = ?`, [enabled, target, existing[kind].id]);
    } else {
      await run(`INSERT INTO channels (id,user_id,kind,target,enabled,created_at) VALUES (?,?,?,?,?,?)`,
        [id(), uid, kind, target, enabled, Date.now()]);
    }
  }
  res.redirect("/settings");
});

pagesRouter.post("/settings/apikeys", requireAuth, async (req, res) => {
  const { plaintext } = await createApiKey(req.user.id, String(req.body.name || "cli").slice(0, 40));
  res.redirect("/settings?key=" + encodeURIComponent(plaintext));
});

pagesRouter.post("/settings/apikeys/:id/delete", requireAuth, async (req, res) => {
  await revokeApiKey(req.user.id, req.params.id);
  res.redirect("/settings");
});

// web push subscription for this device (session-authed; CSRF via x-csrf-token)
pagesRouter.post("/push/subscribe", requireAuth, async (req, res) => {
  const { endpoint, p256dh, auth } = req.body || {};
  if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: "bad subscription" });
  const existing = await get(`SELECT id FROM push_subscriptions WHERE endpoint = ?`, [endpoint]);
  if (existing) await run(`UPDATE push_subscriptions SET user_id=?, p256dh=?, auth=? WHERE endpoint=?`, [req.user.id, p256dh, auth, endpoint]);
  else await run(`INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,created_at) VALUES (?,?,?,?,?,?)`,
    [id(), req.user.id, endpoint, p256dh, auth, Date.now()]);
  res.json({ ok: true });
});
