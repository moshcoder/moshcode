// The herd in your pocket (PRD 0020, phase 1): the app half.
//
// Box side (Bearer API key — the relay started by `moshcode herd phone on`):
//   POST /api/herd/roster              publish this machine's herd; push on blocked/done
//   GET  /api/herd/commands?machine=   long-poll + claim queued commands
//   POST /api/herd/commands/:id        the relay's result for one command
//   POST /api/herd/screen              one pane's screen, while a phone watches it
//
// Phone side (cookie session; JSON writes carry x-csrf-token):
//   GET  /m                            the phone app (public/herd/)
//   GET  /api/herd                     every machine and session
//   GET  /api/herd/stream              SSE: roster changed, command results
//   GET  /api/herd/pane/stream         SSE: one pane's screen (starts the relay's stream)
//   POST /api/herd/command             approve | prompt | keys
//   GET  /api/herd/command/:id         one command's status
//
// Push buttons (no cookie: a service worker has no CSRF token to send):
//   POST /api/herd/act                 {token, intent} — the token is a one-time
//                                      capability minted for one blocked spell
import crypto from "node:crypto";
import path from "node:path";
import { Router } from "express";
import { sendPushToMany } from "@profullstack/notifications/server";
import { all, get, run } from "../db.mjs";
import { config } from "../config.mjs";
import { id, token } from "../lib/crypto.mjs";
import { bearer, userForApiKey } from "../lib/apikey.mjs";
import { requireAuth } from "../lib/session.mjs";

export const herdRouter = Router();

// A machine is online while its relay keeps checking in. The relay publishes
// at least every 30 s and its command poll touches last_seen every 25 s.
export const ONLINE_MS = 90 * 1000;
const DEFAULT_LONG_POLL_MS = 25 * 1000;
const LONG_POLL_MS = Number(process.env.HERD_POLL_MS) > 0 ? Number(process.env.HERD_POLL_MS) : DEFAULT_LONG_POLL_MS;
// How long POST /api/herd/command waits for the relay before answering
// "queued". Long enough for a live relay (one poll round trip), short enough
// that a phone on a dead machine is not left spinning.
const RESULT_WAIT_MS = Number(process.env.HERD_RESULT_WAIT_MS) >= 0 && process.env.HERD_RESULT_WAIT_MS !== undefined
  ? Number(process.env.HERD_RESULT_WAIT_MS) : 8000;
const MAX_SESSIONS = 100;
const MAX_SCREEN = 200 * 1000;
const PUSH_TTL = 60 * 60; // a blocked prompt an hour old is not worth waking a phone for
export const COMMAND_KINDS = ["approve", "prompt", "keys"];
export const INTENTS = ["allow", "allowAll", "deny"];

const str = (v, max) => (v == null ? null : String(v).slice(0, max));
const num = (v) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : null);

/** The row id for a box, scoped to its owner so two accounts on one box never collide. */
export function machineRowId(userId, machineKey) {
  return crypto.createHash("sha256").update(`${userId}:${machineKey}`).digest("hex").slice(0, 32);
}

// ---- in-process fan-out (best effort in front of the DB, like /sessions) ----
const userStreams = new Map();  // userId -> Set<res>
const paneStreams = new Map();  // `${machineId}/${session}` -> Set<res>
const screens = new Map();      // `${machineId}/${session}` -> { screen, at }
const waiters = new Map();      // machineId -> Set<fn>   (relay long-polls)
const resultWaiters = new Map(); // commandId -> Set<fn>  (phones awaiting a result)

function addTo(map, key, value) { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(value); }
function removeFrom(map, key, value) {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (!set.size) map.delete(key);
}
function sse(res, event) { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* gone */ } }
function toUser(userId, event) { for (const res of userStreams.get(userId) || []) sse(res, event); }
function wakeMachine(machineId) { for (const fn of [...(waiters.get(machineId) || [])]) fn(); }
function settleResult(commandId, result) { for (const fn of [...(resultWaiters.get(commandId) || [])]) fn(result); }

function openSse(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* gone */ } }, 25000);
  req.on("close", () => clearInterval(ping));
}

// ---- push ----

/** What the phone shows for a session that just started needing someone. */
export function pushFor(machine, s) {
  const where = s.cwd ? ` in ${path.basename(String(s.cwd))}` : "";
  const url = `/m#/p/${encodeURIComponent(machine.id)}/${encodeURIComponent(s.name)}`;
  if (s.state === "done") {
    return { title: `${s.name} is done`, body: `${s.engine || "agent"} on ${machine.name}${where}`, url, tag: `herd-${machine.id}-${s.name}` };
  }
  const what = s.blocked_on === "question" ? "has a question" : s.approval ? "wants permission" : "is waiting on you";
  const payload = {
    title: `${s.name} ${what}`,
    body: `${s.engine || "agent"} on ${machine.name}${where}`,
    url,
    tag: `herd-${machine.id}-${s.name}`,
    requireInteraction: true,
  };
  if (s.approval && s.action_token) {
    payload.actions = [{ action: "allow", title: "Allow" }, { action: "deny", title: "Deny" }];
    payload.act = { token: s.action_token };
  }
  return payload;
}

async function pushToUser(userId, payload) {
  if (!config.push.keys) { console.log(`[herd push:stub] ${payload.title}`); return; }
  const subs = await all(`SELECT * FROM push_subscriptions WHERE user_id = ?`, [userId]);
  if (!subs.length) return;
  await sendPushToMany(
    subs.map((s) => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })),
    JSON.stringify(payload),
    {
      keys: config.push.keys,
      subject: config.push.subject,
      ttl: PUSH_TTL,
      onGone: (endpoint) => run(`DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`, [endpoint, userId]),
    },
  ).catch((e) => console.error("herd push failed:", e.message));
}

/**
 * Which incoming rows deserve a push. Only transitions INTO blocked or done,
 * the rule `herd watch` already follows (shouldNotify): a session that sits
 * blocked does not page every heartbeat, and a machine's first publish is
 * history, not news. A new blocked spell (a different blockedAt) is news even
 * when the previous row was also blocked: that is a second permission prompt.
 */
export function shouldPush(prev, next, { firstPublish = false } = {}) {
  if (firstPublish || !prev) return false;
  if (next.state === "blocked") return prev.state !== "blocked" || Number(prev.blocked_at) !== Number(next.blocked_at);
  if (next.state === "done") return prev.state === "working" || prev.state === "blocked";
  return false;
}

// ---- box side ----

async function machineAuth(req, res, next) {
  const user = await userForApiKey(bearer(req));
  if (!user) return res.status(401).json({ error: "invalid or missing API key — run `moshcode login`" });
  req.apiUser = user;
  next();
}

/** The caller's machine, or null. `key` is the box's own machine id. */
const ownedMachine = (userId, key) => get(`SELECT * FROM herd_machines WHERE id = ? AND user_id = ?`, [machineRowId(userId, String(key || "")), userId]);

function readSession(raw) {
  const name = str(raw?.name, 64);
  const state = str(raw?.state, 16);
  if (!name || !state) return null;
  const approval = raw?.approval && typeof raw.approval === "object" ? { allowAll: Boolean(raw.approval.allowAll) } : null;
  const lines = Array.isArray(raw?.lastLines) ? raw.lastLines.slice(-12).map((l) => String(l).slice(0, 300)) : [];
  return {
    name,
    engine: str(raw.engine, 32),
    state,
    blocked_on: str(raw.blockedOn, 16),
    confidence: str(raw.confidence, 16),
    cwd: str(raw.cwd, 300),
    kind: str(raw.kind, 16),
    last_lines: JSON.stringify(lines),
    since: num(raw.since),
    blocked_at: state === "blocked" ? num(raw.blockedAt) : null,
    approval: state === "blocked" && approval ? approval : null,
  };
}

herdRouter.post("/api/herd/roster", machineAuth, async (req, res) => {
  const key = str(req.body?.machine?.id, 64);
  if (!key || !/^[A-Za-z0-9-]{8,64}$/.test(key)) return res.status(400).json({ error: "machine.id required" });
  const user = req.apiUser;
  const now = Date.now();
  const mid = machineRowId(user.id, key);
  const name = str(req.body?.machine?.name, 80) || "machine";
  const existing = await get(`SELECT * FROM herd_machines WHERE id = ?`, [mid]);
  if (existing) {
    await run(`UPDATE herd_machines SET name=?, platform=?, version=?, last_seen_at=? WHERE id=?`,
      [name, str(req.body.machine.platform, 20), str(req.body.machine.version, 20), now, mid]);
  } else {
    await run(`INSERT INTO herd_machines (id,user_id,name,platform,version,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?)`,
      [mid, user.id, name, str(req.body.machine.platform, 20), str(req.body.machine.version, 20), now, now]);
  }
  const machine = { id: mid, name };

  const incoming = (Array.isArray(req.body?.sessions) ? req.body.sessions : []).slice(0, MAX_SESSIONS).map(readSession).filter(Boolean);
  const before = new Map((await all(`SELECT * FROM herd_sessions WHERE machine_id = ?`, [mid])).map((r) => [r.name, r]));
  const pushes = [];
  for (const s of incoming) {
    const prev = before.get(s.name);
    // A new blocked spell gets a new capability; the same spell keeps its own,
    // so a heartbeat does not invalidate the buttons already on the phone.
    const sameSpell = prev && prev.state === "blocked" && s.state === "blocked" && Number(prev.blocked_at) === Number(s.blocked_at);
    const actionToken = s.state === "blocked" && s.approval ? (sameSpell && prev.action_token ? prev.action_token : token(18)) : null;
    const row = { ...s, action_token: actionToken };
    if (prev) {
      await run(`UPDATE herd_sessions SET engine=?, state=?, blocked_on=?, confidence=?, cwd=?, kind=?, last_lines=?, since=?, blocked_at=?, approval=?, action_token=?, updated_at=?
        WHERE machine_id=? AND name=?`,
        [row.engine, row.state, row.blocked_on, row.confidence, row.cwd, row.kind, row.last_lines, row.since, row.blocked_at,
          row.approval ? JSON.stringify(row.approval) : null, row.action_token, now, mid, row.name]);
    } else {
      await run(`INSERT INTO herd_sessions (machine_id,name,engine,state,blocked_on,confidence,cwd,kind,last_lines,since,blocked_at,approval,action_token,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [mid, row.name, row.engine, row.state, row.blocked_on, row.confidence, row.cwd, row.kind, row.last_lines, row.since, row.blocked_at,
          row.approval ? JSON.stringify(row.approval) : null, row.action_token, now]);
    }
    if (shouldPush(prev, row, { firstPublish: !existing })) pushes.push(row);
  }
  const present = new Set(incoming.map((s) => s.name));
  for (const name of before.keys()) {
    if (!present.has(name)) await run(`DELETE FROM herd_sessions WHERE machine_id = ? AND name = ?`, [mid, name]);
  }

  toUser(user.id, { type: "roster", machine: mid });
  for (const row of pushes) await pushToUser(user.id, pushFor(machine, row));

  const watching = incoming.filter((s) => paneStreams.has(`${mid}/${s.name}`)).map((s) => s.name);
  res.json({ ok: true, machine: mid, watching });
});

herdRouter.get("/api/herd/commands", machineAuth, async (req, res) => {
  const machine = await ownedMachine(req.apiUser.id, req.query.machine);
  if (!machine) return res.status(404).json({ error: "unknown machine — publish a roster first" });
  await run(`UPDATE herd_machines SET last_seen_at = ? WHERE id = ?`, [Date.now(), machine.id]);

  const claim = async () => {
    const queued = await all(`SELECT * FROM herd_commands WHERE machine_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 10`, [machine.id]);
    const mine = [];
    for (const c of queued) {
      // The UPDATE is the lock: only the poll that flips 'queued' runs it.
      const claimed = await run(`UPDATE herd_commands SET status='claimed', claimed_at=? WHERE id=? AND status='queued'`, [Date.now(), c.id]);
      if (claimed.rowsAffected) mine.push({ id: c.id, session: c.session, kind: c.kind, args: c.args ? JSON.parse(c.args) : {} });
    }
    return mine;
  };

  const first = await claim();
  if (first.length) return res.json({ commands: first });
  let settled = false;
  const finish = async () => {
    if (settled) return;
    settled = true;
    removeFrom(waiters, machine.id, finish);
    clearTimeout(timer);
    try { res.json({ commands: await claim() }); } catch { /* client gone */ }
  };
  const timer = setTimeout(finish, LONG_POLL_MS);
  addTo(waiters, machine.id, finish);
  req.on("close", () => { settled = true; removeFrom(waiters, machine.id, finish); clearTimeout(timer); });
});

herdRouter.post("/api/herd/commands/:id", machineAuth, async (req, res) => {
  const command = await get(`SELECT * FROM herd_commands WHERE id = ? AND user_id = ?`, [req.params.id, req.apiUser.id]);
  if (!command) return res.status(404).json({ error: "no such command" });
  const result = { ok: Boolean(req.body?.ok), stale: Boolean(req.body?.stale), error: str(req.body?.error, 300) };
  const status = result.ok ? "done" : result.stale ? "stale" : "failed";
  await run(`UPDATE herd_commands SET status=?, result=?, done_at=? WHERE id=? AND status='claimed'`,
    [status, JSON.stringify(result), Date.now(), command.id]);
  const event = { type: "result", id: command.id, machine: command.machine_id, session: command.session, kind: command.kind, status, ...result };
  toUser(req.apiUser.id, event);
  settleResult(command.id, event);
  res.json({ ok: true });
});

herdRouter.post("/api/herd/screen", machineAuth, async (req, res) => {
  const machine = await ownedMachine(req.apiUser.id, req.body?.machine);
  if (!machine) return res.status(404).json({ error: "unknown machine" });
  const session = str(req.body?.session, 64);
  if (!session) return res.status(400).json({ error: "session required" });
  const key = `${machine.id}/${session}`;
  const screen = String(req.body?.screen ?? "").slice(-MAX_SCREEN);
  screens.set(key, { screen, at: Date.now() });
  for (const out of paneStreams.get(key) || []) sse(out, { type: "screen", screen });
  res.json({ ok: true, watching: paneStreams.has(key) });
});

// ---- phone side ----

/** Cookie routes under /api/ skip csrfGuard (it assumes Bearer); writes check here. */
function csrfOk(req) {
  const sent = req.get("x-csrf-token");
  return Boolean(sent) && sent === req.cookies?.mc_csrf;
}

function apiAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "sign in at app.moshcode.sh first", login: "/" });
  next();
}

const phoneApp = path.join(config.root, "public", "herd", "index.html");
herdRouter.get(["/m", "/m/"], requireAuth, (_req, res) => {
  res.set("cache-control", "no-cache");
  res.sendFile(phoneApp);
});

/** One session row as the phone sees it. The action token never leaves the server here. */
export function sessionView(r) {
  let lastLines = [];
  try { lastLines = JSON.parse(r.last_lines || "[]"); } catch { lastLines = []; }
  let approval = null;
  try { approval = r.approval ? JSON.parse(r.approval) : null; } catch { approval = null; }
  return {
    name: r.name, engine: r.engine, state: r.state, blockedOn: r.blocked_on, confidence: r.confidence,
    cwd: r.cwd, kind: r.kind, lastLines, since: num(r.since), blockedAt: num(r.blocked_at), approval, updatedAt: num(r.updated_at),
  };
}

export async function herdFor(userId, now = Date.now()) {
  const machines = await all(`SELECT * FROM herd_machines WHERE user_id = ? ORDER BY last_seen_at DESC`, [userId]);
  const out = [];
  for (const m of machines) {
    const rows = await all(`SELECT * FROM herd_sessions WHERE machine_id = ? ORDER BY name ASC`, [m.id]);
    out.push({
      id: m.id, name: m.name, platform: m.platform, version: m.version,
      lastSeen: num(m.last_seen_at), online: now - Number(m.last_seen_at) < ONLINE_MS,
      sessions: rows.map(sessionView),
    });
  }
  return out;
}

herdRouter.get("/api/herd", apiAuth, async (req, res) => {
  res.set("cache-control", "no-store");
  res.json({ machines: await herdFor(req.user.id), csrf: req.csrfToken });
});

herdRouter.get("/api/herd/stream", apiAuth, (req, res) => {
  openSse(req, res);
  addTo(userStreams, req.user.id, res);
  req.on("close", () => removeFrom(userStreams, req.user.id, res));
});

async function queueCommand({ user, machine, session, kind, args, via, userAgent }) {
  const cid = id();
  await run(`INSERT INTO herd_commands (id,machine_id,user_id,session,kind,args,status,via,user_agent,created_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)`,
    [cid, machine.id, user.id, session, kind, JSON.stringify(args || {}), via, userAgent, Date.now()]);
  wakeMachine(machine.id);
  return cid;
}

herdRouter.get("/api/herd/pane/stream", apiAuth, async (req, res) => {
  const machine = await get(`SELECT * FROM herd_machines WHERE id = ? AND user_id = ?`, [String(req.query.machine || ""), req.user.id]);
  const session = str(req.query.session, 64);
  if (!machine || !session) return res.status(404).json({ error: "no such pane" });
  const key = `${machine.id}/${session}`;
  openSse(req, res);
  const cached = screens.get(key);
  if (cached) sse(res, { type: "screen", screen: cached.screen, cached: true });
  addTo(paneStreams, key, res);
  req.on("close", () => removeFrom(paneStreams, key, res));
  // Ask the relay to start streaming unless it plainly already is.
  if (!cached || Date.now() - cached.at > 3000) {
    await queueCommand({ user: req.user, machine, session, kind: "open-stream", args: {}, via: "app", userAgent: str(req.get("user-agent"), 200) });
  }
  // A relay streams for a minute past the last sign of life; keep it alive
  // while this page is open, with a cheap re-ask every 40 s.
  const keep = setInterval(() => {
    queueCommand({ user: req.user, machine, session, kind: "open-stream", args: {}, via: "app", userAgent: null }).catch(() => {});
  }, 40000);
  req.on("close", () => clearInterval(keep));
});

/** Validate a phone command's shape; returns an error string or null. */
export function commandError(kind, args) {
  if (!COMMAND_KINDS.includes(kind)) return "unknown command";
  if (kind === "approve") {
    if (!INTENTS.includes(args?.intent)) return "intent must be allow, allowAll or deny";
    if (num(args?.blockedAt) == null) return "blockedAt required";
  }
  if (kind === "prompt" && !String(args?.text || "").trim()) return "text required";
  if (kind === "keys" && (!Array.isArray(args?.keys) || !args.keys.length || args.keys.length > 16)) return "keys required";
  return null;
}

/** Wait for the relay's answer to one command, up to `ms`. */
function awaitResult(commandId, ms) {
  if (ms <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (result) => { clearTimeout(timer); removeFrom(resultWaiters, commandId, done); resolve(result); };
    const timer = setTimeout(() => done(null), ms);
    addTo(resultWaiters, commandId, done);
  });
}

herdRouter.post("/api/herd/command", apiAuth, async (req, res) => {
  if (!csrfOk(req)) return res.status(403).json({ error: "bad csrf token — reload the page" });
  const machine = await get(`SELECT * FROM herd_machines WHERE id = ? AND user_id = ?`, [String(req.body?.machine || ""), req.user.id]);
  if (!machine) return res.status(404).json({ error: "no such machine" });
  if (Date.now() - Number(machine.last_seen_at) >= ONLINE_MS) return res.status(409).json({ error: `${machine.name} is offline — is \`moshcode herd phone on\` running there?` });
  const session = str(req.body?.session, 64);
  const kind = String(req.body?.kind || "");
  const args = req.body?.args && typeof req.body.args === "object" ? req.body.args : {};
  const problem = commandError(kind, args);
  if (!session || problem) return res.status(400).json({ error: problem || "session required" });
  const clean = kind === "approve" ? { intent: args.intent, blockedAt: num(args.blockedAt) }
    : kind === "prompt" ? { text: String(args.text).slice(0, 4000) }
    : { keys: args.keys.map((k) => String(k).slice(0, 16)) };
  const cid = await queueCommand({ user: req.user, machine, session, kind, args: clean, via: "app", userAgent: str(req.get("user-agent"), 200) });
  const result = await awaitResult(cid, RESULT_WAIT_MS);
  res.json(result ? { id: cid, ...result } : { id: cid, status: "queued" });
});

herdRouter.get("/api/herd/command/:id", apiAuth, async (req, res) => {
  const c = await get(`SELECT * FROM herd_commands WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
  if (!c) return res.status(404).json({ error: "no such command" });
  let result = null;
  try { result = c.result ? JSON.parse(c.result) : null; } catch { result = null; }
  res.json({ id: c.id, status: c.status, ...(result || {}) });
});

// ---- push buttons ----

herdRouter.post("/api/herd/act", async (req, res) => {
  const tok = str(req.body?.token, 64);
  const intent = String(req.body?.intent || "");
  if (!tok || !["allow", "deny"].includes(intent)) return res.status(400).json({ error: "token and intent (allow|deny) required" });
  const s = await get(`SELECT s.*, m.user_id, m.last_seen_at FROM herd_sessions s JOIN herd_machines m ON m.id = s.machine_id WHERE s.action_token = ?`, [tok]);
  if (!s || s.state !== "blocked") return res.status(410).json({ error: "already answered", stale: true });
  // One use: the token is spent before the command is queued, so a double tap
  // (or a notification shown on two devices) answers once.
  const spent = await run(`UPDATE herd_sessions SET action_token = NULL WHERE machine_id = ? AND name = ? AND action_token = ?`, [s.machine_id, s.name, tok]);
  if (!spent.rowsAffected) return res.status(410).json({ error: "already answered", stale: true });
  const user = { id: s.user_id };
  const cid = await queueCommand({ user, machine: { id: s.machine_id }, session: s.name, kind: "approve",
    args: { intent, blockedAt: num(s.blocked_at) }, via: "push", userAgent: str(req.get("user-agent"), 200) });
  res.json({ ok: true, id: cid });
});
