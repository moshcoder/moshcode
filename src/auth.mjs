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
export function saveCreds(creds) {
  fs.mkdirSync(CREDS_DIR, { recursive: true });
  fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.chmodSync(credsPath, 0o600);
}

/**
 * True when the loopback flow can't work: the browser that opens the authorize
 * URL is on a *different* machine than this process, so the callback to
 * 127.0.0.1 lands on that machine and never reaches our listener. SSH sessions
 * and headless boxes (a droplet, a container, CI) are exactly that case — there
 * the device-code flow is the only one that can finish.
 */
export function isRemoteShell() {
  const forced = String(process.env.MOSHCODE_LOGIN || "").toLowerCase();
  if (forced === "browser") return false;
  if (forced === "device") return true;
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT) return true;
  // No display server on Linux → nothing here can open a browser for us.
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return true;
  return false;
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

/**
 * Pick the login flow that can actually finish here. Over SSH or on a headless
 * box the loopback callback is undeliverable (it hits the *browser's* machine),
 * so fall back to the device code instead of stranding you on a dead
 * 127.0.0.1 URL. `device: true` / `browser: true` force one either way.
 */
export async function loginAuto({ device = false, browser = false } = {}) {
  const remote = !browser && (device || isRemoteShell());
  if (!remote) return login();
  if (!device) {
    console.log(`\n🖥  remote/headless shell — using the device-code flow.`);
    console.log(`   (a loopback callback would open on the browser's machine, not this one.)`);
  }
  return loginDevice({ open: !isRemoteShell() });
}

/**
 * Who is logged in, as a value — the shape `whoami --json` prints, and what
 * moshscript's whoami()/requireLogin() read (src/commands.mjs).
 *
 * Returning rather than printing is the point: a script needs to branch on the
 * account ("do I have credits?", "is this the right email?"), and the only way
 * to get that out of a printing function is to re-parse its stdout. One
 * verified-identity implementation, two callers — the CLI renders it, the
 * script reads it — so the two can never disagree about what "logged in" means.
 *
 * Never throws: an unreachable app is a `status` like any other, because the
 * caller is usually deciding whether to *start* work, not reporting an outage.
 */
export async function identity() {
  const creds = loadCreds();
  if (!creds?.token) {
    return { status: "not_logged_in", verified: false, api: API(), user: null };
  }
  const api = creds.api || API();
  // What we know locally, used for every unverified outcome. Deliberately not
  // presented as confirmed: the app is the authority on the account, and these
  // fields are only what the last successful login happened to write down.
  const localUser = {
    id: creds.id ?? null,
    email: creds.email ?? null,
    name: null,
    credits: null,
  };
  try {
    const res = await fetch(`${api}/api/me`, { headers: { authorization: `Bearer ${creds.token}` } });
    if (res.status === 401) {
      return { status: "expired", verified: false, api, user: localUser, error: { type: "auth", status: 401 } };
    }
    // Any other error status still has a body, and it isn't an account — reading
    // it as one reports a made-up identity for a session the app just refused.
    if (!res.ok) {
      return { status: "unverified", verified: false, api, user: localUser, error: { type: "http", status: res.status } };
    }
    const me = await res.json();
    return {
      status: "authenticated",
      verified: true,
      api,
      user: {
        id: me.id ?? creds.id ?? null,
        email: me.email ?? creds.email ?? null,
        name: me.name ?? null,
        credits: me.credits ?? null,
      },
    };
  } catch {
    return { status: "unreachable", verified: false, api, user: localUser, error: { type: "network" } };
  }
}

/** Print who is logged in (verified against the app). */
export async function whoami({ json = false } = {}) {
  const me = await identity();
  if (json) {
    console.log(JSON.stringify(me, null, 2));
    return;
  }
  const who = me.user?.email || me.user?.name;
  switch (me.status) {
    case "not_logged_in":
      console.log("not logged in — run: moshcode login");
      return;
    case "expired":
      console.log("session expired — run: moshcode login");
      return;
    case "unverified":
      console.log(`${who || "logged in"} @ ${me.api} (couldn't verify — the app returned ${me.error.status})`);
      return;
    case "unreachable":
      console.log(`${who || "logged in"} @ ${me.api} (couldn't reach the app to verify)`);
      return;
    default:
      console.log(`${who || "moshcoder"} 🤘  (${me.user.credits ?? "?"} credits)  @ ${me.api}`);
  }
}

/** Forget local credentials. */
export function logout() {
  try { fs.rmSync(credsPath); console.log("logged out 🤘"); }
  catch { console.log("already logged out"); }
}
