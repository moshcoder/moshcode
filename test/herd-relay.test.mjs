// PRD 0020 phase 1: the box half of the herd on a phone.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  approvalFor, createStreams, createTracker, execute, fingerprint, lastLinesOf, machineIdentity,
  PHONE_KEYS, relayServiceCommands, relayServiceFile, runRelay, snapshot,
} from "../src/herd-relay.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, "fixtures", "approve", name), "utf8");

// ---- approve maps against real dialogs ----

test("claude's Bash permission dialog is approvable, with allow-all", () => {
  assert.deepEqual(approvalFor("claude", fixture("claude-bash.txt")), { allowAll: true });
});

test("claude's edit dialog is approvable, with allow-all-edits", () => {
  assert.deepEqual(approvalFor("claude", fixture("claude-edit.txt")), { allowAll: true });
});

test("codex's command dialog is approvable, and offers (a)", () => {
  assert.deepEqual(approvalFor("codex", fixture("codex-command.txt")), { allowAll: true });
});

test("prose about a dialog is not a dialog", () => {
  assert.equal(approvalFor("claude", fixture("claude-talking-about-permissions.txt")), null);
});

test("an engine with no approve map is never approvable", () => {
  assert.equal(approvalFor("aider", fixture("claude-bash.txt")), null);
  assert.equal(approvalFor("nope", fixture("claude-bash.txt")), null);
});

test("codex without the (a) option offers no allow-all", () => {
  const screen = fixture("codex-command.txt").replace(/^.*\(a\)\n/m, "");
  assert.deepEqual(approvalFor("codex", screen), { allowAll: false });
});

test("an answered dialog still on screen is not live (found live: a second Allow typed into the next prompt)", () => {
  const answered = `${fixture("claude-bash.txt")}\nANSWERED: [1]\n? for shortcuts\n`;
  assert.equal(approvalFor("claude", answered), null);
  const codex = `${fixture("codex-command.txt")}\n• Ran npm test\n  └ 42 passing\n\n› `;
  assert.equal(approvalFor("codex", codex), null);
});

test("a dialog scrolled far above the bottom is not live", () => {
  const screen = fixture("claude-bash.txt") + "\n" + Array(40).fill("output line").join("\n");
  assert.equal(approvalFor("claude", screen), null);
});

// ---- the command executor ----

function rig({ state = "blocked", engine = "claude", screen = fixture("claude-bash.txt"), substrate = "tmux" } = {}) {
  let clock = 1000;
  const tracker = createTracker({ now: () => clock });
  const rows = [{ name: "api", engine, state, blockedOn: state === "blocked" ? "menu" : undefined, alive: true }];
  tracker.observe(rows[0]);
  const sent = [];
  const prompts = [];
  const deps = {
    rows, tracker, streams: createStreams(), substrate,
    read: () => screen,
    keys: (name, keys) => { sent.push({ name, keys }); return { ok: true }; },
    prompt: (name, text) => { prompts.push({ name, text }); return { ok: true }; },
    now: () => clock,
  };
  return { deps, sent, prompts, blockedAt: tracker.since("api"), tick: (ms) => { clock += ms; } };
}

test("allow sends claude's 1, deny sends Escape, allowAll sends 2", () => {
  for (const [intent, keys] of [["allow", ["1"]], ["deny", ["Escape"]], ["allowAll", ["2"]]]) {
    const r = rig();
    const result = execute({ kind: "approve", session: "api", args: { intent, blockedAt: r.blockedAt } }, r.deps);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(r.sent, [{ name: "api", keys }]);
  }
});

test("codex answers with its own letters", () => {
  const r = rig({ engine: "codex", screen: fixture("codex-command.txt") });
  execute({ kind: "approve", session: "api", args: { intent: "allow", blockedAt: r.blockedAt } }, r.deps);
  assert.deepEqual(r.sent[0].keys, ["y"]);
});

test("on the pty substrate Escape is a byte", () => {
  const r = rig({ substrate: "pty" });
  execute({ kind: "approve", session: "api", args: { intent: "deny", blockedAt: r.blockedAt } }, r.deps);
  assert.deepEqual(r.sent[0].keys, ["\x1b"]);
});

test("stale: the session is no longer blocked", () => {
  const r = rig({ state: "working" });
  const result = execute({ kind: "approve", session: "api", args: { intent: "allow", blockedAt: 1000 } }, r.deps);
  assert.deepEqual(result, { ok: false, stale: true });
  assert.equal(r.sent.length, 0);
});

test("stale: a different blocked spell than the one the phone saw", () => {
  const r = rig();
  const result = execute({ kind: "approve", session: "api", args: { intent: "allow", blockedAt: r.blockedAt - 5000 } }, r.deps);
  assert.deepEqual(result, { ok: false, stale: true });
  assert.equal(r.sent.length, 0);
});

test("stale: the dialog left the screen even though state still says blocked", () => {
  const r = rig({ screen: fixture("claude-talking-about-permissions.txt") });
  const result = execute({ kind: "approve", session: "api", args: { intent: "allow", blockedAt: r.blockedAt } }, r.deps);
  assert.deepEqual(result, { ok: false, stale: true });
  assert.equal(r.sent.length, 0);
});

test("allowAll is refused when the dialog has no such option", () => {
  const r = rig({ engine: "codex", screen: fixture("codex-command.txt").replace(/^.*\(a\)\n/m, "") });
  const result = execute({ kind: "approve", session: "api", args: { intent: "allowAll", blockedAt: r.blockedAt } }, r.deps);
  assert.equal(result.ok, false);
  assert.equal(r.sent.length, 0);
});

test("keys: only the key bar's names, mapped per substrate", () => {
  const r = rig({ state: "working" });
  assert.deepEqual(execute({ kind: "keys", session: "api", args: { keys: ["esc", "ctrl-c", "up"] } }, r.deps), { ok: true });
  assert.deepEqual(r.sent[0].keys, ["Escape", "C-c", "Up"]);
  assert.equal(execute({ kind: "keys", session: "api", args: { keys: ["rm -rf /"] } }, r.deps).ok, false);
  assert.equal(execute({ kind: "keys", session: "api", args: { keys: ["__proto__"] } }, r.deps).ok, false);
  const p = rig({ state: "working", substrate: "pty" });
  execute({ kind: "keys", session: "api", args: { keys: ["up", "enter"] } }, p.deps);
  assert.deepEqual(p.sent[0].keys, [PHONE_KEYS.up.bytes, "\r"]);
});

test("prompt types text through sendPrompt; empty is refused", () => {
  const r = rig({ state: "idle" });
  assert.deepEqual(execute({ kind: "prompt", session: "api", args: { text: "ship it" } }, r.deps), { ok: true });
  assert.deepEqual(r.prompts, [{ name: "api", text: "ship it" }]);
  assert.equal(execute({ kind: "prompt", session: "api", args: { text: "  " } }, r.deps).ok, false);
});

test("unknown sessions and remote members are refused", () => {
  const r = rig();
  assert.equal(execute({ kind: "prompt", session: "nope", args: { text: "x" } }, r.deps).error, "no such session");
  r.deps.rows[0].kind = "remote";
  assert.match(execute({ kind: "prompt", session: "api", args: { text: "x" } }, r.deps).error, /remote/);
});

test("open-stream opens a stream that expires when nobody asks again", () => {
  const r = rig({ state: "working" });
  execute({ kind: "open-stream", session: "api" }, r.deps);
  assert.deepEqual(r.deps.streams.active(1000), ["api"]);
  assert.deepEqual(r.deps.streams.active(1000 + 61_000), []);
});

// ---- the tracker and the snapshot ----

test("blockedAt is when the blocked spell began, and a new spell gets a new one", () => {
  let clock = 0;
  const t = createTracker({ now: () => clock });
  const s = { name: "a", state: "blocked", blockedOn: "menu" };
  assert.equal(t.observe(s), 0);
  clock = 10;
  assert.equal(t.observe(s), 0, "same spell");
  clock = 20;
  t.observe({ ...s, state: "working" });
  clock = 30;
  assert.equal(t.observe(s), 30, "blocked again is a new question");
});

test("snapshot shapes rows, drops gone sessions, and marks approvable dialogs", () => {
  const t = createTracker({ now: () => 5 });
  const rows = [
    { name: "api", engine: "claude", state: "blocked", blockedOn: "menu", alive: true, cwd: "/src/api", confidence: "inferred" },
    { name: "web", engine: "codex", state: "working", alive: true, cwd: "/src/web" },
    { name: "old", engine: "claude", state: "gone", alive: false },
  ];
  const screens = { api: fixture("claude-bash.txt"), web: "building…\nesc to interrupt" };
  const out = snapshot(rows, t, { read: (n) => screens[n] });
  assert.deepEqual(out.map((s) => s.name), ["api", "web"]);
  assert.deepEqual(out[0].approval, { allowAll: true });
  assert.equal(out[0].blockedAt, 5);
  assert.equal(out[1].approval, null);
  assert.equal(out[1].blockedAt, null);
  assert.deepEqual(out[1].lastLines, ["building…", "esc to interrupt"]);
});

test("lastLinesOf strips colour and blank lines", () => {
  assert.deepEqual(lastLinesOf("\x1b[32mok\x1b[0m\n\n  \nnext   \n", 5), ["ok", "next"]);
});

test("fingerprint ignores the clock, notices state and screen", () => {
  const a = [{ name: "x", state: "working", blockedOn: null, lastLines: ["a"], approval: null, since: 1 }];
  assert.equal(fingerprint(a), fingerprint([{ ...a[0], since: 999 }]));
  assert.notEqual(fingerprint(a), fingerprint([{ ...a[0], lastLines: ["b"] }]));
});

test("machineIdentity is written once and reused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-relay-id-"));
  const one = machineIdentity({ dir, host: "box", user: "me" });
  const two = machineIdentity({ dir, host: "renamed", user: "me" });
  assert.equal(one.id, two.id);
  assert.equal(two.name, "me@renamed");
  assert.match(one.id, /^[0-9a-f-]{36}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the service ----

test("the systemd unit runs this node on this entry, herd relay", () => {
  const unit = relayServiceFile({ platform: "linux", execPath: "/opt/node", entry: "/m/bin/moshcode.mjs", env: { MOSHCODE_HERD_SOCKET: "x" } });
  assert.match(unit, /^ExecStart=\/opt\/node \/m\/bin\/moshcode\.mjs herd relay$/m);
  assert.match(unit, /^Environment=MOSHCODE_HERD_SOCKET=x$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test("the launchd plist keeps the relay alive", () => {
  const plist = relayServiceFile({ platform: "darwin", execPath: "/opt/node", entry: "/m/bin/moshcode.mjs" });
  assert.match(plist, /<string>\/opt\/node<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
});

test("phone on enables, restarts and asks for lingering (optional)", () => {
  const steps = relayServiceCommands({ platform: "linux", file: "/f", action: "on" });
  assert.deepEqual(steps.map(([c, a]) => `${c} ${a.join(" ")}`).slice(0, 3), [
    "systemctl --user daemon-reload", "systemctl --user enable moshcode-herd-relay.service", "systemctl --user restart moshcode-herd-relay.service",
  ]);
  assert.equal(steps[3][0], "loginctl");
  assert.equal(steps[3][2].optional, true);
});

// ---- the loop, end to end against a fake app ----

test("runRelay publishes the roster, runs a queued approve, and reports the result", async () => {
  const controller = new AbortController();
  const calls = [];
  let delivered = false;
  const sent = [];
  const rows = [{ name: "api", engine: "claude", state: "blocked", blockedOn: "menu", alive: true, cwd: "/src/api" }];
  let blockedAt = null;
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: u.pathname, method: init.method, body });
    const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
    if (u.pathname === "/api/herd/roster") { blockedAt = body.sessions[0].blockedAt; return json({ ok: true, watching: [] }); }
    if (u.pathname === "/api/herd/commands" && init.method === "GET") {
      if (!delivered && blockedAt != null) {
        delivered = true;
        return json({ commands: [{ id: "c1", session: "api", kind: "approve", args: { intent: "allow", blockedAt } }] });
      }
      await new Promise((r) => setTimeout(r, 20));
      return json({ commands: [] });
    }
    if (u.pathname === "/api/herd/commands/c1") { setTimeout(() => controller.abort(), 5); return json({ ok: true }); }
    return json({}, 404);
  };
  await runRelay({
    roster: () => rows,
    fetchImpl,
    api: "http://app.test",
    key: "mck_test",
    machine: { id: "11111111-1111-1111-1111-111111111111", name: "me@box" },
    signal: controller.signal,
    write: () => {},
    read: () => fixture("claude-bash.txt"),
    screenRead: () => "",
    tickMs: 5,
    streamTickMs: 5,
    keysImpl: (name, keys) => { sent.push({ name, keys }); return { ok: true }; },
  });
  const publish = calls.find((c) => c.path === "/api/herd/roster");
  assert.equal(publish.body.machine.name, "me@box");
  assert.deepEqual(publish.body.sessions[0].approval, { allowAll: true });
  const result = calls.find((c) => c.path === "/api/herd/commands/c1");
  assert.deepEqual(result.body, { machine: "11111111-1111-1111-1111-111111111111", ok: true });
  assert.deepEqual(sent, [{ name: "api", keys: ["1"] }]);
});

test("runRelay stops on a revoked login instead of polling forever", async () => {
  const fetchImpl = async (url) => ({
    ok: false, status: 401, json: async () => ({ error: "nope" }),
    url,
  });
  await assert.rejects(runRelay({
    roster: () => [], fetchImpl, api: "http://app.test", key: "mck_dead",
    machine: { id: "22222222-2222-2222-2222-222222222222", name: "me@box" },
    write: () => {}, tickMs: 5, streamTickMs: 5,
  }), /401/);
});
