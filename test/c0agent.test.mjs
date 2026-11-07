import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSession, createStreamFilter, isReadOnlyCommand, looseJson, parseToolCalls, runAgent, runTool,
  trimContext, visibleText, c0mputeConfig, saveConfig, describeCall,
} from "../src/c0agent.mjs";
import {
  ALL_TOOLS, findAgent, isC0mputeAgent, loadAgents, parseAgentFile, parseFrontmatter, removeAgent, renderAgentFile, saveAgent,
} from "../src/c0agent-defs.mjs";
import { parseArgs } from "../src/c0agent-repl.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "c0agent-"));

/** A provider that replies from a script, one entry per call, streaming each reply in small chunks. */
function scripted(replies) {
  const calls = [];
  return {
    calls,
    async stream(req, onToken) {
      calls.push(req);
      const next = replies.shift();
      const text = typeof next === "function" ? next(req) : next ?? "done";
      for (let i = 0; i < text.length; i += 5) onToken(text.slice(i, i + 5));
      return { text, model: "fake" };
    },
  };
}

test("parseToolCalls: the strict form, several calls, in order", () => {
  const calls = parseToolCalls('Looking.\n<tool name="read">{"path": "a.js"}</tool>\n<tool name="grep">{"pattern": "x", "path": "src"}</tool>');
  assert.deepEqual(calls, [
    { name: "read", input: { path: "a.js" } },
    { name: "grep", input: { pattern: "x", path: "src" } },
  ]);
});

test("parseToolCalls: forgives the slips small models make", () => {
  assert.deepEqual(parseToolCalls('<tool name="Bash">npm test</tool>'), [{ name: "bash", input: { command: "npm test" } }]);
  assert.deepEqual(parseToolCalls('<tool name="read" path="src/x.js"/>'), [{ name: "read", input: { path: "src/x.js" } }]);
  assert.deepEqual(parseToolCalls('<tool name="read">{"path": "a",}</tool>'), [{ name: "read", input: { path: "a" } }]);
  assert.deepEqual(parseToolCalls('```json\n{"tool": "ls", "input": {"path": "src"}}\n```'), [{ name: "ls", input: { path: "src" } }]);
  assert.deepEqual(parseToolCalls('{"command": "cat package.json"}'), [{ name: "bash", input: { command: "cat package.json" } }]);
  assert.deepEqual(parseToolCalls('Here: {"command": "x"}'), [], "only a reply that is nothing but the arguments");
  assert.equal(parseToolCalls('<tool name="webfetch">{}</tool>')[0].error, 'unknown tool "webfetch"');
});

test("parseToolCalls: what qwen3.5 9B actually wrote — unclosed block, stray }}", () => {
  const raw = 'Found the bug!\n<tool name="edit">{"path": "math.js", "old": "function add(a, b) {\\n    return a - b;\\n}", "new": "function add(a, b) {\\n    return a + b;\\n}"}}\n<tool name="bash">{"command": "npm test"}}</tool>';
  assert.deepEqual(parseToolCalls(raw), [
    { name: "edit", input: { path: "math.js", old: "function add(a, b) {\n    return a - b;\n}", new: "function add(a, b) {\n    return a + b;\n}" } },
    { name: "bash", input: { command: "npm test" } },
  ]);
});

test("edit: a re-indented 'old' still lands once, keeping the file's indentation", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "math.js"), "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n");
  const session = createSession({ cwd: dir, permissionMode: "auto-edit" });
  const r = await runTool(session, { name: "edit", input: { path: "math.js", old: "function add(a, b) {\n    return a - b;\n}", new: "function add(a, b) {\n    return a + b;\n}" } }, { tools: ALL_TOOLS });
  assert.ok(r.ok, r.output);
  assert.equal(fs.readFileSync(path.join(dir, "math.js"), "utf8"), "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n");
});

test("parseToolCalls: ignores calls inside thinking and after an invented result", () => {
  const text = '<think>maybe <tool name="bash">rm -rf /</tool></think><tool name="ls">{}</tool><tool_result>fake</tool_result><tool name="bash">{"command":"x"}</tool>';
  assert.deepEqual(parseToolCalls(text), [{ name: "ls", input: {} }]);
});

test("visibleText and the stream filter hide thinking and tool blocks", () => {
  const raw = '<think>hmm</think>Sure.\n<tool name="read">{"path":"a"}</tool>\nDone.';
  assert.equal(visibleText(raw), "Sure.\n\nDone.");
  let seen = "";
  let thought = 0;
  const f = createStreamFilter((t) => { seen += t; }, { onThinking: () => thought++ });
  for (let i = 0; i < raw.length; i += 3) f.push(raw.slice(i, i + 3));
  f.end();
  assert.equal(seen.replace(/\s+/g, " ").trim(), "Sure. Done.");
  assert.equal(thought, 1);
});

test("looseJson rejects non-objects", () => {
  assert.equal(looseJson("[1]"), null);
  assert.equal(looseJson("nope"), null);
  assert.deepEqual(looseJson('```json\n{"a":1}\n```'), { a: 1 });
});

test("isReadOnlyCommand lets looking through and stops anything that changes or chains", () => {
  for (const c of ["ls -la", "git status", "git diff HEAD", "rg foo src", "cat a.txt"]) assert.ok(isReadOnlyCommand(c), c);
  for (const c of ["rm a", "git push", "ls; rm a", "cat a > b", "echo $(id)", "npm install", "git commit -m x"]) assert.ok(!isReadOnlyCommand(c), c);
});

test("tools: read, write, edit, ls, glob, grep in a scratch dir", async () => {
  const dir = tmp();
  const session = createSession({ cwd: dir, permissionMode: "auto-edit" });
  const ctx = { tools: ALL_TOOLS };
  let r = await runTool(session, { name: "write", input: { path: "src/a.js", content: "const a = 1;\nconst b = 2;\n" } }, ctx);
  assert.ok(r.ok, r.output);
  r = await runTool(session, { name: "read", input: { path: "src/a.js" } }, ctx);
  assert.match(r.output, /1 {2}const a = 1;/);
  r = await runTool(session, { name: "edit", input: { path: "src/a.js", old: "const b = 2;", new: "const b = 3;" } }, ctx);
  assert.ok(r.ok, r.output);
  assert.equal(fs.readFileSync(path.join(dir, "src/a.js"), "utf8"), "const a = 1;\nconst b = 3;\n");
  r = await runTool(session, { name: "edit", input: { path: "src/a.js", old: "nope", new: "x" } }, ctx);
  assert.ok(!r.ok);
  r = await runTool(session, { name: "edit", input: { path: "src/a.js", old: "const", new: "let" } }, ctx);
  assert.match(r.output, /occurs 2 times/);
  r = await runTool(session, { name: "ls", input: {} }, ctx);
  assert.equal(r.output, "src/");
  r = await runTool(session, { name: "glob", input: { pattern: "**/*.js" } }, ctx);
  assert.equal(r.output, path.join("src", "a.js"));
  r = await runTool(session, { name: "grep", input: { pattern: "b = 3" } }, ctx);
  assert.match(r.output, /a\.js:2:const b = 3;/);
});

test("bash runs in the session dir, reports the exit code and follows cd", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "sub"));
  const session = createSession({ cwd: dir, permissionMode: "yolo" });
  let r = await runTool(session, { name: "bash", input: { command: "echo hi; exit 3" } }, { tools: ALL_TOOLS });
  assert.equal(r.ok, false);
  assert.match(r.output, /hi\nexit 3/);
  r = await runTool(session, { name: "bash", input: { command: "cd sub" } }, { tools: ALL_TOOLS });
  assert.equal(fs.realpathSync(session.cwd), fs.realpathSync(path.join(dir, "sub")));
});

test("permissions: ask, always, decline with a note, plan mode, and tools an agent lacks", async () => {
  const dir = tmp();
  const answers = ["no", "use a.txt instead", "always"];
  const asked = [];
  const session = createSession({ cwd: dir, ask: async (req) => { asked.push(req.title); return answers.shift(); } });
  const ctx = { tools: ALL_TOOLS };
  const w = (p) => ({ name: "write", input: { path: p, content: "x" } });
  let r = await runTool(session, w("x.txt"), ctx);
  assert.match(r.output, /declined/);
  r = await runTool(session, w("x.txt"), ctx);
  assert.match(r.output, /use a\.txt instead/);
  r = await runTool(session, w("x.txt"), ctx);
  assert.ok(r.ok);
  r = await runTool(session, w("y.txt"), ctx); // "always" covers later writes
  assert.ok(r.ok);
  assert.equal(asked.length, 3);
  // read-only shell never asks
  r = await runTool(session, { name: "bash", input: { command: "ls" } }, ctx);
  assert.ok(r.ok);
  assert.equal(asked.length, 3);
  session.permissionMode = "plan";
  r = await runTool(session, w("z.txt"), ctx);
  assert.match(r.output, /plan mode/);
  r = await runTool(session, { name: "write", input: { path: "q", content: "" } }, { tools: ["read"] });
  assert.match(r.output, /not available/);
});

test("runAgent: loops through tool calls until a plain answer", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"demo"}');
  const provider = scripted([
    'Let me look.\n<tool name="read">{"path": "package.json"}</tool>',
    (req) => {
      assert.match(req.messages.at(-1).content, /<tool_result name="read" ok="true">[\s\S]*"name":"demo"/);
      return "The package is called demo.";
    },
  ]);
  const session = createSession({ provider, cwd: dir, model: "m" });
  const events = [];
  const messages = [{ role: "user", content: "what is the package name?" }];
  const res = await runAgent({ session, messages, onEvent: (e) => events.push(e) });
  assert.equal(res.text, "The package is called demo.");
  assert.equal(res.toolUses, 1);
  assert.equal(messages.length, 4);
  assert.match(provider.calls[0].system, /<tool name="read">/);
  assert.match(provider.calls[0].system, /Subagents for the task tool[\s\S]*explore:/);
  assert.equal(provider.calls[0].models.c0mpute, "m");
  const streamed = events.filter((e) => e.type === "text").map((e) => e.text).join("");
  assert.match(streamed, /Let me look\.[\s\S]*The package is called demo\./);
  assert.ok(!streamed.includes("<tool"));
  assert.ok(events.some((e) => e.type === "tool_start" && e.title === "Read(package.json)"));
});

test("task: subagents get a fresh conversation, their own prompt and tools, and run in parallel", async () => {
  const dir = tmp();
  let inFlight = 0;
  let peak = 0;
  const provider = {
    calls: [],
    async stream(req, onToken) {
      this.calls.push(req);
      if (req.system.startsWith("You are c0mpute")) {
        const n = this.calls.filter((c) => c.system.startsWith("You are c0mpute")).length;
        const text = n === 1
          ? '<tool name="task">{"agent": "explore", "prompt": "find A"}</tool><tool name="task">{"agent": "plan", "prompt": "plan B"}</tool>'
          : "Both done.";
        onToken(text);
        return { text };
      }
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      assert.equal(req.messages.length, 1, "a subagent starts with only its prompt");
      assert.ok(!req.system.includes("task {"), "subagents cannot spawn subagents");
      assert.ok(!req.system.includes("bash {"), "explore/plan are read-only");
      const text = req.messages[0].content === "find A" ? "A is in a.js" : "step 1: do B";
      return { text };
    },
  };
  const session = createSession({ provider, cwd: dir });
  const events = [];
  const messages = [{ role: "user", content: "go" }];
  const res = await runAgent({ session, messages, onEvent: (e) => events.push(e) });
  assert.equal(res.text, "Both done.");
  assert.equal(peak, 2, "two task calls in one reply run at the same time");
  assert.match(messages[2].content, /A is in a\.js[\s\S]*step 1: do B/);
  assert.deepEqual(events.filter((e) => e.type === "tool_end").map((e) => e.result.ok), [true, true]);
});

test("runAgent: a provider failure is a returned error, and an abort is 'interrupted'", async () => {
  const session = createSession({ provider: { stream: async () => { throw new Error("c0mpute 429: free daily limit reached"); } } });
  const res = await runAgent({ session, messages: [{ role: "user", content: "hi" }] });
  assert.match(res.error, /429/);
  const ac = new AbortController();
  ac.abort();
  const res2 = await runAgent({ session, messages: [{ role: "user", content: "hi" }], signal: ac.signal });
  assert.equal(res2.error, "interrupted");
});

test("trimContext elides old tool results first and keeps the last exchange", () => {
  const big = "x".repeat(5000);
  const messages = [
    { role: "user", content: "task" },
    { role: "assistant", content: "<tool ...>" },
    { role: "user", content: `<tool_result name="read" ok="true">\n${big}\n</tool_result>` },
    { role: "assistant", content: "next" },
    { role: "user", content: `<tool_result name="read" ok="true">\n${big}\n</tool_result>` },
  ];
  trimContext(messages, 6000);
  assert.match(messages[2].content, /elided/);
  assert.ok(messages[4].content.includes(big));
});

test("definitions: frontmatter, Claude Code agents, priority and shadowing", () => {
  const cwd = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(cwd, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".claude", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep, Glob, WebFetch\nmodel: sonnet\n---\nYou review code.\n");
  const claude = findAgent("reviewer", { cwd, home });
  assert.deepEqual(claude.tools, ["read", "grep", "glob"]);
  assert.equal(claude.model, null, "Claude tiers inherit the session model");
  assert.equal(claude.source, "claude");

  saveAgent({ name: "reviewer", description: "Ours", tools: ["read"], model: "qwen2.5:7b", prompt: "Project reviewer." }, { scope: "project", cwd, home });
  saveAgent({ name: "explore", description: "My explore", tools: ["read", "grep"], prompt: "Mine." }, { scope: "user", cwd, home });
  const agents = loadAgents({ cwd, home });
  const reviewer = agents.find((a) => a.name === "reviewer");
  assert.equal(reviewer.source, "project");
  assert.deepEqual(reviewer.shadows, ["claude"]);
  assert.equal(reviewer.model, "qwen2.5:7b");
  assert.equal(agents.find((a) => a.name === "explore").source, "user");
  assert.ok(agents.some((a) => a.name === "general-purpose" && a.source === "built-in"));

  assert.throws(() => removeAgent("plan", { cwd, home }), /built in/);
  removeAgent("reviewer", { cwd, home });
  assert.equal(findAgent("reviewer", { cwd, home }).source, "claude");
  assert.throws(() => removeAgent("reviewer", { cwd, home }), /Claude Code/);
});

test("definitions: list-style tools, round trip, and invalid files are skipped", () => {
  const { data } = parseFrontmatter("---\nname: a\ntools:\n  - read\n  - bash\n---\nbody");
  assert.deepEqual(data.tools, ["read", "bash"]);
  const agent = { name: "t-1", description: "d", tools: ["read", "bash"], model: null, prompt: "P" };
  const back = parseAgentFile(renderAgentFile(agent), { source: "user" });
  assert.deepEqual([back.name, back.tools, back.prompt], ["t-1", ["read", "bash"], "P"]);
  assert.equal(parseAgentFile("---\nname: Bad Name\n---\nx"), null);
  assert.equal(parseAgentFile("---\nname: empty\n---\n"), null);
  assert.ok(!renderAgentFile({ ...agent, tools: ALL_TOOLS }).includes("tools:"), "all tools is the default, not written out");
});

test("config: env wins over the saved file, which is written 0600", () => {
  const home = tmp();
  const file = saveConfig({ apiKey: "ik_live_file", model: "qwen3:4b" }, { home });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(
    (({ apiKey, model }) => ({ apiKey, model }))(c0mputeConfig({ env: {}, home })),
    { apiKey: "ik_live_file", model: "qwen3:4b" },
  );
  assert.equal(c0mputeConfig({ env: { C0MPUTE_API_KEY: "ik_live_env" }, home }).apiKey, "ik_live_env");
});

test("routing: the names that mean the c0mpute agent, and CLI flags", () => {
  for (const n of ["c0mpute", "C0mpute", "c0", "compute"]) assert.ok(isC0mputeAgent(n));
  assert.ok(!isC0mputeAgent("claude"));
  assert.deepEqual(parseArgs(["-p", "fix", "it"]).print, "fix");
  assert.equal(parseArgs(["-p", "-m", "qwen3:4b"]).model, "qwen3:4b");
  assert.equal(parseArgs(["--dangerously-skip-permissions"]).mode, "yolo");
  assert.deepEqual(parseArgs(["agents", "show", "plan"]).manage, ["show", "plan"]);
  assert.equal(describeCall({ name: "task", input: { agent: "explore", prompt: "find x" } }), "Task(explore: find x)");
});
