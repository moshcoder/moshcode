// `moshcode login` OAuth-style flow (authorization code + PKCE + loopback):
//   GET  /cli/authorize   browser lands here (login required) → approve page
//   POST /cli/authorize   approve → mint a code, redirect to the CLI's loopback
//   POST /cli/token       CLI exchanges code + verifier → an API key (bearer)
//   GET  /api/me          Bearer → who am I (for `moshcode whoami`)
import { Router } from "express";
import crypto from "node:crypto";
import { get, run } from "../db.mjs";
import { id, token, sha256 } from "../lib/crypto.mjs";
import { page, footer, appBar, esc } from "../lib/html.mjs";
import { requireAuth, csrfInput } from "../lib/session.mjs";
import { createApiKey, bearer, userForApiKey } from "../lib/apikey.mjs";
import { balance } from "../lib/credits.mjs";
import { config } from "../config.mjs";

export const cliRouter = Router();

// Unambiguous alphabet for the short human device code (no 0/O/1/I/L/vowels).
const CODE_ALPHA = "BCDFGHJKMNPQRSTVWXYZ23456789";
function makeUserCode() {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHA[crypto.randomInt(CODE_ALPHA.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const normCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(.{4})(.{4})/, "$1-$2");

// Only loopback redirect URIs are allowed (the CLI listens on 127.0.0.1).
function loopbackOk(uri) {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch { return false; }
}

cliRouter.get("/cli/authorize", requireAuth, (req, res) => {
  const { redirect_uri, state, code_challenge } = req.query;
  if (!loopbackOk(redirect_uri) || !state || !code_challenge) {
    return res.status(400).type("html").send(page({ body: `<main class="wrap" style="padding-top:12vh"><h1>Bad CLI request</h1><p class="dim mono">missing/invalid redirect_uri, state, or code_challenge.</p></main>` }));
  }
  const name = String(req.query.name || "moshcode cli").slice(0, 40);
  const body = `${appBar(req.user, 0)}
  <main class="wrap" style="max-width:460px;padding-top:8vh">
    <div class="card"><div class="card-body" style="text-align:center">
      <div style="font-size:2rem">🔑</div>
      <h1 style="font-size:1.4rem;margin:10px 0">Authorize the moshcode CLI</h1>
      <p class="dim mono" style="font-size:.82rem">Grant <b class="acid">${esc(name)}</b> on this machine access to create &amp; read approvals as <b>${esc(req.user.email || req.user.display_name)}</b>. This is how <span class="acid">notify()</span> / <span class="acid">ask()</span> reach you.</p>
      <form method="post" action="/cli/authorize" style="margin-top:18px">
        ${csrfInput(req)}
        <input type="hidden" name="redirect_uri" value="${esc(redirect_uri)}">
        <input type="hidden" name="state" value="${esc(state)}">
        <input type="hidden" name="code_challenge" value="${esc(code_challenge)}">
        <input type="hidden" name="name" value="${esc(name)}">
        <button class="btn acid block" type="submit">Authorize &amp; connect 🤘</button>
      </form>
      <p class="faint mono" style="font-size:.72rem;margin-top:12px">You'll return to your terminal.</p>
    </div></div>
  </main>${footer}`;
  res.type("html").send(page({ title: "moshcode ▸ authorize CLI", body }));
});

cliRouter.post("/cli/authorize", requireAuth, async (req, res) => {
  const { redirect_uri, state, code_challenge, name } = req.body;
  if (!loopbackOk(redirect_uri) || !state || !code_challenge) return res.status(400).send("bad request");
  const code = token(24);
  const now = Date.now();
  await run(
    `INSERT INTO cli_auth_codes (code,user_id,code_challenge,redirect_uri,name,created_at,expires_at) VALUES (?,?,?,?,?,?,?)`,
    [code, req.user.id, code_challenge, redirect_uri, String(name || "cli").slice(0, 40), now, now + 5 * 60 * 1000]
  );
  const u = new URL(redirect_uri);
  u.searchParams.set("code", code);
  u.searchParams.set("state", state);
  res.redirect(u.toString());
});

cliRouter.post("/cli/token", async (req, res) => {
  const { code, code_verifier } = req.body || {};
  if (!code || !code_verifier) return res.status(400).json({ error: "code and code_verifier required" });
  const row = await get(`SELECT * FROM cli_auth_codes WHERE code = ?`, [code]);
  if (!row || row.used || row.expires_at < Date.now()) return res.status(400).json({ error: "invalid or expired code" });

  // PKCE: base64url(sha256(verifier)) must equal the stored challenge
  const challenge = crypto.createHash("sha256").update(String(code_verifier)).digest("base64url");
  if (challenge !== row.code_challenge) return res.status(400).json({ error: "PKCE verification failed" });

  await run(`UPDATE cli_auth_codes SET used = 1 WHERE code = ?`, [code]);
  const user = await get(`SELECT * FROM users WHERE id = ?`, [row.user_id]);
  const { plaintext } = await createApiKey(user.id, row.name || "moshcode cli");
  res.json({ access_token: plaintext, token_type: "bearer", user: { id: user.id, email: user.email || null, name: user.display_name } });
});

cliRouter.get("/api/me", async (req, res) => {
  const user = await userForApiKey(bearer(req));
  if (!user) return res.status(401).json({ error: "invalid or missing API key" });
  res.json({ id: user.id, email: user.email || null, name: user.display_name, credits: await balance(user.id) });
});

// ---- device-code flow (headless / CI: `moshcode login --device`) ----

// CLI asks for a code pair.
cliRouter.post("/cli/device/code", async (req, res) => {
  const deviceCode = token(32);
  let userCode = makeUserCode();
  // avoid the astronomically-unlikely collision on the human code
  for (let i = 0; i < 3 && await get(`SELECT 1 FROM device_codes WHERE user_code = ?`, [userCode]); i++) userCode = makeUserCode();
  const now = Date.now();
  const interval = 5, ttl = 10 * 60 * 1000;
  await run(
    `INSERT INTO device_codes (device_code,user_code,status,name,interval_s,created_at,expires_at) VALUES (?,?,?,?,?,?,?)`,
    [deviceCode, userCode, "pending", String(req.body?.name || "moshcode cli").slice(0, 40), interval, now, now + ttl]
  );
  res.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${config.origin}/device`,
    verification_uri_complete: `${config.origin}/device?code=${encodeURIComponent(userCode)}`,
    expires_in: Math.floor(ttl / 1000),
    interval,
  });
});

// The page a human opens to approve a device.
cliRouter.get("/device", requireAuth, (req, res) => {
  const prefill = req.query.code ? normCode(req.query.code) : "";
  const done = req.query.done;
  const bad = req.query.bad;
  const body = `${appBar(req.user, 0)}
  <main class="wrap" style="max-width:440px;padding-top:8vh">
    <div class="card"><div class="card-body" style="text-align:center">
      <div style="font-size:2rem">🔑</div>
      <h1 style="font-size:1.4rem;margin:10px 0">Connect a device</h1>
      ${done ? `<div class="notice ok">✓ device connected — return to your terminal 🤘</div>`
        : `<p class="dim mono" style="font-size:.82rem">Enter the code shown in your terminal to authorize the moshcode CLI as <b>${esc(req.user.email || req.user.display_name)}</b>.</p>
        ${bad ? `<div class="notice err">that code is invalid or expired — check your terminal.</div>` : ""}
        <form method="post" action="/device" style="margin-top:14px">${csrfInput(req)}
          <input name="user_code" value="${esc(prefill)}" placeholder="XXXX-XXXX" autocomplete="off" autocapitalize="characters"
            style="text-align:center;font-size:1.3rem;letter-spacing:.2em;text-transform:uppercase" required>
          <button class="btn acid block" type="submit" style="margin-top:12px">Authorize 🤘</button>
        </form>`}
    </div></div>
  </main>${footer}`;
  res.type("html").send(page({ title: "moshcode ▸ connect device", body }));
});

cliRouter.post("/device", requireAuth, async (req, res) => {
  const userCode = normCode(req.body.user_code);
  const row = await get(`SELECT * FROM device_codes WHERE user_code = ? AND status = 'pending' AND expires_at > ?`, [userCode, Date.now()]);
  if (!row) return res.redirect(`/device?bad=1${req.body.user_code ? "&code=" + encodeURIComponent(req.body.user_code) : ""}`);
  await run(`UPDATE device_codes SET status = 'approved', user_id = ? WHERE device_code = ?`, [req.user.id, row.device_code]);
  res.redirect("/device?done=1");
});

// CLI polls here until approved.
cliRouter.post("/cli/device/token", async (req, res) => {
  const row = await get(`SELECT * FROM device_codes WHERE device_code = ?`, [req.body?.device_code || ""]);
  if (!row || row.expires_at < Date.now() || row.status === "claimed") return res.status(400).json({ error: "expired_token" });
  if (row.status === "denied") return res.status(400).json({ error: "access_denied" });
  if (row.status !== "approved") return res.status(400).json({ error: "authorization_pending" });

  await run(`UPDATE device_codes SET status = 'claimed' WHERE device_code = ?`, [row.device_code]);
  const user = await get(`SELECT * FROM users WHERE id = ?`, [row.user_id]);
  const { plaintext } = await createApiKey(user.id, row.name || "moshcode cli");
  res.json({ access_token: plaintext, token_type: "bearer", user: { id: user.id, email: user.email || null, name: user.display_name } });
});
