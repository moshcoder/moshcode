// Integration tests for `seq` assignment on POST /api/sessions/:id/output.
//
// sessions.test.mjs already pins "seq must be monotonic per session" for output
// posted one chunk at a time. A CLI streams output as it arrives, so chunks are
// also in flight concurrently — these cover that case, where a read-then-insert
// hands two chunks the same seq and the mirror loses one for good.
//
// Same shape as approvals-credits.test.mjs: boot the real router against a
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

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-sessions-seq-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
process.env.SESSION_POLL_MS = "300"; // don't sit through a real long-poll window

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, all, db } = await import("../src/db.mjs");
  // The local libsql driver resolves statements in microtasks, which fully
  // serializes concurrent request handlers and hides read-check-write races.
  // Production runs against a network database (Turso), where every statement
  // is a round trip. Defer each statement to a macrotask so two in-flight
  // handlers genuinely interleave, like they would against the remote DB.
  const execute = db.execute.bind(db);
  db.execute = (stmt) => new Promise((resolve, reject) => {
    setTimeout(() => execute(stmt).then(resolve, reject), 2);
  });
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
  const { port } = server.address();

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u2','x@y.z','two',1)`);
  const keyOne = (await createApiKey("u1", "cli one")).plaintext;
  const keyTwo = (await createApiKey("u2", "cli two")).plaintext;

  // Raw http with a fresh connection per request: fetch()/undici would reuse a
  // keep-alive socket for same-origin calls and serialize the "concurrent"
  // posts, hiding the race this exercises.
  const call = (token) => (path_, body) => new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: path_, agent: false,
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

  const rowsFor = (sid) =>
    all(`SELECT seq, chunk FROM session_output WHERE session_id = ? ORDER BY id ASC`, [sid]);

  // The exact predicate GET /sessions/:id/stream replays with, so these assert
  // what a reconnecting browser can actually still receive.
  const replaySince = (sid, since) =>
    all(`SELECT seq, chunk FROM session_output WHERE session_id = ? AND seq > ? ORDER BY seq ASC`, [sid, since]);

  return { run, all, db, server, one: call(keyOne), two: call(keyTwo), rowsFor, replaySince };
}

// One shared app/db for the whole file (db.mjs is a module-level singleton —
// closing it between tests would break the next boot).
let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

// ---- the bug ----

test("sessions: two concurrent output chunks get distinct seqs", skip, async () => {
  const { one, rowsFor } = await app();

  const reg = await one("/api/sessions", { name: "concurrent-pair" });
  const sid = reg.body.id;

  const [a, b] = await Promise.all([
    one(`/api/sessions/${sid}/output`, { chunk: "AAA\n" }),
    one(`/api/sessions/${sid}/output`, { chunk: "BBB\n" }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const rows = await rowsFor(sid);
  assert.equal(rows.length, 2, "both chunks must be stored");
  const seqs = rows.map((r) => Number(r.seq));
  assert.equal(new Set(seqs).size, 2, `both chunks got seq ${JSON.stringify(seqs)} — seq must be unique per session`);
  assert.deepEqual([...seqs].sort((x, y) => x - y), [1, 2]);
});

test("sessions: a browser resuming mid-race still receives the other chunk", skip, async () => {
  const { one, rowsFor, replaySince } = await app();

  // The mirror's resume contract: the page remembers the last seq it rendered
  // and reconnects with ?since=<seq>, which replays `seq > since`. If a
  // concurrent chunk shares that seq it is skipped permanently — the operator
  // is looking at a terminal that silently dropped a line.
  const reg = await one("/api/sessions", { name: "resume" });
  const sid = reg.body.id;

  await Promise.all([
    one(`/api/sessions/${sid}/output`, { chunk: "one\n" }),
    one(`/api/sessions/${sid}/output`, { chunk: "two\n" }),
  ]);

  const rows = await rowsFor(sid);
  const seenSeq = Number(rows[0].seq); // the only chunk this browser rendered
  const stillAvailable = await replaySince(sid, seenSeq);

  assert.equal(
    stillAvailable.length,
    rows.length - 1,
    `wrote ${rows.length} chunks; a browser resuming from seq ${seenSeq} can still see ${stillAvailable.length}`
  );
  const delivered = new Set([rows[0].chunk, ...stillAvailable.map((r) => r.chunk)]);
  assert.deepEqual([...delivered].sort(), ["one\n", "two\n"], "no chunk may be unreachable");
});

test("sessions: a burst of concurrent chunks is numbered without gaps or repeats", skip, async () => {
  const { one, rowsFor } = await app();

  const reg = await one("/api/sessions", { name: "burst" });
  const sid = reg.body.id;

  const chunks = ["c1\n", "c2\n", "c3\n", "c4\n", "c5\n"];
  await Promise.all(chunks.map((chunk) => one(`/api/sessions/${sid}/output`, { chunk })));

  const rows = await rowsFor(sid);
  assert.equal(rows.length, chunks.length, "every chunk must be stored");
  const seqs = rows.map((r) => Number(r.seq)).sort((x, y) => x - y);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5], `expected 1..5, got ${JSON.stringify(seqs)}`);
  assert.deepEqual(rows.map((r) => r.chunk).sort(), [...chunks].sort(), "no chunk may be dropped");
});

// ---- controls: these pass with and without the fix ----

test("sessions: sequential output is still numbered in posting order", skip, async () => {
  const { one, rowsFor } = await app();

  const reg = await one("/api/sessions", { name: "sequential" });
  const sid = reg.body.id;

  await one(`/api/sessions/${sid}/output`, { chunk: "first\n" });
  await one(`/api/sessions/${sid}/output`, { chunk: "second\n" });
  await one(`/api/sessions/${sid}/output`, { chunk: "third\n" });

  const rows = await rowsFor(sid);
  assert.deepEqual(rows.map((r) => r.chunk), ["first\n", "second\n", "third\n"]);
  assert.deepEqual(rows.map((r) => Number(r.seq)), [1, 2, 3]);
});

test("sessions: seq is numbered per session, not globally", skip, async () => {
  const { one, rowsFor } = await app();

  const a = (await one("/api/sessions", { name: "sess-a" })).body.id;
  const b = (await one("/api/sessions", { name: "sess-b" })).body.id;

  await one(`/api/sessions/${a}/output`, { chunk: "in a\n" });
  await one(`/api/sessions/${b}/output`, { chunk: "in b\n" });

  assert.deepEqual((await rowsFor(a)).map((r) => Number(r.seq)), [1]);
  assert.deepEqual((await rowsFor(b)).map((r) => Number(r.seq)), [1], "a second session starts its own numbering");
});

test("sessions: an empty chunk writes no output row", skip, async () => {
  const { one, rowsFor } = await app();

  const reg = await one("/api/sessions", { name: "empty" });
  const sid = reg.body.id;

  const res = await one(`/api/sessions/${sid}/output`, { chunk: "" });
  assert.equal(res.status, 200, "a keep-alive post with no output is still accepted");
  assert.deepEqual(await rowsFor(sid), [], "no row for an empty chunk");
});

test("sessions: an ordinary chunk is one row, at the stored limit", skip, async () => {
  const { one, rowsFor } = await app();

  const reg = await one("/api/sessions", { name: "at-cap" });
  const sid = reg.body.id;

  await one(`/api/sessions/${sid}/output`, { chunk: "x".repeat(20000) });

  const rows = await rowsFor(sid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chunk.length, 20000, "a row is still capped at 20000 chars");
  assert.equal(Number(rows[0].seq), 1);
});

test("sessions: a chunk past the row limit is split, not truncated", skip, async () => {
  const { one, rowsFor } = await app();

  // The row cap keeps one flush from writing an unbounded string. It used to be
  // applied with slice(), so the overflow was published live to every watcher
  // and then thrown away — the same session read one way while you watched it
  // and another way after a reload, with no sign anything was missing. A build
  // that dumps a wall of output inside one 150ms flush is exactly that case.
  const chunk = `${"x".repeat(20000)}TAIL-MUST-SURVIVE\n`;
  const reg = await one("/api/sessions", { name: "oversized" });
  const sid = reg.body.id;

  await one(`/api/sessions/${sid}/output`, { chunk });

  const rows = await rowsFor(sid);
  assert.equal(rows.length, 2, "the overflow becomes another row");
  assert.ok(rows.every((r) => r.chunk.length <= 20000), "each row still respects the cap");
  assert.equal(rows.map((r) => r.chunk).join(""), chunk, "every byte posted must be stored");
  assert.deepEqual(rows.map((r) => Number(r.seq)), [1, 2], "and in order, so a replay reassembles it");
});

test("sessions: a foreign key still cannot append output", skip, async () => {
  const { one, two, rowsFor } = await app();

  const reg = await one("/api/sessions", { name: "owned" });
  const sid = reg.body.id;

  const write = await two(`/api/sessions/${sid}/output`, { chunk: "not yours\n" });
  assert.equal(write.status, 404, "a foreign key must not append output");
  assert.deepEqual(await rowsFor(sid), [], "and must not have written a row");
});
