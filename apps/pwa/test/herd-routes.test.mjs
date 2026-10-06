// PRD 0020 phase 1: the app half of the herd on a phone.
//
// Boots the real router against a throwaway libsql file database, the same way
// approvals-notify.test.mjs does, and skips when the PWA deps are missing.
import assert from "node:assert/strict";
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

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pwa-herd-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
process.env.HERD_POLL_MS = "150";
process.env.HERD_RESULT_WAIT_MS = "400";

const MACHINE = "aaaaaaaa-1111-2222-3333-444444444444";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, all, get } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { herdRouter, machineRowId } = await import("../src/routes/herd.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");
  const { token } = await import("../src/lib/crypto.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(herdRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const seedUser = async (userId) => {
    await run(`INSERT INTO users (id, email, display_name, created_at) VALUES (?,?,?,?)`, [userId, `${userId}@b.c`, "demo", Date.now()]);
    const { plaintext } = await createApiKey(userId, "cli");
    const sess = token();
    await run(`INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)`, [sess, userId, Date.now(), Date.now() + 3600e3]);
    const csrf = token(16);
    return { id: userId, key: plaintext, cookie: `mc_sess=${sess}; mc_csrf=${csrf}`, csrf, mid: machineRowId(userId, MACHINE) };
  };

  const box = (u) => ({
    publish: (sessions, machine = MACHINE) => fetch(`${base}/api/herd/roster`, {
      method: "POST", headers: { authorization: `Bearer ${u.key}`, "content-type": "application/json" },
      body: JSON.stringify({ machine: { id: machine, name: "me@box", platform: "linux", version: "0.112.0" }, sessions }),
    }).then(async (r) => ({ status: r.status, body: await r.json() })),
    poll: () => fetch(`${base}/api/herd/commands?machine=${MACHINE}`, { headers: { authorization: `Bearer ${u.key}` } })
      .then(async (r) => ({ status: r.status, body: await r.json() })),
    result: (cid, body) => fetch(`${base}/api/herd/commands/${cid}`, {
      method: "POST", headers: { authorization: `Bearer ${u.key}`, "content-type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.status),
  });

  const phone = (u) => ({
    herd: () => fetch(`${base}/api/herd`, { headers: { cookie: u.cookie } }).then(async (r) => ({ status: r.status, body: await r.json() })),
    command: (body, { csrf = u.csrf } = {}) => fetch(`${base}/api/herd/command`, {
      method: "POST", headers: { cookie: u.cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() })),
  });

  const act = (tok, intent) => fetch(`${base}/api/herd/act`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: tok, intent }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  return { base, server, run, all, get, seedUser, box, phone, act };
}

const blocked = (blockedAt, extra = {}) => ({
  name: "api", engine: "claude", state: "blocked", blockedOn: "menu", cwd: "/src/api", lastLines: ["Do you want to proceed?", "❯ 1. Yes"],
  since: blockedAt, blockedAt, approval: { allowAll: true }, ...extra,
});
const working = (since) => ({ name: "api", engine: "claude", state: "working", cwd: "/src/api", lastLines: ["esc to interrupt"], since });

test("herd on a phone: publish, list, approve, answer, push token", { skip: !deps && "apps/pwa deps not installed" }, async (t) => {
  const app = await boot();
  t.after(() => app.server.close());
  const me = await app.seedUser("u-herd-1");
  const other = await app.seedUser("u-herd-2");

  await t.test("the box publishes; the phone lists it with no action token in sight", async () => {
    const r = await app.box(me).publish([working(1)]);
    assert.equal(r.status, 200);
    assert.equal(r.body.machine, me.mid);
    const h = await app.phone(me).herd();
    assert.equal(h.status, 200);
    assert.equal(h.body.machines.length, 1);
    const [m] = h.body.machines;
    assert.equal(m.name, "me@box");
    assert.equal(m.online, true);
    assert.equal(m.sessions[0].state, "working");
    assert.ok(!JSON.stringify(h.body).includes("action_token"));
  });

  await t.test("another account never sees it, even publishing the same machine id", async () => {
    await app.box(other).publish([working(1)]);
    const h = await app.phone(other).herd();
    assert.equal(h.body.machines.length, 1);
    assert.notEqual(h.body.machines[0].id, me.mid);
    const mine = await app.phone(me).herd();
    assert.equal(mine.body.machines.length, 1, "my roster is still only mine");
  });

  await t.test("signed out, the API says 401", async () => {
    const r = await fetch(`${app.base}/api/herd`);
    assert.equal(r.status, 401);
  });

  let actionToken = null;
  await t.test("a transition into blocked mints a one-time action token", async () => {
    await app.box(me).publish([blocked(500)]);
    const row = await app.get(`SELECT * FROM herd_sessions WHERE machine_id = ? AND name = 'api'`, [me.mid]);
    assert.equal(row.state, "blocked");
    assert.equal(Number(row.blocked_at), 500);
    assert.ok(row.action_token);
    actionToken = row.action_token;
    // A heartbeat in the same spell keeps the same token.
    await app.box(me).publish([blocked(500)]);
    const again = await app.get(`SELECT action_token FROM herd_sessions WHERE machine_id = ? AND name = 'api'`, [me.mid]);
    assert.equal(again.action_token, actionToken);
  });

  await t.test("a phone command needs the csrf header", async () => {
    const r = await app.phone(me).command({ machine: me.mid, session: "api", kind: "approve", args: { intent: "allow", blockedAt: 500 } }, { csrf: "wrong" });
    assert.equal(r.status, 403);
  });

  await t.test("bad shapes are refused before they reach the box", async () => {
    const p = app.phone(me);
    assert.equal((await p.command({ machine: me.mid, session: "api", kind: "approve", args: { intent: "yolo", blockedAt: 1 } })).status, 400);
    assert.equal((await p.command({ machine: me.mid, session: "api", kind: "approve", args: { intent: "allow" } })).status, 400);
    assert.equal((await p.command({ machine: me.mid, session: "api", kind: "exec", args: {} })).status, 400);
    assert.equal((await p.command({ machine: other.mid, session: "api", kind: "prompt", args: { text: "x" } })).status, 404, "someone else's machine");
  });

  await t.test("approve: queued, claimed once by the relay, answered back to the phone", async () => {
    const pending = app.phone(me).command({ machine: me.mid, session: "api", kind: "approve", args: { intent: "allow", blockedAt: 500 } });
    // The relay's long-poll picks it up.
    let claimed = null;
    for (let i = 0; i < 10 && !claimed; i++) {
      const p = await app.box(me).poll();
      claimed = p.body.commands.find((c) => c.kind === "approve") || null;
    }
    assert.ok(claimed, "the relay got the command");
    assert.deepEqual(claimed.args, { intent: "allow", blockedAt: 500 });
    // A second poll does not get it again.
    const second = await app.box(me).poll();
    assert.equal(second.body.commands.filter((c) => c.id === claimed.id).length, 0);
    assert.equal(await app.box(me).result(claimed.id, { ok: true }), 200);
    const answer = await pending;
    assert.equal(answer.status, 200);
    assert.equal(answer.body.status, "done");
    const row = await app.get(`SELECT status, via FROM herd_commands WHERE id = ?`, [claimed.id]);
    assert.equal(row.status, "done");
    assert.equal(row.via, "app");
  });

  await t.test("the push button: one tap answers once, a second tap is stale", async () => {
    const first = await app.act(actionToken, "allow");
    assert.equal(first.status, 200);
    const twice = await app.act(actionToken, "deny");
    assert.equal(twice.status, 410);
    assert.equal(twice.body.stale, true);
    const cmd = await app.get(`SELECT * FROM herd_commands WHERE id = ?`, [first.body.id]);
    assert.equal(cmd.kind, "approve");
    assert.equal(cmd.via, "push");
    assert.deepEqual(JSON.parse(cmd.args), { intent: "allow", blockedAt: 500 });
  });

  await t.test("a token for a session that moved on is refused", async () => {
    await app.box(me).publish([blocked(900)]);
    const { action_token: tok } = await app.get(`SELECT action_token FROM herd_sessions WHERE machine_id = ? AND name = 'api'`, [me.mid]);
    assert.ok(tok);
    await app.box(me).publish([working(950)]);
    const r = await app.act(tok, "allow");
    assert.equal(r.status, 410);
  });

  await t.test("a session that disappears from the box disappears from the phone", async () => {
    await app.box(me).publish([]);
    const h = await app.phone(me).herd();
    assert.equal(h.body.machines[0].sessions.length, 0);
  });

  await t.test("an offline machine refuses commands with a reason", async () => {
    await app.run(`UPDATE herd_machines SET last_seen_at = ? WHERE id = ?`, [Date.now() - 10 * 60e3, me.mid]);
    const r = await app.phone(me).command({ machine: me.mid, session: "api", kind: "prompt", args: { text: "hi" } });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /offline/);
  });
});

test("shouldPush: only transitions into blocked or done, never a first publish", async () => {
  if (!deps) return;
  const { shouldPush, pushFor } = await import("../src/routes/herd.mjs");
  assert.equal(shouldPush(undefined, { state: "blocked", blocked_at: 1 }), false);
  assert.equal(shouldPush({ state: "working" }, { state: "blocked", blocked_at: 1 }, { firstPublish: true }), false);
  assert.equal(shouldPush({ state: "working" }, { state: "blocked", blocked_at: 1 }), true);
  assert.equal(shouldPush({ state: "blocked", blocked_at: 1 }, { state: "blocked", blocked_at: 1 }), false);
  assert.equal(shouldPush({ state: "blocked", blocked_at: 1 }, { state: "blocked", blocked_at: 2 }), true, "a second prompt");
  assert.equal(shouldPush({ state: "working" }, { state: "done" }), true);
  assert.equal(shouldPush({ state: "idle" }, { state: "done" }), false);
  assert.equal(shouldPush({ state: "blocked" }, { state: "working" }), false);

  const push = pushFor({ id: "m1", name: "me@box" }, { name: "api", engine: "claude", state: "blocked", cwd: "/src/api", approval: { allowAll: true }, action_token: "tok" });
  assert.equal(push.title, "api wants permission");
  assert.deepEqual(push.actions.map((a) => a.action), ["allow", "deny"]);
  assert.deepEqual(push.act, { token: "tok" });
  assert.equal(push.url, "/m#/p/m1/api");
  assert.ok(!push.body.includes("Do you want"), "no screen text leaves through the push service");
  const done = pushFor({ id: "m1", name: "me@box" }, { name: "api", engine: "claude", state: "done", cwd: "/src/api" });
  assert.equal(done.actions, undefined);
});
