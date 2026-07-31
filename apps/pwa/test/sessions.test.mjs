// Integration tests for the live session mirror (/api/sessions + /sessions).
//
// Same shape as cli-token.test.mjs: boot the real router against a throwaway
// libsql file database, and skip cleanly when the PWA dependencies aren't
// installed so the root `npm test` stays green in a fresh clone.
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

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-sessions-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
process.env.SESSION_POLL_MS = "300"; // don't sit through a real long-poll window

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, all, get, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { sessionsRouter } = await import("../src/routes/sessions.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");

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

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u2','x@y.z','two',1)`);
  const keyOne = (await createApiKey("u1", "cli one")).plaintext;
  const keyTwo = (await createApiKey("u2", "cli two")).plaintext;

  const api = (token) => (path_, body) =>
    fetch(`${base}${path_}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

  return { run, all, get, db, server, base, one: api(keyOne), two: api(keyTwo) };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

test("sessions: malformed poll windows fall back instead of creating a hot loop", skip, async () => {
  const { readLongPollMs } = await import("../src/routes/sessions.mjs");

  for (const value of [null, "", "abc", "300ms", "-1", "0", "1.5", "1e3", "Infinity", "2147483648"]) {
    assert.equal(readLongPollMs(value), 25_000, String(value));
  }
  assert.equal(readLongPollMs(), 300);
  assert.equal(readLongPollMs(" 300 "), 300);
  assert.equal(readLongPollMs("2147483647"), 2_147_483_647);
});

test("sessions: register, then output lands in the scrollback in order", skip, async () => {
  const { one, all } = await app();

  const reg = await one("/api/sessions", { name: "mosh @ test", host: "test", version: "9.9.9" });
  assert.equal(reg.status, 200);
  assert.ok(reg.body.id, "register must return a session id");

  await one(`/api/sessions/${reg.body.id}/output`, { chunk: "first\n" });
  await one(`/api/sessions/${reg.body.id}/output`, { chunk: "second\n" });

  const rows = await all(`SELECT seq, chunk FROM session_output WHERE session_id = ? ORDER BY seq`, [reg.body.id]);
  assert.deepEqual(rows.map((r) => r.chunk), ["first\n", "second\n"]);
  assert.deepEqual(rows.map((r) => Number(r.seq)), [1, 2], "seq must be monotonic per session");
});

test("sessions: another user's key cannot read or write the session", skip, async () => {
  const { one, two } = await app();

  const reg = await one("/api/sessions", { name: "mine" });
  const write = await two(`/api/sessions/${reg.body.id}/output`, { chunk: "not yours" });
  assert.equal(write.status, 404, "a foreign key must not append output");

  const poll = await two(`/api/sessions/${reg.body.id}/commands`);
  assert.equal(poll.status, 404, "a foreign key must not drain commands");
});

test("sessions: a queued command is claimed exactly once", skip, async () => {
  const { one, run, all } = await app();

  const reg = await one("/api/sessions", { name: "claims" });
  const sid = reg.body.id;
  await run(`INSERT INTO session_commands (id,session_id,body,status,created_at) VALUES ('c1',?,'/whoami','queued',?)`,
    [sid, Date.now()]);

  // Two polls race for the same command; the UPDATE is the lock, so exactly
  // one may carry it. Without that, one web command would run twice.
  const [a, b] = await Promise.all([
    one(`/api/sessions/${sid}/commands`),
    one(`/api/sessions/${sid}/commands`),
  ]);
  const delivered = [...(a.body?.commands || []), ...(b.body?.commands || [])];
  assert.equal(delivered.length, 1, "exactly one poll may claim the command");
  assert.equal(delivered[0].body, "/whoami");

  const rows = await all(`SELECT status FROM session_commands WHERE id = 'c1'`);
  assert.equal(rows[0].status, "claimed");
});

test("sessions: command acknowledgements require a claimed command", skip, async () => {
  const { one, run, get } = await app();

  const reg = await one("/api/sessions", { name: "ack-state" });
  const sid = reg.body.id;
  await run(`INSERT INTO session_commands (id,session_id,body,status,created_at) VALUES ('queued-ack',?,'/status','queued',?)`,
    [sid, Date.now()]);

  const queued = await one(`/api/sessions/${sid}/commands/queued-ack`, {});
  assert.equal(queued.status, 409);
  assert.equal(queued.body.error, "command is not claimed");
  assert.equal((await get(`SELECT status FROM session_commands WHERE id = 'queued-ack'`)).status, "queued");

  const missing = await one(`/api/sessions/${sid}/commands/missing`, {});
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "no such command");
});

test("sessions: command acknowledgements complete claimed commands idempotently", skip, async () => {
  const { one, run, get } = await app();

  const reg = await one("/api/sessions", { name: "ack-idempotent" });
  const sid = reg.body.id;
  await run(`INSERT INTO session_commands (id,session_id,body,status,created_at,claimed_at) VALUES ('claimed-ack',?,'/status','claimed',?,?)`,
    [sid, Date.now(), Date.now()]);

  const first = await one(`/api/sessions/${sid}/commands/claimed-ack`, {});
  assert.equal(first.status, 200);
  assert.equal((await get(`SELECT status FROM session_commands WHERE id = 'claimed-ack'`)).status, "done");

  const retry = await one(`/api/sessions/${sid}/commands/claimed-ack`, {});
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, { ok: true });
});

test("sessions: ending a session marks it ended", skip, async () => {
  const { one, get } = await app();

  const reg = await one("/api/sessions", { name: "ends" });
  const end = await one(`/api/sessions/${reg.body.id}/end`, {});
  assert.equal(end.status, 200);

  const row = await get(`SELECT status, ended_at FROM cli_sessions WHERE id = ?`, [reg.body.id]);
  assert.equal(row.status, "ended");
  assert.ok(Number(row.ended_at) > 0, "ended_at must be stamped");
});

test("sessions: an unauthenticated caller gets 401, not a session", skip, async () => {
  const { base } = await app();
  const res = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "anon" }),
  });
  assert.equal(res.status, 401);
});
