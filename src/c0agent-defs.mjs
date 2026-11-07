// Agent definitions for the c0mpute agent (`moshcode agents c0mpute`).
//
// The same shape Claude Code uses for its subagents, on purpose: a markdown
// file whose frontmatter names the agent and whose body is its system prompt.
//
//   ---
//   name: code-reviewer
//   description: Reviews a diff for bugs. Use after any change.
//   tools: read, grep, glob        (omit for every tool)
//   model: qwen2.5:7b              (omit, or "inherit", for the session's model)
//   ---
//   You are a careful reviewer…
//
// Where they live, highest priority first, so a project can override a
// personal agent of the same name and both can override a built-in:
//
//   ./.moshcode/agents/*.md     project   (commit it, the team gets it)
//   ~/.moshcode/agents/*.md     user
//   ./.claude/agents/*.md       claude    (read-only reuse of Claude Code agents)
//   ~/.claude/agents/*.md       claude
//   built-in                    general-purpose, explore, plan
//
// Claude Code agents name tools in PascalCase (Read, Grep, MultiEdit) and
// models by tier (sonnet, opus); both are mapped, and anything we cannot run
// here (WebFetch, NotebookEdit, …) is dropped rather than refused, so an
// existing .claude/agents directory works without edits.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Every tool the c0mpute agent has. `task` (subagents) is the main agent's only. */
export const ALL_TOOLS = ["read", "write", "edit", "bash", "glob", "grep", "ls", "todo", "task"];
export const READ_ONLY_TOOLS = ["read", "glob", "grep", "ls"];

const TOOL_ALIASES = {
  read: "read", view: "read", cat: "read",
  write: "write", create: "write",
  edit: "edit", multiedit: "edit", str_replace: "edit", replace: "edit",
  bash: "bash", shell: "bash", run: "bash", exec: "bash",
  glob: "glob", find: "glob",
  grep: "grep", search: "grep",
  ls: "ls", list: "ls",
  todo: "todo", todowrite: "todo", todos: "todo",
  task: "task", agent: "task", subagent: "task",
};

/** Map one tool name (any case, Claude Code's or ours) to ours, or null. */
export function normalizeTool(name) {
  const t = String(name ?? "").trim().toLowerCase().replace(/[^a-z_]/g, "");
  return Object.hasOwn(TOOL_ALIASES, t) ? TOOL_ALIASES[t] : null;
}

/** Claude Code's model tiers mean "whatever the session runs" here. */
const INHERIT_MODELS = new Set(["", "inherit", "sonnet", "opus", "haiku", "fable", "default"]);

export const BUILTIN_AGENTS = [
  {
    name: "general-purpose",
    description: "General agent for multi-step tasks: research a question, search code, make a change. Use when no specialist fits.",
    tools: ALL_TOOLS.filter((t) => t !== "task"),
    model: null,
    source: "built-in",
    prompt: [
      "You are a general-purpose agent working for a lead agent. Do the task you are given completely,",
      "using the tools, then reply with a concise report of what you found or changed: file paths,",
      "line numbers, commands run and their results. The lead agent only sees your final reply.",
    ].join(" "),
  },
  {
    name: "explore",
    description: "Read-only search agent: finds files, definitions and usages fast. Use to answer \"where is X\" or \"how does Y work\" without changing anything.",
    tools: READ_ONLY_TOOLS,
    model: null,
    source: "built-in",
    prompt: [
      "You are a read-only code search agent. Use glob, grep, ls and read to locate what was asked.",
      "Never guess: cite file paths and line numbers you actually read. Finish with a short answer",
      "listing the relevant files and what each one does for the question.",
    ].join(" "),
  },
  {
    name: "plan",
    description: "Read-only architect: studies the code and returns a step-by-step implementation plan with the files to change.",
    tools: READ_ONLY_TOOLS,
    model: null,
    source: "built-in",
    prompt: [
      "You are a software architect. Read the relevant code, then reply with a numbered implementation",
      "plan: each step names the file to change and what changes, then list risks and how to test it.",
      "Do not write code beyond short snippets.",
    ].join(" "),
  },
];

/** The four directories definitions load from, highest priority first. */
export function agentDirs({ cwd = process.cwd(), home = os.homedir() } = {}) {
  return [
    { source: "project", dir: path.join(cwd, ".moshcode", "agents"), writable: true },
    { source: "user", dir: path.join(home, ".moshcode", "agents"), writable: true },
    { source: "claude", dir: path.join(cwd, ".claude", "agents"), writable: false },
    { source: "claude", dir: path.join(home, ".claude", "agents"), writable: false },
  ];
}

/**
 * Split `---\nyaml\n---\nbody`. Only the flat `key: value` subset agent files
 * use, plus `[a, b]` and `- item` lists, so there is no YAML dependency.
 */
export function parseFrontmatter(text) {
  const src = String(text ?? "").replace(/^﻿/, "");
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!m) return { data: {}, body: src.trim() };
  const data = {};
  let listKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      (data[listKey] ||= []).push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    listKey = null;
    if (!value.trim()) { listKey = key; data[key] = []; continue; }
    const v = value.trim();
    data[key] = v.startsWith("[") && v.endsWith("]")
      ? v.slice(1, -1).split(",").map(unquote).filter(Boolean)
      : unquote(v);
  }
  return { data, body: m[2].trim() };
}

function unquote(s) {
  const t = String(s).trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
}

/** A valid agent name: what Claude Code accepts, lowercase letters, digits, dashes. */
export function validName(name) {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(name ?? ""));
}

/** One definition file → an agent, or null when it is not one. */
export function parseAgentFile(text, { source = "user", file = null } = {}) {
  const { data, body } = parseFrontmatter(text);
  const name = String(data.name ?? (file ? path.basename(file, ".md") : "")).trim().toLowerCase();
  if (!validName(name) || !body) return null;
  const rawTools = data.tools == null || data.tools === ""
    ? null
    : (Array.isArray(data.tools) ? data.tools : String(data.tools).split(","));
  const tools = rawTools
    ? [...new Set(rawTools.map(normalizeTool).filter(Boolean))]
    : ALL_TOOLS.filter((t) => t !== "task");
  const model = String(data.model ?? "").trim();
  return {
    name,
    description: String(data.description ?? "").trim() || `${name} agent`,
    tools: tools.filter((t) => t !== "task"), // subagents never spawn subagents
    model: INHERIT_MODELS.has(model.toLowerCase()) ? null : model,
    prompt: body,
    source,
    file,
  };
}

/**
 * Every agent, highest priority wins per name. Each entry carries `shadows`,
 * the lower-priority sources it hides, so the list can say so.
 */
export function loadAgents(opts = {}) {
  const byName = new Map();
  const add = (agent) => {
    const seen = byName.get(agent.name);
    if (seen) { seen.shadows.push(agent.source); return; }
    byName.set(agent.name, { ...agent, shadows: [] });
  };
  for (const { source, dir } of agentDirs(opts)) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { continue; }
    for (const f of names) {
      const file = path.join(dir, f);
      let text;
      try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
      const agent = parseAgentFile(text, { source, file });
      if (agent) add(agent);
    }
  }
  for (const agent of BUILTIN_AGENTS) add(agent);
  return [...byName.values()];
}

export function findAgent(name, opts = {}) {
  const n = String(name ?? "").trim().toLowerCase().replace(/^@/, "");
  return loadAgents(opts).find((a) => a.name === n) || null;
}

/** The markdown a definition is saved as. */
export function renderAgentFile({ name, description, tools, model, prompt }) {
  const lines = ["---", `name: ${name}`, `description: ${oneLine(description)}`];
  const t = (tools || []).filter((x) => x !== "task");
  const everything = ALL_TOOLS.filter((x) => x !== "task");
  if (t.length && !everything.every((x) => t.includes(x))) lines.push(`tools: ${t.join(", ")}`);
  if (model) lines.push(`model: ${model}`);
  lines.push("---", "", String(prompt ?? "").trim(), "");
  return lines.join("\n");
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Write a definition to the project or user directory. Returns its path. */
export function saveAgent(agent, { scope = "project", ...opts } = {}) {
  if (!validName(agent.name)) throw new Error(`"${agent.name}" is not a valid agent name (a-z, 0-9, dashes)`);
  const target = agentDirs(opts).find((d) => d.source === scope && d.writable);
  if (!target) throw new Error(`can't save to "${scope}": use project or user`);
  fs.mkdirSync(target.dir, { recursive: true });
  const file = path.join(target.dir, `${agent.name}.md`);
  fs.writeFileSync(file, renderAgentFile(agent));
  return file;
}

/** Delete a saved definition. Built-ins and Claude Code's files are not ours to delete. */
export function removeAgent(name, opts = {}) {
  const agent = findAgent(name, opts);
  if (!agent) throw new Error(`no agent named "${name}"`);
  if (agent.source === "built-in") throw new Error(`${agent.name} is built in; shadow it with /agents new ${agent.name} instead`);
  if (agent.source === "claude") throw new Error(`${agent.name} belongs to Claude Code (${agent.file}); delete it there`);
  fs.rmSync(agent.file);
  return agent;
}

/**
 * Does this engine token mean the c0mpute agent? `c0mpute` is also a TOOL
 * (the network's own CLI), so only `agents`/`start` route here; `/c0mpute`
 * alone still runs the network CLI.
 */
export function isC0mputeAgent(token) {
  return ["c0mpute", "c0", "compute", "c0mpute.com", "c0agent"].includes(String(token ?? "").trim().toLowerCase());
}
