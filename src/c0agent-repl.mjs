// The terminal surface of the c0mpute agent: `moshcode agents c0mpute`.
//
// Shaped after Claude Code on purpose, so nobody has to learn it:
//   >            type a task; the agent streams, tool calls print as ● Read(…)
//   /agents      list, create (generated or by hand), show, edit, remove subagents
//   @name task   run one subagent directly
//   shift-tab    cycle permission mode: ask → accept edits → plan → ask
//   esc / ^C     interrupt the running turn; ^C twice at an empty prompt exits
//   -p "task"    print mode: run once, answer on stdout, progress on stderr

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import {
  LEAD_AGENT, c0mputeConfig, compactConversation, configFile, createProvider, createSession,
  draftAgent, listModels, runAgent, saveConfig,
} from "./c0agent.mjs";
import {
  ALL_TOOLS, READ_ONLY_TOOLS, agentDirs, findAgent, loadAgents, normalizeTool, removeAgent, renderAgentFile, saveAgent, validName,
} from "./c0agent-defs.mjs";
import { acid, amber, ash, bone, danger, dim, err, info, ok, warn } from "./ui.mjs";

const MODES = ["ask", "auto-edit", "plan"];
const MODE_LABEL = {
  ask: "ask before edits and commands",
  "auto-edit": "accept edits on",
  plan: "plan mode (read-only)",
  yolo: "bypass permissions",
};

export const USAGE = `moshcode agents c0mpute [options] [prompt]

  a Claude-Code-style coding agent whose model runs on the c0mpute peer network

options:
  -p, --print <prompt>        run once and print the answer (stdin works too)
  -m, --model <name>          model for this session (default: ${"saved, else the best house model"})
  -a, --agent <name>          run as one of your agents instead of the lead agent
  -C, --cwd <dir>             work in <dir> instead of the current directory
  --permission-mode <mode>    ask | auto-edit | plan
  -y, --dangerously-skip-permissions   never ask (use in a container)
  agents [list|show|rm] <n>   manage agent definitions without opening a session

agents live in ./.moshcode/agents and ~/.moshcode/agents (markdown + frontmatter);
Claude Code's .claude/agents are picked up too. key: C0MPUTE_API_KEY or /key.`;

// ─── argument parsing ────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = { print: null, model: null, agent: null, mode: null, cwd: null, words: [], manage: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Everything after `--` is the prompt, even words that look like flags.
    if (a === "--") { opts.words.push(...argv.slice(i + 1)); break; }
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-p" || a === "--print") { opts.print = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : ""; }
    else if (a === "-m" || a === "--model") opts.model = argv[++i];
    else if (a === "-a" || a === "--agent") opts.agent = argv[++i];
    else if (a === "--permission-mode") opts.mode = argv[++i];
    else if (a === "-C" || a === "--cwd") opts.cwd = argv[++i];
    else if (a === "-y" || a === "--yes" || a === "--dangerously-skip-permissions") opts.mode = "yolo";
    // `agents …` as the first word (after any flags) manages definitions; later it's prompt text.
    else if (!opts.words.length && opts.print == null && (a === "agents" || a === "agent")) { opts.manage = argv.slice(i + 1); break; }
    else opts.words.push(a);
  }
  if (opts.print === "" && opts.words.length) opts.print = opts.words.join(" ");
  return opts;
}

// ─── rendering ───────────────────────────────────────────────────────────────

function toolsLabel(tools) {
  const t = tools.filter((x) => x !== "task");
  if (ALL_TOOLS.filter((x) => x !== "task").every((x) => t.includes(x))) return "all tools";
  if (t.length === READ_ONLY_TOOLS.length && READ_ONLY_TOOLS.every((x) => t.includes(x))) return "read-only";
  return t.join(", ");
}

export function renderAgentList(agents, write) {
  const groups = [
    ["project", "Project agents (.moshcode/agents)"],
    ["user", "Personal agents (~/.moshcode/agents)"],
    ["claude", "Claude Code agents (.claude/agents, read-only)"],
    ["built-in", "Built-in agents"],
  ];
  for (const [source, title] of groups) {
    const list = agents.filter((a) => a.source === source);
    if (!list.length) continue;
    write(bone(title));
    for (const a of list) {
      const shadow = a.shadows.length ? ash(` (overrides ${a.shadows.join(", ")})`) : "";
      write(`  ${acid(a.name)}${shadow} ${ash("·")} ${dim(toolsLabel(a.tools))}${a.model ? ` ${ash("·")} ${dim(a.model)}` : ""}`);
      write(`    ${ash(a.description.length > 110 ? `${a.description.slice(0, 107)}…` : a.description)}`);
    }
    write("");
  }
  write(ash(`/agents new · /agents show <name> · /agents edit <name> · /agents rm <name> · @<name> <task>`));
}

function renderTodos(todos, write) {
  for (const t of todos) {
    const box = t.status === "done" ? acid("☒") : t.status === "in_progress" ? amber("◐") : ash("☐");
    write(`  ${box} ${t.status === "done" ? dim(t.text) : t.text}`);
  }
}

/** A spinner on one line of stderr that steps aside whenever real output prints. */
function createSpinner(stream = process.stderr) {
  const frames = ["✻", "✳", "✢", "·", "✢", "✳"];
  let timer = null;
  let label = "";
  let started = 0;
  let i = 0;
  const tty = stream.isTTY;
  const draw = () => {
    if (!tty) return;
    const secs = Math.round((Date.now() - started) / 1000);
    stream.write(`\r\x1b[2K${acid(frames[i++ % frames.length])} ${label} ${ash(`(${secs}s · esc to interrupt)`)}`);
  };
  return {
    start(text) {
      label = text;
      if (timer) return;
      started = Date.now();
      draw();
      timer = setInterval(draw, 120);
    },
    label(text) { label = text; },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      if (tty) stream.write("\r\x1b[2K");
    },
    get active() { return Boolean(timer); },
  };
}

/** "anthony@profullstack-dev-vienna:e98c6ec2" -> "profullstack-dev-vienna". */
export function shortNode(name) {
  if (!name) return "a node";
  return String(name).replace(/^[^@\s]+@/, "").replace(/:[0-9a-f]{6,}$/i, "");
}

const kTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * The spinner label for one c0mpute job status. `job` carries what earlier
 * statuses said (node, when writing began) so a later one can use it.
 */
export function statusLabel(status, job, { promptTokens = 0, agent = null, now = Date.now() } = {}) {
  const who = agent ? `${agent} · ` : "";
  const node = shortNode(job.node);
  switch (status.stage) {
    case "queued":
      // The node only reports in with its first token, so this covers its
      // queue AND it reading the prompt (minutes on a CPU node).
      return `${who}${node} has the job · waiting for the first token (queue + reading ~${kTokens(promptTokens)} prompt tokens)`;
    case "started":
      return `${who}${node} is reading the prompt (~${kTokens(promptTokens)} tokens; a CPU node can take minutes)`;
    case "writing": {
      const secs = (now - (job.writingSince ?? now)) / 1000;
      const rate = secs >= 2 ? ` · ${(status.tokens / secs).toFixed(1)} tok/s` : "";
      return `${who}${node} writing · ${status.tokens} token${status.tokens === 1 ? "" : "s"}${rate}`;
    }
    case "retry":
      return `${who}${status.model ?? "model"} unavailable (${status.reason}); trying the next model`;
    default:
      return null;
  }
}

/** The event sink shared by the REPL and print mode. */
function createRenderer({ out, log, spinner, quiet = false }) {
  let atLineStart = true;
  let wroteText = false;
  const line = (s) => { spinner.stop(); if (!atLineStart) { out("\n"); atLineStart = true; } log(s); };
  const jobs = new Map(); // agent@depth -> {node, writingSince}
  return {
    reset() { wroteText = false; },
    get wroteText() { return wroteText; },
    finish() { spinner.stop(); if (!atLineStart) { out("\n"); atLineStart = true; } },
    event(e) {
      if (e.type === "waiting") {
        jobs.set(`${e.agent}@${e.depth}`, {});
        const size = e.promptTokens ? ` (~${kTokens(e.promptTokens)} token prompt)` : "";
        spinner.start(e.depth ? `${e.agent} · sending to c0mpute…` : `Sending to c0mpute${size}…`);
        return;
      }
      if (e.type === "status") {
        const key = `${e.agent}@${e.depth}`;
        const job = jobs.get(key) ?? {};
        jobs.set(key, job);
        const s = e.status;
        if (s.node) job.node = s.node;
        if (s.stage === "writing" && job.writingSince == null) job.writingSince = Date.now();
        const label = statusLabel(s, job, { promptTokens: e.promptTokens, agent: e.depth ? e.agent : null });
        if (!label) return;
        // Text is mid-line on stdout: a spinner redraw would wipe it.
        if (!spinner.active && !atLineStart) return;
        if (spinner.active) spinner.label(label); else spinner.start(label);
        return;
      }
      if (e.type === "thinking" && !e.depth) { spinner.label("Thinking…"); return; }
      if (e.type === "text") {
        if (e.depth || quiet) return;
        let t = e.text;
        if (!wroteText) t = t.replace(/^\s+/, "");
        if (!t) return;
        spinner.stop();
        if (!wroteText) { out(`${acid("●")} `); }
        wroteText = true;
        out(t);
        atLineStart = t.endsWith("\n");
        return;
      }
      if (e.type === "turn_end") { if (!e.depth && wroteText && !atLineStart) { out("\n"); atLineStart = true; } wroteText = false; return; }
      if (e.type === "tool_start") {
        if (e.depth) line(`  ${ash("⎿")}  ${dim(`[${e.agent}]`)} ${dim(e.title)}`);
        else line(`${acid("●")} ${bone(e.title)}`);
        return;
      }
      if (e.type === "tool_end") {
        const r = e.result;
        if (e.depth && r.ok) return;
        const first = String(r.output ?? "").split("\n")[0];
        const pad = e.depth ? "     " : "  ";
        if (!r.ok) line(`${pad}${ash("⎿")}  ${danger(first.length > 140 ? `${first.slice(0, 137)}…` : first)}`);
        else if (e.call.name === "task") line(`${pad}${ash("⎿")}  ${ok(`Done (${r.summary})`)}`);
        else line(`${pad}${ash("⎿")}  ${ash(r.summary || first)}`);
        return;
      }
      if (e.type === "todo" && !e.depth) { spinner.stop(); renderTodos(e.todos, log); return; }
      if (e.type === "error") line(err(`${e.depth ? `[${e.agent}] ` : ""}${e.error}`));
    },
  };
}

// ─── management (no session needed) ──────────────────────────────────────────

export function manageAgents(args, { write = (l) => console.log(l), cwd = process.cwd() } = {}) {
  const [verb = "list", name] = args;
  if (verb === "list" || verb === "ls") { renderAgentList(loadAgents({ cwd }), write); return 0; }
  if (verb === "show" || verb === "cat") {
    const a = findAgent(name, { cwd });
    if (!a) { write(err(`no agent named "${name}"`)); return 1; }
    write(ash(a.file || `${a.source} agent`));
    write(renderAgentFile(a));
    return 0;
  }
  if (verb === "rm" || verb === "remove" || verb === "delete") {
    try { const a = removeAgent(name, { cwd }); write(ok(`removed ${a.name} (${a.file})`)); return 0; }
    catch (e) { write(err(e.message)); return 1; }
  }
  if (verb === "dirs" || verb === "where") {
    for (const d of agentDirs({ cwd })) write(`${pad8(d.source)} ${d.dir}${d.writable ? "" : ash("  (read-only)")}`);
    return 0;
  }
  write(err(`unknown: agents ${verb}. try list, show <name>, rm <name>, dirs — or /agents new inside a session`));
  return 1;
}

const pad8 = (s) => s.padEnd(8);

// ─── print mode ──────────────────────────────────────────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function runPrint(prompt, { cfg, opts }) {
  const provider = await createProvider(cfg);
  const mode = opts.mode || "ask";
  const session = createSession({
    provider, model: cfg.model, permissionMode: mode, cwd: opts.cwd || process.cwd(),
    // Nobody to ask: refuse, and say how to allow it.
    ask: async () => "no — print mode cannot ask; rerun with --dangerously-skip-permissions or --permission-mode auto-edit",
  });
  const lead = opts.agent ? findAgent(opts.agent, { cwd: session.cwd }) : LEAD_AGENT;
  if (!lead) { console.error(`no agent named "${opts.agent}"`); return 1; }
  const spinner = createSpinner();
  const r = createRenderer({ out: () => {}, log: (l) => process.stderr.write(`${l}\n`), spinner, quiet: true });
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const res = await runAgent({ session, agent: lead, messages: [{ role: "user", content: prompt }], signal: controller.signal, onEvent: (e) => r.event(e) });
  r.finish();
  if (res.text) process.stdout.write(`${res.text}\n`);
  if (res.error) { process.stderr.write(`${res.error}\n`); return 1; }
  return 0;
}

// ─── the REPL ────────────────────────────────────────────────────────────────

const HISTORY = () => path.join(os.homedir(), ".moshcode", "c0mpute_history");

function loadHistory() {
  try { return fs.readFileSync(HISTORY(), "utf8").split("\n").filter(Boolean).reverse().slice(0, 500); } catch { return []; }
}

function appendHistory(line) {
  try { fs.mkdirSync(path.dirname(HISTORY()), { recursive: true }); fs.appendFileSync(HISTORY(), `${line.replace(/\n/g, " ")}\n`); } catch { /* best effort */ }
}

const HELP = [
  ["/agents", "list agents · new · show <n> · edit <n> · rm <n> · run <n> <task>"],
  ["@<agent> <task>", "run one subagent directly"],
  ["/model [name]", "show or switch the model (saved)"],
  ["/models", "models c0mpute serves right now"],
  ["/permissions [mode]", "ask · auto-edit · plan (shift-tab cycles)"],
  ["/todos", "the current checklist"],
  ["/compact", "summarize the conversation to free context"],
  ["/clear", "start a fresh conversation"],
  ["/cost", "calls and estimated tokens this session"],
  ["/key [ik_live_…]", "save a c0mpute key (or show where it comes from)"],
  ["/cwd [dir]", "show or change the working directory"],
  ["/exit", "leave (also ^D)"],
];

export async function c0agentMain(argv = [], { write = (l) => console.log(l) } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) { write(USAGE); return 0; }
  if (opts.manage) return manageAgents(opts.manage, { write, cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd() });
  const saved = c0mputeConfig();
  const cfg = { ...saved, model: opts.model || saved.model };
  if (opts.cwd) {
    const dir = path.resolve(opts.cwd);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { write(err(`not a directory: ${dir}`)); return 1; }
    opts.cwd = dir;
  }
  if (opts.mode && !["ask", "auto-edit", "plan", "yolo"].includes(opts.mode)) { write(err(`unknown permission mode "${opts.mode}"`)); return 1; }

  if (opts.print != null || !process.stdin.isTTY) {
    const prompt = opts.print || opts.words.join(" ") || (!process.stdin.isTTY ? await readStdin() : "");
    if (!prompt) { write(err("nothing to do: pass a prompt with -p")); return 1; }
    return runPrint(prompt, { cfg, opts });
  }
  return repl({ cfg, opts, write });
}

async function repl({ cfg, opts, write }) {
  const provider = await createProvider(cfg);
  let busy = null; // AbortController of the running turn
  const spinner = createSpinner();
  const out = (s) => process.stdout.write(s);
  const log = (s) => process.stdout.write(`${s}\n`);
  const renderer = createRenderer({ out, log, spinner });

  readline.emitKeypressEvents(process.stdin);
  // Registered before readline's own listener, so shift-tab can tell the
  // completer (which readline also runs for shift-tab) to stand down.
  let shiftTab = false;
  const onKey = (_s, key) => {
    if (!key) return;
    if (key.name === "escape" && busy) { busy.abort(); return; }
    if (key.name === "tab" && key.shift) {
      shiftTab = true;
      if (busy) return;
      const i = MODES.indexOf(session.permissionMode);
      session.permissionMode = MODES[(i + 1) % MODES.length];
      setImmediate(() => { process.stdout.write("\r\x1b[2K"); prompt(); rl.write(null, { ctrl: true, name: "e" }); });
    }
  };
  process.stdin.prependListener("keypress", onKey);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history: loadHistory(),
    historySize: 500,
    terminal: true,
    completer: (line) => {
      if (shiftTab) { shiftTab = false; return [[], line]; }
      const words = ["/agents", "/model", "/models", "/permissions", "/todos", "/compact", "/clear", "/cost", "/key", "/cwd", "/exit", "/help",
        ...loadAgents({ cwd: session.cwd }).map((a) => `@${a.name}`)];
      const last = line.split(/\s+/).pop();
      const hits = words.filter((w) => w.startsWith(last));
      return [hits.length ? hits : [], last];
    },
  });

  // One question at a time: parallel subagents can each want permission.
  let asking = Promise.resolve();
  const question = (q) => new Promise((resolve) => rl.question(q, resolve));
  const askPermission = (req) => {
    const p = asking.then(async () => {
      spinner.stop();
      log("");
      log(`${amber("●")} ${bone(req.agent && req.agent !== "c0mpute" ? `[${req.agent}] ${req.title}` : req.title)}`);
      for (const l of String(req.preview).split("\n").slice(0, 24)) {
        log(`  ${l.startsWith("+ ") ? acid(l) : l.startsWith("- ") ? danger(l) : dim(l)}`);
      }
      const a = (await question(`  ${bone("Allow?")} ${ash("[y]es · [a]lways for this session · [n]o, or type what to do instead")} `)).trim();
      if (/^(y|yes)$/i.test(a) || a === "") return "yes";
      if (/^(a|always)$/i.test(a)) return "always";
      if (/^(n|no)$/i.test(a)) return "no";
      return a;
    });
    asking = p.catch(() => {});
    return p;
  };

  const session = createSession({ provider, model: cfg.model, cwd: opts.cwd || process.cwd(), permissionMode: opts.mode || cfg.permissionMode || "ask", ask: askPermission });
  const lead = opts.agent ? findAgent(opts.agent, { cwd: session.cwd }) : LEAD_AGENT;
  if (!lead) { write(err(`no agent named "${opts.agent}"`)); rl.close(); return 1; }
  let messages = [];

  const prompt = () => {
    const mode = session.permissionMode === "ask" ? "" : `${amber(`⏵⏵ ${MODE_LABEL[session.permissionMode]}`)} `;
    rl.setPrompt(`${mode}${acid(">")} `);
    rl.prompt(true);
  };
  let lastInt = 0;
  rl.on("SIGINT", () => {
    if (busy) { busy.abort(); return; }
    if (rl.line) { rl.write(null, { ctrl: true, name: "u" }); return; }
    if (Date.now() - lastInt < 1500) { rl.close(); return; }
    lastInt = Date.now();
    log(ash("\n(press ^C again to exit)"));
    prompt();
  });

  // Banner.
  log("");
  log(`${acid("✻")} ${bone("c0mpute agent")} ${ash("— moshcode")}`);
  log(`  ${ash("model")} ${cfg.model}   ${ash("cwd")} ${session.cwd}`);
  log(`  ${ash("key")}   ${cfg.apiKey ? `${cfg.apiKey.slice(0, 8)}… ${ash(`(${cfg.keySource})`)}` : amber("none: free tier, 10 prompts a day — /key ik_live_… to add one")}`);
  log(`  ${ash("prompts and tool output go to the peer node that takes each job; keep secrets out")}`);
  if (session.permissionMode === "yolo") log(`  ${warn("permissions bypassed: every edit and command runs without asking")}`);
  log(`  ${ash("/help for commands · /agents for subagents · @agent to run one")}`);
  log("");

  const runTurn = async (agent, content, { asSub = false } = {}) => {
    busy = new AbortController();
    renderer.reset();
    const started = Date.now();
    let res;
    try {
      if (asSub) {
        res = await runAgent({ session, agent, messages: [{ role: "user", content }], depth: 1, signal: busy.signal, onEvent: (e) => renderer.event(e) });
        renderer.finish();
        if (res.text) { log(`${acid("●")} ${bone(`[${agent.name}]`)}`); log(res.text); }
      } else {
        messages.push({ role: "user", content });
        res = await runAgent({ session, agent, messages, signal: busy.signal, onEvent: (e) => renderer.event(e) });
        renderer.finish();
      }
    } finally {
      busy = null;
      spinner.stop();
    }
    if (res?.error === "interrupted") log(amber("  ⎿ interrupted · what should c0mpute do instead?"));
    else if (res?.error && res.error !== "step limit") log(err(res.error));
    log(ash(`  ${Math.round((Date.now() - started) / 1000)}s`));
  };

  const commands = {
    help: () => { for (const [c, d] of HELP) log(`  ${acid(c.padEnd(22))} ${ash(d)}`); },
    clear: () => { messages = []; session.todos = []; log(ok("new conversation")); },
    cost: () => log(`  ${session.usage.calls} model calls · ~${session.usage.inputTokens.toLocaleString()} in / ~${session.usage.outputTokens.toLocaleString()} out tokens ${ash("(estimated)")}`),
    todos: () => (session.todos.length ? renderTodos(session.todos, log) : log(ash("  no todos"))),
    cwd: (args) => {
      if (!args[0]) { log(`  ${session.cwd}`); return; }
      const dir = path.resolve(session.cwd, args[0].replace(/^~(?=\/|$)/, os.homedir()));
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { log(err(`not a directory: ${dir}`)); return; }
      session.cwd = dir;
      log(ok(dir));
    },
    permissions: (args) => {
      if (!args[0]) { log(`  ${MODE_LABEL[session.permissionMode]} ${ash(`(${session.permissionMode})`)}`); return; }
      if (!["ask", "auto-edit", "plan", "yolo"].includes(args[0])) { log(err("modes: ask, auto-edit, plan, yolo")); return; }
      session.permissionMode = args[0];
      log(ok(MODE_LABEL[args[0]]));
    },
    model: (args) => {
      if (!args[0]) { log(`  ${session.model}`); return; }
      session.model = args[0];
      saveConfig({ model: args[0] });
      log(ok(`model ${args[0]} ${ash("(saved)")}`));
    },
    models: async () => {
      const ids = await listModels();
      for (const id of ids) log(`  ${id === session.model ? acid("●") : " "} ${id}`);
    },
    key: (args) => {
      if (!args[0]) {
        const c = c0mputeConfig();
        log(c.apiKey ? `  ${c.apiKey.slice(0, 8)}… from ${c.keySource}` : `  ${amber("no key")} ${ash("— free tier, 10 prompts a day. get an ik_live_ key at infernetprotocol.com, then /key <it>")}`);
        return;
      }
      if (!/^(ik_live_|c0k_|ifc_)/.test(args[0])) log(warn("that doesn't look like a c0mpute key (ik_live_…); saving it anyway"));
      const file = saveConfig({ apiKey: args[0] });
      log(ok(`saved to ${file} (0600) — takes effect next session`));
    },
    compact: async () => {
      if (!messages.length) { log(ash("  nothing to compact")); return; }
      busy = new AbortController();
      spinner.start("Compacting…");
      try { const s = await compactConversation(session, messages, { signal: busy.signal }); spinner.stop(); log(ok("compacted")); log(dim(s)); }
      catch (e) { spinner.stop(); log(err(String(e.message || e))); }
      finally { busy = null; }
    },
    agents: (args) => agentsCommand(args),
  };

  async function agentsCommand(args) {
    const [verb, ...rest] = args;
    if (!verb || verb === "list") { renderAgentList(loadAgents({ cwd: session.cwd }), log); return; }
    if (verb === "show" || verb === "rm" || verb === "dirs" || verb === "remove") {
      if (verb === "rm" || verb === "remove") {
        const a = findAgent(rest[0], { cwd: session.cwd });
        if (a && a.source !== "built-in" && a.source !== "claude") {
          const yes = (await question(`  remove ${a.name} (${a.file})? [y/N] `)).trim();
          if (!/^y/i.test(yes)) return;
        }
      }
      manageAgents([verb, ...rest], { write: log, cwd: session.cwd });
      return;
    }
    if (verb === "run") {
      const a = findAgent(rest[0], { cwd: session.cwd });
      if (!a) { log(err(`no agent named "${rest[0]}"`)); return; }
      if (!rest.slice(1).join(" ").trim()) { log(err("usage: /agents run <name> <task>")); return; }
      await runTurn(a, rest.slice(1).join(" "), { asSub: true });
      return;
    }
    if (verb === "edit") {
      let a = findAgent(rest[0], { cwd: session.cwd });
      if (!a) { log(err(`no agent named "${rest[0]}"`)); return; }
      if (a.source === "built-in" || a.source === "claude") {
        const file = saveAgent(a, { scope: "project", cwd: session.cwd });
        log(info(`copied ${a.name} to ${file} so your edits override the ${a.source} one`));
        a = { ...a, file };
      }
      editFile(a.file);
      const after = findAgent(a.name, { cwd: session.cwd });
      log(after ? ok(`${after.name} saved`) : warn("the file no longer parses as an agent (needs name + a prompt body)"));
      return;
    }
    if (verb === "new" || verb === "create") { await newAgentWizard(rest); return; }
    log(err(`unknown: /agents ${verb}. try /agents, new, show, edit, rm, run`));
  }

  function editFile(file) {
    const editor = process.env.VISUAL || process.env.EDITOR || "nano";
    rl.pause();
    spawnSync(editor, [file], { stdio: "inherit", shell: true });
    rl.resume();
  }

  async function newAgentWizard(rest) {
    const manual = rest.includes("--manual");
    let name = rest.find((r) => !r.startsWith("-"));
    log(bone("Create a new agent"));
    const where = (await question(`  ${ash("save to")} [p]roject ${ash("(.moshcode/agents)")} or [u]ser ${ash("(~/.moshcode/agents)")}? [p] `)).trim();
    const scope = /^u/i.test(where) ? "user" : "project";
    const description = (await question(`  ${ash("what should it do, and when should it be used?")}\n  ${acid(">")} `)).trim();
    if (!description) { log(ash("  cancelled")); return; }
    let agent;
    if (!manual) {
      const gen = (await question(`  generate the definition with c0mpute? [Y/n] `)).trim();
      if (!/^n/i.test(gen)) {
        busy = new AbortController();
        spinner.start("Drafting the agent…");
        try { agent = await draftAgent(session, description, { signal: busy.signal }); }
        catch (e) { spinner.stop(); log(warn(`${e.message || e} — switching to manual`)); }
        finally { spinner.stop(); busy = null; }
        if (agent && name) agent.name = name;
      }
    }
    if (!agent) {
      while (!validName(name)) {
        name = (await question(`  ${ash("name (lowercase, dashes)")}: `)).trim().toLowerCase();
        if (!name) { log(ash("  cancelled")); return; }
        if (!validName(name)) log(err("use a-z, 0-9 and dashes"));
      }
      const t = (await question(`  tools: [a]ll · [r]ead-only · or a list like read, grep, bash [a] `)).trim();
      const tools = /^r/i.test(t) ? READ_ONLY_TOOLS
        : !t || /^a/i.test(t) ? ALL_TOOLS.filter((x) => x !== "task")
        : [...new Set(t.split(/[,\s]+/).map(normalizeTool).filter((x) => x && x !== "task"))];
      const promptText = (await question(`  ${ash("system prompt (one line, or blank for a starter you can /agents edit)")}:\n  ${acid(">")} `)).trim();
      agent = { name, description, tools, model: null, prompt: promptText || `You are ${name}. ${description}` };
    }
    const m = (await question(`  model ${ash(`(enter to inherit ${session.model})`)}: `)).trim();
    if (m) agent.model = m;
    log("");
    for (const l of renderAgentFile(agent).split("\n")) log(`  ${dim(l)}`);
    const exists = findAgent(agent.name, { cwd: session.cwd });
    if (exists && exists.source === scope) log(warn(`this replaces ${exists.file}`));
    const go = (await question(`  save? [Y]es · [e]dit in $EDITOR first · [n]o `)).trim();
    if (/^n/i.test(go)) { log(ash("  not saved")); return; }
    const file = saveAgent(agent, { scope, cwd: session.cwd });
    if (/^e/i.test(go)) editFile(file);
    const saved = findAgent(agent.name, { cwd: session.cwd });
    log(ok(`${agent.name} saved to ${file}`));
    if (saved) log(ash(`  the lead agent can now delegate to it; or run it yourself: @${saved.name} <task>`));
  }

  // A prompt given on the command line is the first turn, the way
  // `claude "<prompt>"` starts: interactive, with that already submitted.
  // `moshcode handoff <engine> c0mpute` opens the session this way.
  const initial = opts.words.join(" ").trim();
  if (initial) {
    const firstLine = initial.split("\n")[0];
    log(`${acid(">")} ${firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine}${initial.includes("\n") ? ash(` (+${initial.split("\n").length - 1} lines)`) : ""}`);
    try { await runTurn(lead, initial); } catch (e) { spinner.stop(); log(err(String(e?.stack || e))); }
    log("");
  }

  // The loop.
  prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) { prompt(); continue; }
    appendHistory(line);
    try {
      if (line.startsWith("/")) {
        const [c, ...args] = line.slice(1).split(/\s+/);
        if (c === "exit" || c === "quit" || c === "q") break;
        const fn = commands[c.toLowerCase()];
        if (fn) await fn(args);
        else log(err(`unknown command /${c} — /help`));
      } else if (line.startsWith("@")) {
        const m = line.match(/^@([a-z0-9-]+)\s*([\s\S]*)$/i);
        const a = m && findAgent(m[1], { cwd: session.cwd });
        if (!a) log(err(`no agent named "${m?.[1] ?? line}" — /agents to list them`));
        else if (!m[2].trim()) log(err(`usage: @${a.name} <task>`));
        else await runTurn(a, m[2].trim(), { asSub: true });
      } else {
        await runTurn(lead, line);
      }
    } catch (e) {
      spinner.stop();
      log(err(String(e?.stack || e)));
    }
    log("");
    prompt();
  }
  spinner.stop();
  process.stdin.off("keypress", onKey);
  rl.close();
  log(ash("bye 🤘"));
  return 0;
}

export { configFile };
