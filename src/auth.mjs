// `moshcode login` — browser OAuth-style flow (authorization code + PKCE +
// loopback) that authenticates against the moshcode app (app.moshcode.sh) and
// stores an API token locally. That token is what moshscript's notify()/ask()
// use to reach you (see src/notify.mjs), so a single `moshcode login` wires up
// the whole human-in-the-loop for scripts too.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const API = () => (process.env.MOSHCODE_API || "https://app.moshcode.sh").replace(/\/+$/, "");
const CREDS_DIR = path.join(os.homedir(), ".moshcode");
export const credsPath = path.join(CREDS_DIR, "credentials.json");

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Stored credentials, or null. { api, token, email } */
export function loadCreds() {
  try { return JSON.parse(fs.readFileSync(credsPath, "utf8")); } catch { return null; }
}
function saveCreds(creds) {
  fs.mkdirSync(CREDS_DIR, { recursive: true });
  fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try { const c = spawn(cmd, args, { stdio: "ignore", detached: true }); c.on("error", () => {}); c.unref(); } catch { /* print fallback */ }
}

const donePage = (msg) =>
  `<!doctype html><meta charset=utf-8><body style="background:#070806;color:#edf2e4;font-family:ui-monospace,monospace;text-align:center;padding:16vh 24px">
   <div style="font-size:2rem">🤘</div><h1 style="color:#a6ff1a">${msg}</h1><p>Return to your terminal. You can close this tab.</p></body>`;

/** Run the login flow. Returns { email } on success; throws on failure/timeout. */
export function login({ timeoutMs = 180000 } = {}) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      try {
        if (err) throw new Error(`authorization denied (${err})`);
        if (!code || gotState !== state) throw new Error("bad authorization response (state mismatch)");
        const tokRes = await fetch(`${API()}/cli/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, code_verifier: verifier }),
        });
        if (!tokRes.ok) throw new Error(`token exchange failed (${tokRes.status})`);
        const tok = await tokRes.json();
        saveCreds({ api: API(), token: tok.access_token, email: tok.user?.email || null, id: tok.user?.id });
        res.writeHead(200, { "content-type": "text/html" }).end(donePage("you're in 🤘"));
        server.close();
        resolve({ email: tok.user?.email || null });
      } catch (e) {
        res.writeHead(400, { "content-type": "text/html" }).end(donePage("login failed — check the terminal"));
        server.close();
        reject(e);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirect = `http://127.0.0.1:${port}/callback`;
      const authUrl = `${API()}/cli/authorize?` + new URLSearchParams({
        redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: "S256",
        name: `moshcode cli @ ${os.hostname()}`,
      });
      console.log(`\n🔑 opening your browser to authorize the moshcode CLI…`);
      console.log(`   if it doesn't open, visit:\n   ${authUrl}\n`);
      openBrowser(authUrl);
    });

    const timer = setTimeout(() => { server.close(); reject(new Error("login timed out — run `moshcode login` again")); }, timeoutMs);
    server.on("close", () => clearTimeout(timer));
  });
}

/**
 * Device-code login (headless / CI): no local browser or loopback needed. Prints
 * a short code + URL; you approve it in ANY browser; the CLI polls until done.
 */
export async function loginDevice({ open = true } = {}) {
  const startRes = await fetch(`${API()}/cli/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `moshcode cli @ ${os.hostname()}` }),
  });
  if (!startRes.ok) throw new Error(`couldn't start device login (${startRes.status})`);
  const d = await startRes.json();

  console.log(`\n🔑 to log in, open:  ${d.verification_uri}`);
  console.log(`   and enter code:  \x1b[1m\x1b[38;5;154m${d.user_code}\x1b[0m\n`);
  if (open) openBrowser(d.verification_uri_complete);

  const interval = Math.max(2, d.interval || 5) * 1000;
  const deadline = Date.now() + (d.expires_in || 600) * 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  console.log("   waiting for you to authorize…");
  for (;;) {
    if (Date.now() > deadline) throw new Error("code expired — run `moshcode login --device` again");
    await sleep(interval);
    let data;
    try {
      const r = await fetch(`${API()}/cli/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: d.device_code }),
      });
      data = await r.json();
    } catch { continue; } // transient network — keep polling
    if (data.access_token) {
      saveCreds({ api: API(), token: data.access_token, email: data.user?.email || null, id: data.user?.id });
      return { email: data.user?.email || null };
    }
    if (data.error === "access_denied") throw new Error("authorization denied");
    if (data.error === "expired_token") throw new Error("code expired — run `moshcode login --device` again");
    // authorization_pending / slow_down → keep waiting
  }
}

/** Print who is logged in (verified against the app). */
export async function whoami() {
  const creds = loadCreds();
  if (!creds?.token) { console.log("not logged in — run: moshcode login"); return; }
  try {
    const res = await fetch(`${creds.api || API()}/api/me`, { headers: { authorization: `Bearer ${creds.token}` } });
    if (res.status === 401) { console.log("session expired — run: moshcode login"); return; }
    const me = await res.json();
    console.log(`${me.email || me.name || "moshcoder"} 🤘  (${me.credits ?? "?"} credits)  @ ${creds.api || API()}`);
  } catch {
    console.log(`${creds.email || "logged in"} @ ${creds.api || API()} (couldn't reach the app to verify)`);
  }
}

/** Forget local credentials. */
export function logout() {
  try { fs.rmSync(credsPath); console.log("logged out 🤘"); }
  catch { console.log("already logged out"); }
}
