// `/mcp` and `/skill` command flows, shared by the TUI and the CLI. Each parses
// a canonical spec, plans the per-engine fan-out, runs it, and prints a
// per-engine summary. See prd/0003.
import { ENGINES, isInstalled } from "./engines.mjs";
import {
  MCP_ENGINES, deriveName, isRemoteTarget, planMcpAdd, runMcpAdd,
} from "./mcp.mjs";
import {
  SKILL_ENGINES, planSkillInstall, runSkillInstall, skillName,
} from "./skills.mjs";
import { acid, ash, bone, ok, err, info } from "./ui.mjs";

function splitKV(pair) {
  const i = String(pair).indexOf("=");
  return i === -1 ? [String(pair), ""] : [pair.slice(0, i), pair.slice(i + 1)];
}

function headerName(header) {
  const i = String(header).indexOf(":");
  return i === -1 ? null : String(header).slice(0, i).trim();
}

function flagValue(rest, index, flag) {
  const value = rest[index + 1];
  if (value === undefined || value === "--") return { error: `${flag} requires a value` };
  return { value };
}

/** Parse `/mcp` tokens (after the `mcp` word) into { list } | { spec } | { error }. */
export function parseMcp(tokens) {
  const verb = tokens[0];
  if (!verb || verb === "list") return { list: true };
  if (verb !== "install" && verb !== "add") return { error: `unknown mcp verb "${verb}" — try install, add, or list` };

  const rest = tokens.slice(1);
  let name, transport, cmdParts = null;
  const env = [], headers = [], positional = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--") { cmdParts = rest.slice(i + 1); break; }
    else if (t === "--name") {
      const next = flagValue(rest, i, t);
      if (next.error) return next;
      name = next.value; i++;
    }
    else if (t === "-t" || t === "--transport") {
      const next = flagValue(rest, i, t);
      if (next.error) return next;
      transport = next.value; i++;
    }
    else if (t === "-e" || t === "--env") {
      const next = flagValue(rest, i, t);
      if (next.error) return next;
      env.push(splitKV(next.value)); i++;
    }
    else if (t === "-H" || t === "--header") {
      const next = flagValue(rest, i, t);
      if (next.error) return next;
      headers.push(next.value); i++;
    }
    else positional.push(t);
  }

  if (verb === "add") name = name || positional.shift();
  let target, args = [];
  if (cmdParts) { target = cmdParts[0]; args = cmdParts.slice(1); }
  else { target = positional[0]; args = positional.slice(1); }

  if (verb === "install" && !name) {
    if (target && isRemoteTarget(target)) name = deriveName(target);
    else return { error: "a stdio command server needs an explicit --name" };
  }
  if (!name) return { error: "missing server name" };
  if (!target) return { error: "missing server URL or command" };
  if (env.some(([key]) => String(key).trim() === "")) {
    return { error: "mcp --env requires a non-empty key" };
  }
  if (headers.some((header) => headerName(header) === null)) {
    return { error: "mcp --header requires a Name: Value header" };
  }
  if (headers.some((header) => headerName(header) === "")) {
    return { error: "mcp --header requires a non-empty header name" };
  }
  return { spec: { name, target, args, transport, env, headers } };
}

const DOT = { installed: acid("●"), missing: ash("○") };
function line(key, statusText) { return `   ${bone(key.padEnd(9))} ${statusText}`; }

/** Print the MCP support matrix + install status. */
export function printMcpTargets() {
  console.log(bone("  mcp") + ash("  — register a server everywhere with ") + acid("/mcp install <url>"));
  for (const key of MCP_ENGINES) {
    const dot = isInstalled(ENGINES[key].bin) ? DOT.installed : DOT.missing;
    console.log(`   ${dot} ${bone(key.padEnd(9))} ${ash("mcp add supported")}`);
  }
  console.log(`   ${DOT.missing} ${bone("aider".padEnd(9))} ${ash("no MCP support")}`);
}

/** Print the skills support matrix + install status. */
export function printSkillTargets() {
  console.log(bone("  skills") + ash("  — install a skill everywhere with ") + acid("/skill install <git-url>"));
  for (const key of SKILL_ENGINES) {
    const dot = isInstalled(ENGINES[key].bin) ? DOT.installed : DOT.missing;
    console.log(`   ${dot} ${bone(key.padEnd(9))} ${ash("skills supported")}`);
  }
  for (const key of ["codex", "opencode", "aider"]) {
    console.log(`   ${DOT.missing} ${bone(key.padEnd(9))} ${ash("no skills primitive")}`);
  }
}

function summarize(results) {
  for (const r of results) {
    if (r.status === "added" || r.status === "installed") console.log(line(r.key, ok(r.status)));
    else if (r.status === "failed") console.log(line(r.key, err(`failed${r.code != null ? ` (code ${r.code})` : ""}`)));
    else if (r.status === "not-installed") console.log(line(r.key, ash("not installed — /install " + r.key)));
    else console.log(line(r.key, ash(`skipped — ${r.reason}`)));
  }
}

/** Run `/mcp …`. `tokens` are the words after `mcp`. */
export async function mcpCommand(tokens) {
  const parsed = parseMcp(tokens);
  if (parsed.list) { printMcpTargets(); return; }
  if (parsed.error) { console.log(err(parsed.error)); return; }

  const { spec } = parsed;
  console.log(info(`registering ${bone(spec.name)} → ${ash(spec.target)} across MCP engines…`));
  const results = await runMcpAdd(planMcpAdd(spec));
  summarize(results);
  if (spec.headers.length || /^https?:/i.test(spec.target)) {
    console.log(ash("  note: OAuth/HTTP servers may still need per-engine auth (e.g. `opencode mcp auth`, `codex mcp login`)."));
  }
}

/** Run `/skill …`. `tokens` are the words after `skill`. */
export async function skillCommand(tokens) {
  const verb = tokens[0];
  if (!verb || verb === "list") { printSkillTargets(); return; }
  if (verb !== "install") { console.log(err(`unknown skill verb "${verb}" — try install or list`)); return; }

  const rest = tokens.slice(1);
  let name, source;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--name") name = rest[++i];
    else if (!source) source = rest[i];
  }
  if (!source) { console.log(err("usage: /skill install <git-url|path> [--name <name>]")); return; }

  const spec = { source, name: skillName(source, name) };
  console.log(info(`installing skill ${bone(spec.name)} → ${ash(source)} across skills engines…`));
  const results = await runSkillInstall(planSkillInstall(spec));
  summarize(results);
}
