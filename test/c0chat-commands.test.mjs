import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chatKeyConfig, collectPushFiles, describePending, deviceLogin, mediaBackend, parseChatCommand, parseMusicCommand,
  parsePluginCommand, parsePromoCommand, parsePushCommand, parseVideoCommand, runMediaJob,
} from "../src/c0chat-commands.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "c0chat-"));
const noSleep = async () => {};
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** A fetch that answers from a list of [method path, response] rules, in order per path. */
function fakeFetch(routes) {
  const calls = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || "GET"} ${u.pathname}`;
    calls.push({ key, init, url });
    const q = queues.get(key);
    if (!q || !q.length) return new Response("not found", { status: 404 });
    const r = q.length > 1 ? q.shift() : q[0];
    const { status = 200, json, body, type } = r;
    if (json !== undefined) return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    return new Response(body ?? "", { status, headers: { "content-type": type ?? "application/octet-stream" } });
  };
  return { impl, calls };
}

const infernet = { name: "c0mpute network", base: "https://inf.test", key: "ik_live_x", paths: mediaBackend({ baseUrl: "https://inf.test" }, { key: null }).paths, pushable: false };

test("parseChatCommand routes every chat command the way c0mpute.com/chat does", () => {
  assert.deepEqual(parseChatCommand("/image a red bicycle"), { kind: "media", media: "image", prompt: "a red bicycle", body: { prompt: "a red bicycle", size: "landscape" } });
  assert.equal(parseChatCommand("/img cat").media, "image");
  assert.equal(parseChatCommand("/draw cat").media, "image");
  assert.equal(parseChatCommand("/song lo-fi").media, "music");
  assert.equal(parseChatCommand("/lp drowned city synthwave").media, "album");
  assert.equal(parseChatCommand("/clip a paper boat").media, "video");
  assert.equal(parseChatCommand("/promo c0mpute.com anime vertical").media, "promo");
  assert.equal(parseChatCommand("/push hosting mysite").kind, "push");
  assert.equal(parseChatCommand("/connect hosting").kind, "connect");
  assert.equal(parseChatCommand("/plugins").kind, "plugin");
  assert.equal(parseChatCommand("/login").kind, "login");
  // bare commands give the chat's usage line, never the model
  assert.deepEqual(parseChatCommand("/image"), { kind: "usage", message: "usage: /image <what to draw>" });
  assert.deepEqual(parseChatCommand("/video"), { kind: "usage", message: "usage: /video <what happens in the clip>" });
  assert.equal(parseChatCommand("/album").kind, "usage");
  // the agent's own commands and plain tasks are not chat commands
  for (const l of ["/help", "/agents", "/clear", "/model x", "fix the failing test in src/app.js", "@explore find the router"]) assert.equal(parseChatCommand(l), null, l);
  // plain text asking for a promo of a link becomes /promo, as in the chat
  const p = parseChatCommand("make a claymation promo video for https://moshcode.sh");
  assert.equal(p.media, "promo");
  assert.deepEqual({ url: p.body.url, style: p.body.style }, { url: "https://moshcode.sh", style: "claymation" });
});

test("argument rules match the chat's parsers", () => {
  assert.deepEqual(parseMusicCommand("/music lo-fi hip hop lyrics: la la la"), { prompt: "lo-fi hip hop", lyrics: "la la la" });
  assert.deepEqual(parseMusicCommand("/music jazz\nlyrics:\nhello\nworld"), { prompt: "jazz", lyrics: "hello\nworld" });
  assert.deepEqual(parseVideoCommand("/video --model wan2.2-ti2v-5b a fox"), { prompt: "a fox", model: "wan2.2-ti2v-5b" });
  assert.match(parseVideoCommand("/video --model nope a fox"), /model must be one of/);
  assert.deepEqual(parsePromoCommand("/promo https://c0mpute.com ghibli tiktok"), { url: "https://c0mpute.com", style: "anime", vertical: true, brief: "ghibli tiktok" });
  assert.deepEqual(parsePromoCommand("/promo example.dev"), { url: "https://example.dev", style: "pixar", vertical: false, brief: "example.dev" });
  assert.deepEqual(parsePushCommand("/push ls"), { kind: "ls" });
  assert.deepEqual(parsePushCommand("/push hosting rm my-site"), { kind: "rm", name: "my-site" });
  assert.equal(parsePushCommand("/push hosting Bad_Name").kind, "help");
  assert.deepEqual(parsePluginCommand("/plugin https://mcp.example.com/mcp"), { kind: "add", target: "https://mcp.example.com/mcp" });
  assert.deepEqual(parsePluginCommand("/plugin off github"), { kind: "off", slug: "github" });
});

test("mediaBackend: Infernet with the model key out of the box, c0mpute.com once signed in", () => {
  const open = mediaBackend({ baseUrl: "https://infernetprotocol.com/", apiKey: "ik_live_a" }, { key: null });
  assert.equal(open.base, "https://infernetprotocol.com");
  assert.equal(open.paths.image, "/api/chat/image");
  assert.equal(open.key, "ik_live_a");
  const signedIn = mediaBackend({ apiKey: "ik_live_a" }, { key: "c0k_b", url: "https://c0mpute.com" });
  assert.equal(signedIn.paths.image, "/api/v1/images");
  assert.equal(signedIn.key, "c0k_b");
  assert.equal(signedIn.pushable, true);
});

test("chatKeyConfig: env, then moshcode's /login copy, then `c0mpute chat login`; never an ik_live_ key", () => {
  const home = tmp();
  assert.equal(chatKeyConfig({ env: {}, home }).key, null);
  fs.mkdirSync(path.join(home, ".c0mpute"));
  fs.writeFileSync(path.join(home, ".c0mpute", "chat.json"), JSON.stringify({ key: "c0k_cli", url: "https://staging.c0mpute.com/" }));
  assert.deepEqual(chatKeyConfig({ env: {}, home }).key, "c0k_cli");
  assert.equal(chatKeyConfig({ env: {}, home }).url, "https://staging.c0mpute.com");
  fs.mkdirSync(path.join(home, ".moshcode"));
  fs.writeFileSync(path.join(home, ".moshcode", "c0mpute.json"), JSON.stringify({ apiKey: "ik_live_z", chatKey: "c0k_mosh" }));
  assert.equal(chatKeyConfig({ env: {}, home }).key, "c0k_mosh");
  assert.equal(chatKeyConfig({ env: { C0MPUTE_CHAT_KEY: "c0k_env", C0MPUTE_API_KEY: "c0k_ignored" }, home }).key, "c0k_env");
  assert.equal(chatKeyConfig({ env: { C0MPUTE_CHAT_KEY: "ik_live_wrong" }, home }).key, "c0k_mosh");
});

test("runMediaJob /image: polls through queued + a deploy 503, saves the one-shot PNG", async () => {
  const dir = tmp();
  const { impl, calls } = fakeFetch({
    "POST /api/chat/image": { status: 202, json: { id: ID, status: "pending", poll: `/api/chat/image/${ID}` } },
    [`GET /api/chat/image/${ID}`]: [
      { status: 202, json: { stage: "queued", queue_position: 2 } },
      { status: 503, body: "<html>deploying</html>", type: "text/html" },
      { status: 200, body: "PNGDATA", type: "image/png" },
    ],
  });
  const lines = [];
  const r = await runMediaJob({ kind: "image", body: { prompt: "a red bicycle" }, prompt: "a red bicycle", backend: infernet, outDir: dir, onStatus: (l) => lines.push(l), fetchImpl: impl, sleep: noSleep });
  assert.equal(r.files.length, 1);
  assert.match(path.basename(r.files[0].path), /^a-red-bicycle-0f8fad5b\.png$/);
  assert.equal(fs.readFileSync(r.files[0].path, "utf8"), "PNGDATA");
  assert.ok(lines.some((l) => /#2 in line/.test(l)));
  assert.ok(lines.some((l) => /restarting \(HTTP 503\)/.test(l)));
  assert.equal(calls[0].init.headers.authorization, "Bearer ik_live_x");
  assert.equal(JSON.parse(calls[0].init.body).prompt, "a red bicycle");
});

test("runMediaJob /music keeps the title and lyrics from the 202s and saves song, cover and lyrics", async () => {
  const dir = tmp();
  const { impl } = fakeFetch({
    "POST /api/chat/music": { status: 202, json: { id: ID, poll: `/api/chat/music/${ID}` } },
    [`GET /api/chat/music/${ID}`]: [
      { status: 202, json: { stage: "writing" } },
      { status: 202, json: { title: "Neon Rain", lyrics: "la la", node: { stage: "rendering", worker: "12D3KooWabcdefgh", eta_s: 120, stage_elapsed_s: 30 } } },
      { status: 200, body: "MP3", type: "audio/mpeg" },
    ],
    [`GET /api/chat/music/${ID}/cover`]: { status: 200, body: "COVER", type: "image/png" },
  });
  const lines = [];
  const r = await runMediaJob({ kind: "music", body: { prompt: "synthwave", lyrics: "" }, prompt: "synthwave", backend: infernet, outDir: dir, onStatus: (l) => lines.push(l), fetchImpl: impl, sleep: noSleep });
  assert.deepEqual(r.files.map((f) => path.basename(f.path)), ["Neon Rain-0f8fad5b.mp3", "Neon Rain-0f8fad5b.png", "Neon Rain-0f8fad5b-lyrics.txt"]);
  assert.equal(r.title, "Neon Rain");
  assert.ok(lines.some((l) => /rendering on node …abcdefgh/.test(l)));
  assert.match(fs.readFileSync(path.join(dir, "Neon Rain-0f8fad5b-lyrics.txt"), "utf8"), /Neon Rain\n\nla la/);
});

test("runMediaJob /album downloads the zip and the cover named after the band", async () => {
  const dir = tmp();
  const { impl } = fakeFetch({
    "POST /api/chat/album": { status: 202, json: { id: ID, poll: `/api/chat/album/${ID}`, tracks: 3, limited: true } },
    [`GET /api/chat/album/${ID}`]: [
      { status: 202, json: { stage: "recording", band: "Rusty Waves", album: "Metal Tides", tracks: [{ status: "done" }, { status: "pending" }, { status: "planned" }] } },
      { status: 200, json: { stage: "done", band: "Rusty Waves", album: "Metal Tides", zip: `/api/chat/album/${ID}/zip`, cover: "ready" } },
    ],
    [`GET /api/chat/album/${ID}/zip`]: { status: 200, body: "ZIP", type: "application/zip" },
    [`GET /api/chat/album/${ID}/cover`]: { status: 200, body: "PNG", type: "image/png" },
  });
  const lines = [];
  const r = await runMediaJob({ kind: "album", body: { prompt: "sea metal" }, prompt: "sea metal", backend: infernet, outDir: dir, onStatus: (l) => lines.push(l), fetchImpl: impl, sleep: noSleep });
  assert.deepEqual(r.files.map((f) => path.basename(f.path)), ["Rusty Waves - Metal Tides.zip", "Rusty Waves - Metal Tides.png"]);
  assert.equal(r.title, '"Metal Tides" by Rusty Waves');
  assert.ok(lines.some((l) => /only 3 free songs left/.test(l)));
  assert.ok(lines.some((l) => /1\/3 done/.test(l)));
});

test("runMediaJob /promo and /video fetch the MP4 the done body points at", async () => {
  const dir = tmp();
  const { impl } = fakeFetch({
    "POST /api/chat/promo": { status: 202, json: { id: ID, poll: `/api/chat/promo/${ID}` } },
    [`GET /api/chat/promo/${ID}`]: [
      { status: 202, json: { stages: { brand: { state: "done" }, script: { state: "running", detail: "writing scenes" } } } },
      { status: 200, json: { status: "done", title: "moshcode", duration: 30 } },
    ],
    [`GET /api/chat/promo/${ID}/video`]: { status: 200, body: "MP4", type: "video/mp4" },
    "POST /api/chat/video": { status: 202, json: { id: ID, poll: `/api/chat/video/${ID}`, video: `/api/chat/video/${ID}/video` } },
    [`GET /api/chat/video/${ID}`]: { status: 200, json: { status: "done", video: `/api/chat/video/${ID}/video` } },
    [`GET /api/chat/video/${ID}/video`]: { status: 200, body: "CLIP", type: "video/mp4" },
  });
  const lines = [];
  const p = await runMediaJob({ kind: "promo", body: { url: "https://moshcode.sh" }, prompt: "moshcode.sh", backend: infernet, outDir: dir, onStatus: (l) => lines.push(l), fetchImpl: impl, sleep: noSleep });
  assert.deepEqual(p.files.map((f) => path.basename(f.path)), ["moshcode-0f8fad5b.mp4"]);
  assert.ok(lines.some((l) => l === "script: writing scenes · 1/7 stages"));
  const v = await runMediaJob({ kind: "video", body: { prompt: "a fox" }, prompt: "a fox", backend: infernet, outDir: dir, fetchImpl: impl, sleep: noSleep });
  assert.equal(fs.readFileSync(v.files[0].path, "utf8"), "CLIP");
});

test("runMediaJob turns 429 / 402 / a job failure into a readable error", async () => {
  const dir = tmp();
  const limited = fakeFetch({ "POST /api/chat/image": { status: 429, json: { error: "free daily limit reached" } } });
  await assert.rejects(runMediaJob({ kind: "image", body: {}, prompt: "x", backend: infernet, outDir: dir, fetchImpl: limited.impl, sleep: noSleep }), /free daily limit reached/);
  const failed = fakeFetch({
    "POST /api/chat/image": { status: 202, json: { id: ID, poll: `/api/chat/image/${ID}` } },
    [`GET /api/chat/image/${ID}`]: { status: 500, json: { error: "diffusion worker crashed" } },
  });
  await assert.rejects(runMediaJob({ kind: "image", body: {}, prompt: "x", backend: infernet, outDir: dir, fetchImpl: failed.impl, sleep: noSleep }), /diffusion worker crashed/);
});

test("describePending covers every kind", () => {
  assert.match(describePending("image", { stage: "rendering", detail: "step 4/20" }), /step 4\/20/);
  assert.match(describePending("video", { stage: "rendering", eta_s: 600 }), /about 10 min left/);
  assert.match(describePending("music", { stage: "writing" }), /writing lyrics/);
  assert.match(describePending("album", { stage: "planning", tracksWanted: 8 }), /8 songs/);
});

test("collectPushFiles: c0mpute.com results by src, open-network ones left out, page + chat.md first", () => {
  const files = collectPushFiles("demo", [
    { role: "user", content: "/image a cat" },
    { role: "assistant", content: "image: a cat" },
    { role: "user", content: "/music lo-fi" },
  ], [
    { kind: "image", id: "img1", pushable: true, turn: 0 },
    { kind: "music", id: "song1", title: "Night Drive", audioType: "audio/mpeg", pushable: true, turn: 2 },
    { kind: "image", id: "open1", pushable: false, turn: 0 },
    { kind: "album", id: "alb1", album: { band: "B", album: "A", zip: "/x", cover: true }, pushable: true },
  ]);
  assert.deepEqual(files.map((f) => f.path), ["index.html", "chat.md", "images/01.png", "music/01 - Night Drive.mp3", "music/01 - Night Drive.png", "albums/B - A.zip", "albums/B - A.png"]);
  assert.equal(files[2].src, "/api/v1/images/img1");
  assert.match(files[0].text, /<img src="images\/01.png"/);
});

test("deviceLogin polls until the browser approves and returns the c0k_ key", async () => {
  const { impl, calls } = fakeFetch({
    "POST /api/v1/cli/device": { status: 200, json: { device_code: "dc", user_code: "ABCD-EFGH", verification_uri_complete: "https://c0mpute.com/device?code=ABCD-EFGH", interval: 1, expires_in: 60 } },
    "POST /api/v1/cli/token": [{ status: 428, json: { error: { message: "pending" } } }, { status: 200, json: { key: "c0k_new" } }],
  });
  let shown;
  const key = await deviceLogin({ url: "https://c0mpute.com", key: null }, { fetchImpl: impl, sleep: noSleep, onCode: (c) => { shown = c; } });
  assert.equal(key, "c0k_new");
  assert.equal(shown.code, "ABCD-EFGH");
  assert.equal(calls.filter((c) => c.key === "POST /api/v1/cli/token").length, 2);
  assert.equal(calls[0].init.headers.authorization, undefined);
});
