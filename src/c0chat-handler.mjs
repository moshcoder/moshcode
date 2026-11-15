// Runs the c0mpute chat's slash commands (src/c0chat-commands.mjs) for the
// `moshcode agents c0mpute` REPL and its print mode. Media jobs take minutes
// (a clip: half an hour), so in the REPL each one is a background task on the
// task board, the way the chat keeps a card rendering while you type.

import path from "node:path";
import { saveConfig } from "./c0agent.mjs";
import {
  CHAT_HELP, PLUGIN_HELP, chatApi, chatKeyConfig, collectPushFiles, deviceLogin, mediaBackend, runMediaJob,
} from "./c0chat-commands.mjs";
import { acid, amber, ash, bone, danger, dim, err, ok, warn } from "./ui.mjs";
import { pidAlive, readTasks } from "./c0agent-tasks.mjs";

const LABEL = { image: "image", video: "video", music: "song", album: "album", promo: "promo video" };
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("stopped")); }, { once: true });
});

/**
 * `ctx`: { cfg, cwd(): string, log(line), board?, transcript: [], media: [],
 *          foreground(fn): runs fn(signal) as an interruptible foreground step,
 *          fetchImpl?, home? }
 * Returns handle(parsed) → Promise; `parsed` comes from parseChatCommand.
 */
export function createChatHandler(ctx) {
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
  const log = ctx.log;
  const chat = () => chatKeyConfig(ctx.home ? { home: ctx.home } : undefined);
  const outDir = () => path.join(ctx.cwd(), "c0mpute-media");
  const rel = (p) => { const r = path.relative(ctx.cwd(), p); return r.startsWith("..") ? p : r; };

  function mediaTask(parsed, { resume = null, resumedFrom = null } = {}) {
    const backend = mediaBackend(ctx.cfg, chat());
    const title = `/${parsed.media} ${parsed.prompt}`.slice(0, 200);
    ctx.transcript.push({ role: "user", content: title });
    const turn = ctx.transcript.length - 1;
    let onStarted = () => {};
    const run = (signal, onStatus) => runMediaJob({
      kind: parsed.media, body: parsed.body, prompt: parsed.prompt, backend, outDir: outDir(), onStatus, signal, fetchImpl,
      resume, onStarted: (job) => onStarted(job),
    }).then((r) => {
      ctx.media.push({ ...r.record, turn });
      const lines = [`saved ${r.files.map((f) => rel(f.path)).join(", ")}`, r.summary];
      ctx.transcript.push({ role: "assistant", content: `${LABEL[parsed.media]}: ${r.title ?? parsed.prompt}` });
      return { ...r, text: lines.join("\n") };
    });
    if (!ctx.board) return { backend, run };
    const t = ctx.board.add({ title, agent: `c0mpute ${LABEL[parsed.media]}`, background: true, cwd: ctx.cwd() });
    const controller = new AbortController();
    t.controller = controller;
    // The network's job id, saved the moment it exists: a later session
    // (after `moshcode update self`, a closed terminal) polls the same job
    // instead of losing it. The job itself keeps running server-side.
    const remember = (job) => {
      ctx.board.update(t, { remote: { kind: parsed.media, id: job.id, poll: job.poll, base: backend.base, startedAt: job.startedAt ?? Date.now() } });
      ctx.board.save?.();
    };
    onStarted = remember;
    if (resume) remember({ ...resume });
    if (resumedFrom) ctx.board.note(t, `picked up from #${resumedFrom} after its session ended`);
    ctx.board.update(t, { activity: resume ? `picking the job back up on ${backend.name}` : `sending to ${backend.name}` });
    let lastLine = "";
    run(controller.signal, (line) => {
      if (!line || line === lastLine) return;
      lastLine = line;
      ctx.board.update(t, { activity: line });
      ctx.board.note(t, line);
    }).then(
      (r) => ctx.board.update(t, { state: "completed", activity: "done", result: r.text }),
      (e) => ctx.board.update(t, controller.signal.aborted ? { state: "stopped", activity: "stopped" } : { state: "failed", error: String(e?.message || e) }),
    );
    log(`${acid("◐")} ${ash(`#${t.id}`)} ${bone(`${LABEL[parsed.media]} started on ${backend.name}`)} ${ash(`— keep working; it saves to ./${rel(outDir())}/ · /tasks ${t.id} to watch`)}`);
    if (!backend.key) log(ash("  no key: the free tier allows 10 a day · /key ik_live_… or /login for more"));
    return t;
  }

  async function push(cmd) {
    const api = chatApi(chat(), { fetchImpl });
    if (cmd.kind === "help") {
      if (cmd.error) log(err(cmd.error));
      log(ash("  usage: /push hosting <name> · /push hosting ls · /push hosting rm <name>"));
      return;
    }
    if (cmd.kind === "ls") {
      const r = await api.must("/api/v1/hosting/pushes");
      const list = r.pushes ?? [];
      if (!list.length) { log(ash("  no sites yet: /push hosting <name>")); return; }
      for (const p of list) log(`  ${p.status === "live" ? acid("●") : p.status === "failed" ? danger("✗") : amber("◐")} ${bone(p.name)} ${ash(p.status)}${p.url ? ` ${p.url}` : ""}${p.error ? ` ${danger(p.error)}` : ""}`);
      return;
    }
    if (cmd.kind === "rm") {
      const r = await api.call(`/api/v1/hosting/pushes/${encodeURIComponent(cmd.name)}`, { method: "DELETE" });
      if (!r.ok) throw new Error(r.body?.error?.message || `HTTP ${r.status}`);
      log(ok(r.status === 202 ? `${cmd.name} is being taken down` : `${cmd.name} deleted`));
      return;
    }
    const mine = ctx.media.filter((m) => m.pushable);
    const skipped = ctx.media.length - mine.length;
    if (skipped) log(warn(`  ${skipped} result${skipped === 1 ? " was" : "s were"} made before /login (on the open network), so ${skipped === 1 ? "it stays" : "they stay"} out of the site`));
    const files = collectPushFiles(cmd.name, ctx.transcript, ctx.media);
    const node = ctx.pushNode?.() ?? null;
    const r = await api.call("/api/v1/hosting/pushes", { method: "POST", body: { name: cmd.name, files, ...(node ? { node } : {}) } });
    if (r.status === 409) throw new Error(`${r.body?.error?.message || "no hosting node"} — link one with \`c0mpute chat connect hosting\` on a node, then /connect hosting`);
    if (!r.ok) throw new Error(r.body?.error?.message || `HTTP ${r.status}`);
    const id = r.body?.push?.id ?? cmd.name;
    log(`${acid("◐")} ${bone(`publishing ${cmd.name}`)} ${ash(`(${files.length} files${r.body?.push?.node ? ` on ${r.body.push.node}` : ""})`)}`);
    await ctx.foreground(async (signal) => {
      const until = Date.now() + 2 * 3600_000;
      let last = "";
      while (Date.now() < until) {
        await sleep(3000, signal);
        const s = await api.call(`/api/v1/hosting/pushes/${encodeURIComponent(id)}`, { signal }).catch(() => null);
        if (!s || s.status >= 500) continue;
        if (!s.ok) throw new Error(s.body?.error?.message || `HTTP ${s.status}`);
        const p = s.body?.push ?? {};
        const line = `${p.status}${p.progress ? ` · ${p.progress}` : ""}`;
        if (line !== last) { last = line; ctx.status?.(line); }
        if (p.status === "live") { log(ok(`${cmd.name} is live: ${p.url}${p.copies ? ash(` (${p.copies} copies)`) : ""}`)); return; }
        if (p.status === "failed") throw new Error(p.error || "the push failed");
      }
      throw new Error("still not live after 2 h — /push hosting ls");
    });
  }

  async function connect(cmd) {
    if (cmd.error) { log(err(cmd.error)); return; }
    const api = chatApi(chat(), { fetchImpl });
    const r = await api.must("/api/v1/hosting/nodes");
    const nodes = r.nodes ?? [];
    if (!cmd.node) {
      if (!nodes.length) { log(ash("  no hosting nodes: run `c0mpute chat connect hosting --name <node>` on the machine that should publish (pushes fall back to the shared cloud node)")); return; }
      const cur = ctx.pushNode?.();
      for (const n of nodes) log(`  ${n.name === cur ? acid("●") : " "} ${bone(n.name)} ${n.online ? acid("online") : ash("offline")}${n.version ? ash(` v${n.version}`) : ""}${n.payments ? ash(` · ${n.payments}`) : ""}`);
      log(ash("  /connect hosting <node> picks the one /push uses"));
      return;
    }
    const n = nodes.find((x) => x.name === cmd.node);
    if (!n) throw new Error(`no hosting node "${cmd.node}" on your account — /connect hosting lists them`);
    saveConfig({ pushNode: n.name }, ctx.home ? { home: ctx.home } : undefined);
    log(ok(`/push will publish on ${n.name}${n.online ? "" : ash(" (offline right now)")}`));
  }

  async function plugin(cmd) {
    const api = chatApi(chat(), { fetchImpl });
    if (cmd.kind === "help") { if (cmd.error) log(err(cmd.error)); for (const l of PLUGIN_HELP.split("\n")) log(ash(`  ${l}`)); return; }
    if (cmd.kind === "ls") {
      const r = await api.must("/api/v1/chat/plugins");
      const mine = r.plugins ?? [];
      if (mine.length) log(bone("your plugins"));
      for (const p of mine) log(`  ${p.status === "on" ? acid("●") : p.status === "needs_sign_in" ? amber("●") : ash("○")} ${bone(p.slug)} ${ash(p.status)}${p.tools?.length ? ash(` · ${p.tools.length} tools`) : ""}${p.connect_url && p.status === "needs_sign_in" ? `\n    sign in: ${p.connect_url}` : ""}`);
      const cat = (r.catalog ?? []).filter((c) => !c.added);
      if (cat.length) { log(bone("catalog")); for (const c of cat) log(`  ${bone(c.slug ?? c.name)} ${ash(c.title ?? c.description ?? "")}`); }
      if (!mine.length && !cat.length) log(ash("  none yet: /plugin add <https://… MCP server>"));
      log(ash("  plugins give tools to chats on c0mpute.com (web chat, TUI, /v1 API)"));
      return;
    }
    if (cmd.kind === "add") {
      const body = /^https?:\/\//i.test(cmd.target) ? { url: cmd.target } : { slug: cmd.target.toLowerCase() };
      const r = await api.must("/api/v1/chat/plugins", { method: "POST", body });
      log(ok(`added ${r.plugin?.slug ?? cmd.target}`));
      if (r.connect_url) log(`  ${amber("sign in")} ${r.connect_url} ${ash("(link valid 10 min)")}`);
      return;
    }
    if (cmd.kind === "rm") { await api.must(`/api/v1/chat/plugins/${cmd.slug}`, { method: "DELETE" }); log(ok(`removed ${cmd.slug}`)); return; }
    if (cmd.kind === "on" || cmd.kind === "off") {
      await api.must(`/api/v1/chat/plugins/${cmd.slug}/toggle`, { method: "POST", body: { enabled: cmd.kind === "on" } });
      log(ok(`${cmd.slug} ${cmd.kind}`));
      return;
    }
    if (cmd.kind === "connect") { const r = await api.must(`/api/v1/chat/plugins/${cmd.slug}/connect`); log(`  ${amber("sign in")} ${r.connect_url}`); }
  }

  async function login() {
    const c = chat();
    if (c.key) log(ash(`  already signed in (${c.source}); signing in again replaces moshcode's copy`));
    await ctx.foreground(async (signal) => {
      const key = await deviceLogin(c, {
        signal, fetchImpl,
        onCode: ({ url, code }) => { log(`  open ${bone(url)}`); log(ash(`  code ${code} · waiting for the browser (esc to cancel)`)); },
      });
      const file = saveConfig({ chatKey: key }, ctx.home ? { home: ctx.home } : undefined);
      log(ok(`signed in to c0mpute.com · key saved to ${file} (0600)`));
      log(ash("  /image /music /album /promo /video now run on your c0mpute.com account, and /push, /connect, /plugin work"));
    });
  }

  /**
   * Media jobs a session that has since ended (update, closed terminal) left
   * running: the network still has them, so poll them here. Each is picked up
   * once; tasks a live session owns, or that finished, are left alone.
   */
  function resumeOrphans({ alive = pidAlive } = {}) {
    if (!ctx.board?.file) return [];
    const all = readTasks({ file: ctx.board.file, alive });
    // Taken: owned by a live session, or already finished (by whichever session).
    const held = new Set(all.filter((t) => t.remote?.id && (alive(t.pid) || t.state === "completed" || t.state === "failed")).map((t) => t.remote.id));
    for (const t of ctx.board.tasks) if (t.remote?.id) held.add(t.remote.id);
    const picked = [];
    for (const old of all) {
      const r = old.remote;
      if (!r?.id || !r.poll || old.pid === process.pid || alive(old.pid) || old.userStopped) continue;
      if (old.state === "completed" || old.state === "failed" || held.has(r.id) || !LABEL[r.kind]) continue;
      const backend = mediaBackend(ctx.cfg, chat());
      if (r.base && backend.base !== r.base) {
        log(ash(`  #${old.id} ran on ${r.base}; this session talks to ${backend.base}, so it is not picked up`));
        continue;
      }
      held.add(r.id);
      const prompt = String(old.prompt ?? old.title ?? "").replace(new RegExp(`^/${r.kind}\\s+`), "");
      const t = mediaTask({ media: r.kind, prompt, body: null }, { resume: { id: r.id, poll: r.poll, startedAt: r.startedAt }, resumedFrom: old.id });
      if (t?.id) {
        old.pickedUp = t.id;
        picked.push({ from: old.id, to: t.id });
      }
    }
    return picked;
  }

  const handle = async function handle(parsed) {
    switch (parsed.kind) {
      case "usage": log(ash(`  ${parsed.message}`)); return null;
      case "media": return mediaTask(parsed);
      case "push": return push(parsed.cmd);
      case "connect": return connect(parsed.cmd);
      case "plugin": return plugin(parsed.cmd);
      case "login": return login();
      default: return null;
    }
  };
  handle.resumeOrphans = resumeOrphans;
  return handle;
}

export const CHAT_HELP_ROWS = CHAT_HELP;

/** Print mode: run a media line in the foreground, file paths on stdout. */
export async function runChatPrint(parsed, { cfg, cwd }) {
  const transcript = [];
  const media = [];
  const errLog = (l) => process.stderr.write(`${l}\n`);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const handle = createChatHandler({
    cfg, cwd: () => cwd, log: errLog, transcript, media,
    foreground: (fn) => fn(controller.signal),
    status: (l) => errLog(dim(`  ${l}`)),
    pushNode: () => null,
  });
  try {
    if (parsed.kind !== "media") { await handle(parsed); return 0; }
    const { backend, run } = await handle(parsed);
    errLog(ash(`${LABEL[parsed.media]} on ${backend.name}…`));
    let last = "";
    // A queued job's line only changes its m:ss timer: print it when the words change.
    const key = (l) => String(l).replace(/\b\d+:\d\d\b/g, "");
    const r = await run(controller.signal, (l) => { if (l && key(l) !== last) { last = key(l); errLog(dim(`  ${l}`)); } });
    for (const f of r.files) process.stdout.write(`${f.path}\n`);
    errLog(ok(r.summary));
    return 0;
  } catch (e) {
    errLog(err(String(e?.message || e)));
    return 1;
  }
}
