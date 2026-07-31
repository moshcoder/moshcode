// Live CLI session mirror — see what a running `mosh` instance sees, and type
// back into it from the browser.
//
//   POST /api/sessions                      CLI registers a session (Bearer key)
//   POST /api/sessions/:id/output           CLI appends output → fans out to SSE
//   POST /api/sessions/:id/end              CLI marks the session finished
//   GET  /api/sessions/:id/commands         CLI long-polls + claims queued commands
//   POST /api/sessions/:id/commands/:cid    CLI acks one as done
//   GET  /sessions                          human: connected instances
//   GET  /sessions/:id                      human: the mirror + a send box
//   GET  /sessions/:id/stream               human: SSE (scrollback, then live)
//   POST /sessions/:id/commands             human: queue a command
import { Router } from "express";
import { get, all, run } from "../db.mjs";
import { id } from "../lib/crypto.mjs";
import { bearer, userForApiKey } from "../lib/apikey.mjs";
import { balance } from "../lib/credits.mjs";
import { page, footer, appBar, esc } from "../lib/html.mjs";
import { requireAuth, csrfInput } from "../lib/session.mjs";

export const sessionsRouter = Router();

// A session is "live" only while the CLI keeps checking in. Anything quieter
// than this is shown as stale — the process was killed, the laptop slept, the
// network dropped. We never trust `status` alone for that reason.
const STALE_MS = 90 * 1000;
// Scrollback kept per session. Enough to open a page mid-run and have context,
// small enough that a chatty session can't grow the table without bound.
const SCROLLBACK = 400;
// How long a CLI poll parks waiting for a command. Overridable so tests don't
// have to sit through a real one.
const DEFAULT_LONG_POLL_MS = 25 * 1000;
export function readLongPollMs(value = process.env.SESSION_POLL_MS) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_LONG_POLL_MS;
  const ms = Number(raw);
  return Number.isSafeInteger(ms) && ms > 0 && ms <= 2_147_483_647
    ? ms
    : DEFAULT_LONG_POLL_MS;
}
const LONG_POLL_MS = readLongPollMs();

const isLive = (s) => s.status === "live" && Date.now() - Number(s.last_seen_at) < STALE_MS;

// ---- in-process fan-out ----
// Browsers watching each session, and CLIs parked on a long-poll. Both are
// best-effort caches in front of the DB: every SSE client replays from
// session_output on connect, and every long-poll falls back to a plain query,
// so a restart (or a second app instance) degrades to polling rather than
// losing data.
// A watcher is anything with `send(event)`, not a response: while a browser is
// still catching up on its scrollback its events go to a buffer instead of the
// wire. See the stream route.
const watchers = new Map(); // sessionId -> Set<{ send }>
const waiters = new Map();  // sessionId -> Set<fn>

function publish(sessionId, event) {
  const set = watchers.get(sessionId);
  if (!set) return;
  for (const w of set) { try { w.send(event); } catch { /* client vanished */ } }
}

/** A watcher that writes SSE frames straight to a live response. */
const sseWatcher = (res) => ({
  send: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
});

function wake(sessionId) {
  const set = waiters.get(sessionId);
  if (!set) return;
  for (const fn of [...set]) fn();
}

function addTo(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}
function removeFrom(map, key, value) {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (!set.size) map.delete(key);
}

// Resolve a session the caller is allowed to touch, or null.
const ownedSession = (sessionId, userId) =>
  get(`SELECT * FROM cli_sessions WHERE id = ? AND user_id = ?`, [sessionId, userId]);

// ---- CLI side (Bearer API key) ----

async function cliAuth(req, res, next) {
  const user = await userForApiKey(bearer(req));
  if (!user) return res.status(401).json({ error: "invalid or missing API key" });
  req.apiUser = user;
  next();
}

sessionsRouter.post("/api/sessions", cliAuth, async (req, res) => {
  const now = Date.now();
  const row = {
    id: id(),
    user_id: req.apiUser.id,
    name: String(req.body?.name || "mosh").slice(0, 60),
    host: req.body?.host ? String(req.body.host).slice(0, 60) : null,
    version: req.body?.version ? String(req.body.version).slice(0, 20) : null,
    cwd: req.body?.cwd ? String(req.body.cwd).slice(0, 200) : null,
  };
  await run(
    `INSERT INTO cli_sessions (id,user_id,name,host,version,cwd,status,created_at,last_seen_at)
     VALUES (?,?,?,?,?,?,'live',?,?)`,
    [row.id, row.user_id, row.name, row.host, row.version, row.cwd, now, now]
  );
  res.json({ id: row.id, url: `/sessions/${row.id}` });
});

sessionsRouter.post("/api/sessions/:id/output", cliAuth, async (req, res) => {
  const session = await ownedSession(req.params.id, req.apiUser.id);
  if (!session) return res.status(404).json({ error: "no such session" });

  const chunk = String(req.body?.chunk ?? "");
  const engine = req.body?.engine === undefined ? session.engine : (req.body.engine || null);
  const now = Date.now();
  await run(`UPDATE cli_sessions SET last_seen_at = ?, engine = ? WHERE id = ?`, [now, engine, session.id]);

  if (chunk) {
    // seq is per-session and monotonic so a reconnecting browser can ask for
    // "everything after N" instead of replaying the whole scrollback.
    //
    // Pick it inside the INSERT, the same way a credit reservation claims its
    // row. Reading MAX(seq) and then inserting is not enough: a CLI streams
    // output as it arrives, so two chunks are in flight at once, and against a
    // network database (Turso) both reads land before either insert does. Both
    // then write the same seq — and a browser resuming from `?since=<that seq>`
    // asks for `seq > since`, so the chunk it had not received yet is skipped
    // for good.
    const inserted = await get(
      `INSERT INTO session_output (session_id,seq,chunk,created_at)
       SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ? FROM session_output WHERE session_id = ?
       RETURNING seq`,
      [session.id, chunk.slice(0, 20000), now, session.id]
    );
    const seq = Number(inserted.seq);
    await run(
      `DELETE FROM session_output WHERE session_id = ? AND seq <= ?`,
      [session.id, seq - SCROLLBACK]
    );
    publish(session.id, { type: "out", seq, chunk });
  }
  if (engine !== session.engine) publish(session.id, { type: "engine", engine });
  res.json({ ok: true });
});

sessionsRouter.post("/api/sessions/:id/end", cliAuth, async (req, res) => {
  const session = await ownedSession(req.params.id, req.apiUser.id);
  if (!session) return res.status(404).json({ error: "no such session" });
  const now = Date.now();
  await run(`UPDATE cli_sessions SET status='ended', ended_at=?, last_seen_at=? WHERE id=?`, [now, now, session.id]);
  publish(session.id, { type: "end" });
  wake(session.id);
  res.json({ ok: true });
});

// Long-poll: claim queued commands for this session. Returns as soon as any
// exist, else parks until one arrives or the poll window closes.
sessionsRouter.get("/api/sessions/:id/commands", cliAuth, async (req, res) => {
  const session = await ownedSession(req.params.id, req.apiUser.id);
  if (!session) return res.status(404).json({ error: "no such session" });
  await run(`UPDATE cli_sessions SET last_seen_at = ? WHERE id = ?`, [Date.now(), session.id]);

  const claim = async () => {
    const queued = await all(
      `SELECT * FROM session_commands WHERE session_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 10`,
      [session.id]
    );
    const mine = [];
    for (const c of queued) {
      // The UPDATE is the lock — only the poll that flips 'queued' runs it.
      const claimed = await run(
        `UPDATE session_commands SET status='claimed', claimed_at=? WHERE id=? AND status='queued'`,
        [Date.now(), c.id]
      );
      if (claimed.rowsAffected) mine.push({ id: c.id, body: c.body });
    }
    return mine;
  };

  const first = await claim();
  if (first.length) return res.json({ commands: first });

  let settled = false;
  const finish = async () => {
    if (settled) return;
    settled = true;
    removeFrom(waiters, session.id, onWake);
    clearTimeout(timer);
    try { res.json({ commands: await claim() }); } catch { /* client gone */ }
  };
  const onWake = () => { finish(); };
  const timer = setTimeout(finish, LONG_POLL_MS);
  addTo(waiters, session.id, onWake);
  req.on("close", () => {
    settled = true;
    removeFrom(waiters, session.id, onWake);
    clearTimeout(timer);
  });
});

sessionsRouter.post("/api/sessions/:id/commands/:cid", cliAuth, async (req, res) => {
  const session = await ownedSession(req.params.id, req.apiUser.id);
  if (!session) return res.status(404).json({ error: "no such session" });
  const completed = await run(
    `UPDATE session_commands SET status='done', done_at=? WHERE id=? AND session_id=? AND status='claimed'`,
    [Date.now(), req.params.cid, session.id]);
  if (!completed.rowsAffected) {
    const command = await get(
      `SELECT status FROM session_commands WHERE id=? AND session_id=?`,
      [req.params.cid, session.id]
    );
    if (!command) return res.status(404).json({ error: "no such command" });
    if (command.status === "done") return res.json({ ok: true });
    return res.status(409).json({ error: "command is not claimed" });
  }
  publish(session.id, { type: "command-done", id: req.params.cid });
  res.json({ ok: true });
});

// ---- human side (cookie session) ----

sessionsRouter.get("/sessions", requireAuth, async (req, res) => {
  const rows = await all(
    `SELECT * FROM cli_sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 50`,
    [req.user.id]
  );
  const items = rows.length ? rows.map((s) => {
    const live = isLive(s);
    return `<a class="card sess" href="/sessions/${esc(s.id)}">
      <div class="card-body">
        <div class="sess-top">
          <span class="dot ${live ? "on" : "off"}"></span>
          <b>${esc(s.name)}</b>
          <span class="faint mono">${esc(s.version ? "v" + s.version : "")}</span>
        </div>
        <div class="dim mono sess-meta">${live ? (s.engine ? `▸ ${esc(s.engine)}` : "idle") : "offline"} · ${ago(s.last_seen_at)}${s.cwd ? ` · ${esc(s.cwd)}` : ""}</div>
      </div></a>`;
  }).join("") : `<div class="card"><div class="card-body dim mono">
      No mosh instances have checked in yet. Run <span class="acid">mosh</span> on a machine
      that's logged in (<span class="acid">/login</span>) and it shows up here.
    </div></div>`;

  res.type("html").send(page({
    title: "moshcode ▸ sessions",
    head: SESSION_CSS,
    body: `${appBar(req.user, await balance(req.user.id), req.csrfToken)}
    <main class="wrap" style="max-width:760px;padding-top:5vh">
      <h1 style="font-size:1.3rem;margin-bottom:4px">Sessions</h1>
      <p class="dim mono" style="font-size:.8rem;margin-bottom:16px">Live mirrors of your running mosh instances.</p>
      ${items}
    </main>${footer}`,
  }));
});

sessionsRouter.get("/sessions/:id", requireAuth, async (req, res) => {
  const s = await ownedSession(req.params.id, req.user.id);
  if (!s) return res.status(404).type("html").send(page({ body: `<main class="wrap" style="padding-top:12vh"><h1>No such session</h1></main>` }));
  const live = isLive(s);
  res.type("html").send(page({
    title: `moshcode ▸ ${s.name}`,
    head: SESSION_CSS,
    body: `${appBar(req.user, await balance(req.user.id), req.csrfToken)}
    <main class="wrap" style="max-width:900px;padding-top:5vh">
      <div class="sess-top" style="margin-bottom:10px">
        <span class="dot ${live ? "on" : "off"}" id="dot"></span>
        <b>${esc(s.name)}</b>
        <span class="faint mono">${esc(s.version ? "v" + s.version : "")}${s.cwd ? " · " + esc(s.cwd) : ""}</span>
        <a class="faint mono" href="/sessions" style="margin-left:auto">← all sessions</a>
      </div>
      <div id="term" class="term" aria-live="polite"></div>
      <form id="send" method="post" action="/sessions/${esc(s.id)}/commands" class="sendbar">
        ${csrfInput(req)}
        <input name="body" id="body" placeholder="/agents claude" autocomplete="off" spellcheck="false" ${live ? "" : "disabled"}>
        <button class="btn acid" type="submit" ${live ? "" : "disabled"}>run</button>
      </form>
      <p class="faint mono" style="font-size:.72rem;margin-top:8px">
        Commands run in the live mosh prompt. Output from an engine that has taken over the
        terminal (<span class="acid">/agents</span>) stays on that machine — you'll see the
        hand-off, not the engine's own screen.
      </p>
    </main>
    <script>${MIRROR_JS}</script>
    <script>mirror(${JSON.stringify(s.id)});</script>
    ${footer}`,
  }));
});

sessionsRouter.get("/sessions/:id/stream", requireAuth, async (req, res) => {
  const s = await ownedSession(req.params.id, req.user.id);
  if (!s) return res.status(404).end();

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");

  // Subscribe BEFORE reading the scrollback, not after. The read is evaluated
  // by the database and the rows then travel back; a chunk committed inside
  // that window is in neither the result nor the fan-out, and the mirror only
  // ever reconnects with the highest seq it has rendered, so the hole never
  // heals. Events that arrive while the replay is still going are held, then
  // flushed behind it in order.
  const held = [];
  let watcher = { send: (event) => held.push(event) };
  let ping = null;
  addTo(watchers, s.id, watcher);
  // Registered now, not after the replay: a browser that closes the tab mid-read
  // would otherwise leave its watcher in the map forever.
  req.on("close", () => { clearInterval(ping); removeFrom(watchers, s.id, watcher); });

  const asked = Number(req.query.since || 0);
  const since = Number.isFinite(asked) ? asked : 0;
  const back = await all(
    `SELECT seq, chunk FROM session_output WHERE session_id = ? AND seq > ? ORDER BY seq ASC`,
    [s.id, since]
  );

  const live = sseWatcher(res);
  let last = since;
  for (const row of back) {
    last = Number(row.seq);
    live.send({ type: "out", seq: row.seq, chunk: row.chunk });
  }
  if (!isLive(s)) live.send({ type: "offline" });

  // Swap the buffer for the wire and drain it. Synchronous, so publish() can't
  // land between the two. Anything the scrollback already carried is dropped —
  // subscribing early means a chunk can legitimately be in both.
  removeFrom(watchers, s.id, watcher);
  watcher = live;
  addTo(watchers, s.id, watcher);
  for (const event of held) {
    if (event.type === "out" && Number(event.seq) <= last) continue;
    try { live.send(event); } catch { /* client vanished */ }
  }

  // Proxies drop an idle stream; a comment every 25s is cheaper than a reconnect.
  ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* gone */ } }, 25000);
});

sessionsRouter.post("/sessions/:id/commands", requireAuth, async (req, res) => {
  const s = await ownedSession(req.params.id, req.user.id);
  if (!s) return res.status(404).json({ error: "no such session" });
  const body = String(req.body?.body || "").trim().slice(0, 500);
  if (!body) return wantsJson(req) ? res.status(400).json({ error: "empty command" }) : res.redirect(`/sessions/${s.id}`);
  if (!isLive(s)) return wantsJson(req) ? res.status(409).json({ error: "session offline" }) : res.redirect(`/sessions/${s.id}`);

  const cid = id();
  await run(`INSERT INTO session_commands (id,session_id,body,status,created_at) VALUES (?,?,?,'queued',?)`,
    [cid, s.id, body, Date.now()]);
  wake(s.id); // release the CLI's long-poll immediately
  publish(s.id, { type: "queued", id: cid, body });
  return wantsJson(req) ? res.json({ ok: true, id: cid }) : res.redirect(`/sessions/${s.id}`);
});

const wantsJson = (req) => (req.get("accept") || "").includes("application/json");

function ago(ts) {
  const s = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const SESSION_CSS = `<style>
  .sess { display:block; text-decoration:none; margin-bottom:10px; }
  .sess-top { display:flex; align-items:center; gap:8px; }
  .sess-meta { font-size:.76rem; margin-top:4px; }
  .dot { width:8px; height:8px; border-radius:50%; display:inline-block; flex:none; }
  .dot.on { background:#a6ff1a; box-shadow:0 0 8px #a6ff1a; }
  .dot.off { background:#4a4f42; }
  .term {
    background:#050604; border:1px solid #1d2418; border-radius:8px; padding:12px;
    height:60vh; min-height:280px; overflow-y:auto; white-space:pre-wrap; word-break:break-word;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.8rem; line-height:1.5; color:#edf2e4;
  }
  .sendbar { display:flex; gap:8px; margin-top:10px; }
  .sendbar input { flex:1; font-family:ui-monospace,monospace; }
  .sendbar input:disabled, .sendbar button:disabled { opacity:.45; cursor:not-allowed; }
</style>`;

// Rendered client-side: the CLI ships raw ANSI, and colour is most of how the
// pit reads. Only SGR (colour/bold/dim) is translated; every other escape —
// cursor moves, clears — is dropped rather than mangled into visible junk.
const MIRROR_JS = `
function mirror(sessionId) {
  var term = document.getElementById("term"), dot = document.getElementById("dot");
  var form = document.getElementById("send"), input = document.getElementById("body");
  var seq = 0;
  var COLORS = { 30:"#070806",31:"#ff0050",32:"#a6ff1a",33:"#ffd53d",34:"#4d9fff",35:"#c77dff",36:"#4de1e1",37:"#edf2e4",90:"#6b7263",91:"#ff5c88",92:"#c8ff6b",93:"#ffe27a",94:"#8cc0ff",95:"#dcb0ff",96:"#8ff0f0",97:"#ffffff" };
  function esc(s){ return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function render(text) {
    var out = "", open = 0, i = 0;
    var re = /\\u001b\\[([0-9;]*)m|\\u001b\\[[0-9;?]*[A-Za-z]|\\u001b\\][^\\u0007]*\\u0007/g, m;
    while ((m = re.exec(text))) {
      out += esc(text.slice(i, m.index));
      i = re.lastIndex;
      if (m[1] === undefined) continue;            // non-SGR escape → drop
      var codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
      for (var c = 0; c < codes.length; c++) {
        var code = codes[c];
        if (code === 0) { while (open) { out += "</span>"; open--; } }
        else if (code === 1) { out += '<span style="font-weight:700">'; open++; }
        else if (code === 2) { out += '<span style="opacity:.65">'; open++; }
        else if (COLORS[code]) { out += '<span style="color:' + COLORS[code] + '">'; open++; }
      }
    }
    out += esc(text.slice(i));
    while (open) { out += "</span>"; open--; }
    return out;
  }
  function append(chunk) {
    var stick = term.scrollTop + term.clientHeight >= term.scrollHeight - 40;
    term.insertAdjacentHTML("beforeend", render(chunk));
    if (stick) term.scrollTop = term.scrollHeight;
  }
  function offline() { if (dot) { dot.classList.remove("on"); dot.classList.add("off"); } }
  function connect() {
    var es = new EventSource("/sessions/" + sessionId + "/stream?since=" + seq);
    es.onmessage = function (e) {
      var d = JSON.parse(e.data);
      if (d.type === "out") { seq = d.seq; append(d.chunk); }
      else if (d.type === "queued") { append("\\u001b[2m\\u001b[36m▸ (web) " + d.body + "\\u001b[0m\\n"); }
      else if (d.type === "end" || d.type === "offline") { offline(); }
    };
    es.onerror = function () { es.close(); setTimeout(connect, 3000); };
  }
  if (form) form.addEventListener("submit", function (e) {
    e.preventDefault();
    var body = input.value.trim();
    if (!body) return;
    fetch(form.action, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ body: body, _csrf: form._csrf.value }),
    }).then(function (r) { if (r.ok) input.value = ""; });
  });
  connect();
}
`;
