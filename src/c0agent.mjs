// The c0mpute agent: a Claude-Code-style coding agent whose model runs on the
// c0mpute peer network (`moshcode agents c0mpute`).
//
// Every other engine moshcode drives is somebody else's CLI. c0mpute has no
// coding CLI, only inference, so this file is the harness: the loop that sends
// the conversation to a node, runs the tools the model asks for on THIS
// machine, feeds the results back, and stops when the model answers without
// asking for anything. Subagents (`task`) are the same loop with a fresh
// conversation, their own system prompt and a narrower tool list.
//
// Why tools are a text protocol and not the API's `tools` field: Infernet's
// chat endpoint takes string content and ignores `tools`, and the house
// models are 2B-9B. So the model writes
//
//     <tool name="read">{"path": "src/a.js"}</tool>
//
// and we parse it, leniently: attributes instead of JSON, a bare string where
// the tool has one obvious argument, or a fenced ```json {"tool": …}``` block
// all work, because a small model gets the shape slightly wrong more often
// than it gets it exactly right.
//
// Privacy: prompts and tool output go to whichever peer node takes the job.
// The REPL says so on start; do not point this at secrets.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ALL_TOOLS, BUILTIN_AGENTS, loadAgents, normalizeTool } from "./c0agent-defs.mjs";

// ─── config ──────────────────────────────────────────────────────────────────

export const DEFAULT_BASE_URL = "https://infernetprotocol.com";
/** The house models, best first. Every Infernet node pulls these. */
export const HOUSE_MODELS = [
  "huihui_ai/qwen3.5-abliterated:9b",
  "qwen2.5:7b",
  "qwen3:4b",
  "gemma3:4b",
];

const nonEmpty = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function configFile(home = os.homedir()) {
  return path.join(home, ".moshcode", "c0mpute.json");
}

function readConfigFile(home) {
  try { return JSON.parse(fs.readFileSync(configFile(home), "utf8")) || {}; } catch { return {}; }
}

/** Effective config: env over ~/.moshcode/c0mpute.json over defaults. */
export function c0mputeConfig({ env = process.env, home = os.homedir() } = {}) {
  const file = readConfigFile(home);
  return {
    apiKey: nonEmpty(env.C0MPUTE_API_KEY) || nonEmpty(file.apiKey),
    keySource: nonEmpty(env.C0MPUTE_API_KEY) ? "C0MPUTE_API_KEY" : nonEmpty(file.apiKey) ? configFile(home) : null,
    baseUrl: (nonEmpty(env.C0MPUTE_URL) || nonEmpty(file.baseUrl) || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: nonEmpty(env.C0MPUTE_MODEL) || nonEmpty(file.model) || HOUSE_MODELS[0],
    permissionMode: "ask",
  };
}

/** Merge `patch` into ~/.moshcode/c0mpute.json (0600: it can hold a key). */
export function saveConfig(patch, { home = os.homedir() } = {}) {
  const file = configFile(home);
  const next = { ...readConfigFile(home), ...patch };
  for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* not ours to fix */ }
  return file;
}

/** The provider every session talks to. Lazy, so tests never load it. */
export async function createProvider(cfg) {
  const { C0mputeProvider } = await import("@profullstack/ai-providers");
  const models = [...new Set([cfg.model, ...HOUSE_MODELS])];
  return new C0mputeProvider({
    apiKey: cfg.apiKey || undefined,
    baseUrl: cfg.baseUrl,
    models,
    concurrency: 4, // parallel subagents
    timeoutMs: 600_000,
    stallMs: 120_000,
  });
}

/** The models c0mpute.com lists right now, or the house list when it won't say. */
export async function listModels({ fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl("https://c0mpute.com/api/v1/models", { signal: AbortSignal.timeout(8000) });
    const body = await res.json();
    const ids = (body?.data || []).map((m) => m.id).filter(Boolean);
    if (ids.length) return ids;
  } catch { /* fall through */ }
  return [...HOUSE_MODELS];
}

// ─── protocol ────────────────────────────────────────────────────────────────

/** The argument a bare (non-JSON) tool body means, per tool. */
const PRIMARY_ARG = { read: "path", write: "path", ls: "path", bash: "command", glob: "pattern", grep: "pattern", task: "prompt" };

/** Drop a reasoning model's visible thinking, closed or cut off. */
export function stripThink(text) {
  return String(text ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "");
}

function parseAttrs(s) {
  const out = {};
  for (const m of String(s).matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

/** Parse a JSON object, forgiving the slips small models make. */
export function looseJson(text) {
  const t = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  if (!t.startsWith("{")) return null;
  // The first balanced object: a stray "}}" or trailing prose after it is not ours.
  const first = balancedObject(t);
  for (const candidate of [t, first, first?.replace(/,\s*([}\]])/g, "$1")]) {
    if (!candidate) continue;
    try { const v = JSON.parse(candidate); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { /* next */ }
  }
  return null;
}

/** The text of the first brace-balanced object in `t` (strings respected), or null. */
function balancedObject(t) {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return t.slice(0, i + 1);
  }
  return null;
}

/**
 * Tool blocks as `{ attrs, body }`. A block ends at its </tool>, or, when the
 * model forgot to close it, at the next <tool or the end of the reply.
 */
function toolBlocks(src) {
  const blocks = [];
  const opens = [...src.matchAll(/<tool\b([^>]*?)(\/?)>/gi)];
  for (let k = 0; k < opens.length; k++) {
    const m = opens[k];
    if (m[2]) { blocks.push({ attrs: m[1], body: "" }); continue; }
    const start = m.index + m[0].length;
    const nextOpen = k + 1 < opens.length ? opens[k + 1].index : src.length;
    const rest = src.slice(start, nextOpen);
    const close = rest.search(/<\/tool\s*>/i);
    blocks.push({ attrs: m[1], body: close >= 0 ? rest.slice(0, close) : rest });
  }
  return blocks;
}

/**
 * Every tool call in one assistant message, in order. Anything the model
 * wrote after a `<tool_result` is its own invention of an answer it has not
 * been given yet, so parsing stops there.
 */
export function parseToolCalls(text) {
  let src = stripThink(text);
  const fake = src.search(/<tool_result\b/i);
  if (fake >= 0) src = src.slice(0, fake);
  const calls = [];
  for (const block of toolBlocks(src)) {
    const attrs = parseAttrs(block.attrs);
    const name = normalizeTool(attrs.name);
    if (!name) { calls.push({ name: attrs.name || "?", input: {}, error: `unknown tool "${attrs.name}"` }); continue; }
    delete attrs.name;
    const body = block.body.trim();
    let input = looseJson(body);
    if (!input) {
      input = { ...attrs };
      if (body && PRIMARY_ARG[name] && input[PRIMARY_ARG[name]] == null) input[PRIMARY_ARG[name]] = body;
      if (body && name === "write" && input.content == null && attrs.path) input.content = body;
    } else {
      input = { ...attrs, ...input };
    }
    calls.push({ name, input });
  }
  if (calls.length) return calls;
  // Fallback: a fenced JSON block that names a tool.
  for (const m of src.matchAll(/```(?:json|tool)?\s*(\{[\s\S]*?\})\s*```/gi)) {
    const obj = looseJson(m[1]);
    const name = normalizeTool(obj?.tool ?? obj?.name);
    if (!name) continue;
    const input = obj.input ?? obj.args ?? obj.arguments ?? obj.parameters
      ?? Object.fromEntries(Object.entries(obj).filter(([k]) => k !== "tool" && k !== "name"));
    calls.push({ name, input: typeof input === "object" && input ? input : {} });
  }
  if (calls.length) return calls;
  // Last resort: the whole reply is just the arguments of one tool.
  const bare = looseJson(src.trim());
  const inferred = bare && inferTool(bare);
  return inferred ? [{ name: inferred, input: bare }] : [];
}

/** Which tool a bare arguments object belongs to, when its keys say so unambiguously. */
export function inferTool(args) {
  const k = new Set(Object.keys(args));
  if (k.has("command")) return "bash";
  if (k.has("path") && (k.has("old") || k.has("old_string"))) return "edit";
  if (k.has("path") && k.has("content")) return "write";
  if (k.has("agent") && k.has("prompt")) return "task";
  if (k.has("items")) return "todo";
  if (k.has("pattern") && /[*?]/.test(String(args.pattern)) && !k.has("glob")) return "glob";
  if (k.has("pattern")) return "grep";
  if (k.has("path") && k.size <= 3) return "read";
  return null;
}

/** What the user sees of a reply: no thinking, no tool calls. */
export function visibleText(text) {
  let src = stripThink(text);
  const fake = src.search(/<tool_result\b/i);
  if (fake >= 0) src = src.slice(0, fake);
  return src.replace(/<tool\b[^>]*?(\/>|>[\s\S]*?(<\/tool\s*>|(?=<tool\b)|$))/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A streaming filter: feed it tokens, it calls `emit` with the text that is
 * not inside <think>, <tool> or <tool_result>. Holds back a possible partial
 * tag at the end of a chunk until the next one decides it.
 */
export function createStreamFilter(emit, { onThinking = () => {} } = {}) {
  let pending = "";
  let inside = null; // "think" | "tool" | "tool_result"
  const open = /<(think|tool_result|tool)\b/i;
  const pump = () => {
    for (;;) {
      if (!inside) {
        const m = pending.match(open);
        if (m) {
          if (m.index) emit(pending.slice(0, m.index));
          inside = m[1].toLowerCase();
          if (inside === "think") onThinking();
          pending = pending.slice(m.index);
          continue;
        }
        const lt = pending.lastIndexOf("<");
        const keep = lt >= 0 && pending.length - lt < 14 ? pending.length - lt : 0;
        if (pending.length - keep) emit(pending.slice(0, pending.length - keep));
        pending = pending.slice(pending.length - keep);
        return;
      }
      const close = new RegExp(`</${inside}\\s*>`, "i");
      const c = pending.match(close);
      const selfClose = inside === "tool" ? pending.match(/^<tool\b[^>]*\/>/i) : null;
      if (selfClose) { pending = pending.slice(selfClose[0].length); inside = null; continue; }
      if (!c) return;
      pending = pending.slice(c.index + c[0].length);
      inside = null;
    }
  };
  return {
    push(chunk) { pending += chunk; pump(); },
    end() { if (!inside && pending) emit(pending); pending = ""; inside = null; },
  };
}

// ─── tools ───────────────────────────────────────────────────────────────────

const TOOL_CHARS = () => Number(process.env.C0AGENT_TOOL_CHARS) > 0 ? Number(process.env.C0AGENT_TOOL_CHARS) : 8000;

function cap(text, max = TOOL_CHARS()) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n… [${s.length - max} more characters cut; narrow the request]`;
}

function resolvePath(session, p) {
  if (!p || typeof p !== "string") throw new Error("path is required");
  const expanded = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
  return path.resolve(session.cwd, expanded);
}

const rel = (session, abs) => {
  const r = path.relative(session.cwd, abs);
  return r && !r.startsWith("..") ? r : abs;
};

/** One-line rendering of a call, the way Claude Code prints `Read(src/a.js)`. */
export function describeCall({ name, input = {} }) {
  const arg = {
    read: input.path, write: input.path, edit: input.path, ls: input.path || ".",
    bash: input.command, glob: input.pattern, grep: input.pattern && `${input.pattern}${input.path ? ` in ${input.path}` : ""}`,
    task: input.agent && `${input.agent}: ${input.description || input.prompt || ""}`,
    todo: Array.isArray(input.items) ? `${input.items.length} items` : "",
  }[name];
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  const one = String(arg ?? "").replace(/\s+/g, " ").trim();
  return `${label}(${one.length > 90 ? `${one.slice(0, 87)}…` : one})`;
}

/** Shell commands that only look, never change. Run without asking. */
export function isReadOnlyCommand(cmd) {
  const c = String(cmd ?? "").trim();
  if (!c || /[;&|`$<>]|\n/.test(c.replace(/\s2>&1$/, ""))) return false;
  const [bin, sub] = c.split(/\s+/);
  if (["ls", "pwd", "cat", "head", "tail", "wc", "rg", "grep", "file", "which", "stat", "tree", "du", "echo", "date", "uname", "env"].includes(bin)) return true;
  if (bin === "git") return ["status", "diff", "log", "show", "branch", "remote", "rev-parse", "ls-files", "blame"].includes(sub);
  if (["node", "npm", "pnpm", "python3", "cargo", "go", "bun"].includes(bin)) return ["--version", "-v", "-V", "version"].includes(sub);
  return false;
}

function needsApproval(session, call) {
  const mode = session.permissionMode;
  if (call.name === "write" || call.name === "edit") {
    if (mode === "plan") return "deny";
    if (mode === "auto-edit" || mode === "yolo") return "allow";
    return session.allowed.has(call.name) ? "allow" : "ask";
  }
  if (call.name === "bash") {
    if (isReadOnlyCommand(call.input?.command)) return "allow";
    if (mode === "plan") return "deny";
    if (mode === "yolo") return "allow";
    const first = String(call.input?.command ?? "").trim().split(/\s+/)[0];
    return session.allowed.has(`bash:${first}`) ? "allow" : "ask";
  }
  return "allow";
}

function preview(call, session) {
  const { name, input } = call;
  if (name === "bash") return String(input.command ?? "");
  if (name === "write") {
    const lines = String(input.content ?? "").split("\n");
    return `${rel(session, resolvePath(session, input.path))} (${lines.length} lines)\n${lines.slice(0, 12).map((l) => `+ ${l}`).join("\n")}${lines.length > 12 ? "\n+ …" : ""}`;
  }
  if (name === "edit") {
    const minus = String(input.old ?? "").split("\n").slice(0, 10).map((l) => `- ${l}`);
    const plus = String(input.new ?? "").split("\n").slice(0, 10).map((l) => `+ ${l}`);
    return `${rel(session, resolvePath(session, input.path))}\n${[...minus, ...plus].join("\n")}`;
  }
  return describeCall(call);
}

function walkGlob(pattern, cwd) {
  const skip = (p) => /(^|\/)(node_modules|\.git)(\/|$)/.test(p);
  if (typeof fs.globSync === "function") {
    return fs.globSync(pattern, { cwd, exclude: (p) => skip(typeof p === "string" ? p : p.name) })
      .filter((p) => !skip(p));
  }
  const r = spawnSync("rg", ["--files", "--glob", pattern], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

function runShell(command, { cwd, signal, timeoutMs }) {
  return new Promise((resolve) => {
    const marker = `__c0cwd_${process.pid}__`;
    const shell = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
    const script = `${command}\n__c0rc=$?\nprintf '\\n${marker}%s\\n' "$PWD"\nexit $__c0rc`;
    const child = spawn(shell, ["-c", script], { cwd, env: { ...process.env, CI: "1", PAGER: "cat", GIT_PAGER: "cat" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (d) => { out += d; if (out.length > 400_000) out = out.slice(-200_000); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      let newCwd = null;
      const at = out.lastIndexOf(marker);
      if (at >= 0) {
        newCwd = out.slice(at + marker.length).split("\n")[0].trim() || null;
        out = out.slice(0, at).replace(/\n$/, "");
      }
      resolve({ code, out, timedOut, newCwd });
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, out: String(e.message), timedOut: false, newCwd: null }); });
  });
}

/** Run one tool. Always resolves `{ ok, output }`; a thrown error is a failed result. */
export async function runTool(session, call, ctx = {}) {
  const { name, input = {} } = call;
  try {
    if (call.error) return { ok: false, output: `${call.error}. tools: ${ctx.tools.join(", ")}` };
    if (!ctx.tools.includes(name)) return { ok: false, output: `${name} is not available to this agent. tools: ${ctx.tools.join(", ")}` };
    const gate = needsApproval(session, call);
    if (gate === "deny") return { ok: false, output: `${name} is blocked in plan mode: reply with your plan instead.` };
    if (gate === "ask") {
      const answer = await session.ask({ name, agent: ctx.agent?.name, title: describeCall(call), preview: preview(call, session) });
      if (answer === "always") session.allowed.add(name === "bash" ? `bash:${String(input.command).trim().split(/\s+/)[0]}` : name);
      else if (answer !== "yes") return { ok: false, output: `the user declined this ${name}${answer && answer !== "no" ? `: ${answer}` : ""}. do something else or ask them.` };
    }
    switch (name) {
      case "read": {
        const file = resolvePath(session, input.path);
        const st = fs.statSync(file);
        if (st.isDirectory()) return { ok: false, output: `${input.path} is a directory: use ls` };
        const lines = fs.readFileSync(file, "utf8").split("\n");
        const offset = Math.max(1, Number(input.offset) || 1);
        const limit = Math.min(Math.max(1, Number(input.limit) || 300), 2000);
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const body = slice.map((l, i) => `${String(offset + i).padStart(5)}  ${l.length > 400 ? `${l.slice(0, 400)}…` : l}`).join("\n");
        const more = offset - 1 + limit < lines.length ? `\n… ${lines.length - (offset - 1 + limit)} more lines: read with offset ${offset + limit}` : "";
        session.readFiles.add(file);
        return { ok: true, output: cap(body + more), summary: `${slice.length} lines` };
      }
      case "write": {
        const file = resolvePath(session, input.path);
        if (typeof input.content !== "string") return { ok: false, output: "content (string) is required" };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const existed = fs.existsSync(file);
        fs.writeFileSync(file, input.content);
        const n = input.content.split("\n").length;
        return { ok: true, output: `${existed ? "overwrote" : "created"} ${rel(session, file)} (${n} lines)`, summary: `${n} lines` };
      }
      case "edit": {
        const file = resolvePath(session, input.path);
        const oldS = String(input.old ?? input.old_string ?? "");
        const newS = String(input.new ?? input.new_string ?? "");
        if (!oldS) return { ok: false, output: "old (the exact text to replace) is required; read the file first" };
        const text = fs.readFileSync(file, "utf8");
        const count = text.split(oldS).length - 1;
        if (!count) {
          // Small models re-indent what they copy. Accept the one place that
          // matches line for line once leading whitespace is ignored, and keep
          // the file's own indentation on the lines that replace it.
          const fuzzy = indentTolerantMatch(text, oldS);
          if (fuzzy) {
            const replacement = reindent(newS, oldS, fuzzy.text);
            fs.writeFileSync(file, text.slice(0, fuzzy.index) + replacement + text.slice(fuzzy.index + fuzzy.text.length));
            return { ok: true, output: `edited ${rel(session, file)} (matched ignoring indentation)`, summary: "1 replacement" };
          }
          return { ok: false, output: `old text not found in ${input.path}: read the file and copy it exactly, including indentation` };
        }
        if (count > 1 && !input.all) return { ok: false, output: `old text occurs ${count} times in ${input.path}: include more surrounding lines, or pass "all": true` };
        fs.writeFileSync(file, input.all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS));
        const delta = newS.split("\n").length - oldS.split("\n").length;
        return { ok: true, output: `edited ${rel(session, file)} (${count} replacement${count > 1 ? "s" : ""})`, summary: `${delta >= 0 ? "+" : ""}${delta} lines` };
      }
      case "bash": {
        const command = String(input.command ?? "").trim();
        if (!command) return { ok: false, output: "command is required" };
        const timeoutMs = Math.min(Math.max(Number(input.timeout) || 120_000, 1000), 600_000);
        const r = await runShell(command, { cwd: session.cwd, signal: ctx.signal, timeoutMs });
        if (r.newCwd && r.newCwd !== session.cwd && fs.existsSync(r.newCwd)) session.cwd = r.newCwd;
        const head = r.timedOut ? `timed out after ${timeoutMs / 1000}s\n` : "";
        return { ok: r.code === 0, output: cap(`${head}${r.out.replace(/\s+$/, "") || "(no output)"}\nexit ${r.code}`), summary: `exit ${r.code}` };
      }
      case "glob": {
        if (!input.pattern) return { ok: false, output: "pattern is required, like **/*.js" };
        const base = input.path ? resolvePath(session, input.path) : session.cwd;
        const files = walkGlob(String(input.pattern), base);
        const withTime = files.map((f) => { let t = 0; try { t = fs.statSync(path.join(base, f)).mtimeMs; } catch { /* gone */ } return [f, t]; });
        withTime.sort((a, b) => b[1] - a[1]);
        const list = withTime.slice(0, 200).map(([f]) => rel(session, path.join(base, f)));
        return { ok: true, output: list.length ? cap(list.join("\n") + (files.length > 200 ? `\n… ${files.length - 200} more` : "")) : "no files match", summary: `${files.length} files` };
      }
      case "grep": {
        if (!input.pattern) return { ok: false, output: "pattern is required" };
        const where = input.path ? resolvePath(session, input.path) : ".";
        const args = ["-n", "--no-heading", "--color", "never", "-S", "-m", "50"];
        if (input.glob) args.push("--glob", String(input.glob));
        args.push("--", String(input.pattern), where);
        let r = spawnSync("rg", args, { cwd: session.cwd, encoding: "utf8", maxBuffer: 8 << 20 });
        if (r.error) r = spawnSync("grep", ["-rnE", "--exclude-dir=node_modules", "--exclude-dir=.git", String(input.pattern), where], { cwd: session.cwd, encoding: "utf8", maxBuffer: 8 << 20 });
        const lines = (r.stdout || "").split("\n").filter(Boolean);
        return { ok: true, output: lines.length ? cap(lines.slice(0, 200).join("\n") + (lines.length > 200 ? `\n… ${lines.length - 200} more matches` : "")) : "no matches", summary: `${lines.length} matches` };
      }
      case "ls": {
        const dir = resolvePath(session, input.path || ".");
        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.name !== ".git" && e.name !== "node_modules")
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
        return { ok: true, output: cap(entries.slice(0, 300).join("\n") || "(empty)"), summary: `${entries.length} entries` };
      }
      case "todo": {
        const items = Array.isArray(input.items) ? input.items : [];
        session.todos = items.map((t) => ({
          text: String(t?.text ?? t?.content ?? t ?? ""),
          status: ["pending", "in_progress", "done"].includes(t?.status) ? t.status : t?.done ? "done" : "pending",
        })).filter((t) => t.text);
        ctx.onEvent?.({ type: "todo", todos: session.todos, depth: ctx.depth });
        return { ok: true, output: "todo list updated", summary: `${session.todos.length} items` };
      }
      case "task": {
        const agents = loadAgents({ cwd: session.cwd });
        const target = agents.find((a) => a.name === String(input.agent ?? "general-purpose").toLowerCase().replace(/^@/, ""));
        if (!target) return { ok: false, output: `no agent "${input.agent}". agents: ${agents.map((a) => a.name).join(", ")}` };
        if (!input.prompt) return { ok: false, output: "prompt is required: everything the subagent needs, it sees nothing else" };
        const started = Date.now();
        const sub = await runAgent({
          session,
          agent: target,
          messages: [{ role: "user", content: String(input.prompt) }],
          depth: (ctx.depth ?? 0) + 1,
          signal: ctx.signal,
          onEvent: ctx.onEvent,
        });
        const secs = Math.round((Date.now() - started) / 1000);
        return { ok: !sub.error, output: cap(sub.text || sub.error || "(the subagent returned nothing)"), summary: `${sub.toolUses} tool uses · ${secs}s` };
      }
      default:
        return { ok: false, output: `unknown tool ${name}` };
    }
  } catch (e) {
    const msg = String(e?.message || e);
    return { ok: false, output: e?.code === "ENOENT" ? `${msg}\nthat path does not exist: use ls or glob to find the real file name` : msg };
  }
}

/** The single span of `text` equal to `old` line for line, ignoring leading whitespace. */
export function indentTolerantMatch(text, old) {
  const want = old.replace(/\n+$/, "").split("\n").map((l) => l.trim());
  if (!want.some(Boolean)) return null;
  const lines = text.split("\n");
  const starts = [];
  let pos = 0;
  for (const l of lines) { starts.push(pos); pos += l.length + 1; }
  const hits = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, j) => lines[i + j].trim() === w)) hits.push(i);
  }
  if (hits.length !== 1) return null;
  const i = hits[0];
  const endLine = i + want.length - 1;
  const index = starts[i];
  return { index, text: text.slice(index, starts[endLine] + lines[endLine].length) };
}

/** Shift `next` by the indentation difference between what the model wrote and what the file has. */
function reindent(next, wrote, actual) {
  const leads = (s) => s.split("\n").filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0]);
  const w = leads(wrote);
  const a = leads(actual);
  // Map each indentation the model used to the file's indentation at the same line.
  const map = new Map();
  w.forEach((x, i) => { if (a[i] != null && !map.has(x)) map.set(x, a[i]); });
  return next.replace(/\n+$/, "").split("\n").map((l) => {
    const lead = l.match(/^[ \t]*/)[0];
    return map.has(lead) ? map.get(lead) + l.slice(lead.length) : l;
  }).join("\n");
}

// ─── prompts ─────────────────────────────────────────────────────────────────

const TOOL_DOCS = {
  read: `read {"path": "<file>", "offset": 1, "limit": 300}  read a file with line numbers`,
  write: `write {"path": "<file>", "content": "..."}  create or overwrite a whole file`,
  edit: `edit {"path": "<file>", "old": "exact old text", "new": "replacement"}  replace text; read the file first, copy "old" exactly`,
  bash: `bash {"command": "npm test"}  run a shell command in the project`,
  glob: `glob {"pattern": "**/*.js"}  find files by name`,
  grep: `grep {"pattern": "function main", "path": "<dir>", "glob": "*.js"}  search file contents (regex)`,
  ls: `ls {"path": "."}  list a directory`,
  todo: `todo {"items": [{"text": "write the test", "status": "in_progress"}]}  keep a checklist for multi-step work`,
  task: `task {"agent": "explore", "prompt": "everything the subagent needs to know"}  hand a self-contained job to a subagent`,
};

function projectNotes(cwd) {
  for (const f of ["MOSHCODE.md", "AGENTS.md", "CLAUDE.md"]) {
    try {
      const text = fs.readFileSync(path.join(cwd, f), "utf8").trim();
      if (text) return `\n\n# Project instructions (${f})\n${text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text}`;
    } catch { /* next */ }
  }
  return "";
}

/** The top of the working directory, so the model starts from real names, not guesses. */
function topLevel(cwd) {
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.name !== ".git" && e.name !== "node_modules")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
    return entries.length ? `files here: ${entries.slice(0, 60).join("  ")}${entries.length > 60 ? `  … (${entries.length - 60} more)` : ""}` : "the directory is empty";
  } catch { return ""; }
}

function gitLine(cwd) {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? `git branch: ${r.stdout.trim()}` : "not a git repository";
}

/** The system prompt for one agent, lead or sub. */
export function systemPrompt({ agent, tools, session, depth = 0, agents = [] }) {
  const lead = depth === 0 && agent.name === "c0mpute";
  const intro = lead
    ? "You are c0mpute, a coding agent running in the user's terminal through moshcode. You help with software tasks by using tools on the user's machine."
    : agent.prompt;
  const docs = tools.map((t) => `- ${TOOL_DOCS[t]}`).join("\n");
  const subagents = tools.includes("task") && agents.length
    ? `\n\n# Subagents for the task tool\n${agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")}\nUse a subagent for searches or self-contained jobs. Several task calls in one reply run in parallel.`
    : "";
  return [
    intro,
    "",
    "# How to use tools",
    "To use a tool, write a tool block with a JSON object and then STOP and wait for the result:",
    "",
    '<tool name="read">{"path": "package.json"}</tool>',
    "",
    "You may write several tool blocks in one reply. The results come back in <tool_result> blocks.",
    "Never write <tool_result> yourself. When the work is done, reply with plain text and no tool block.",
    "",
    "# Tools",
    docs,
    subagents,
    "",
    "# Rules",
    "- Read a file before you edit it. Prefer edit over rewriting a whole file.",
    "- Do not invent file contents, paths or command output: look first.",
    "- Keep replies short. Say what you changed and how you checked it.",
    lead ? "- For a multi-step change, keep a todo list and run the tests at the end." : "- Your final reply is all the lead agent sees: include the facts it needs.",
    "",
    "# Environment",
    `working directory: ${session.cwd}`,
    `platform: ${process.platform} · date: ${new Date().toISOString().slice(0, 10)} · ${gitLine(session.cwd)}`,
    topLevel(session.cwd),
    lead ? projectNotes(session.cwd) : "",
  ].join("\n");
}

/** The lead agent: every tool, and it is the only one that can spawn subagents. */
export const LEAD_AGENT = {
  name: "c0mpute",
  description: "the main agent",
  tools: ALL_TOOLS,
  model: null,
  prompt: "",
  source: "built-in",
};

// ─── context ─────────────────────────────────────────────────────────────────

const CONTEXT_CHARS = () => Number(process.env.C0AGENT_CONTEXT_CHARS) > 0 ? Number(process.env.C0AGENT_CONTEXT_CHARS) : 40_000;

/**
 * Keep the conversation inside a small model's window: elide the bodies of
 * the oldest tool results first. The last exchange is never touched.
 */
export function trimContext(messages, max = CONTEXT_CHARS()) {
  const size = () => messages.reduce((n, m) => n + m.content.length, 0);
  for (let i = 0; i < messages.length - 2 && size() > max; i++) {
    const m = messages[i];
    if (m.role === "user" && m.content.includes("<tool_result") && !m.elided) {
      m.content = m.content.replace(/(<tool_result[^>]*>)[\s\S]*?(<\/tool_result>)/g, "$1\n[elided to save context: run the tool again if you need it]\n$2");
      m.elided = true;
    }
  }
  return messages;
}

const formatResult = (call, r) =>
  `<tool_result name="${call.name}" ok="${r.ok}">\n${r.output}\n</tool_result>`;

// ─── the loop ────────────────────────────────────────────────────────────────

/**
 * A session: what the agents share. `provider` is anything with
 * `stream(req, onToken) -> { text, model }`; `ask` answers a permission
 * prompt with "yes" | "always" | "no" | <a note for the model>.
 */
export function createSession({ provider, model, cwd = process.cwd(), permissionMode = "ask", ask } = {}) {
  return {
    provider,
    model,
    cwd,
    permissionMode,
    ask: ask || (async () => "no"),
    allowed: new Set(),
    readFiles: new Set(),
    todos: [],
    usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
  };
}

/**
 * Run one agent until it answers without a tool call. Returns
 * `{ text, toolUses, error? }`. Never throws for a model or tool failure;
 * an abort ends it with `error: "interrupted"`.
 */
export async function runAgent({ session, agent = LEAD_AGENT, messages, depth = 0, signal, onEvent = () => {}, maxSteps }) {
  const isLead = depth === 0;
  const tools = (isLead ? agent.tools : agent.tools.filter((t) => t !== "task")).filter((t) => ALL_TOOLS.includes(t));
  const agents = tools.includes("task") ? loadAgents({ cwd: session.cwd }) : [];
  const system = systemPrompt({ agent, tools, session, depth, agents });
  const model = agent.model || session.model;
  const limit = maxSteps ?? (isLead ? 40 : 25);
  let toolUses = 0;
  let last = "";
  for (let step = 0; step < limit; step++) {
    if (signal?.aborted) return { text: last, toolUses, error: "interrupted" };
    trimContext(messages);
    onEvent({ type: "waiting", agent: agent.name, depth });
    const filter = createStreamFilter(
      (t) => onEvent({ type: "text", text: t, agent: agent.name, depth }),
      { onThinking: () => onEvent({ type: "thinking", agent: agent.name, depth }) },
    );
    let res;
    try {
      res = await session.provider.stream(
        { system, messages: messages.map(({ role, content }) => ({ role, content })), maxTokens: 2048, temperature: 0.2, signal, models: { c0mpute: model } },
        (t) => filter.push(t),
      );
    } catch (e) {
      if (signal?.aborted) return { text: last, toolUses, error: "interrupted" };
      const error = String(e?.message || e);
      onEvent({ type: "error", error, agent: agent.name, depth });
      return { text: last, toolUses, error };
    }
    filter.end();
    session.usage.calls += 1;
    session.usage.inputTokens += res.usage?.inputTokens ?? 0;
    session.usage.outputTokens += res.usage?.outputTokens ?? 0;
    const raw = String(res.text ?? "");
    if (process.env.C0AGENT_DEBUG) process.stderr.write(`\n--- ${agent.name} @ ${res.model} ---\n${raw}\n---\n`);
    const calls = parseToolCalls(raw);
    // Keep only what the model said up to its last tool call: anything after
    // is a guess at results it hasn't seen.
    messages.push({ role: "assistant", content: stripThink(raw).replace(/<tool_result\b[\s\S]*$/i, "").trim() || "(no reply)" });
    onEvent({ type: "turn_end", agent: agent.name, depth, model: res.model, calls: calls.length });
    last = visibleText(raw) || last;
    if (!calls.length) return { text: last, toolUses };

    // Subagent calls in one reply run in parallel; everything else in order.
    const results = new Array(calls.length);
    const runOne = async (call, i) => {
      onEvent({ type: "tool_start", call, title: describeCall(call), agent: agent.name, depth });
      const r = await runTool(session, call, { tools, agent, depth, signal, onEvent });
      onEvent({ type: "tool_end", call, title: describeCall(call), result: r, agent: agent.name, depth });
      results[i] = r;
    };
    const tasks = [];
    for (let i = 0; i < calls.length; i++) {
      if (calls[i].name === "task") tasks.push(runOne(calls[i], i));
      else { await Promise.all(tasks.splice(0)); await runOne(calls[i], i); }
    }
    await Promise.all(tasks);
    toolUses += calls.length;
    messages.push({ role: "user", content: calls.map((c, i) => formatResult(c, results[i])).join("\n\n") });
  }
  return { text: last || `stopped after ${limit} steps`, toolUses, error: last ? undefined : "step limit" };
}

/** `/compact`: replace the conversation with the model's own summary of it. */
export async function compactConversation(session, messages, { signal } = {}) {
  const transcript = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n").slice(-30_000);
  const res = await session.provider.stream({
    system: "Summarize this coding session so the work can continue: the goal, decisions, files changed, what is left. Under 300 words.",
    messages: [{ role: "user", content: transcript }],
    maxTokens: 700,
    temperature: 0.2,
    signal,
    models: { c0mpute: session.model },
  }, () => {});
  const summary = visibleText(res.text);
  messages.splice(0, messages.length,
    { role: "user", content: `Summary of our session so far:\n${summary}` },
    { role: "assistant", content: "Got it. Ready to continue." });
  return summary;
}

/** Ask the model to draft an agent definition from a one-line description (/agents new). */
export async function draftAgent(session, description, { signal } = {}) {
  const res = await session.provider.stream({
    system: [
      "You design subagents for a coding assistant. Reply with ONLY a JSON object:",
      '{"name": "kebab-case-name", "description": "one sentence: what it does and when to use it",',
      ' "tools": ["read", "grep"], "prompt": "the system prompt, second person, 5-15 lines"}',
      `tools must be chosen from: ${ALL_TOOLS.filter((t) => t !== "task").join(", ")}. Give read-only agents only read, glob, grep, ls.`,
    ].join("\n"),
    messages: [{ role: "user", content: String(description) }],
    maxTokens: 900,
    temperature: 0.3,
    signal,
    models: { c0mpute: session.model },
  }, () => {});
  const text = visibleText(res.text);
  const obj = looseJson(text.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!obj?.prompt) throw new Error("the model did not return a usable definition; write it by hand with /agents new --manual");
  const name = String(obj.name ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "custom-agent";
  const tools = (Array.isArray(obj.tools) ? obj.tools : []).map(normalizeTool).filter((t) => t && t !== "task");
  return { name, description: String(obj.description ?? description), tools: tools.length ? [...new Set(tools)] : ALL_TOOLS.filter((t) => t !== "task"), model: null, prompt: String(obj.prompt) };
}

export { BUILTIN_AGENTS };
