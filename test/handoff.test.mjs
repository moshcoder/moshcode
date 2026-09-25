// `moshcode handoff` (PRD 0018 R1, R2, R3, R12).
//
// The failure this file exists to prevent is a quiet one. A handoff that
// misreads a transcript does not crash: it writes a shorter conversation, seeds
// the next engine with it, and the operator finds out several turns later that
// the decisions are gone. So the reader is tested against a fixture per engine
// that includes everything it is supposed to SKIP, and the refusals are tested
// as hard as the successes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { READERS, UNREADABLE, isReadable, listSessions, readSession } from "../src/transcript.mjs";
import {
  PORTABLE_TRANSCRIPT_VERSION, SEEDS, buildTranscript, handoffId, parseHandoff, planHandoff,
  recordHandoff, seedPrompt, sources, targets, handoffCommand,
} from "../src/handoff.mjs";
import { BRIDGE_TOOLS, bridgeHandle } from "../src/mcp.mjs";
import { fold, readLedger, renderTree } from "../src/openfleet.mjs";
import { claudeProjectSlugs } from "../src/cost.mjs";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/handoff", import.meta.url));

const CWD = "/work/api";

/**
 * A throwaway HOME with one engine's fixture planted where that engine writes.
 *
 * os.homedir() reads $HOME on POSIX, which is how every reader here is pointed
 * at a fake tree instead of the machine's real transcripts. The same trick
 * cost.test.mjs uses, for the same reason.
 */
function withHome(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "moshcode-handoff-"));
  const previous = process.env.HOME;
  const previousFleet = process.env.OPENFLEET_HOME;
  const previousMosh = process.env.MOSHCODE_HOME;
  process.env.HOME = dir;
  process.env.OPENFLEET_HOME = path.join(dir, ".openfleet");
  process.env.MOSHCODE_HOME = path.join(dir, ".moshcode");
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
      if (previousFleet === undefined) delete process.env.OPENFLEET_HOME; else process.env.OPENFLEET_HOME = previousFleet;
      if (previousMosh === undefined) delete process.env.MOSHCODE_HOME; else process.env.MOSHCODE_HOME = previousMosh;
      rmSync(dir, { recursive: true, force: true });
    });
}

const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

function plantClaude(home, file = "claude-session.jsonl", session = "c41b501f-de0a-411d-90a9-1e858636a4c2") {
  const dir = path.join(home, ".claude", "projects", claudeProjectSlugs(CWD)[0]);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(target, fixture(file));
  return target;
}

function plantCodex(home) {
  const dir = path.join(home, ".codex", "sessions", "2026", "09", "25");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "rollout-2026-09-25T17-10-00-01a01818.jsonl");
  fs.writeFileSync(target, fixture("codex-rollout.jsonl"));
  return target;
}

/* ------------------------------------------------- R1: reading a transcript */

test("the claude reader keeps the conversation and drops everything that is not", async () => {
  await withHome(async (home) => {
    plantClaude(home);
    const session = await readSession("claude", { cwd: CWD });

    assert.equal(session.engine, "claude");
    assert.equal(session.id, "c41b501f-de0a-411d-90a9-1e858636a4c2");
    assert.equal(session.cwd, CWD);
    assert.deepEqual(session.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    assert.match(session.messages[0].text, /move the queue off redis/);
    assert.match(session.messages[1].text, /postgres-backed queue/);

    // The five kinds of record that are in the fixture precisely so they can be
    // shown to be absent: the injected environment block, a tool result in the
    // user's seat, a subagent's sidechain, a meta turn the engine typed for the
    // user, and a synthetic assistant turn with no API call behind it.
    const all = session.messages.map((m) => m.text).join("\n");
    assert.ok(!all.includes("system-reminder"), "an injected block travelled");
    assert.ok(!all.includes("tool_result"), "a tool result travelled");
    assert.ok(!all.includes("subagent"), "a sidechain travelled");
    assert.ok(!all.includes("/compact"), "a meta turn travelled");
    assert.ok(!all.includes("API Error"), "a synthetic turn travelled");
    assert.ok(!all.includes("the user wants postgres"), "a thinking block travelled");
  });
});

test("the claude reader collects the files that were written, and only those", async () => {
  await withHome(async (home) => {
    plantClaude(home);
    const session = await readSession("claude", { cwd: CWD });
    assert.deepEqual(session.changes.sort(), [
      "/work/api/migrations/003-queue.sql",
      "/work/api/src/queue.mjs",
    ]);
    // Bash ran `pnpm test`, which changed nothing anyone can name.
    assert.ok(!session.changes.some((c) => c.includes("pnpm")));
  });
});

test("the codex reader reads the middle of a rollout, which is the conversation", async () => {
  await withHome(async (home) => {
    plantCodex(home);
    const session = await readSession("codex", { cwd: CWD });
    assert.equal(session.id, "01a01818-2592-7613-9a49-30ecb2068f6d");
    assert.equal(session.cwd, CWD);
    assert.deepEqual(session.messages.map((m) => m.role), ["user", "assistant", "assistant"]);
    assert.match(session.messages[0].text, /finish it/);
    assert.match(session.messages.at(-1).text, /tests pass/);
    // The developer turn is the system prompt, and the environment block is
    // injected. Neither is conversation.
    const all = session.messages.map((m) => m.text).join("\n");
    assert.ok(!all.includes("You are Codex"), "the system prompt travelled");
    assert.ok(!all.includes("environment_context"), "an injected block travelled");
    assert.deepEqual(session.changes, ["/work/api/src/worker.mjs"]);
  });
});

test("the newest session wins, and --session picks another by a prefix of its id", async () => {
  await withHome(async (home) => {
    const old = plantClaude(home, "claude-session.jsonl", "aaaaaaaa-0000-0000-0000-000000000000");
    const recent = plantClaude(home, "claude-session.jsonl", "bbbbbbbb-1111-1111-1111-111111111111");
    // mtime is what orders them, so make the order explicit rather than racing.
    fs.utimesSync(old, new Date(1000), new Date(1000));
    fs.utimesSync(recent, new Date(2000), new Date(2000));

    const sessions = await listSessions("claude", { cwd: CWD });
    assert.equal(sessions.length, 2);
    // The transcript records its own session id, which wins over the file name.
    assert.equal(sessions[0].file, recent);

    const picked = await readSession("claude", { cwd: CWD, id: "aaaaaaaa" });
    assert.equal(picked.file, old);
  });
});

/**
 * opencode's transcript is a database, not a file, so its fixture is built
 * rather than committed. The schema is the part that matters and is copied from
 * a real store: `message` holds the role and the directory, `part` holds one row
 * per block, and the text lives in a JSON column on the part.
 */
function plantOpencode(home) {
  const dir = path.join(home, ".local", "share", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "opencode.db"));
  db.exec("create table message (id text primary key, session_id text, time_created integer, data text)");
  db.exec("create table part (id text primary key, message_id text, session_id text, time_created integer, data text)");
  const msg = db.prepare("insert into message values (?, ?, ?, ?)");
  const part = db.prepare("insert into part values (?, ?, ?, ?, ?)");
  const session = "ses_02982eb87ffe";
  msg.run("msg_1", session, 1000, JSON.stringify({ role: "user", path: { cwd: CWD } }));
  part.run("prt_1", "msg_1", session, 1000, JSON.stringify({ type: "text", text: "the queue is still on redis" }));
  msg.run("msg_2", session, 2000, JSON.stringify({ role: "assistant", modelID: "x", path: { cwd: CWD } }));
  // One message arrives as several parts, and they belong to one turn.
  part.run("prt_2", "msg_2", session, 2000, JSON.stringify({ type: "text", text: "I will move it." }));
  part.run("prt_3", "msg_2", session, 2001, JSON.stringify({ type: "tool", tool: "edit", state: { input: { filePath: "/work/api/src/queue.mjs" } } }));
  part.run("prt_4", "msg_2", session, 2002, JSON.stringify({ type: "text", text: "Done, the interface is unchanged." }));
  db.close();
  return session;
}

test("the opencode reader joins the part table, which is where the words are", async () => {
  await withHome(async (home) => {
    const session = plantOpencode(home);
    const read = await readSession("opencode", { cwd: CWD });
    assert.equal(read.id, session);
    assert.equal(read.cwd, CWD);
    assert.deepEqual(read.messages.map((m) => m.role), ["user", "assistant"]);
    assert.match(read.messages[0].text, /still on redis/);
    // Two text parts of one message are one turn, not two.
    assert.match(read.messages[1].text, /I will move it\./);
    assert.match(read.messages[1].text, /interface is unchanged/);
    assert.deepEqual(read.changes, ["/work/api/src/queue.mjs"]);
  });
});

/* ---------------------------------------------------------- R1: it refuses */

test("a transcript that parses to no messages is a refusal, not an empty conversation", async () => {
  await withHome(async (home) => {
    plantClaude(home, "claude-unreadable.jsonl", "cccccccc-2222-2222-2222-222222222222");
    await assert.rejects(
      () => readSession("claude", { cwd: CWD }),
      /parsed to no messages/,
      "a moved format must stop the handoff",
    );
  });
});

test("an engine with no reader refuses with the reason, not with silence", async () => {
  for (const engine of Object.keys(UNREADABLE)) {
    assert.equal(isReadable(engine), false, `${engine} claims a reader it has none of`);
    await assert.rejects(() => readSession(engine, { cwd: CWD }), (error) => {
      assert.equal(error.message, UNREADABLE[engine]);
      return true;
    });
  }
});

test("a directory with no session of that engine refuses by name", async () => {
  await withHome(async () => {
    await assert.rejects(() => readSession("claude", { cwd: CWD }), /no claude session recorded for/);
  });
});

test("a --session that matches nothing refuses rather than falling back to the newest", async () => {
  await withHome(async (home) => {
    plantClaude(home);
    await assert.rejects(() => readSession("claude", { cwd: CWD, id: "nope" }), /no claude session matches "nope"/);
  });
});

/* ------------------------------------------- R1: the seeding table is honest */

test("every engine is either seedable or refused by name, and none is left out", () => {
  const seedable = targets();
  assert.deepEqual(seedable, ["opencode", "privacycode", "claude", "codex", "gemini", "qwen", "omp"]);
  for (const [key, seed] of Object.entries(SEEDS)) {
    assert.ok(seed.argv || seed.unsupported, `${key} is neither seedable nor refused`);
    assert.ok(!(seed.argv && seed.unsupported), `${key} is both`);
  }
  // Source coverage is narrower than target coverage, which is the honest state
  // of things and the reason both lists are stated rather than assumed equal.
  assert.deepEqual(sources(), ["opencode", "privacycode", "claude", "codex"]);
});

test("an unseedable target is refused with what it does instead", () => {
  const plan = planHandoff({ from: "claude", to: "kimi" });
  assert.match(plan.error, /kimi cannot be handed off to/);
  assert.match(plan.error, /prints one answer and exits/);
  assert.match(plan.error, /seedable: /);
});

test("an unreadable source is refused with what can be read instead", () => {
  const plan = planHandoff({ from: "omp", to: "claude" });
  assert.match(plan.error, /omp cannot be handed off from/);
  assert.match(plan.error, /readable: opencode, privacycode, claude, codex/);
});

test("aliases resolve on both sides, as they do everywhere else", () => {
  const plan = planHandoff({ from: "cc", to: "openai" });
  assert.equal(plan.from, "claude");
  assert.equal(plan.to, "codex");
});

/* ------------------------------------------ R3: the portable transcript itself */

test("the transcript carries the documented shape, and says when it is an excerpt", async () => {
  await withHome(async (home) => {
    plantClaude(home);
    const session = await readSession("claude", { cwd: CWD });
    const doc = buildTranscript(session, { to: "codex", now: Date.parse("2026-09-25T18:22:41Z"), version: "9.9.9" });

    assert.equal(doc.portable_transcript, PORTABLE_TRANSCRIPT_VERSION);
    assert.equal(doc.generated.by, "moshcode 9.9.9");
    assert.equal(doc.generated.at, "2026-09-25T18:22:41Z");
    assert.equal(doc.generated.to, "codex");
    assert.equal(doc.source.engine, "claude");
    assert.equal(doc.source.messages, 4);
    assert.equal(doc.source.dropped, 0);
    assert.deepEqual(Object.keys(doc.messages[0]), ["role", "at", "text"]);
    assert.equal(doc.messages[0].at, "2026-09-25T17:04:02Z");
    assert.deepEqual(doc.changes[0], { path: "/work/api/src/queue.mjs", action: "written" });

    const capped = buildTranscript(session, { max: 2 });
    assert.equal(capped.messages.length, 2);
    assert.equal(capped.source.dropped, 2);
    // The newest are what the next engine has to continue from.
    assert.match(capped.messages.at(-1).text, /Dead letters/);
  });
});

test("the seed is one line, because a pane submits a prompt on the first newline", () => {
  const doc = buildTranscript(
    { engine: "claude", id: "x", cwd: CWD, start: 0, end: 1, messages: [{ role: "user", text: "a\nb", at: 0 }], changes: [] },
    { max: 1 },
  );
  const prompt = seedPrompt(doc, "/tmp/h.json");
  assert.ok(!prompt.includes("\n"), "a newline in the seed submits it early");
  assert.match(prompt, /\/tmp\/h\.json/);
  assert.match(prompt, /portable transcript, version 0\.1/);
  assert.match(prompt, /working tree is the real state/);
});

test("the id sorts by time and names both engines", () => {
  assert.equal(handoffId("claude", "codex", Date.parse("2026-09-25T18:22:41Z")), "claude-codex-182241");
});

/* -------------------------------------------------- R1: the command, end to end */

test("the command writes the transcript and builds the launch, without launching", async () => {
  await withHome(async (home) => {
    plantClaude(home);
    const out = [];
    const errors = [];
    const code = await handoffCommand(["claude", "codex", "--cwd", CWD, "--dry-run", "--json"], {
      write: (l) => out.push(l), fail: (l) => errors.push(l),
      launch: () => { throw new Error("a dry run must not launch"); },
    });
    assert.equal(code, 0, errors.join("\n"));
    const result = JSON.parse(out.join("\n"));

    assert.equal(result.from, "claude");
    assert.equal(result.to, "codex");
    assert.equal(result.launched, false);
    assert.equal(result.messages, 4);
    assert.equal(result.changes, 2);
    assert.equal(result.transcript, path.join(home, ".moshcode", "handoffs", `${result.handoff}.json`));

    const doc = JSON.parse(fs.readFileSync(result.transcript, "utf8"));
    assert.equal(doc.portable_transcript, "0.1");
    assert.equal(doc.messages.length, 4);
    // A whole conversation about someone's code is not world-readable.
    assert.equal(fs.statSync(result.transcript).mode & 0o077, 0);

    // Codex takes its prompt positionally, so the argv is the binary and one
    // string. The string names the file rather than carrying the transcript.
    assert.equal(result.argv.length, 2);
    assert.match(result.argv[1], /portable transcript/);
    assert.ok(result.argv[1].includes(result.transcript));
  });
});

test("the command launches the target with its plain defaults and no bypass flags", async () => {
  await withHome(async (home) => {
    plantClaude(home);
    const launched = [];
    const code = await handoffCommand(["claude", "opencode", "--cwd", CWD], {
      write: () => {}, fail: () => {},
      launch: (engine, argv) => { launched.push([engine.bin, argv]); return { ok: true, code: 0 }; },
    });
    assert.equal(code, 0);
    assert.equal(launched.length, 1);
    const [bin, argv] = launched[0];
    assert.equal(bin, "opencode");
    assert.equal(argv[0], "--prompt");
    assert.equal(argv.length, 2);
    assert.ok(!argv.includes("--auto"), "a handoff must not also bypass approvals");
  });
});

test("the command says what it picked before it starts anything", async () => {
  await withHome(async (home) => {
    plantClaude(home);
    const out = [];
    await handoffCommand(["claude", "codex", "--cwd", CWD, "--dry-run"], {
      write: (l) => out.push(l), fail: () => {},
    });
    const text = out.join("\n");
    assert.match(text, /claude session c41b501f/);
    assert.match(text, /4 messages/);
    assert.match(text, /2 files changed/);
    assert.match(text, /transcript /);
    assert.match(text, /dry run, not launching/);
  });
});

test("bad arguments are refused before anything is read", async () => {
  for (const [argv, pattern] of [
    [[], /usage: moshcode handoff/],
    [["claude"], /usage: moshcode handoff/],
    [["claude", "codex", "--session"], /--session needs a value/],
    [["claude", "codex", "--max", "0"], /--max must be a whole number/],
    [["claude", "codex", "--nope"], /unknown handoff flag "--nope"/],
    [["a", "b", "c"], /handoff takes two engines/],
  ]) {
    const parsed = parseHandoff(argv);
    assert.match(parsed.error, pattern, argv.join(" "));
  }
});

test("an unknown engine is refused with the list", async () => {
  const errors = [];
  const code = await handoffCommand(["nope", "codex"], { write: () => {}, fail: (l) => errors.push(l) });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /unknown engine "nope"/);
});

/* ---------------------------------------------------- R2: the OpenFleet edge */

test("a handoff writes the record that puts the edge in the fleet tree", async () => {
  await withHome(async (home) => {
    plantClaude(home);
    const out = [];
    await handoffCommand(["claude", "codex", "--cwd", CWD, "--dry-run", "--json"], {
      write: (l) => out.push(l), fail: () => {},
    });
    const result = JSON.parse(out.join("\n"));
    const fleet = result.fleet.fleet;

    const dir = path.join(home, ".openfleet", "fleets", fleet, "members");
    const records = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    const child = records.find((r) => r.member === result.handoff);
    assert.ok(child, "the handoff wrote no record");
    assert.equal(child.parent, result.fleet.parent);
    assert.equal(child.engine, "moshcode/codex");
    assert.equal(child.depth, 1);
    assert.deepEqual(child.handoff, {
      from: "claude", to: "codex",
      session: "c41b501f-de0a-411d-90a9-1e858636a4c2",
      transcript: result.transcript, messages: 4,
    });
    // The source session had no record of its own, so one was written for it.
    const parent = records.find((r) => r.member === result.fleet.parent);
    assert.ok(parent, "the parent has no record, so the child hangs from nothing");
    assert.equal(parent.engine, "moshcode/claude");

    const lines = readLedger(fleet, process.env);
    const handoffLine = lines.find((l) => l.event === "member.handoff");
    assert.ok(handoffLine, "no member.handoff was written");
    assert.equal(handoffLine.member, result.handoff);
    assert.equal(handoffLine.parent, result.fleet.parent);
    assert.equal(lines.filter((l) => l.event === "member.start").length, 2);

    // And the tree draws it, which is the whole point of R2.
    const tree = renderTree(fold({ fleets: [{ fleet, lines, records }] }));
    const rows = tree.split("\n");
    const parentRow = rows.findIndex((r) => r.includes(result.fleet.parent) && !r.includes(result.handoff));
    const childRow = rows.findIndex((r) => r.includes(result.handoff));
    assert.ok(parentRow >= 0 && childRow > parentRow, `the child is not under the parent:\n${tree}`);
    assert.match(rows[childRow], /^\s*[│ ]*[└├]/, "the child is not drawn as a child");
  });
});

test("a handoff inside a fleet member hangs off that member rather than inventing one", async () => {
  await withHome(async (home) => {
    const fleetHome = path.join(home, ".openfleet");
    const fleet = "team@box";
    const recordFile = path.join(fleetHome, "fleets", fleet, "members", "worker-1.json");
    fs.mkdirSync(path.dirname(recordFile), { recursive: true });
    fs.writeFileSync(recordFile, JSON.stringify({
      openfleet: "0.1", fleet, sysop: "boss@box", member: "worker-1", swarm: "job-0101",
      depth: 0, engine: "moshcode/claude", session: "worker-1", host: "box", cwd: CWD,
    }));
    const env = { ...process.env, OPENFLEET_HOME: fleetHome, OPENFLEET_RECORD: recordFile, OPENFLEET_MEMBER: "worker-1" };

    const edge = recordHandoff({
      from: "claude", to: "codex", id: "claude-codex-010203", session: "abc",
      transcript: "/tmp/t.json", cwd: CWD, messages: 3, env,
    });
    assert.equal(edge.fleet, fleet);
    assert.equal(edge.parent, "worker-1", "an existing member must be the parent");
    assert.equal(edge.recorded, true);
    // Nothing was invented for the source: it already had a record.
    const members = fs.readdirSync(path.join(fleetHome, "fleets", fleet, "members")).sort();
    assert.deepEqual(members, ["claude-codex-010203.json", "worker-1.json"]);
  });
});

/* -------------------------------------------------------- R12: the MCP bridge */

test("the bridge lists handoff as a tool, with a schema an engine can call", async () => {
  const response = await bridgeHandle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tool = response.result.tools.find((t) => t.name === "moshcode_handoff");
  assert.ok(tool, "the bridge does not expose handoff");
  assert.deepEqual(tool.inputSchema.required, ["from", "to"]);
  assert.equal(BRIDGE_TOOLS.length, response.result.tools.length);
});

test("the bridge answers initialize, and refuses a method it does not have", async () => {
  const init = await bridgeHandle({ jsonrpc: "2.0", id: 1, method: "initialize" }, { version: "1.2.3" });
  assert.equal(init.result.serverInfo.name, "moshcode");
  assert.equal(init.result.serverInfo.version, "1.2.3");
  assert.ok(init.result.capabilities.tools);

  const unknown = await bridgeHandle({ jsonrpc: "2.0", id: 2, method: "nope/nope" });
  assert.equal(unknown.error.code, -32601);

  // A notification takes no answer at all.
  assert.equal(await bridgeHandle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("calling handoff over the bridge does the work and launches nothing", async () => {
  await withHome(async (home) => {
    plantClaude(home);
    const response = await bridgeHandle({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "moshcode_handoff", arguments: { from: "claude", to: "codex", cwd: CWD } },
    });
    assert.equal(response.result.isError, false);
    const result = JSON.parse(response.result.content[0].text);
    assert.equal(result.launched, false, "a bridge call must not open a terminal");
    assert.equal(result.messages, 4);
    assert.ok(fs.existsSync(result.transcript));
  });
});

test("a refused handoff comes back over the bridge as a readable reason", async () => {
  const response = await bridgeHandle({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "moshcode_handoff", arguments: { from: "claude", to: "kimi" } },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /kimi cannot be handed off to/);
});

/* ------------------------------------------------------- the dispatched verb */

test("the CLI dispatches handoff, and its help changes nothing", async () => {
  const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-handoff-cli-"));
  try {
    const { stdout } = await run(process.execPath, [BIN, "handoff", "--help"], { cwd: workdir });
    assert.match(stdout, /^moshcode handoff —/);
    assert.match(stdout, /--session <id>/);
    assert.deepEqual(fs.readdirSync(workdir), [], "--help wrote into the cwd");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("the CLI refuses an unreadable source with the reason and exit 1", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "moshcode-handoff-home-"));
  try {
    await run(process.execPath, [BIN, "handoff", "omp", "claude"], { env: { ...process.env, HOME: home } });
    assert.fail("an unreadable source should exit non-zero");
  } catch (error) {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /omp cannot be handed off from/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* --------------------------------------------------- the readers stay in step */

test("every readable engine has both halves of a reader", () => {
  for (const [engine, reader] of Object.entries(READERS)) {
    assert.equal(typeof reader.sessions, "function", `${engine} cannot list sessions`);
    assert.equal(typeof reader.read, "function", `${engine} cannot read one`);
    assert.ok(!UNREADABLE[engine], `${engine} is both readable and listed as unreadable`);
  }
});

test("`moshcode mcp bridge` speaks MCP on stdio", async () => {
  const child = spawn(process.execPath, [BIN, "mcp", "bridge"], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  const done = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let cut;
      while ((cut = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (line) lines.push(JSON.parse(line));
        if (lines.length === 2) resolve();
      }
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await done;
  child.stdin.end();
  child.kill();

  assert.equal(lines[0].result.serverInfo.name, "moshcode");
  // The notification in the middle got no answer, so tools/list is the second
  // line and not the third.
  assert.equal(lines[1].id, 2);
  assert.ok(lines[1].result.tools.some((t) => t.name === "moshcode_handoff"));
});
