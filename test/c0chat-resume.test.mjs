import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskBoard } from "../src/c0agent-tasks.mjs";
import { createChatHandler } from "../src/c0chat-handler.mjs";
import { mediaBackend } from "../src/c0chat-commands.mjs";

test("a new session picks up media jobs an ended session left running, once, and leaves the rest", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c0resume-"));
  const file = path.join(home, ".moshcode", "c0mpute-tasks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cfg = { baseUrl: "https://inf.test" };
  const base = mediaBackend(cfg, { key: null }).base;
  const DEAD = 999_991;
  const LIVE = 4242;
  const remote = (id) => ({ kind: "album", id, poll: `/api/chat/album/${id}`, base, startedAt: 1 });
  const row = (id, pid, state, extra = {}) => ({ id, pid, title: `/album celtic punk ${id}`, prompt: `/album celtic punk ${id}`, agent: "c0mpute album", background: true, cwd: home, state, activity: "", startedAt: 1, updatedAt: 1, endedAt: null, result: null, error: null, log: [], ...extra });
  fs.writeFileSync(file, JSON.stringify([
    row("aaaa", DEAD, "working", { remote: remote("job-orphan") }),        // session died: pick up
    row("bbbb", LIVE, "working", { remote: remote("job-live") }),          // its session is alive
    row("cccc", DEAD, "completed", { remote: remote("job-done") }),        // finished
    row("dddd", DEAD, "stopped", { remote: remote("job-stopped"), userStopped: true }),
    row("eeee", DEAD, "working"),                                          // older task, no job id saved
    row("ffff", DEAD, "stopped", { remote: remote("job-done") }),          // a copy of a job that later finished
  ]));
  const board = createTaskBoard({ file, pid: process.pid });
  const fetchImpl = async () => new Response(JSON.stringify({ status: "pending" }), { status: 202, headers: { "content-type": "application/json" } });
  const lines = [];
  const handle = createChatHandler({ cfg, cwd: () => home, log: (l) => lines.push(l), board, transcript: [], media: [], foreground: (fn) => fn(), fetchImpl, home });
  const alive = (pid) => pid === LIVE || pid === process.pid;
  try {
    const picked = handle.resumeOrphans({ alive });
    assert.deepEqual(picked.map((p) => p.from), ["aaaa"]);
    const t = board.find(picked[0].to);
    assert.equal(t.remote.id, "job-orphan");
    assert.equal(t.title, "/album celtic punk aaaa");
    // Saved at once, so another new session sees it as taken.
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(saved.some((r) => r.pid === process.pid && r.remote?.id === "job-orphan"));
    assert.deepEqual(handle.resumeOrphans({ alive }), []);
  } finally {
    for (const t of board.tasks) t.controller?.abort();
  }
});
