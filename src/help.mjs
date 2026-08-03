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
export function usageBlock(name, verb = null) {
  const command = findCommand(name);
  if (!command) return "";
  return renderCommand(command, { verb: verb ? findVerb(command, verb) : null });
}
