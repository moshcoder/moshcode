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
import { pagesRouter } from "./routes/pages.mjs";

const app = express();
app.disable("x-powered-by");
if (config.secure) app.set("trust proxy", 1); // Railway terminates TLS

// body parsing — keep the raw body for HMAC signature verification
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// static
app.use(express.static(path.join(config.root, "public"), { maxAge: "1h" }));
// the @simplewebauthn/browser UMD bundle, served from node_modules (no CDN)
app.get("/vendor/simplewebauthn-browser.umd.js", (_req, res) =>
  res.sendFile(path.join(config.root, "node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js")));

app.get("/healthz", (_req, res) => res.json({ ok: true, env: config.env }));

app.use(sessionMiddleware);
app.use(csrfGuard);

// routes
app.use(authRouter);      // GET / (+ /auth/login|register|logout)
app.use(passkeyRouter);
app.use(coinpayRouter);
app.use(approvalsRouter);
app.use(creditsRouter);
app.use(pagesRouter);     // /app, /settings

app.use((req, res) => res.status(404).type("html").send(
  `<body style="background:#070806;color:#edf2e4;font-family:monospace;padding:14vh 24px;text-align:center"><h1 style="color:#a6ff1a">404</h1><p>no such page in the pit.</p><a style="color:#a6ff1a" href="/app">back to the pit →</a></body>`));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).type("html").send(`<body style="background:#070806;color:#ff0050;font-family:monospace;padding:14vh 24px;text-align:center"><h1>500</h1><p>a bug got in. (there are no bugs, only features.)</p></body>`);
});

async function main() {
  await migrate();
  app.listen(config.port, () => console.log(`🤘 app.moshcode.sh on :${config.port} (${config.env}) — ${config.origin}`));
}
main().catch((e) => { console.error("boot failed:", e); process.exit(1); });

export { app };
