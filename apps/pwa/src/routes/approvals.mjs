// The human-in-the-loop approvals surface.
//   POST /api/approvals        ingest from the CLI (Bearer API key) → fan out + charge
//   GET  /api/approvals/:id    CLI long-poll (Bearer owner, or ?t=cap) → {status,response}
//   GET  /approve/:id          human page (session owner, or ?t=cap)
//   POST /approve/:id          submit a response (approve / redirect)
//   POST /approve/:id/kill     kill the loop
import { Router } from "express";
import { get, run } from "../db.mjs";
import { config } from "../config.mjs";
import { id, token } from "../lib/crypto.mjs";
import { bearer, userForApiKey } from "../lib/apikey.mjs";
import { verifySignature } from "../lib/signature.mjs";
import { balance, charge, costOf } from "../lib/credits.mjs";
import { fanOut } from "../lib/deliver.mjs";
import { page, footer, appBar, esc } from "../lib/html.mjs";
import { csrfInput } from "../lib/session.mjs";

export const approvalsRouter = Router();

const linkFor = (a) => `${config.origin}/approve/${a.id}?t=${a.cap_token}`;

// ---- CLI ingest ----
approvalsRouter.post("/api/approvals", async (req, res) => {
  const user = await userForApiKey(bearer(req));
  if (!user) return res.status(401).json({ error: "invalid or missing API key" });
  // optional signature check (defense in depth) when both sides share the secret
  if (config.ingestSecret && req.get("x-moshcode-signature")) {
    if (!verifySignature(req.get("x-moshcode-signature"), req.rawBody || "", config.ingestSecret)) {
      return res.status(401).json({ error: "bad signature" });
    }
  }
  const message = String(req.body?.message || "").slice(0, 500);
  if (!message) return res.status(400).json({ error: "message required" });

  const approval = {
    id: id(),
    user_id: user.id,
    script: req.body?.script ? String(req.body.script).slice(0, 200) : null,
    message,
    context: req.body?.context ? JSON.stringify(req.body.context) : null,
    kind: req.body?.kind === "notify" ? "notify" : "ask",
    cap_token: token(18),
    created_at: Date.now(),
  };
  const url = `${config.origin}/approve/${approval.id}?t=${approval.cap_token}`;

  // decide which channels we can afford, deliver only to those, then charge for
  // what actually went out (so the ledger always matches reality)
  const { all } = await import("../db.mjs");
  const enabled = (await all(`SELECT kind FROM channels WHERE user_id = ? AND enabled = 1`, [user.id])).map((r) => r.kind);
  const fullCost = costOf(enabled);
  const bal = await balance(user.id);
  const affordable = bal >= fullCost ? enabled : enabled.filter((k) => costOf([k]) === 0);

  const notified = await fanOut(user, { ...approval, url }, affordable);
  const cost = costOf(notified);

  await run(
    `INSERT INTO approvals (id,user_id,script,message,context,kind,status,cap_token,channels,cost,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [approval.id, approval.user_id, approval.script, approval.message, approval.context, approval.kind,
     "pending", approval.cap_token, JSON.stringify(notified), cost, approval.created_at]
  );

  if (cost > 0) await charge(user.id, cost, "approval.delivered", { id: approval.id, channels: notified });

  res.status(201).json({
    id: approval.id,
    url,
    status: "pending",
    delivered: notified,
    charged: cost,
    warning: bal < fullCost ? "insufficient credits — only free channels were used" : undefined,
  });
});

// ---- CLI poll ----
approvalsRouter.get("/api/approvals/:id", async (req, res) => {
  const a = await get(`SELECT * FROM approvals WHERE id = ?`, [req.params.id]);
  if (!a) return res.status(404).json({ error: "not found" });
  const viaCap = req.query.t && req.query.t === a.cap_token;
  const viaKey = (await userForApiKey(bearer(req)))?.id === a.user_id;
  if (!viaCap && !viaKey) return res.status(403).json({ error: "forbidden" });
  res.json({ id: a.id, status: a.status, response: a.response ?? null });
});

// ---- human page ----
function canView(req, a) {
  return (req.query.t && req.query.t === a.cap_token) || (req.user && req.user.id === a.user_id);
}

approvalsRouter.get("/approve/:id", async (req, res) => {
  const a = await get(`SELECT * FROM approvals WHERE id = ?`, [req.params.id]);
  if (!a) return res.status(404).type("html").send(page({ body: `<main class="wrap" style="padding-top:12vh"><h1>404 — no such approval</h1></main>` }));
  if (!canView(req, a)) return res.status(403).type("html").send(page({ body: `<main class="wrap" style="padding-top:12vh"><h1>403 — not your pit</h1></main>` }));

  const ctx = a.context ? JSON.parse(a.context) : {};
  const done = a.status !== "pending";
  const cells = Object.entries(ctx).map(([k, v]) =>
    `<div style="background:var(--surface);padding:11px 13px;border:1px solid var(--line);border-radius:8px">
      <div class="label" style="font-size:.6rem">${esc(k)}</div><div class="mono" style="margin-top:3px">${esc(String(v))}</div></div>`).join("");

  const t = req.query.t ? `?t=${esc(req.query.t)}` : "";
  const body = `${appBar(req.user, req.user ? await balance(req.user.id) : 0)}
  <main class="wrap" style="max-width:560px;padding-top:40px">
    <div class="card">
      <div class="card-head"><span class="h">${esc(a.script || "moshscript")} · ${a.kind}()</span>
        <span class="pill ${done ? "on" : "warn"}">${done ? esc(a.status) : "paused for you"}</span></div>
      <div class="card-body">
        <h1 style="font-size:1.7rem;letter-spacing:-.02em">${esc(a.message)}</h1>
        ${cells ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px">${cells}</div>` : ""}
        ${done
          ? `<div class="notice ok" style="margin-top:18px">${a.status === "submitted" ? `You replied: “${esc(a.response || "")}”` : "This loop was killed."}</div>`
          : `<form method="post" action="/approve/${a.id}${t}" style="margin-top:18px">${csrfInput(req)}
              <label class="field"><span>Instructions back to the script (optional)</span>
                <textarea name="response" rows="3" placeholder="e.g. yes — and bump the tag to v2.1"></textarea></label>
              <div style="display:flex;gap:10px;flex-wrap:wrap">
                <button class="btn acid" type="submit">Approve &amp; continue</button>
                <button class="btn" type="submit" name="redirect" value="1">Send instructions</button>
              </div>
            </form>
            <form method="post" action="/approve/${a.id}/kill${t}" style="margin-top:10px">${csrfInput(req)}
              <button class="btn danger" type="submit">Kill the loop</button></form>`}
      </div>
    </div>
  </main>${footer}`;
  res.type("html").send(page({ title: "moshcode ▸ approve", body }));
});

async function resolve(req, res, status, response) {
  const a = await get(`SELECT * FROM approvals WHERE id = ?`, [req.params.id]);
  if (!a) return res.status(404).send("not found");
  if (!canView(req, a)) return res.status(403).send("forbidden");
  if (a.status === "pending") {
    await run(`UPDATE approvals SET status = ?, response = ?, submitted_at = ? WHERE id = ?`,
      [status, response, Date.now(), a.id]);
  }
  const t = req.query.t ? `?t=${req.query.t}` : "";
  res.redirect(`/approve/${a.id}${t}`);
}

approvalsRouter.post("/approve/:id", (req, res) => resolve(req, res, "submitted", String(req.body.response || "").slice(0, 2000)));
approvalsRouter.post("/approve/:id/kill", (req, res) => resolve(req, res, "killed", null));
