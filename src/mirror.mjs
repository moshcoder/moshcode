// Live session mirror — the CLI half of `/sessions` on app.moshcode.sh.
//
// While the pit is open, everything moshcode prints is tee'd to the app so you
// can watch this machine from a browser, and commands typed there are handed
// back to the prompt as if you'd typed them. It is deliberately best-effort:
// every network call is swallowed, because a flaky link must never take down
// the terminal you're actually working in.
//
// What it can't see: once an engine takes the terminal (`/agents claude`), the
// child writes straight to the tty on its own fd — those bytes never pass
// through this process. The mirror shows the hand-off, not the engine's screen.
import os from "node:os";
import { loadCreds } from "./auth.mjs";

const FLUSH_MS = 150;      // batch writes so a busy render is one request, not fifty
const MAX_BUFFER = 16000;  // flush early once a batch gets big

export function createMirror({
  version = "",
  cwd = process.cwd(),
  fetchImpl = fetch,
  credentials = loadCreds(),
} = {}) {
  const creds = credentials;
  let sessionId = null;
  let stopped = false;
  let pending = "";
  let flushTimer = null;
  let engine = null;
  let engineDirty = false;
  // The parked long-poll, so stop() can cut it loose instead of leaving the
  // process alive for up to a full poll window after the pit closes.
  let poll = null;
  const onCommand = new Set();

  const api = (creds?.api || "https://app.moshcode.sh").replace(/\/+$/, "");
  const headers = { "content-type": "application/json", authorization: `Bearer ${creds?.token}` };

  const post = async (path, body, opts = {}) => {
    try {
      const r = await fetchImpl(`${api}${path}`, { method: "POST", headers, body: JSON.stringify(body), ...opts });
      return r.ok ? await r.json().catch(() => ({})) : null;
    } catch { return null; }
  };

  // The browser runs a real terminal emulator over this stream, so it has to
  // know how wide the tty on this end is — otherwise every line wraps at the
  // wrong column and anything that redraws in place lands crooked.
  //
  // Piped output (CI, `mosh | tee`) has no size at all, and half a size is no
  // use to an emulator, so send nothing rather than nulls: the app keeps
  // whatever it already had and the page falls back to filling its box.
  const size = () => {
    const { columns, rows } = process.stdout;
    return columns && rows ? { cols: columns, rows } : {};
  };

  async function flush() {
    flushTimer = null;
    if (!sessionId || (!pending && !engineDirty)) return;
    const chunk = pending;
    pending = "";
    engineDirty = false;
    await post(`/api/sessions/${sessionId}/output`, { chunk, engine, ...size() });
  }

  function schedule() {
    if (flushTimer || stopped) return;
    flushTimer = setTimeout(flush, FLUSH_MS);
    flushTimer.unref?.(); // never hold the process open on account of the mirror
  }

  /** Tee a chunk of terminal output to the app. */
  function write(text) {
    if (!sessionId || stopped || !text) return;
    pending += text;
    if (pending.length >= MAX_BUFFER) { clearTimeout(flushTimer); flushTimer = null; flush(); }
    else schedule();
  }

  /** Note which engine owns the terminal right now (null = back in the pit). */
  function setEngine(name) {
    const next = name || null;
    if (next === engine) return;
    engine = next;
    engineDirty = true;
    schedule();
  }

  // Dragging a window edge fires `resize` continuously, so settle first and
  // send one empty post carrying the final geometry.
  let resizeTimer = null;
  function onResize() {
    if (stopped || !sessionId) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      post(`/api/sessions/${sessionId}/output`, { chunk: "", engine, ...size() });
    }, 120);
    resizeTimer.unref?.();
  }

  // Long-poll for commands typed on the web. One request parks on the server
  // until something is queued, so a command lands in well under a second
  // without us hammering the API.
  async function pump() {
    while (!stopped && sessionId) {
      let got = null;
      try {
        poll = new AbortController();
        const r = await fetchImpl(`${api}/api/sessions/${sessionId}/commands`, { headers, signal: poll.signal });
        got = r.ok ? await r.json() : null;
      } catch { /* network blip or stop() aborting us — handled below */ }
      if (stopped) return;
      if (!got) { await sleep(5000); continue; }
      for (const c of got.commands || []) {
        for (const fn of onCommand) { try { fn(c.body); } catch { /* handler's problem */ } }
        post(`/api/sessions/${sessionId}/commands/${c.id}`, {});
      }
    }
  }

  return {
    get id() { return sessionId; },
    get url() { return sessionId ? `${api}/sessions/${sessionId}` : null; },
    /** Register with the app. Resolves false when not logged in or unreachable. */
    async start() {
      if (!creds?.token) return false;
      const r = await post("/api/sessions", {
        name: `mosh @ ${os.hostname()}`,
        host: os.hostname(),
        version,
        cwd,
        ...size(),
      });
      if (!r?.id) return false;
      sessionId = r.id;
      // A resize carries no output of its own, so nudge a flush: the new
      // geometry rides the next post and the watching browser reshapes with us
      // instead of waiting for whatever gets printed next.
      process.stdout.on("resize", onResize);
      pump();
      return true;
    },
    write,
    setEngine,
    /** Subscribe to commands sent from the web. Returns an unsubscribe fn. */
    onCommand(fn) { onCommand.add(fn); return () => onCommand.delete(fn); },
    async stop() {
      if (!sessionId || stopped) return;
      stopped = true;
      clearTimeout(flushTimer);
      clearTimeout(resizeTimer);
      flushTimer = null;
      resizeTimer = null;
      process.stdout.off?.("resize", onResize);
      try { poll?.abort(); } catch { /* already gone */ }
      // Flush whatever is left before saying goodbye, so the last thing you
      // did is visible in the mirror rather than lost with the process.
      if (pending) {
        const chunk = pending;
        pending = "";
        await post(`/api/sessions/${sessionId}/output`, { chunk, engine, ...size() });
      }
      await post(`/api/sessions/${sessionId}/end`, {});
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Tee process stdout/stderr into `sink` while leaving the real terminal
 * untouched. Returns a restore fn.
 */
export function teeOutput(sink) {
  const targets = [process.stdout, process.stderr];
  const originals = targets.map((s) => s.write.bind(s));
  targets.forEach((stream, i) => {
    stream.write = (chunk, enc, cb) => {
      try { sink(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); }
      catch { /* mirroring must never break printing */ }
      return originals[i](chunk, enc, cb);
    };
  });
  return () => targets.forEach((stream, i) => { stream.write = originals[i]; });
}
