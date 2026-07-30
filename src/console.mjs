// `moshcode console` — a browser terminal on this box, gated by moshcode login.
//
// Rather than reimplement a terminal in the session mirror (xterm.js, keystroke
// relay, cursor addressing), run ttyd — which is already a terminal — and put an
// authenticating reverse proxy in front of it. You get arrow keys, history, and
// full-screen TUIs because it is a real pty on the other end, not a log view.
//
// WHY THE GATEWAY RUNS HERE, not in apps/pwa: the hosted app is on Railway and
// the shell you want is on this machine. A proxy inside apps/pwa would have to
// reach back across the internet to a port on the dev box, which means exposing
// that port — the exact thing worth avoiding. So the box serves its own gateway
// and asks app.moshcode.sh only "is this token yours?".
//
// SECURITY: everything behind this is a shell. ttyd itself MUST stay bound to
// loopback (`ttyd -i 127.0.0.1`); the only way in is a valid moshcode token,
// which is exchanged once for a short-lived HMAC cookie. Binding the gateway to
// a tailnet address instead of 0.0.0.0 is strictly better and is what the docs
// recommend.
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";

import { loadCreds } from "./auth.mjs";

export const DEFAULT_TTYD = "127.0.0.1:7681";
const COOKIE = "moshcode_console";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // re-auth twice a day

/** Split "host:port" into the pieces net/http want. Defaults to ttyd's port. */
export function parseTarget(target = DEFAULT_TTYD) {
  const cleaned = String(target).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const [host, port] = cleaned.split(":");
  return { host: host || "127.0.0.1", port: Number(port || 7681) };
}

/** Cookies from a raw header — cookie-parser is an express thing and the
 *  websocket upgrade never reaches express. */
export function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    const raw = part.slice(eq + 1).trim();
    // A cookie value is whatever the client chose to send, and decodeURIComponent
    // throws on a stray "%". This runs before any auth check, in an async request
    // handler and in an `upgrade` listener — a throw in either takes the whole
    // gateway down, so an unauthenticated client must not be able to cause one.
    // Falling back to the raw value is what the `cookie` package does too.
    try { out[k] = decodeURIComponent(raw); } catch { out[k] = raw; }
  }
  return out;
}

/**
 * A signed, expiring session value. HMAC over the payload with a per-process
 * secret, so a cookie cannot be forged and does not survive a restart.
 */
export function mintCookie(secret, { user = "", now = Date.now(), ttlMs = SESSION_TTL_MS } = {}) {
  // base64url, not percent-encoding: the field is dot-delimited and an email
  // ("a@profullstack.com") is full of dots that encodeURIComponent leaves alone.
  const payload = `${Buffer.from(String(user)).toString("base64url")}.${now + ttlMs}`;
  const mac = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

/** Verify a cookie minted above. Returns the user, or null when invalid/expired. */
export function readCookie(secret, value, now = Date.now()) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3) return null;
  const [user, expiry, mac] = parts;
  const payload = `${user}.${expiry}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!Number(expiry) || Number(expiry) < now) return null;
  return Buffer.from(user, "base64url").toString("utf8");
}

/**
 * Ask the moshcode app whether this token is a real login. The gateway trusts
 * the app for identity rather than keeping its own user list.
 */
export async function verifyToken(api, token, fetchImpl = fetch) {
  if (!token) return null;
  try {
    const r = await fetchImpl(`${api.replace(/\/+$/, "")}/api/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const body = await r.json().catch(() => ({}));
    return body?.user?.email || body?.email || body?.user?.id || "authenticated";
  } catch {
    return null;
  }
}

const DENIED = `<!doctype html><meta charset="utf-8"><title>moshcode console</title>
<body style="background:#070806;color:#edf2e4;font-family:monospace;padding:14vh 24px;text-align:center">
<h1 style="color:#a6ff1a">🔒 not logged in</h1>
<p>this terminal is gated by your moshcode login.</p>
<p style="color:#8a8f80">run <code>moshcode console</code> on a machine where you have run <code>moshcode login</code>.</p>
</body>`;

/** Copy a client request through to ttyd and stream the answer back. */
function proxyHttp(req, res, target) {
  const upstream = http.request(
    { host: target.host, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: `${target.host}:${target.port}` } },
    (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("console backend unreachable — is ttyd running?");
  });
  req.pipe(upstream);
}

/**
 * Hand the websocket over at the socket level. ttyd's terminal is a websocket,
 * and an upgrade cannot be proxied with http.request — we replay the handshake
 * onto a raw connection and then just let the two sockets talk.
 */
function proxyUpgrade(req, socket, head, target) {
  const upstream = net.connect(target.port, target.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const bail = () => { try { socket.destroy(); } catch { /* already gone */ } };
  upstream.on("error", bail);
  socket.on("error", () => { try { upstream.destroy(); } catch { /* already gone */ } });
}

/**
 * The gateway. `?token=<moshcode token>` authenticates once and is swapped for
 * the cookie, so the token never has to appear again (or sit in browser history
 * for the rest of the session — the handshake redirects it away).
 */
export function createConsoleServer({
  ttyd = DEFAULT_TTYD,
  api = "https://app.moshcode.sh",
  secret = crypto.randomBytes(32).toString("hex"),
  verify = verifyToken,
} = {}) {
  const target = parseTarget(ttyd);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const cookies = parseCookies(req.headers.cookie);
    if (readCookie(secret, cookies[COOKIE])) return proxyHttp(req, res, target);

    const token = url.searchParams.get("token");
    const user = token ? await verify(api, token) : null;
    if (!user) {
      res.writeHead(401, { "content-type": "text/html" });
      return res.end(DENIED);
    }
    // Drop the token from the URL so it stops travelling with every request.
    url.searchParams.delete("token");
    res.writeHead(302, {
      "set-cookie": `${COOKIE}=${mintCookie(secret, { user })}; HttpOnly; SameSite=Lax; Path=/`,
      location: `${url.pathname}${url.search}`,
    });
    res.end();
  });

  server.on("upgrade", (req, socket, head) => {
    // The websocket carries the terminal itself; an unauthenticated upgrade
    // would hand out a shell regardless of how well the page is guarded.
    if (!readCookie(secret, parseCookies(req.headers.cookie)[COOKIE])) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    proxyUpgrade(req, socket, head, target);
  });

  return server;
}

/** The URL to hand a browser: this box's gateway, carrying a one-time token. */
export function consoleUrl(base, token) {
  const u = new URL(String(base));
  if (token) u.searchParams.set("token", token);
  return u.toString();
}

/** `moshcode console` — print (and optionally serve) the browser terminal. */
export async function consoleCommand(args = []) {
  const serve = args.includes("serve");
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const creds = loadCreds();
  const api = creds?.api || "https://app.moshcode.sh";

  if (!serve) {
    const base = flag("url", process.env.MOSHCODE_CONSOLE_URL);
    if (!base) {
      console.error("usage: moshcode console serve [--port 7682] [--ttyd 127.0.0.1:7681] [--bind 127.0.0.1]\n"
        + "       moshcode console --url https://dev.example.com/   (open an existing gateway)");
      return 1;
    }
    if (!creds?.token) { console.error("not logged in — run: moshcode login"); return 1; }
    console.log(consoleUrl(base, creds.token));
    return 0;
  }

  const port = Number(flag("port", 7682));
  const bind = flag("bind", "127.0.0.1");
  const ttyd = flag("ttyd", DEFAULT_TTYD);
  const server = createConsoleServer({ ttyd, api });
  await new Promise((resolve) => server.listen(port, bind, resolve));
  console.log(`🖥  moshcode console gateway on http://${bind}:${port} → ttyd ${ttyd}`);
  console.log(`   auth: moshcode login tokens verified against ${api}`);
  if (bind === "0.0.0.0") {
    console.log("   ! bound to every interface — prefer a tailnet address or a reverse proxy with TLS");
  }
  return new Promise(() => {}); // serve until killed
}
