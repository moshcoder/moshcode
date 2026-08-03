// The new-API-key box hides the key until it is asked for.
//
// The handoff box (see apikey-reveal.test.mjs for the cookie and URL side of it)
// sat on screen with the credential in the clear. That box is open at exactly
// the moment a machine is being paired — when a window is most likely to be
// shared, projected or photographed — and the only control over it dismissed it
// for good. So the key is masked past its 12-character prefix and a Reveal
// toggle shows it on demand.
//
// The masking is applied by script over a fully rendered key rather than the
// other way round, so a visitor without JS still receives the one thing the box
// exists to hand over. That makes the script the thing worth testing, so these
// tests pull it out of the served page and run it against a stub DOM.
//
// Boots the real routers against a throwaway libsql file database; skips cleanly
// when the PWA dependencies are not installed.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = { express: require("express"), cookieParser: require("cookie-parser") };
} catch {
  deps = null; // pwa dependencies not installed — tests below skip
}

// Point the app at a throwaway database BEFORE importing its modules (config
// reads the environment once, at import time).
const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-mask-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const SESSION = "test-session-token";
const CSRF = "test-csrf-token";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { pagesRouter } = await import("../src/routes/pages.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(pagesRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  await run(`INSERT INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','demo',1)`);
  await run(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)`,
    [SESSION, "u1", Date.now(), Date.now() + 60_000]);

  return { server, db, base: `http://127.0.0.1:${server.address().port}` };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = !deps && "apps/pwa deps not installed";
const AUTH = `mc_sess=${SESSION}`;

const setCookie = (res, name) => {
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).split(";")[0] : null;
};

// Create a key and return the /settings page that hands it over.
async function keyPage(name = "laptop") {
  const { base } = await app();
  const created = await fetch(`${base}/settings/apikeys`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${AUTH}; mc_csrf=${CSRF}` },
    body: new URLSearchParams({ _csrf: CSRF, name }).toString(),
  });
  const handoff = setCookie(created, "mc_c_newkey");
  const res = await fetch(`${base}/settings`, { headers: { cookie: `${AUTH}; mc_c_newkey=${handoff}` } });
  const html = await res.text();
  const key = /<b class="mono" id="newkey"[^>]*>([^<]*)<\/b>/.exec(html)?.[1] ?? null;
  return { html, key };
}

// The banner's own script, picked out of the page by the id it drives.
const bannerScript = (html) =>
  [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("revealkey")) ?? null;

// Run that script against a stub DOM and hand back the elements it touched.
function runBanner(source, secret) {
  const stub = (id) => ({
    id, textContent: "", hidden: true, attrs: {}, handlers: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, f) { this.handlers[k] = f; },
  });
  const newkey = stub("newkey"), revealkey = stub("revealkey"), copykey = stub("copykey");
  newkey.textContent = secret;
  const nodes = { newkey, revealkey, copykey };
  const copied = [];

  const sandbox = {
    document: {
      getElementById: (id) => nodes[id] ?? null,
      createElement: () => ({ style: {}, select() {} }),
      execCommand: () => true,
      body: { appendChild() {}, removeChild() {} },
    },
    navigator: { clipboard: { writeText: (v) => { copied.push(v); return Promise.resolve(); } } },
    window: { isSecureContext: true },
    setTimeout: () => 0,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    newkey, revealkey, copykey, copied,
    click: (el) => el.handlers.click.call(el),
  };
}

// ---------- the bug ----------

test("the key is masked as soon as the script runs", { skip }, async () => {
  const { html, key } = await keyPage();
  const dom = runBanner(bannerScript(html), key);

  assert.notEqual(dom.newkey.textContent, key, "the secret must not sit on screen unasked");
  assert.ok(dom.newkey.textContent.startsWith(key.slice(0, 12)), "the prefix stays legible");
  assert.match(dom.newkey.textContent.slice(12), /^•+$/, "the rest is masked");
  assert.equal(dom.newkey.textContent.length, key.length, "the mask does not misreport the length");
});

test("Reveal shows the key and turns into Hide", { skip }, async () => {
  const { html, key } = await keyPage();
  const dom = runBanner(bannerScript(html), key);

  assert.equal(dom.revealkey.textContent, "Reveal");
  assert.equal(dom.revealkey.attrs["aria-pressed"], "false");

  dom.click(dom.revealkey);
  assert.equal(dom.newkey.textContent, key, "revealing shows the whole key");
  assert.equal(dom.revealkey.textContent, "Hide");
  assert.equal(dom.revealkey.attrs["aria-pressed"], "true", "a toggle must report its state");

  dom.click(dom.revealkey);
  assert.notEqual(dom.newkey.textContent, key, "and it can be put back");
  assert.equal(dom.revealkey.textContent, "Reveal");
  assert.equal(dom.revealkey.attrs["aria-pressed"], "false");
});

test("Copy copies the key, never the mask", { skip }, async () => {
  // The copy handler used to read the element's text. Masking that element would
  // have quietly turned the button into a bullet dispenser — and the key is
  // unrecoverable, so the user would not get a second attempt.
  const { html, key } = await keyPage();
  const dom = runBanner(bannerScript(html), key);

  assert.notEqual(dom.newkey.textContent, key, "precondition: masked when the button is pressed");
  dom.click(dom.copykey);
  assert.deepEqual(dom.copied, [key], "the clipboard gets the real key");
});

test("Copy still works after a reveal and re-hide", { skip }, async () => {
  const { html, key } = await keyPage();
  const dom = runBanner(bannerScript(html), key);
  dom.click(dom.revealkey);
  dom.click(dom.revealkey);
  dom.click(dom.copykey);
  assert.deepEqual(dom.copied, [key]);
});

// ---------- no-JS fallback: masking is the enhancement, not the delivery ----------

test("the server sends the key in full, and hides the button that needs script", { skip }, async () => {
  const { html, key } = await keyPage();
  assert.match(key ?? "", /^mck_[A-Za-z0-9_-]+$/, "rendered in full — no JS, still usable");

  const button = /<button[^>]*id="revealkey"[^>]*>/.exec(html)[0];
  assert.match(button, /\bhidden\b/, "no dead control for a visitor without script");
  assert.match(button, /aria-controls="newkey"/, "the toggle names what it operates");
  assert.match(bannerScript(html), /reveal\.hidden = false/, "the script un-hides it with the behaviour");
});

// ---------- controls: the rest of the box is untouched ----------

test("Dismiss still posts to the route that clears the key", { skip }, async () => {
  const { html } = await keyPage();
  assert.match(html, /action="\/settings\/apikeys\/hide"[^>]*>[\s\S]*?>Dismiss</,
    "the dismiss control keeps its route; only its label moved aside for Reveal/Hide");
  assert.doesNotMatch(html, /id="revealkey"[^>]*>Dismiss</, "the two controls are distinct");
});

test("a settings page with no new key has no banner script", { skip }, async () => {
  const { base } = await app();
  const html = await (await fetch(`${base}/settings`, { headers: { cookie: AUTH } })).text();
  assert.equal(bannerScript(html), null, "nothing to mask, nothing to ship");
});
