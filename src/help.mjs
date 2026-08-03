// Help, rendered from the command table rather than written out.
//
// This replaces an 87-line template literal in bin/moshcode.mjs that had
// already drifted: `dns` and `version` were dispatchable and absent from it,
// aliases were missing, and half the flags existed only in the parsers. Nothing
// here knows a command name — it all comes from src/cli-schema.mjs, so a verb
// that is added to the table is documented by construction (PRD 0006 R5).
//
// Pure and side-effect free by design. Help is the one command guaranteed to
// run before anything is installed and before anyone has logged in, so it must
// not touch the network, read credentials, or write to disk (R2). The only
// impurity is the engine/tool roster, which the caller passes in.

import {
  CORE_CLI_COMMANDS,
  COMMAND_GROUPS,
  NOT_IN_PIT,
  PIT_COMMANDS,
  VERB_TABLES,
} from "./cli-schema.mjs";

/** Every rendered line wraps here. 28 lines of the old help ran past it. */
export const WIDTH = 80;

/** What asks for help, at any level. */
export const HELP_TOKENS = ["--help", "-h", "help"];

/**
 * Is this argument list asking for help?
 *
 * Position-independent within its own level (R1), which is the whole fix:
 * `moshcode mcp install --help` and `moshcode mcp --help install` both ask the
 * same question, and today the first one is a usage error.
 *
 * `stopAt` is for `run`, where the boundary matters: `moshcode run --help` is
 * the runner's help, and `moshcode run script.mosh --help` is the script's
 * argument (PRD 0004 R13). Everything at or after the first non-flag token is
 * somebody else's to interpret.
 */
export function wantsHelp(args = [], { stopAt = false } = {}) {
  for (const arg of args) {
    if (stopAt && !String(arg).startsWith("-")) return false;
    if (HELP_TOKENS.includes(arg)) return true;
  }
  return false;
}

/** Arguments with the help tokens removed, so the rest can still be read. */
export function withoutHelp(args = []) {
  return args.filter((a) => !HELP_TOKENS.includes(a));
}

const isAlias = (c) => Boolean(c.aliasOf);

/** Commands that are not aliases — the ones with something to say. */
export const primaryCommands = () => CORE_CLI_COMMANDS.filter((c) => !isAlias(c) && c.group);

/** The aliases pointing at a command, as bare names. */
export const aliasesFor = (name) =>
  CORE_CLI_COMMANDS.filter((c) => c.aliasOf === name).map((c) => c.name);

/**
 * Resolve what the user typed to the entry that documents it.
 *
 * Aliases resolve to their target rather than rendering twice (R7): `moshcode
 * help where` is a question about `pwd`, and answering it with a stub that says
 * "alias for pwd" and nothing else would be true and useless.
 */
export function findCommand(name) {
  const wanted = String(name ?? "").toLowerCase();
  const hit = CORE_CLI_COMMANDS.find((c) => c.name === wanted);
  if (!hit) return null;
  return hit.aliasOf ? CORE_CLI_COMMANDS.find((c) => c.name === hit.aliasOf) ?? null : hit;
}

/** The sub-verb table a command declares, or an empty list. */
export function verbsFor(command) {
  return (command?.verbs && VERB_TABLES[command.verbs]) || [];
}

export function findVerb(command, name) {
  const wanted = String(name ?? "").toLowerCase();
  return verbsFor(command).find((v) => v.name === wanted) ?? null;
}

/* ------------------------------------------------------------------ suggest */

/** Levenshtein, iterative, two rows. Small inputs; this is a typo check. */
function distance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const row = [i + 1];
    for (let j = 0; j < b.length; j++) {
      row[j + 1] = Math.min(
        prev[j + 1] + 1,
        row[j] + 1,
        prev[j] + (a[i] === b[j] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * The nearest command to something that is not one, or null.
 *
 * Drawn from the same set completion offers (R11), so the two can never
 * disagree about what exists. The threshold is deliberately tight: suggesting
 * `run` for `xyzzy` is noise, and a wrong suggestion is worse than none because
 * it sends people to try a second wrong command.
 */
export function suggest(input, extra = []) {
  const typed = String(input ?? "").toLowerCase();
  if (!typed) return null;
  const candidates = [...CORE_CLI_COMMANDS.map((c) => c.name), ...extra]
    .filter((n) => !n.startsWith("-"));

  let best = null;
  let bestScore = Infinity;
  for (const name of candidates) {
    const score = distance(typed, name);
    if (score < bestScore) { best = name; bestScore = score; }
  }
  // Allow one edit for short words, two for longer ones; never more.
  const ceiling = typed.length <= 4 ? 1 : 2;
  return bestScore <= ceiling ? best : null;
}

/* ------------------------------------------------------------------- render */

/** Wrap `text` to WIDTH, indenting continuations by `indent` spaces. */
export function wrap(text, indent = 0, width = WIDTH) {
  // Every line — the first one included — is placed after `indent` columns:
  // the first continues an already-printed label, the rest are padded to sit
  // under it. So they all get the same budget, and the total never exceeds
  // `width`. Getting this wrong is how a "wraps at 80" helper emits 92.
  const budget = Math.max(20, width - indent);
  const pad = " ".repeat(indent);
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > budget && line) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i ? pad + l : l)).join("\n");
}

/** `  name        description`, wrapped, for a two-column list. */
function row(left, right, pad = 22) {
  const head = `  ${left.padEnd(pad)}`;
  if (!right) return head.trimEnd();
  const wrapped = wrap(right, head.length, WIDTH);
  return `${head}${wrapped}`;
}

/**
 * The top-level overview: one screen, grouped, with a way in (R10).
 *
 * A menu rather than an index. The old help printed every command, every
 * engine, every tool and the whole moshscript vocabulary in 127 lines — which
 * is why nobody read it and why `moshcode help | grep` became the interface.
 * `--all` keeps that available for the people who grep.
 */
export function renderOverview({ engines = [], tools = [], version = "" } = {}) {
  const out = [];
  out.push(`moshcode${version ? ` ${version}` : ""} — a metal wrapper for coding engines 🤘`);
  out.push("");
  out.push("usage: moshcode [command] [args…]        no command → open the mosh pit");
  out.push("");

  for (const group of COMMAND_GROUPS) {
    const members = primaryCommands().filter((c) => c.group === group.key);
    if (!members.length) continue;
    const names = members.map((c) => c.name).join(" · ");
    out.push(row(group.title, names, 10));
  }

  out.push("");
  if (engines.length) out.push(row("engines", engines.join(" · "), 10));
  if (tools.length) out.push(row("tools", tools.join(" · "), 10));
  out.push("");
  out.push(row("moshcode help <command>", "drill into one (flags, examples)", 26));
  out.push(row("moshcode help --all", "the whole wall", 26));
  out.push(row("moshcode help --json", "the machine-readable model", 26));
  out.push("");
  out.push("engines are installed and driven by moshcode — 🤘 no bugs, only features");
  return out.join("\n");
}

/** One command, in full: synopsis, flags, sub-verbs, examples, see also (R4). */
export function renderCommand(command, { verb = null } = {}) {
  if (!command) return "";
  const target = verb || command;
  const title = verb ? `moshcode ${command.name} ${verb.name}` : `moshcode ${command.name}`;
  const out = [`${title} — ${target.description}`];

  const synopsis = target.synopsis || [];
  if (synopsis.length) {
    out.push("", "usage:");
    for (const [line, note] of synopsis) out.push(row(line, note, 44));
  }

  const flags = target.flags || [];
  if (flags.length) {
    out.push("", "flags:");
    for (const [flag, description, fallback] of flags) {
      out.push(row(flag, `${description}${fallback ? `   (default: ${fallback})` : ""}`, 22));
    }
  }

  if (!verb) {
    const verbs = verbsFor(command);
    if (verbs.length) {
      out.push("", "verbs:");
      for (const v of verbs) out.push(row(v.name, v.description, 22));
      out.push("", `moshcode help ${command.name} <verb>   for one of them`);
    }
  }

  const examples = target.examples || [];
  if (examples.length) {
    out.push("", "examples:");
    for (const [cmd, note] of examples) out.push(row(cmd, note ? `# ${note}` : "", 44));
  }

  if (!verb) {
    const aliases = aliasesFor(command.name);
    if (aliases.length) out.push("", `aliases: ${aliases.join(", ")}`);
  }

  if (target.note) out.push("", wrap(target.note, 0));

  const seeAlso = target.seeAlso || command.seeAlso || [];
  if (seeAlso.length) {
    out.push("", `see also: ${seeAlso.map((s) => `moshcode help ${s}`).join(" · ")}`);
  }
  return out.join("\n");
}

/** Every command, in full — what `--all` and the old wall give you (R10). */
export function renderAll(context = {}) {
  const blocks = [renderOverview(context), ""];
  for (const command of primaryCommands()) {
    blocks.push("─".repeat(WIDTH - 20), renderCommand(command), "");
  }
  return blocks.join("\n");
}

/**
 * The help model, for an agent (R9).
 *
 * The same shape `engines --json` and `commands --json` already honor: data on
 * stdout, no decoration, exit 0. This is the interface for the consumer that
 * cannot read a terminal layout — a coding engine that moshcode itself
 * launched, shelling back in to learn what it can drive.
 */
export function helpModel({ engines = [], tools = [], version = "" } = {}) {
  return {
    name: "moshcode",
    version: version || null,
    usage: "moshcode [command] [args…]",
    engines,
    tools,
    groups: COMMAND_GROUPS.map(({ key, title }) => ({
      name: key,
      title,
      commands: primaryCommands().filter((c) => c.group === key).map((c) => c.name),
    })),
    commands: primaryCommands().map((command) => ({
      name: command.name,
      group: command.group,
      description: command.description,
      aliases: aliasesFor(command.name),
      synopsis: (command.synopsis || []).map(([line, note]) => ({ usage: line, note: note || null })),
      flags: (command.flags || []).map(([flags, description, fallback]) => ({
        flags,
        description,
        default: fallback || null,
      })),
      examples: (command.examples || []).map(([cmd, note]) => ({ command: cmd, note: note || null })),
      verbs: verbsFor(command).map((v) => ({
        name: v.name,
        description: v.description,
        synopsis: (v.synopsis || []).map(([line, note]) => ({ usage: line, note: note || null })),
        flags: (v.flags || []).map(([flags, description, fallback]) => ({
          flags,
          description,
          default: fallback || null,
        })),
      })),
      seeAlso: command.seeAlso || [],
      note: command.note || null,
    })),
  };
}

/**
 * The block printed when a command was used wrongly (R3).
 *
 * The command's own usage, never the top-level wall — a mistyped flag on
 * `console` is not a reason to print 127 lines about engines. Callers send this
 * to stderr and exit 1; `renderCommand` on stdout is the same text for the
 * person who asked politely.
 */
/* ------------------------------------------------------- moshscript verbs */

/**
 * A moshscript verb, rendered from the registry (PRD 0006 R14).
 *
 * `moshcode help ask` is a fair question — `ask()` is as much part of the
 * interface as `moshcode prd` — and it used to answer "no help for ask",
 * because the vocabulary lives in a registry that help had never been
 * introduced to.
 *
 * `usage` is optional on a command object, so a verb registered by a host that
 * has not declared one still renders: the signature falls back to `name(…)` and
 * the summary carries the meaning.
 */
export function renderScriptVerb(command) {
  if (!command) return null;
  const out = [`${command.usage || `${command.name}(…)`} — ${command.summary || "a moshscript verb"}`];
  if (command.detail) out.push("", wrap(command.detail, 0));
  out.push("", "a moshscript verb — call it from a .mosh file, not from the shell.");
  out.push("", "see also: moshcode help run · moshcode help commands");
  return out.join("\n");
}

/* ---------------------------------------------------------------- markdown */

export const README_START = "<!-- COMMANDS:START -->";
export const README_END = "<!-- COMMANDS:END -->";

/**
 * The command table as markdown, for README.md (PRD 0006 R13).
 *
 * Generated rather than checked against a hand-written list, and the difference
 * matters: a checker tells you the README is wrong, a generator makes it right.
 * Same shape as the PRD index this repo already keeps between markers, so the
 * convention is one people here already know.
 *
 * Aliases ride along in their target's row instead of getting rows of their
 * own — six extra lines saying "alias for X" is how a table stops being read.
 */
export function renderMarkdown() {
  const rows = primaryCommands().map((command) => {
    const aliases = aliasesFor(command.name);
    const name = `\`moshcode ${command.name}\`${aliases.length ? ` <br>${aliases.map((a) => `\`${a}\``).join(" ")}` : ""}`;
    return `| ${name} | ${command.group} | ${command.description} |`;
  });
  return [
    "| command | group | what it does |",
    "|---|---|---|",
    ...rows,
  ].join("\n");
}

/**
 * Put the generated table between the markers in `markdown`.
 *
 * Returns the document unchanged when it carries no markers, so this can be
 * pointed at a file that has not opted in without mangling it.
 */
export function withCommandTable(markdown) {
  const text = String(markdown);
  const from = text.indexOf(README_START);
  const to = text.indexOf(README_END);
  if (from < 0 || to < 0 || to < from) return text;
  return `${text.slice(0, from + README_START.length)}\n${renderMarkdown()}\n${text.slice(to)}`;
}

/* ------------------------------------------------------------------ the pit */

/** Resolve a pit command, following its aliases. */
export function findPitCommand(name) {
  const wanted = String(name ?? "").toLowerCase().replace(/^\//, "");
  return PIT_COMMANDS.find((c) => c.name === wanted || (c.aliases || []).includes(wanted)) ?? null;
}

/**
 * The model behind `/help` (R12).
 *
 * Structure rather than a string, because the pit colours its output and the
 * CLI does not — returning pre-rendered text would mean either losing the
 * colour or teaching this module about ANSI. The tool roster comes from the
 * caller, which gets it from TOOLS: `/help` used to hardcode nine tool names
 * directly beneath a printTools() whose own comment explains why that goes
 * stale.
 */
export function pitHelpModel({ engines = [], tools = [] } = {}) {
  return {
    commands: PIT_COMMANDS.map((c) => ({
      name: c.name,
      aliases: c.aliases || [],
      args: c.args || "",
      description: c.description,
      usage: `/${c.name}${c.args ? ` ${c.args}` : ""}`,
    })),
    engines,
    tools,
    // Honest about the gap rather than silent about it.
    notInPit: NOT_IN_PIT.map((name) => ({
      name,
      description: findCommand(name)?.description || "",
    })),
  };
}

/**
 * One pit command in detail, for `/help <command>` and `/<command> --help`.
 *
 * Delegates to the CLI block when the verb is the same verb, so flags and
 * examples are written once. Pit-only commands (`/shell`, `/quit`) answer for
 * themselves.
 */
export function renderPitCommand(name) {
  const entry = findPitCommand(name);
  if (!entry) return null;
  if (entry.cli) {
    const command = findCommand(entry.cli);
    if (command) {
      const body = renderCommand(command);
      // The pit spells them with a slash; say so once rather than rewriting
      // every synopsis line.
      return `${body}\n\nin the pit: /${entry.name}${entry.args ? ` ${entry.args}` : ""}`;
    }
  }
  const out = [`/${entry.name} — ${entry.description}`];
  if (entry.args) out.push("", "usage:", row(`/${entry.name} ${entry.args}`, "", 44));
  if (entry.aliases?.length) out.push("", `aliases: ${entry.aliases.map((a) => `/${a}`).join(", ")}`);
  return out.join("\n");
}

export function usageBlock(name, verb = null) {
  const command = findCommand(name);
  if (!command) return "";
  return renderCommand(command, { verb: verb ? findVerb(command, verb) : null });
}
