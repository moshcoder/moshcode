// app.moshcode.sh — Express PWA entrypoint.
import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { config } from "./config.mjs";
import { migrate } from "./migrate.mjs";
import { sessionMiddleware, csrfGuard } from "./lib/session.mjs";
import { authRouter } from "./routes/auth.mjs";
import { passkeyRouter } from "./routes/passkey.mjs";
import { coinpayRouter } from "./routes/coinpay.mjs";
import { approvalsRouter } from "./routes/approvals.mjs";
import { creditsRouter } from "./routes/credits.mjs";
import { cliRouter } from "./routes/cli.mjs";
import { sessionsRouter } from "./routes/sessions.mjs";
import { pagesRouter } from "./routes/pages.mjs";
import { settingsSyncRouter } from "./routes/settings-sync.mjs";
import { moshpitRouter } from "./routes/moshpit.mjs";
import { socialsRouter } from "./routes/socials.mjs";
import { MAX_BATCH, MAX_PUBLISH_BYTES } from "./lib/moshpit-content.mjs";

const app = express();
app.disable("x-powered-by");
if (config.secure) app.set("trust proxy", 1); // Railway terminates TLS

// body parsing — keep the raw body for HMAC signature verification
const captureRaw = (req, _res, buf) => { req.rawBody = buf.toString("utf8"); };

// Publishing takes a batch, and a batch does not fit in body-parser's 100kb
// default: the API documents a ceiling of MAX_BATCH items and would have 413'd
// a legitimate one before the handler ever saw it.
//
// Scoped to the publishing paths rather than raised globally. The limit is what
// stops an unauthenticated POST from making the process buffer megabytes, and
// `verify` above copies every body into a string as well — so the cost of
// raising it is paid on every route, while only this one needs the room.
//
// Mounted BEFORE the global parser because body-parser skips a request whose
// body has already been read. Whichever runs first sets the limit; reverse
// these two lines and the 100kb default silently wins again.
app.use("/api/moshpit/sites", express.json({ limit: MAX_PUBLISH_BYTES, verify: captureRaw }));
app.use(express.json({ verify: captureRaw }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// static
app.use(express.static(path.join(config.root, "public"), { maxAge: "1h" }));
// the @simplewebauthn/browser UMD bundle, served from node_modules (no CDN)
app.get("/vendor/simplewebauthn-browser.umd.js", (_req, res) =>
  res.sendFile(path.join(config.root, "node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js")));
// xterm.js — /sessions/:id is a real terminal emulator, not a <div> of text.
// Same deal as above: shipped from node_modules, never a CDN.
const vendor = {
  "/vendor/xterm.js": "node_modules/@xterm/xterm/lib/xterm.js",
  "/vendor/xterm.css": "node_modules/@xterm/xterm/css/xterm.css",
  "/vendor/xterm-addon-fit.js": "node_modules/@xterm/addon-fit/lib/addon-fit.js",
};
for (const [route, file] of Object.entries(vendor)) {
  app.get(route, (_req, res) => res.sendFile(path.join(config.root, file), { maxAge: "1h" }));
}

app.get("/healthz", (_req, res) => res.json({ ok: true, env: config.env }));

app.use(sessionMiddleware);
app.use(csrfGuard);

// routes
app.use(authRouter);      // GET / (+ /auth/login|register|logout)
app.use(passkeyRouter);
app.use(coinpayRouter);
app.use(approvalsRouter);
app.use(creditsRouter);
app.use(cliRouter);       // /cli/authorize, /cli/token, /api/me
app.use(sessionsRouter);  // /sessions (live CLI mirror) + /api/sessions
app.use(pagesRouter);     // /app, /settings
app.use(settingsSyncRouter); // /api/settings (+ /settings/sync) — the pit's /save and /load
app.use(socialsRouter);   // public browser composers used by /post
app.use(moshpitRouter);  // /pit + /api/moshpit/* — the namespace

app.use((req, res) => res.status(404).type("html").send(
  `<body style="background:#070806;color:#edf2e4;font-family:monospace;padding:14vh 24px;text-align:center"><h1 style="color:#a6ff1a">404</h1><p>no such page in the pit.</p><a style="color:#a6ff1a" href="/">back to the pit →</a></body>`));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  // An unreadable or oversized body is the caller's mistake, and body-parser
  // reports it as a 4xx. Without this branch it fell through to the 500 below,
  // so a script that sent too much was told the server had a bug — and went
  // looking in the wrong place. Report the status body-parser chose.
  const status = Number(err?.status ?? err?.statusCode) || 500;
  if (status >= 400 && status < 500) {
    const detail = err?.type === "entity.too.large"
      ? `that body is too large. Publish up to ${MAX_BATCH} items at a time, and split the batch if it is still refused — publishing upserts on the slug, so a split batch is safe to retry.`
      : "could not read that request body as JSON";
    if (req.path.startsWith("/api/")) return res.status(status).json({ error: detail });
    return res.status(status).type("text").send(`${detail}\n`);
  }
  console.error(err);
  res.status(500).type("html").send(`<body style="background:#070806;color:#ff0050;font-family:monospace;padding:14vh 24px;text-align:center"><h1>500</h1><p>a bug got in. (there are no bugs, only features.)</p></body>`);
});

async function main() {
  await migrate();
  app.listen(config.port, () => console.log(`🤘 app.moshcode.sh on :${config.port} (${config.env}) — ${config.origin}`));
}
main().catch((e) => { console.error("boot failed:", e); process.exit(1); });

export { app };
