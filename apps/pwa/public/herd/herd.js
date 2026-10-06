// moshcode herd on a phone (PRD 0020, phase 1). Plain ES module, no framework.
//
// Routes (hash, so the service worker and a refresh both land on /m):
//   #/                    every session on every machine, blocked first
//   #/p/<machine>/<name>  one pane: approval card, live screen, key bar, composer
//   #/machines            paired machines, and the one command that pairs one
import { pushSupport, subscribe, unsubscribe, getSubscription } from "/vendor/notifications-client.js";

const view = document.getElementById("view");
const title = document.getElementById("title");
const back = document.getElementById("back");
const toastEl = document.getElementById("toast");

const STATE_ORDER = { blocked: 0, working: 1, idle: 2, unknown: 3, done: 4 };
// The key bar (PRD §4): names the relay accepts (src/herd-relay.mjs PHONE_KEYS).
const KEYBAR = [
  ["esc", "Esc"], ["tab", "Tab"], ["up", "↑"], ["down", "↓"], ["left", "←"], ["right", "→"],
  ["enter", "⏎"], ["ctrl-c", "^C"], ["slash", "/"], ["shift-tab", "⇧Tab"], ["1", "1"], ["2", "2"], ["3", "3"],
  ["y", "y"], ["n", "n"], ["backspace", "⌫"], ["ctrl-d", "^D"],
];

let herd = { machines: [] };
let csrf = "";
let paneStream = null;
let term = null;
let fit = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const base = (p) => String(p || "").split("/").filter(Boolean).pop() || "";

function cookieCsrf() {
  const m = document.cookie.match(/(?:^|; )mc_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : csrf;
}

function toast(message, tone = "") {
  toastEl.textContent = message;
  toastEl.className = `toast ${tone}`;
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { toastEl.hidden = true; }, 3200);
}

function ago(ms) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function load() {
  const res = await fetch("/api/herd", { credentials: "same-origin", cache: "no-store" });
  if (res.status === 401) { location.href = "/"; return; }
  const data = await res.json();
  herd = data;
  csrf = data.csrf || csrf;
}

let reloadTimer = null;
function reloadSoon() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => { await load().catch(() => {}); render(); }, 250);
}

function listen() {
  const es = new EventSource("/api/herd/stream");
  es.onmessage = (e) => {
    let event; try { event = JSON.parse(e.data); } catch { return; }
    if (event.type === "roster") reloadSoon();
    if (event.type === "result") onResult(event);
  };
  es.onerror = () => { /* EventSource reconnects on its own */ };
}

function onResult(event) {
  if (event.kind === "open-stream") return;
  if (event.status === "done") toast(`${event.session}: sent`, "good");
  else if (event.status === "stale") toast(`${event.session}: already answered`, "");
  else toast(`${event.session}: ${event.error || "failed"}`, "bad");
}

async function command(machine, session, kind, args) {
  const res = await fetch("/api/herd/command", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-csrf-token": cookieCsrf() },
    body: JSON.stringify({ machine, session, kind, args }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { toast(body.error || `failed (${res.status})`, "bad"); return null; }
  if (body.status === "queued") toast("queued — the machine has not answered yet");
  else onResult({ ...body, session, kind });
  return body;
}

// ---- views ----

function chip(s) {
  const label = s.state === "blocked" && s.blockedOn ? `blocked · ${s.blockedOn}` : s.state;
  return `<span class="chip ${esc(s.state)}">${esc(label)}</span>`;
}

function renderHerd() {
  title.textContent = "herd";
  back.hidden = true;
  const machines = herd.machines || [];
  if (!machines.length) {
    view.innerHTML = `<div class="empty">
      <p>No machines yet.</p>
      <p>On the box running your agents:</p>
      <p class="mono"><code>moshcode herd phone on</code></p>
      <p><a href="#/machines" class="dim">how pairing works →</a></p></div>`;
    return;
  }
  view.innerHTML = machines.map((m) => {
    const sessions = [...m.sessions].sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || a.name.localeCompare(b.name));
    const rows = sessions.length ? sessions.map((s) => `
      <a class="row ${esc(s.state)}" href="#/p/${encodeURIComponent(m.id)}/${encodeURIComponent(s.name)}">
        ${chip(s)}<span class="who">${esc(s.name)}</span>
        <span></span><span class="meta">${esc(s.engine || "")}${s.cwd ? ` · ${esc(base(s.cwd))}` : ""}</span>
        <span class="line">${esc((s.lastLines || []).slice(-1)[0] || "")}</span>
      </a>`).join("") : `<div class="empty">nothing running in this herd</div>`;
    return `<section class="machine">
      <div class="machine-head"><span class="dot ${m.online ? "on" : ""}"></span><span class="name">${esc(m.name)}</span>
        <span class="seen">${m.online ? "online" : `seen ${ago(m.lastSeen)}`}</span></div>
      ${rows}</section>`;
  }).join("");
}

function findPane(mid, name) {
  const machine = (herd.machines || []).find((m) => m.id === mid);
  return { machine, session: machine?.sessions.find((s) => s.name === name) || null };
}

function approvalCard(machine, s) {
  if (!machine?.online) return `<p class="hint">${esc(machine?.name || "this machine")} is offline — answers will wait until its relay is back.</p>`;
  if (s.state !== "blocked") return "";
  if (!s.approval) {
    return `<p class="hint">blocked${s.blockedOn ? ` on a ${esc(s.blockedOn)}` : ""} — answer it with the keys or a reply below.</p>`;
  }
  return `<div class="approve" id="approve">
    <p>${esc(s.name)} wants permission</p>
    <div class="btns">
      <button class="btn go" data-intent="allow" type="button">Allow</button>
      <button class="btn no" data-intent="deny" type="button">Deny</button>
      ${s.approval.allowAll ? `<button class="btn wide" data-intent="allowAll" type="button">Allow all this session</button>` : ""}
    </div></div>`;
}

function renderPane(mid, name) {
  const { machine, session } = findPane(mid, name);
  title.textContent = name;
  back.hidden = false;
  if (!session) {
    closePane();
    view.innerHTML = `<div class="empty">${esc(name)} is not in the herd any more.</div>`;
    return;
  }
  const head = `<div class="pane-head">${chip(session)}<span>${esc(session.engine || "")}</span><span>·</span>
    <span>${esc(machine.name)}</span>${session.cwd ? `<span>·</span><span>${esc(base(session.cwd))}</span>` : ""}</div>`;

  // Re-render only the parts that change when the roster updates; the
  // terminal is kept, because tearing it down drops the screen and the stream.
  const existing = document.getElementById("pane");
  if (existing && existing.dataset.key === `${mid}/${name}`) {
    document.getElementById("pane-head").innerHTML = head;
    document.getElementById("pane-approve").innerHTML = approvalCard(machine, session);
    wireApprove(mid, session);
    return;
  }

  closePane();
  view.innerHTML = `<div id="pane" data-key="${esc(`${mid}/${name}`)}">
    <div id="pane-head">${head}</div>
    <div id="pane-approve">${approvalCard(machine, session)}</div>
    <div class="term-wrap" id="term"></div>
    <div class="term-status" id="term-status">connecting to the screen…</div>
    <div class="keybar" id="keybar">${KEYBAR.map(([k, label]) => `<button type="button" data-key="${esc(k)}">${esc(label)}</button>`).join("")}</div>
    <form class="composer" id="composer">
      <textarea id="prompt" rows="1" placeholder="reply or prompt ${esc(name)}…" enterkeyhint="send" autocapitalize="off" autocomplete="off"></textarea>
      <button class="btn go" type="submit">Send</button>
    </form></div>`;
  wireApprove(mid, session);

  document.getElementById("keybar").addEventListener("click", (e) => {
    const key = e.target.closest("button")?.dataset.key;
    if (key) command(mid, name, "keys", { keys: [key] });
  });
  const input = document.getElementById("prompt");
  document.getElementById("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const r = await command(mid, name, "prompt", { text });
    if (r && r.status !== "failed") input.value = "";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); document.getElementById("composer").requestSubmit(); }
  });
  openTerminal(mid, name);
}

function wireApprove(mid, session) {
  const card = document.getElementById("approve");
  if (!card) return;
  card.addEventListener("click", async (e) => {
    const intent = e.target.closest("button")?.dataset.intent;
    if (!intent) return;
    for (const b of card.querySelectorAll("button")) b.disabled = true;
    const r = await command(mid, session.name, "approve", { intent, blockedAt: session.blockedAt });
    if (!r || r.status === "failed") for (const b of card.querySelectorAll("button")) b.disabled = false;
  });
}

/** Paint a captured screen. The pane is wider than a phone, so the font fits the widest line. */
function paint(screen) {
  const host = document.getElementById("term");
  if (!host || !window.Terminal) return;
  const lines = String(screen || "").replace(/\n+$/, "").split("\n");
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
  const cols = Math.min(240, Math.max(40, ...plain.map((l) => l.length)));
  const rows = Math.max(10, Math.min(80, lines.length));
  const width = host.clientWidth - 12;
  const fontSize = Math.max(6, Math.min(13, Math.floor((width / cols) / 0.6)));
  if (!term) {
    term = new window.Terminal({
      cols, rows, fontSize, convertEol: true, disableStdin: true, cursorBlink: false, scrollback: 0,
      fontFamily: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace',
      theme: { background: "#000000", foreground: "#edf2e4", cursor: "#a6ff1a" },
    });
    term.open(host);
  } else {
    if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
  }
  term.write("\x1b[2J\x1b[3J\x1b[H" + lines.join("\r\n"));
}

function openTerminal(mid, name) {
  const status = document.getElementById("term-status");
  paneStream = new EventSource(`/api/herd/pane/stream?machine=${encodeURIComponent(mid)}&session=${encodeURIComponent(name)}`);
  let got = false;
  const waiting = setTimeout(() => { if (!got && status) status.textContent = "waiting for the machine to send its screen…"; }, 4000);
  paneStream.onmessage = (e) => {
    let event; try { event = JSON.parse(e.data); } catch { return; }
    if (event.type !== "screen") return;
    got = true;
    clearTimeout(waiting);
    if (status) status.textContent = event.cached ? "last screen — refreshing…" : "live";
    paint(event.screen);
  };
}

function closePane() {
  if (paneStream) { paneStream.close(); paneStream = null; }
  if (term) { term.dispose(); term = null; }
}

function renderMachines() {
  closePane();
  title.textContent = "machines";
  back.hidden = false;
  const machines = herd.machines || [];
  const list = machines.length ? machines.map((m) => `
    <div class="machine-head"><span class="dot ${m.online ? "on" : ""}"></span><span class="name">${esc(m.name)}</span>
      <span class="seen">${m.online ? "online" : `seen ${ago(m.lastSeen)}`} · ${m.sessions.length} session${m.sessions.length === 1 ? "" : "s"}</span></div>`).join("")
    : `<p>none yet.</p>`;
  view.innerHTML = `
    <div class="card"><h2>Pair a machine</h2>
      <p>On the box running your agents, signed in to the same account:</p>
      <div class="cmd"><code>moshcode herd phone on</code><button class="btn" type="button" data-copy="moshcode herd phone on">copy</button></div>
      <p>No moshcode there yet?</p>
      <div class="cmd"><code>curl -fsSL https://moshcoding.com/install.sh | sh</code><button class="btn" type="button" data-copy="curl -fsSL https://moshcoding.com/install.sh | sh">copy</button></div>
      <p>The box dials out to app.moshcode.sh. Nothing listens on it: no port, no Tailscale, no SSH key on this phone.</p></div>
    <div class="card"><h2>Paired</h2>${list}</div>
    <div class="card"><h2>On iPhone</h2>
      <p>Share → Add to Home Screen, then open moshcode from the home screen and tap 🔔. Safari only delivers notifications to an installed app, and shows no Allow/Deny buttons on them: tapping one opens the approval here.</p></div>`;
  view.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast("copied", "good"); } catch { toast("copy failed", "bad"); }
  }));
}

function render() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (parts[0] === "p" && parts[1] && parts[2]) return renderPane(parts[1], parts[2]);
  closePane();
  if (parts[0] === "machines") return renderMachines();
  return renderHerd();
}

// ---- push on this device ----
async function setupPush() {
  const btn = document.getElementById("push-btn");
  const why = document.getElementById("push-why");
  const explain = (m) => { why.textContent = m || ""; why.hidden = !m; };
  const set = (on) => { btn.dataset.on = on ? "1" : "0"; btn.textContent = on ? "🔔" : "🔕"; btn.title = on ? "Notifications on" : "Turn on notifications"; };
  const support = pushSupport();
  if (!support.supported) { set(false); btn.addEventListener("click", () => explain(support.message)); return; }
  try { set(Boolean(await getSubscription())); } catch { set(false); }
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      if (btn.dataset.on === "1") { await unsubscribe({ removeUrl: "/push/unsubscribe", headers: { "x-csrf-token": cookieCsrf() } }); set(false); toast("notifications off on this device"); }
      else { await subscribe({ saveUrl: "/push/subscribe", headers: { "x-csrf-token": cookieCsrf() } }); set(true); explain(""); toast("notifications on — a blocked agent will buzz this phone", "good"); }
    } catch (e) { explain(e?.message || "could not change notifications"); }
    finally { btn.disabled = false; }
  });
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
window.addEventListener("hashchange", render);
window.addEventListener("resize", () => { if (term) reloadSoon(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) reloadSoon(); });
await load().catch(() => {});
render();
listen();
setupPush();
