// Integration tests for the scrollback→live handover on GET /sessions/:id/stream.
//
// sessions.test.mjs pins what lands in session_output. These pin what actually
// reaches the browser: the mirror replays the scrollback and then follows the
// fan-out, so a chunk committed between the two is in neither, and the page
// only ever reconnects with the highest seq it rendered — the hole is permanent.
//
// The window is opened deterministically rather than with sleeps: the scrollback
// read is held *after* the database has evaluated it, which is exactly the state
// a network database (Turso) is in while the rows travel back.
//
// Same shape as sessions-output-seq.test.mjs: boot the real router against a
// throwaway libsql file database, and skip cleanly when the PWA dependencies
// aren't installed so the root `npm test` stays green in a fresh clone.
import assert from "node:assert/strict";
import http from "node:http";
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
  deps = null; // pwa dependencies not installed — tests below skip
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-sessions-stream-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
process.env.SESSION_POLL_MS = "300";

const SCROLLBACK_READ = /SELECT seq, chunk FROM session_output/;

// Hooks the test arms around the scrollback read. `before` delays the statement
// reaching the database; `after` delays the rows getting back to the caller.
let delayRead = null;

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, all, db } = await import("../src/db.mjs");

  const execute = db.execute.bind(db);
  db.execute = async (stmt) => {
    const sql = typeof stmt === "string" ? stmt : stmt?.sql || "";
    const hook = SCROLLBACK_READ.test(sql) ? delayRead : null;
    if (!hook) return execute(stmt);
    if (hook.before) await hook.before();
    const rows = await execute(stmt);
    if (hook.after) await hook.after();
    return rows;
  };

  const { sessionMiddleware, csrfGuard, createSession } = await import("../src/lib/session.mjs");
  const { sessionsRouter } = await import("../src/routes/sessions.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  // Test-only: mint a browser cookie without going through the sign-in form.
  app.get("/t/login/:uid", async (req, res) => {
    await createSession(res, req.params.uid);
    res.json({ ok: true });
  });
  app.use(sessionsRouter);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const port = server.address().port;

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u2','x@y.z','two',1)`);
  const keyOne = (await createApiKey("u1", "cli one")).plaintext;

  const cookieFor = async (uid) => {
    const res = await fetch(`${base}/t/login/${uid}`);
    return /mc_sess=[^;]+/.exec(res.headers.get("set-cookie"))[0];
  };

  const cli = (path_, body) =>
    fetch(`${base}${path_}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${keyOne}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

  return { run, all, db, server, base, port, cli, cookieFor };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

/**
 * Open the mirror stream and collect what the browser would render.
 * `onOpen` runs once the response headers are in — i.e. while the route is
 * still working through its scrollback. Resolves when `until` is satisfied or
 * the deadline passes, so a lost chunk fails loudly instead of hanging.
 */
function openStream({ port, cookie, sid, since = 0, onOpen, until = () => false, deadline = 3000 }) {
  return new Promise((resolve) => {
    const events = [];
    let text = "";
    const req = http.get(
      { host: "127.0.0.1", port, path: `/sessions/${sid}/stream?since=${since}`, headers: { cookie }, agent: false },
      (res) => {
        if (res.statusCode !== 200) { req.destroy(); return resolve({ status: res.statusCode, events }); }
        res.setEncoding("utf8");
        const stop = () => { clearTimeout(timer); req.destroy(); resolve({ status: 200, events }); };
        const timer = setTimeout(stop, deadline);
        res.on("data", (d) => {
          text += d;
          const parts = text.split("\n\n");
          text = parts.pop();
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data: "));
            if (line) events.push(JSON.parse(line.slice(6)));
          }
          if (until(events)) stop();
        });
        onOpen?.();
      },
    );
  });
}

const chunks = (events) => events.filter((e) => e.type === "out").map((e) => e.chunk);
const seqs = (events) => events.filter((e) => e.type === "out").map((e) => Number(e.seq));

async function register(cli, name) {
  const reg = await cli("/api/sessions", { name });
  return reg.body.id;
}

// ---- the bug ----

test("stream: a chunk committed while the scrollback is in flight still reaches the mirror", skip, async () => {
  const { cli, cookieFor, port } = await app();
  const cookie = await cookieFor("u1");
  const sid = await register(cli, "gap");
  await cli(`/api/sessions/${sid}/output`, { chunk: "before\n" });

  // Hold the rows on the way back, append in that window, then let them land.
  let release;
  const gate = new Promise((r) => { release = r; });
  let reached;
  const evaluated = new Promise((r) => { reached = r; });
  delayRead = { after: () => { reached(); return gate; } };

  const streaming = openStream({
    port, cookie, sid,
    // "after" is written once the handover is over, so it always arrives. It is
    // the marker that says the stream is healthy and "during" is genuinely lost
    // rather than merely late.
    until: (e) => chunks(e).includes("after\n"),
    onOpen: async () => {
      await evaluated;
      await cli(`/api/sessions/${sid}/output`, { chunk: "during\n" });
      release();
      await cli(`/api/sessions/${sid}/output`, { chunk: "after\n" });
    },
  });
  const { events } = await streaming;
  delayRead = null;

  const seen = chunks(events);
  assert.ok(seen.includes("after\n"), "sanity: the live fan-out must be working");
  assert.ok(seen.includes("during\n"),
    `the chunk written during the scrollback read was never delivered — got ${JSON.stringify(seen)}`);
});

test("stream: the mirror's own resume watermark cannot recover a skipped chunk", skip, async () => {
  const { cli, cookieFor, port, all } = await app();
  const cookie = await cookieFor("u1");
  const sid = await register(cli, "watermark");
  await cli(`/api/sessions/${sid}/output`, { chunk: "one\n" });

  let release;
  const gate = new Promise((r) => { release = r; });
  let reached;
  const evaluated = new Promise((r) => { reached = r; });
  delayRead = { after: () => { reached(); return gate; } };

  const streaming = openStream({
    port, cookie, sid,
    until: (e) => chunks(e).includes("three\n"),
    onOpen: async () => {
      await evaluated;
      await cli(`/api/sessions/${sid}/output`, { chunk: "two\n" });
      release();
      await cli(`/api/sessions/${sid}/output`, { chunk: "three\n" });
    },
  });
  const { events } = await streaming;
  delayRead = null;

  // The page advances `seq` to the last frame it rendered and reconnects with
  // ?since=<that>, so anything below the watermark is never re-sent. Every row
  // in the table must therefore have been seen the first time.
  const rows = await all(`SELECT seq, chunk FROM session_output WHERE session_id = ? ORDER BY seq`, [sid]);
  const watermark = Math.max(0, ...seqs(events));
  const unreachable = rows.filter((r) => Number(r.seq) <= watermark && !seqs(events).includes(Number(r.seq)));
  assert.deepEqual(unreachable.map((r) => r.chunk), [],
    "a chunk below the resume watermark was skipped, so no reconnect can ever fetch it");
});

test("stream: the handover keeps the mirror in seq order", skip, async () => {
  const { cli, cookieFor, port } = await app();
  const cookie = await cookieFor("u1");
  const sid = await register(cli, "order");
  await cli(`/api/sessions/${sid}/output`, { chunk: "a\n" });

  let release;
  const gate = new Promise((r) => { release = r; });
  let reached;
  const evaluated = new Promise((r) => { reached = r; });
  delayRead = { after: () => { reached(); return gate; } };

  const streaming = openStream({
    port, cookie, sid,
    until: (e) => chunks(e).includes("c\n"),
    onOpen: async () => {
      await evaluated;
      await cli(`/api/sessions/${sid}/output`, { chunk: "b\n" });
      release();
      await cli(`/api/sessions/${sid}/output`, { chunk: "c\n" });
    },
  });
  const { events } = await streaming;
  delayRead = null;

  assert.deepEqual(chunks(events), ["a\n", "b\n", "c\n"], "the mirror must read in the order the CLI wrote");
  const s = seqs(events);
  assert.deepEqual(s, [...s].sort((x, y) => x - y), "seq must not go backwards across the handover");
});

// ---- controls: these pass with or without the fix ----

test("stream: a chunk carried by both the scrollback and the fan-out is rendered once", skip, async () => {
  const { cli, cookieFor, port } = await app();
  const cookie = await cookieFor("u1");
  const sid = await register(cli, "dup");
  await cli(`/api/sessions/${sid}/output`, { chunk: "x\n" });

  // Held on the way *in*: the append commits before the read is evaluated, so
  // the same chunk is both in the result set and in the fan-out.
  let release;
  const gate = new Promise((r) => { release = r; });
  let reached;
  const arrived = new Promise((r) => { reached = r; });
  delayRead = { before: () => { reached(); return gate; } };

  const streaming = openStream({
    port, cookie, sid,
    until: (e) => chunks(e).includes("z\n"),
    onOpen: async () => {
      await arrived;
      await cli(`/api/sessions/${sid}/output`, { chunk: "y\n" });
      release();
      await cli(`/api/sessions/${sid}/output`, { chunk: "z\n" });
    },
  });
  const { events } = await streaming;
  delayRead = null;

  assert.deepEqual(chunks(events), ["x\n", "y\n", "z\n"], "no chunk may be rendered twice");
});

test("stream: a fresh mirror replays the whole scrollback", skip, async () => {
  const { cli, cookieFor, port } = await app();
  const cookie = await cookieFor("u1");
  const sid = await register(cli, "replay");
  await cli(`/api/sessions/${sid}/output`, { chunk: "1\n" });
  await cli(`/api/sessions/${sid}/output`, { chunk: "2\n" });

  const { events } = await openStream({
    port, cookie, sid,
    until: (e) => chunks(e).length >= 2,
  });
  assert.deepEqual(chunks(events), ["1\n", "2\n"]);
});

test("stream: since=N replays only what follows it, and a junk since replays everything", skip, async () => {
  const { cli, cookieFor, port } = await app();
  const cookie = await cookieFor("u1");
  const sid = await register(cli, "since");
  await cli(`/api/sessions/${sid}/output`, { chunk: "p\n" });
  await cli(`/api/sessions/${sid}/output`, { chunk: "q\n" });

  const resumed = await openStream({ port, cookie, sid, since: 1, until: (e) => chunks(e).length >= 1 });
  assert.deepEqual(chunks(resumed.events), ["q\n"], "a resume must not repeat what was already rendered");

  const junk = await openStream({ port, cookie, sid, since: "abc", until: (e) => chunks(e).length >= 2 });
  assert.deepEqual(chunks(junk.events), ["p\n", "q\n"], "an unparseable since must fall back to the whole scrollback");
});

test("stream: output written after the mirror is connected arrives live", skip, async () => {
  const { cli, cookieFor, port } = await app();
  const cookie = await cookieFor("u1");
  const sid = await register(cli, "live");

  const { events } = await openStream({
    port, cookie, sid,
    until: (e) => chunks(e).includes("tick\n"),
    onOpen: () => { setTimeout(() => cli(`/api/sessions/${sid}/output`, { chunk: "tick\n" }), 50); },
  });
  assert.deepEqual(chunks(events), ["tick\n"]);
});

test("stream: an ended session opens with an offline frame", skip, async () => {
  const { cli, cookieFor, port } = await app();
  const cookie = await cookieFor("u1");
  const sid = await register(cli, "ended");
  await cli(`/api/sessions/${sid}/output`, { chunk: "bye\n" });
  await cli(`/api/sessions/${sid}/end`, {});

  const { events } = await openStream({
    port, cookie, sid,
    until: (e) => e.some((x) => x.type === "offline"),
  });
  assert.deepEqual(chunks(events), ["bye\n"], "the scrollback still replays for a dead session");
  assert.ok(events.some((e) => e.type === "offline"), "a dead session must say so");
});

test("stream: another user's session is not streamable", skip, async () => {
  const { cli, cookieFor, port } = await app();
  const sid = await register(cli, "private");
  const intruder = await cookieFor("u2");

  const { status } = await openStream({ port, cookie: intruder, sid, deadline: 1000 });
  assert.equal(status, 404, "a session belongs to one account");
});
