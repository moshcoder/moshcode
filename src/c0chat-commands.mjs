// The c0mpute chat's slash commands inside `moshcode agents c0mpute`:
// /image /video /music /album /promo, /push hosting, /connect hosting,
// /plugin and /login, the same lines c0mpute.com/chat and the c0mpute TUI take.
//
// The parsers are ports of c0mpute apps/web/src/lib/chat/{images,videos,music,
// album,promo,push-shared,plugin-shared,commands}.ts: keep the regexes equal.
//
// Two backends, chosen per session:
//   - c0mpute.com /api/v1/* with a c0k_ key (`/login` here, or the key from
//     `c0mpute chat login` in ~/.c0mpute/chat.json). Needed by /push, /connect
//     and /plugin, and the media it makes can be pushed as a site.
//   - otherwise Infernet /api/chat/* with the ik_live_ key moshcode already
//     uses for the model (or none: the network's free tier). Out of the box.
// Both answer a start with 202 {id, poll}; results hang off the poll path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ─── parsers (verbatim ports) ────────────────────────────────────────────────

export function parseImageCommand(text) {
  const m = /^\/(?:image|img|draw)\s+([\s\S]+)$/i.exec(String(text ?? "").trim());
  return m ? m[1].trim() || null : null;
}

export const VIDEO_MODELS = ["wan2.1-t2v-1.3b", "wan2.2-ti2v-5b"];
export const DEFAULT_VIDEO_MODEL = "wan2.1-t2v-1.3b";

/** null = not a video line; string = usage/error; else { prompt, model }. */
export function parseVideoCommand(text) {
  const m = /^\/(?:video|clip|vid)(?:\s+([\s\S]*))?$/i.exec(String(text ?? "").trim());
  if (!m) return null;
  let rest = (m[1] ?? "").trim();
  let model = DEFAULT_VIDEO_MODEL;
  const flag = /(?:^|\s)--model[=\s]+(\S+)/.exec(rest);
  if (flag) {
    if (!VIDEO_MODELS.includes(flag[1])) return `model must be one of: ${VIDEO_MODELS.join(", ")}`;
    model = flag[1];
    rest = rest.replace(flag[0], " ").trim();
  }
  if (!rest) return "usage: /video <what happens in the clip>";
  if (rest.length > 2000) return "prompt must contain 1 to 2000 characters";
  return { prompt: rest, model };
}

/** `/music lo-fi` → { prompt, lyrics: "" }; lyrics after a `lyrics:` line or a blank line. */
export function parseMusicCommand(text) {
  // A terminal line has no newlines: `/music lo-fi lyrics: la la` (as the TUI does).
  const s = String(text ?? "").includes("\n") ? String(text) : String(text ?? "").replace(/\s+lyrics:\s*/i, "\nlyrics:\n");
  const m = /^\/(?:music|song)\s+([\s\S]+)$/i.exec(s.trim());
  if (!m) return null;
  const body = m[1].trim();
  const split = /\n\s*lyrics:\s*\n|\n\s*\n/i.exec(body);
  const prompt = (split ? body.slice(0, split.index) : body).trim();
  const lyrics = split ? body.slice(split.index + split[0].length).trim() : "";
  return prompt ? { prompt, lyrics } : null;
}

export function parseAlbumCommand(text) {
  const m = /^\/(?:album|lp)\s+([\s\S]+)$/i.exec(String(text ?? "").trim());
  if (!m) return null;
  const prompt = m[1].trim();
  return prompt ? { prompt } : null;
}

export const PROMO_STYLES = ["pixar", "anime", "claymation", "flat", "watercolor", "comic", "cinematic"];
const STYLE_ALIASES = [
  [/\b(pixar|disney|dreamworks|3d cartoon|3-d cartoon|cgi cartoon)\b/i, "pixar"],
  [/\b(anime|manga|ghibli)\b/i, "anime"],
  [/\b(clay|claymation|stop[- ]?motion|plasticine|aardman)\b/i, "claymation"],
  [/\b(flat|2d|2-d|vector|motion graphics)\b/i, "flat"],
  [/\b(watercolou?r|storybook|painted)\b/i, "watercolor"],
  [/\b(comic|comic book|marvel|graphic novel)\b/i, "comic"],
  [/\b(cinematic|live[- ]action|photoreal(istic)?|realistic)\b/i, "cinematic"],
];
const styleFromText = (text) => { for (const [re, key] of STYLE_ALIASES) if (re.test(text)) return key; return null; };
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/i;
const BARE_DOMAIN_RE =
  /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|ai|dev|app|co|sh|xyz|world|gg|me|tv|so|tech|site|cloud|us|uk|de|fr|ca))(\/[^\s<>"'`)\]]*)?/i;
const VERTICAL_RE = /\b(vertical|portrait|9:16|9x16|shorts?|reels?|tiktok|stories)\b/i;

function splitPromo(text) {
  const m = URL_RE.exec(text);
  const d = m ? null : BARE_DOMAIN_RE.exec(text);
  const url = m ? m[0].replace(/[.,;:!?]+$/, "") : d ? `https://${d[0].replace(/[.,;:!?]+$/, "")}` : null;
  if (!url) return null;
  return { url, style: styleFromText(text) ?? "pixar", vertical: VERTICAL_RE.test(text), brief: text.replace(URL_RE, " ").replace(/\s+/g, " ").trim() };
}

export function parsePromoCommand(text) {
  const m = /^\/(?:promo|promo-video|demo-video|video-promo)\s+([\s\S]+)$/i.exec(String(text ?? "").trim());
  return m ? splitPromo(m[1].trim()) : null;
}

/** "make a pixar style promo video for https://c0mpute.com": a link AND video words (as the chat does). */
export function detectPromoRequest(text) {
  const s = String(text ?? "").trim();
  if (!s || s.startsWith("/") || s.length > 2000) return null;
  const promoWord = /\b(promo|promotional|explainer|commercial|trailer|sizzle reel|advert|ad spot|demo video|launch video)\b/i.test(s);
  const videoWord = /\b(video|cartoon|animation|animated|clip|reel|short film)\b/i.test(s);
  const makeWord = /\b(make|create|generate|produce|build|render|do|want|need|give me|can you)\b/i.test(s);
  const yes = (promoWord && (videoWord || makeWord)) || (videoWord && makeWord && /\b(promo|demo|ad|cartoon|marketing|launch)\b/i.test(s));
  return yes ? splitPromo(s) : null;
}

export const SITE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function parsePushCommand(text) {
  const m = /^\/push(?:\s+([\s\S]*))?$/i.exec(String(text ?? "").trim());
  if (!m) return null;
  const words = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
  if (words[0]?.toLowerCase() === "hosting") words.shift();
  const [a, b] = words;
  if (!a) return { kind: "help" };
  const verb = a.toLowerCase();
  if (verb === "ls" || verb === "list") return { kind: "ls" };
  if (verb === "rm" || verb === "delete") {
    const name = (b ?? "").toLowerCase();
    return SITE_NAME.test(name) ? { kind: "rm", name } : { kind: "help", error: "usage: /push hosting rm <name>" };
  }
  const name = a.toLowerCase();
  if (!SITE_NAME.test(name)) return { kind: "help", error: `"${a}" is not a site name: use 1-63 of a-z, 0-9 and '-'` };
  return { kind: "push", name };
}

export function parseConnectCommand(text) {
  const m = /^\/connect(?:\s+([\s\S]*))?$/i.exec(String(text ?? "").trim());
  if (!m) return null;
  const words = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
  if (words[0]?.toLowerCase() === "hosting") words.shift();
  const node = words[0]?.toLowerCase() ?? null;
  if (node && !SITE_NAME.test(node)) return { node: null, error: `"${words[0]}" is not a node name` };
  return { node };
}

const SLUGISH = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function parsePluginCommand(text) {
  const m = /^\/plugins?(?:\s+([\s\S]*))?$/i.exec(String(text ?? "").trim());
  if (!m) return null;
  const words = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const [verbRaw, arg] = words;
  const verb = (verbRaw ?? "").toLowerCase();
  if (!verb) return /^\/plugins\b/i.test(text.trim()) ? { kind: "ls" } : { kind: "help" };
  if (verb === "ls" || verb === "list") return { kind: "ls" };
  if (verb === "add" || verb === "install") {
    if (!arg) return { kind: "help", error: "usage: /plugin add <https://… MCP server URL | catalog name>" };
    return { kind: "add", target: arg };
  }
  if (/^https?:\/\//i.test(verbRaw)) return { kind: "add", target: verbRaw };
  const slug = (arg ?? "").toLowerCase();
  const need = (k) => (SLUGISH.test(slug) ? { kind: k, slug } : { kind: "help", error: `usage: /plugin ${k} <name>` });
  if (verb === "rm" || verb === "remove" || verb === "delete") return need("rm");
  if (verb === "on" || verb === "enable") return need("on");
  if (verb === "off" || verb === "disable") return need("off");
  if (verb === "connect" || verb === "signin" || verb === "login") return need("connect");
  return { kind: "help", error: `unknown /plugin command "${verbRaw}"` };
}

export const PLUGIN_HELP = [
  "/plugin add <url | name>   add a remote MCP server (or one from the catalog: /plugin ls)",
  "/plugin ls                 your plugins and the catalog",
  "/plugin on|off <name>      use it in chat, or not",
  "/plugin connect <name>     sign in again",
  "/plugin rm <name>          remove it",
].join("\n");

/** The chat's /help rows (c0mpute commands.ts CHAT_COMMANDS), plus /login. */
export const CHAT_HELP = [
  ["/image <prompt>", "draw a picture on a c0mpute CPU worker (~2 min; also /img, /draw)"],
  ["/video <prompt> [--model wan2.2-ti2v-5b]", "a short clip (20-30 min once a worker is free; also /clip, /vid)"],
  ["/music <style> [lyrics: …]", "a song (ACE-Step 1.5); lyrics add vocals (also /song)"],
  ["/album <idea>", "a band, 8 named songs with lyrics, cover art and a zip (also /lp)"],
  ["/promo <url> [pixar|anime|claymation|flat] [vertical]", "a promo video with narration and music"],
  ["/push hosting <name> | ls | rm <name>", "publish this session's media as a site on the c0mpute network"],
  ["/connect hosting [node]", "list your hosting nodes, or pick the one that publishes"],
  ["/plugin add <url|name> | ls | on|off|rm <name>", "chat plugins (remote MCP servers) on your c0mpute.com account"],
  ["/login", "sign in to c0mpute.com (needed by /push, /connect, /plugin)"],
];

const USAGE = {
  image: "usage: /image <what to draw>",
  img: "usage: /image <what to draw>",
  draw: "usage: /image <what to draw>",
  music: "usage: /music <style> (add \"lyrics: …\" for vocals)",
  song: "usage: /music <style> (add \"lyrics: …\" for vocals)",
  album: "usage: /album <idea for the album>",
  lp: "usage: /album <idea for the album>",
  promo: "usage: /promo <url> [pixar|anime|claymation|flat|watercolor|comic|cinematic] [vertical]",
  "promo-video": "usage: /promo <url> [pixar|anime|claymation|flat|watercolor|comic|cinematic] [vertical]",
  "demo-video": "usage: /promo <url> [pixar|anime|claymation|flat|watercolor|comic|cinematic] [vertical]",
  "video-promo": "usage: /promo <url> [pixar|anime|claymation|flat|watercolor|comic|cinematic] [vertical]",
};

/**
 * One line → what the chat would do with it, in the chat's order (push,
 * connect, plugin, promo, album, music, image, video). null = not a chat
 * command (the agent's own /commands and plain prompts go on as before).
 * Plain text that asks for a promo video of a link becomes /promo, as in
 * the chat.
 */
export function parseChatCommand(line) {
  const s = String(line ?? "").trim();
  if (!s) return null;
  let r;
  if ((r = parsePushCommand(s))) return { kind: "push", cmd: r };
  if ((r = parseConnectCommand(s))) return { kind: "connect", cmd: r };
  if ((r = parsePluginCommand(s))) return { kind: "plugin", cmd: r };
  if (/^\/login$/i.test(s)) return { kind: "login" };
  if ((r = parsePromoCommand(s) ?? detectPromoRequest(s))) return { kind: "media", media: "promo", prompt: r.brief || r.url, body: { url: r.url, style: r.style, vertical: r.vertical, brief: r.brief } };
  if ((r = parseAlbumCommand(s))) return { kind: "media", media: "album", prompt: r.prompt, body: { prompt: r.prompt } };
  if ((r = parseMusicCommand(s))) return { kind: "media", media: "music", prompt: r.prompt, body: { prompt: r.prompt, lyrics: r.lyrics } };
  if ((r = parseImageCommand(s))) return { kind: "media", media: "image", prompt: r, body: { prompt: r, size: "landscape" } };
  r = parseVideoCommand(s);
  if (typeof r === "string") return { kind: "usage", message: r };
  if (r) return { kind: "media", media: "video", prompt: r.prompt, body: { prompt: r.prompt, model: r.model } };
  const name = (/^\/(\S*)/.exec(s)?.[1] ?? "").toLowerCase();
  if (s.startsWith("/") && USAGE[name]) return { kind: "usage", message: USAGE[name] };
  return null;
}

// ─── keys and backends ───────────────────────────────────────────────────────

export const C0MPUTE_COM = "https://c0mpute.com";
const nonEmpty = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { return {}; } };

/**
 * The c0mpute.com key (c0k_…), if any: C0MPUTE_CHAT_KEY, then `/login`'s copy
 * in ~/.moshcode/c0mpute.json (chatKey), then `c0mpute chat login`'s
 * ~/.c0mpute/chat.json. (C0MPUTE_API_KEY is moshcode's Infernet key; the
 * c0mpute CLI uses the same name for a c0k_ key, so it is not read here.)
 */
export function chatKeyConfig({ env = process.env, home = os.homedir() } = {}) {
  const mosh = readJson(path.join(home, ".moshcode", "c0mpute.json"));
  const cli = readJson(path.join(home, ".c0mpute", "chat.json"));
  const url = (nonEmpty(env.C0MPUTE_CHAT_URL) || nonEmpty(mosh.chatUrl) || nonEmpty(cli.url) || C0MPUTE_COM).replace(/\/+$/, "");
  const isKey = (k) => typeof k === "string" && /^c0[ks]_/.test(k.trim());
  if (isKey(env.C0MPUTE_CHAT_KEY)) return { key: env.C0MPUTE_CHAT_KEY.trim(), url, source: "C0MPUTE_CHAT_KEY" };
  if (isKey(mosh.chatKey)) return { key: mosh.chatKey.trim(), url, source: "~/.moshcode/c0mpute.json" };
  if (isKey(cli.key)) return { key: cli.key.trim(), url, source: "~/.c0mpute/chat.json (c0mpute chat login)" };
  return { key: null, url, source: null };
}

const KINDS = ["image", "video", "music", "album", "promo"];
const V1_PATH = { image: "/api/v1/images", video: "/api/v1/videos", music: "/api/v1/music", album: "/api/v1/album", promo: "/api/v1/promo" };
const INFERNET_PATH = { image: "/api/chat/image", video: "/api/chat/video", music: "/api/chat/music", album: "/api/chat/album", promo: "/api/chat/promo" };

/** Where media jobs go: c0mpute.com when signed in there, else Infernet with the model key. */
export function mediaBackend(cfg, chat = chatKeyConfig()) {
  if (chat?.key) return { name: "c0mpute.com", base: chat.url, key: chat.key, paths: V1_PATH, pushable: true };
  return { name: "c0mpute network", base: (cfg?.baseUrl || "https://infernetprotocol.com").replace(/\/+$/, ""), key: cfg?.apiKey || null, paths: INFERNET_PATH, pushable: false };
}

// ─── media jobs ──────────────────────────────────────────────────────────────

export const POLL_MS = { image: 4000, video: 10_000, music: 5000, album: 5000, promo: 4000 };
export const DEADLINE_MS = { image: 2 * 3600_000, video: 3 * 3600_000, music: 2 * 3600_000, album: 4 * 3600_000, promo: 2 * 3600_000 };
const PROMO_STAGES = ["brand", "script", "frames", "motion", "voice", "music", "render"];
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v, max = 200) => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const sleepFor = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error("stopped")); return; }
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new Error("stopped")); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

export function safeName(text, max = 80) {
  // eslint-disable-next-line no-control-regex -- strip control characters
  return String(text ?? "").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || "c0mpute";
}

export function slug(text, max = 40) {
  const s = String(text ?? "").normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, max).replace(/-+$/, "");
  return s || "c0mpute";
}

function nodeLine(n) {
  if (!n || typeof n !== "object" || typeof n.stage !== "string") return null;
  const node = typeof n.worker === "string" ? `node …${n.worker.slice(-8)}` : "a node";
  const retry = (n.attempt ?? 1) > 1 ? ` (attempt ${n.attempt})` : "";
  switch (n.stage) {
    case "starting": case "finding_worker": return `finding a c0mpute music worker${retry}`;
    case "queued": return `queued for a c0mpute music worker${n.queue_position ? ` (#${n.queue_position} in line)` : ""} · ${mmss(n.stage_elapsed_s ?? 0)}`;
    case "rendering": {
      const left = typeof n.eta_s === "number" ? Math.max(0, n.eta_s - (n.stage_elapsed_s ?? 0)) : undefined;
      const eta = left === undefined ? "" : left > 0 ? ` · ~${mmss(left)} left` : " · past the node's estimate, still working";
      return `rendering on ${node}${retry} · ${mmss(n.stage_elapsed_s ?? 0)} in${eta}`;
    }
    case "fetching_result": return `${node} finished; fetching the song`;
    case "retrying": return `${node} failed${n.detail ? ` (${n.detail})` : ""}; trying another worker`;
    case "done": return "song ready";
    default: return "song failed";
  }
}

/** One status line from a 202 poll body (ported from the TUI's applyPending). */
export function describePending(kind, b = {}) {
  b = b ?? {};
  const queued = (what, pos) => `queued for a c0mpute ${what} worker${pos ? ` (#${pos} in line)` : ""}; it starts when one is free`;
  switch (kind) {
    case "image": return b.stage === "queued" ? queued("image", num(b.queue_position)) : `drawing on a c0mpute CPU worker${str(b.detail) ? ` · ${str(b.detail)}` : ""}`;
    case "video": {
      if (b.stage === "queued" || !b.stage) return queued("video", num(b.queue_position));
      const eta = num(b.eta_s);
      return `${str(b.stage, 40)}${str(b.detail) ? ` · ${str(b.detail)}` : ""}${eta ? ` · about ${eta < 90 ? `${Math.round(eta)}s` : `${Math.round(eta / 60)} min`} left` : ""}`;
    }
    case "music":
      if (b.stage === "writing") return "writing lyrics and a style from your brief";
      return nodeLine(b.node) ?? "composing with ACE-Step 1.5 on a c0mpute worker";
    case "album": {
      const tracks = Array.isArray(b.tracks) ? b.tracks : [];
      const total = tracks.length || num(b.tracksWanted) || 0;
      const done = tracks.filter((t) => t?.status === "done").length;
      const failed = tracks.filter((t) => t?.status === "failed").length;
      const head = b.album ? `"${str(b.album, 100)}" by ${str(b.band, 80) ?? "?"} · ` : "";
      switch (b.stage) {
        case "planning": return `naming the band, the album and ${total || "its"} songs`;
        case "writing": return `${head}writing lyrics · ${tracks.filter((t) => t?.lyrics || (t?.status && t.status !== "planned")).length}/${total} songs`;
        case "recording": return `${head}recording on c0mpute workers · ${done}/${total} done${failed ? ` · ${failed} failed` : ""}`;
        case "cover": return `${head}songs done; finishing the cover`;
        default: return "starting the album";
      }
    }
    case "promo": {
      const stages = b.stages && typeof b.stages === "object" ? b.stages : {};
      const done = PROMO_STAGES.filter((k) => ["done", "skipped"].includes(stages[k]?.state)).length;
      const running = PROMO_STAGES.find((k) => stages[k]?.state === "running");
      const detail = running && str(stages[running]?.detail, 160);
      return `${running ? `${running}${detail ? `: ${detail}` : ""}` : "starting the promo"} · ${done}/${PROMO_STAGES.length} stages`;
    }
    default: return "working";
  }
}

async function jsonOf(res) {
  const type = res.headers.get("content-type") || "";
  if (!type.includes("json")) { await res.arrayBuffer().catch(() => {}); return null; }
  return res.json().catch(() => null);
}

function errorText(status, body) {
  const e = body?.error;
  const msg = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : null;
  if (status === 401) return msg || "not signed in (401): /login, or /key for the c0mpute network";
  if (status === 402) return msg || "balance too low (402): top up at c0mpute.com or infernetprotocol.com";
  if (status === 429) return msg || "rate limited (429): the free tier allows 10 a day; /key ik_live_… or /login for more";
  return msg ? `${msg} (HTTP ${status})` : `HTTP ${status}`;
}

function uniquePath(dir, name) {
  let p = path.join(dir, name);
  if (!fs.existsSync(p)) return p;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i++) { p = path.join(dir, `${stem}-${i}${ext}`); if (!fs.existsSync(p)) return p; }
  return p;
}

const audioExt = (type) => (type.includes("wav") ? "wav" : type.includes("flac") ? "flac" : type.includes("ogg") ? "ogg" : "mp3");

/**
 * Start one media job, poll it to the end and save what it made in `outDir`.
 * Resolves { id, files: [{ path, label }], title, summary, record } where
 * `record` is what /push later needs; throws on failure. `onStatus(line)`
 * hears every progress line.
 */
export async function runMediaJob({ kind, body, prompt, backend, outDir, onStatus = () => {}, signal, fetchImpl = globalThis.fetch, sleep = sleepFor, now = Date.now }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown media kind ${kind}`);
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (backend.key) headers.authorization = `Bearer ${backend.key}`;
  const abs = (p) => (/^https?:\/\//i.test(p) ? p : `${backend.base}${p.startsWith("/") ? "" : "/"}${p}`);
  const get = (p) => fetchImpl(abs(p), { headers: backend.key ? { authorization: `Bearer ${backend.key}` } : {}, signal });

  onStatus(`sending to ${backend.name}`);
  const startRes = await fetchImpl(abs(backend.paths[kind]), { method: "POST", headers, body: JSON.stringify(body), signal });
  const started = await jsonOf(startRes);
  if (startRes.status !== 202 && startRes.status !== 200) throw new Error(errorText(startRes.status, started));
  const id = str(started?.id, 100);
  const poll = str(started?.poll, 300) || (id ? `${backend.paths[kind]}/${id}` : null);
  if (!id || !poll) throw new Error("the network did not return a job id");
  if (kind === "album" && started?.limited && typeof started.tracks === "number") onStatus(`only ${started.tracks} free songs left today, so this album has ${started.tracks} tracks`);

  fs.mkdirSync(outDir, { recursive: true });
  const t0 = now();
  let last = {};
  let wait = 1500;
  for (;;) {
    await sleep(wait, signal);
    wait = POLL_MS[kind];
    if (now() - t0 > DEADLINE_MS[kind]) throw new Error(`gave up after ${Math.round(DEADLINE_MS[kind] / 3600_000)} h; the job id is ${id}`);
    let res;
    try { res = await get(poll); } catch (e) {
      if (signal?.aborted) throw new Error("stopped");
      onStatus(`network error (${e?.message || e}); retrying`);
      wait = Math.max(15_000, POLL_MS[kind]);
      continue;
    }
    const type = res.headers.get("content-type") || "";
    if (res.status === 202) {
      const b = await jsonOf(res);
      if (b) last = { ...last, ...b };
      onStatus(describePending(kind, b));
      continue;
    }
    if (res.status === 408 || res.status === 429 || (res.status >= 500 && res.status <= 504 && !(await peekFatal(res)))) {
      onStatus(`${backend.name} is restarting (HTTP ${res.status}); the job is kept, polling again`);
      wait = POLL_MS[kind] * 3;
      continue;
    }
    if (res.status !== 200) {
      const b = await jsonOf(res);
      throw new Error(errorText(res.status, b));
    }
    // Done. Images and songs are the poll's own 200 body, served once: save it now.
    const files = [];
    const save = async (r, name, label) => {
      const p = uniquePath(outDir, name);
      fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
      files.push({ path: p, label });
      return p;
    };
    const fetchSave = async (url, name, label, optional = false) => {
      try {
        const r = await get(url);
        if (r.status !== 200) { await r.arrayBuffer().catch(() => {}); if (!optional) throw new Error(`${label}: HTTP ${r.status}`); return null; }
        return await save(r, name, label);
      } catch (e) { if (!optional) throw e; return null; }
    };
    const base = `${slug(last.title || prompt)}-${id.slice(0, 8)}`;
    const record = { kind, id, title: str(last.title, 120), prompt, pushable: backend.pushable };
    if (kind === "image") {
      await save(res, `${base}.png`, "image");
    } else if (kind === "music") {
      const title = str(last.title, 120);
      record.audioType = type.split(";")[0] || "audio/mpeg";
      const stem = `${safeName(title || slug(prompt))}-${id.slice(0, 8)}`;
      await save(res, `${stem}.${audioExt(type)}`, "song");
      await fetchSave(`${poll}/cover`, `${stem}.png`, "cover", true);
      if (str(last.lyrics)) { const p = uniquePath(outDir, `${stem}-lyrics.txt`); fs.writeFileSync(p, `${title ? `${title}\n\n` : ""}${last.lyrics}\n`); files.push({ path: p, label: "lyrics" }); }
    } else {
      const b = type.includes("json") ? await res.json().catch(() => ({})) : null;
      if (b === null && kind === "video") { await save(res, `${base}.mp4`, "video"); }
      const done = b ?? {};
      if (kind === "video" && b) await fetchSave(str(done.video, 300) ?? `${poll}/video`, `${base}.mp4`, "video");
      if (kind === "album") {
        const name = safeName([done.band ?? last.band, done.album ?? last.album].filter(Boolean).join(" - ") || base);
        record.album = { band: str(done.band ?? last.band, 80), album: str(done.album ?? last.album, 100), zip: typeof done.zip === "string" ? done.zip : null, cover: false };
        record.title = record.album.album ? `"${record.album.album}" by ${record.album.band ?? "?"}` : null;
        if (typeof done.zip === "string") await fetchSave(done.zip, `${name}.zip`, "album zip");
        record.album.cover = Boolean(await fetchSave(`${poll}/cover`, `${name}.png`, "cover", true));
      }
      if (kind === "promo") {
        record.title = str(done.title ?? last.title, 100);
        const pbase = `${slug(record.title || prompt)}-${id.slice(0, 8)}`;
        await fetchSave(str(done.video, 300) ?? `${poll}/video`, `${pbase}.mp4`, "video");
        record.captions = Boolean(await fetchSave(str(done.captions, 300) ?? `${poll}/captions`, `${pbase}.srt`, "captions", true));
      }
    }
    const secs = Math.round((now() - t0) / 1000);
    return { id, files, title: record.title, record, summary: `${record.title ? `${record.title} · ` : ""}done in ${mmss(secs)}` };
  }
}

/** A 5xx whose JSON says it is the job's own failure (no `retry`) ends the job. */
async function peekFatal(res) {
  const type = res.headers.get("content-type") || "";
  if (!type.includes("json")) return false;
  try {
    const b = await res.clone().json();
    if (!b?.error) return false;
    return !(typeof b.error === "object" && b.error.retry === true) && res.status < 502;
  } catch { return false; }
}

// ─── c0mpute.com account calls (/push, /connect, /plugin, /login) ─────────────

export function chatApi(chat, { fetchImpl = globalThis.fetch } = {}) {
  const call = async (p, { method = "GET", body, auth = true, signal } = {}) => {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) {
      if (!chat.key) throw new Error("not signed in to c0mpute.com: /login first (or `c0mpute chat login`)");
      headers.authorization = `Bearer ${chat.key}`;
    }
    const res = await fetchImpl(`${chat.url}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    const json = await jsonOf(res);
    return { status: res.status, ok: res.ok, body: json ?? {} };
  };
  const must = async (p, o) => {
    const r = await call(p, o);
    if (!r.ok) throw new Error(errorText(r.status, r.body));
    return r.body;
  };
  return { call, must };
}

/** Device login: prints a link, waits for the browser, returns the c0k_ key. */
export async function deviceLogin(chat, { label = `moshcode on ${os.hostname()}`, onCode = () => {}, signal, fetchImpl, sleep = sleepFor } = {}) {
  const api = chatApi(chat, { fetchImpl });
  const d = await api.must("/api/v1/cli/device", { method: "POST", body: { label }, auth: false, signal });
  onCode({ url: d.verification_uri_complete, code: d.user_code });
  const until = Date.now() + (Number(d.expires_in) || 600) * 1000;
  let interval = Math.max(1, Number(d.interval) || 5) * 1000;
  while (Date.now() < until) {
    await sleep(interval, signal);
    const r = await api.call("/api/v1/cli/token", { method: "POST", body: { device_code: d.device_code }, auth: false, signal }).catch(() => null);
    if (!r) continue;
    if (r.status === 200 && typeof r.body.key === "string") return r.body.key;
    if (r.status === 429) interval += 1000;
    else if (r.status === 410) throw new Error("the sign-in code expired; /login again");
    else if (r.status !== 428) throw new Error(errorText(r.status, r.body));
  }
  throw new Error("the sign-in code expired; /login again");
}

// ─── /push: the session's media as a site ────────────────────────────────────

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fileSlug = (s, fallback) => (s || "").normalize("NFKD").replace(/[^\w\s()+,=@-]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || fallback;

/**
 * Push files for what this session made (c0mpute.com results only: a node
 * fetches each `src` through c0mpute.com) plus index.html and chat.md, the
 * shape the web chat's collectPushFiles builds.
 */
export function collectPushFiles(title, turns, media) {
  const two = (n) => String(n).padStart(2, "0");
  const files = [];
  const byTurn = new Map();
  let img = 0, song = 0, vid = 0;
  const add = (turn, f) => {
    if (files.some((x) => x.path.toLowerCase() === f.path.toLowerCase())) return;
    files.push(f);
    byTurn.set(turn, [...(byTurn.get(turn) ?? []), f]);
  };
  for (const m of media.filter((x) => x.pushable)) {
    const t = m.turn ?? -1;
    if (m.kind === "image") add(t, { path: `images/${two(++img)}.png`, type: "image/png", src: `/api/v1/images/${m.id}` });
    if (m.kind === "music") {
      const n = two(++song);
      const name = fileSlug(m.title ?? "", "song").slice(0, 60);
      const t2 = m.audioType || "audio/mpeg";
      add(t, { path: `music/${n} - ${name}.${audioExt(t2)}`, type: t2, src: `/api/v1/music/${m.id}` });
      add(t, { path: `music/${n} - ${name}.png`, type: "image/png", src: `/api/v1/music/${m.id}/cover` });
    }
    if (m.kind === "album" && m.album?.zip) {
      const name = fileSlug([m.album.band, m.album.album].filter(Boolean).join(" - "), `album ${m.id.slice(0, 6)}`);
      add(t, { path: `albums/${name}.zip`, type: "application/zip", src: `/api/v1/album/${m.id}/zip` });
      if (m.album.cover) add(t, { path: `albums/${name}.png`, type: "image/png", src: `/api/v1/album/${m.id}/cover` });
    }
    if (m.kind === "promo") {
      const n = two(++vid);
      add(t, { path: `video/${n}.mp4`, type: "video/mp4", src: `/api/v1/promo/${m.id}/video` });
      if (m.captions) add(t, { path: `video/${n}.vtt`, type: "text/vtt", src: `/api/v1/promo/${m.id}/captions` });
    }
  }
  const shown = turns.map((m, i) => ({ m, i })).filter(({ m }) => m.role === "user" || m.role === "assistant");
  const md = shown.map(({ m }) => `**${m.role === "user" ? "you" : "c0mpute"}:** ${m.content}`).join("\n\n");
  const body = shown.map(({ m, i }) => {
    const mediaHtml = (byTurn.get(i) ?? []).map((f) => {
      const href = f.path.split("/").map(encodeURIComponent).join("/");
      if (f.type.startsWith("image/")) return `<a href="${href}"><img src="${href}" alt="" loading="lazy"></a>`;
      if (f.type.startsWith("audio/")) return `<audio controls preload="none" src="${href}"></audio> <a href="${href}" download>${esc(f.path)}</a>`;
      if (f.type.startsWith("video/")) return `<video controls preload="none" src="${href}"></video>`;
      return `<a href="${href}" download>${esc(f.path)}</a>`;
    }).join("\n");
    return `<section id="m${i + 1}"><b>${m.role === "user" ? "you" : "c0mpute"}</b><div>${esc(m.content)}</div>${mediaHtml}</section>`;
  }).join("\n");
  const t = esc(title || "c0mpute chat");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--dim:#666;--line:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0b;--fg:#eee;--dim:#999;--line:#333}}
body{background:var(--bg);color:var(--fg);font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:52rem;margin:0 auto;padding:1.5rem 1rem}
section{border-top:1px solid var(--line);padding:.8rem 0}section b{color:var(--dim)}
section div{white-space:pre-wrap;overflow-wrap:anywhere}img,video{max-width:100%;height:auto;display:block;margin:.5rem 0}audio{width:100%}
footer{color:var(--dim);margin-top:2rem}a{color:inherit}
</style></head><body>
<h1>${t}</h1>
${body}
<footer>made with <a href="https://moshcode.sh">moshcode</a> on <a href="https://c0mpute.com/chat">c0mpute</a>, hosted on the c0mpute network · <a href="chat.md">chat.md</a></footer>
</body></html>
`;
  // Inline text is capped at 1 MiB per push: keep the transcript under it.
  const cap = (s) => (Buffer.byteLength(s) > 400_000 ? `${s.slice(0, 400_000)}\n…` : s);
  return [
    { path: "index.html", type: "text/html", text: cap(html) },
    { path: "chat.md", type: "text/markdown", text: cap(`# ${title || "c0mpute chat"}\n\n${md}\n`) },
    ...files,
  ];
}
