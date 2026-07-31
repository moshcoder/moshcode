// Pasting a block of commands into the session page.
//
// The CLI hands exactly one line to the prompt per turn — readline resolves on
// the first line it sees and would swallow anything after it — so a paste has
// to arrive as one queued command per line, in the order it was pasted.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = { express: require("express"), cookieParser: require("cookie-parser") };
} catch {
  deps = null;
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-paste-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const SESSION = "paste-session-token";
const CSRF = "paste-csrf-token";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, all, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { sessionsRouter } = await import("../src/routes/sessions.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(sessionsRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await run(`INSERT INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','demo',1)`);
  await run(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)`,
    [SESSION, "u1", Date.now(), Date.now() + 60_000]);
  await run(`INSERT INTO cli_sessions (id,user_id,name,status,created_at,last_seen_at) VALUES (?,?,?,?,?,?)`,
    ["cli-1", "u1", "local", "live", Date.now(), Date.now()]);

  const send = (body) => fetch(`${base}/sessions/cli-1/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      cookie: `mc_sess=${SESSION}; mc_csrf=${CSRF}`,
    },
    body: JSON.stringify({ body, _csrf: CSRF }),
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

  const queued = () => all(
    `SELECT body FROM session_commands WHERE session_id = 'cli-1' ORDER BY created_at ASC, rowid ASC`);

  return { run, all, db, server, send, queued };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

test("paste: each line is queued separately, in the order it was pasted", skip, async () => {
  const { send, queued, run } = await app();

  const res = await send("/agents claude\nnpm test\n/quit");
  assert.equal(res.status, 200);
  assert.equal(res.body.queued, 3, "one queued command per pasted line");

  assert.deepEqual((await queued()).map((r) => r.body), ["/agents claude", "npm test", "/quit"]);
  await run(`DELETE FROM session_commands WHERE session_id = 'cli-1'`);
});

test("paste: blank lines and stray carriage returns are dropped, not queued", skip, async () => {
  const { send, queued, run } = await app();

  // A copied block usually arrives with CRLFs and a trailing newline. Queuing
  // those as commands would send bare enters at the prompt.
  const res = await send("  first\r\n\r\n   \r\nsecond  \r\n");
  assert.equal(res.body.queued, 2);
  assert.deepEqual((await queued()).map((r) => r.body), ["first", "second"]);
  await run(`DELETE FROM session_commands WHERE session_id = 'cli-1'`);
});

test("paste: a single line still behaves exactly as before", skip, async () => {
  const { send, queued, run } = await app();

  const res = await send("/status");
  assert.equal(res.body.queued, 1);
  assert.ok(res.body.id, "the first command id is still returned");
  assert.deepEqual((await queued()).map((r) => r.body), ["/status"]);
  await run(`DELETE FROM session_commands WHERE session_id = 'cli-1'`);
});

test("paste: a runaway paste is capped rather than queued in full", skip, async () => {
  const { send, queued, run } = await app();

  // Pasting a whole file by mistake must not queue thousands of lines against
  // a prompt that runs them one at a time.
  const res = await send(Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n"));
  assert.equal(res.body.queued, 50);
  const rows = await queued();
  assert.equal(rows.length, 50);
  assert.equal(rows[0].body, "line-0", "the cap keeps the start of the paste");
  assert.equal(rows[49].body, "line-49");
  await run(`DELETE FROM session_commands WHERE session_id = 'cli-1'`);
});

test("paste: an empty body is still rejected", skip, async () => {
  const { send, queued } = await app();

  const res = await send("\n\n   \n");
  assert.equal(res.status, 400);
  assert.equal((await queued()).length, 0);
});
