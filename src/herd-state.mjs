// Semantic state for herd sessions (PRD 0009 R6–R8, PRD 0019 R2).
//
// The roster's whole value is the state column. Everything else it shows —
// name, engine, cwd — you already knew when you started the session; "which one
// stopped to ask me something" is the thing you cannot get any other way.
//
// ONE AUTHORITY PER SESSION. herdr's rule, adopted because the failure it
// prevents is real: an engine hook that reports `working` and a screen rule
// that reads `blocked` cannot both be right, and a roster that flickers between
// them is worse than one that says `unknown`. So a session with a live hook
// report is read from the hook and the screen rules are not consulted at all.
//
// THE HEARTBEAT COMES FIRST. PRD 0019 R2. A run moshcode started writes a beat
// under $OPENFLEET_HOME, and a beat that carries a state is that run saying
// what it is doing. That is a fact. Everything below it in the order is the
// herd working out what an engine probably meant by what it drew on a screen,
// which is a guess, and the guess expires whenever a vendor ships a new
// footer: Claude Code 2.1 overwrote the pane title and dropped "? for
// shortcuts" and detection broke, which is the failure this ordering exists to
// stop mattering.
//
// KNOWN VERSUS INFERRED, PERMANENTLY. Heartbeats exist only for runs moshcode
// starts. An engine somebody launched by hand in a pane has nothing to report
// with and has to be inferred from its screen forever, so the two tiers are
// the shape of the world rather than a migration. Every answer therefore
// carries `confidence`: `known` when a run, a hook or the runtime said so,
// `inferred` when a regular expression decided. A roster that shows both the
// same way is showing a confident lie roughly as often as it shows a fact.
//
// Screen rules stay, and they are the part that rots. Engines change their
// prompts between releases and nothing tells us. Three things make that
// survivable: rules ship next to each engine's install spec in
// src/engines.mjs so they version together, `unknown` is always a safe answer
// and never blocks anything, and a user can add or override a pattern in
// ~/.moshcode/herd/rules.json without waiting for a release.
import fs from "node:fs";
import path from "node:path";

import { ENGINES } from "./engines.mjs";
import { capture, herdDir, remoteStatus, sessionExited } from "./herd.mjs";
import { liveBeats } from "./run-record.mjs";
import { TOOLS } from "./tools.mjs";

/** The vocabulary the roster, notifications, and `wait` all share. */
export const STATES = ["working", "blocked", "done", "idle", "unknown"];

/**
 * What a blocked session is blocked *on* (PRD 0011 R4).
 *
 * The roster still prints `blocked`, because five kinds of amber is four more
 * than anyone reads at a glance. The sub-kind rides in `--json` and in
 * notifications, where it is worth something: an `--ask` reply to a numbered
 * menu wants a digit, and one to a question wants a sentence, and answering a
 * menu with a paragraph types the paragraph into the menu.
 */
export const BLOCKED_KINDS = ["permission", "question", "menu"];

/**
 * Parse the state token a hook or a human passes to `herd report`.
 *
 * `blocked:permission` is one string on a command line and two facts here.
 * Returns null for anything not in the vocabulary — an unknown state has to
 * fail loudly at the edge rather than be written into the status file where
 * every later reader has to cope with it.
 */
export function parseState(raw) {
  const [state, kind] = String(raw ?? "").trim().split(":");
  if (!STATES.includes(state)) return null;
  if (kind === undefined || kind === "") return { state };
  if (state !== "blocked" || !BLOCKED_KINDS.includes(kind)) return null;
  return { state, kind };
}

/**
 * `gone` is deliberately not in STATES: it is not a state an agent is in, it is
 * the absence of one. It exists so the roster can show what a reboot took and
 * `moshcode restore` has something to rebuild from.
 */
export const ALL_STATES = [...STATES, "gone"];

/** How long a hook's report stays authoritative before the screen takes over. */
export const HOOK_TTL_MS = 15 * 60 * 1000;

/**
 * Where an answer came from, and whether it is a fact (PRD 0019 R2).
 *
 * `runtime` is the process itself: exited or not, which nothing can argue
 * with. `heartbeat` is the run moshcode started saying what it is doing.
 * `hook` is the engine's own lifecycle event. Those three are reports, and
 * all three expire, so a stale one becomes an absence rather than a claim.
 *
 * `screen` is a regular expression looking at a terminal and deciding. It is
 * the only source that can be wrong while nothing has gone wrong, which is
 * why it is the one this whole requirement exists to label.
 *
 * `remote` is `inferred` and the choice is deliberate. A remote's claim is a
 * report, but it is that herd's report, worked out over there by a heartbeat
 * or by a screen rule, and the protocol does not carry which. The cached
 * status also never expires (see remoteStatus in herd.mjs), so the claim can
 * be an hour old. Two things we cannot see add up to something we should not
 * call a fact. When the remote protocol carries its own confidence, this can
 * carry it through.
 */
export const AUTHORITY_CONFIDENCE = {
  runtime: "known",
  heartbeat: "known",
  hook: "known",
  remote: "inferred",
  screen: "inferred",
};

/** The two tiers the roster shows. Nothing is ever a third thing. */
export const CONFIDENCE = ["known", "inferred"];

/**
 * The tier for an authority. Anything unrecognised is `inferred`, because a
 * source we cannot name is not one we get to call a fact.
 */
export function confidenceOf(authority) {
  return AUTHORITY_CONFIDENCE[authority] === "known" ? "known" : "inferred";
}

/** An answer with its tier attached. Every return from sessionState goes through here. */
const answer = (state, authority, extra = {}) => ({
  state, authority, confidence: confidenceOf(authority), ...extra,
});

const statusDir = () => path.join(herdDir(), "status");
const statusFile = (name) => path.join(statusDir(), `${name}.json`);

/**
 * Terminal escapes have to go before anything is matched.
 *
 * tmux's capture-pane already hands back plain text, but the pty substrate's
 * transcript is the raw stream — every colour change, cursor move and
 * alternate-screen switch still in it. A rule like /Do you want to/ will miss
 * when the engine coloured half the sentence.
 */
export function stripAnsi(text) {
  return String(text)
    // CSI, OSC and the two-character escapes, in that order.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r(?!\n)/g, "\n");
}

/**
 * Patterns that hold across engines.
 *
 * Every one of these is a *terminal-shaped* question — a y/n, a numbered menu
 * selector, a "press enter" — rather than a word that happens to appear in
 * agent output. "Approve" on its own would match an agent writing about an
 * approvals feature; `[y/N]` at the end of a screen would not.
 */
export const COMMON_RULES = {
  blocked: [
    /\[y\/n\]/i,
    /\((?:y(?:es)?\/n(?:o)?)\)\s*[:?]?\s*$/im,
    /\bdo you want to\b/i,
    /\bpress (?:enter|return) to continue\b/i,
    // The cursor on a numbered menu. Engines do not agree on the glyph —
    // Claude Code draws ❯, Codex draws › — and the plain > is there for the
    // ones that use ASCII. Observed, not guessed.
    /^\s*[❯›▸>]\s*\d+\.\s+\S/m,
    /\bwaiting for (?:your )?(?:approval|confirmation)\b/i,
  ],
  working: [
    /\besc(?:ape)? to interrupt\b/i,
    /\bctrl\+c to (?:stop|cancel|interrupt)\b/i,
    /\bpress esc to cancel\b/i,
  ],
  // A prompt sitting at the very end of the screen, waiting for a keystroke —
  // a shell's `$`, a root `#`, zsh/starship's `❯`/`➜`, an agent's `>` composer.
  // Anchored to the end of the *capture* rather than to any line, because a `$`
  // in the middle of output is a dollar sign and not an invitation.
  //
  // Checked after blocked and working, so the cost of a false positive is only
  // `idle` where `unknown` was already the honest answer. This is what stops a
  // couple of shells in the herd reading `unknown` forever.
  idle: [
    // The glyph last: `… $`, `… #`, `… ❯`.
    /[$%#>❯➜»]\s*$/,
    // The glyph first, with the path after it: `➜  ~/src/api `, which is what
    // zsh and starship actually draw. Restricted to ❯ and ➜ because those are
    // prompt characters and almost nothing else; `>` and `#` in that position
    // are markdown quotes and headings, which agents print all the time.
    // Claude Code's `❯ 2. Dark mode` selector reaches the blocked rule first,
    // so a menu still reads blocked rather than idle.
    /(?:^|\n)[^\n]*[❯➜][^\n]*$/,
  ],
};

/**
 * Which *kind* of blocked a screen is showing.
 *
 * Only consulted once a screen has already classified as `blocked`, so these
 * are labels rather than detectors and can afford to be loose. A screen that
 * matches nothing here is blocked with no sub-kind, which is exactly what the
 * roster printed before this existed.
 */
export const BLOCKED_KIND_RULES = {
  // The menu test goes first: Claude Code's permission dialog IS a numbered
  // menu, and "which keystroke answers this" is the question the sub-kind is
  // for. A y/n is a menu of two with no digits, so it stays a permission.
  menu: [/^\s*[❯›▸>]\s*\d+\.\s+\S/m],
  permission: [
    /\[y\/n\]/i,
    /\((?:y(?:es)?\/n(?:o)?)\)\s*[:?]?\s*$/im,
    /\((?:Y\)es|N\)o)/,
    /\bdo you want to\b/i,
    /\bpermission (?:request|required)\b/i,
    /\ballow (?:this )?(?:command|tool|execution)\b/i,
    /\bapprove this (?:command|edit|change)\b/i,
    /\bwaiting for (?:your )?(?:approval|confirmation)\b/i,
  ],
  question: [/\?\s*$/m, /\bpress (?:enter|return) to continue\b/i],
};

/** The sub-kind of an already-blocked screen, or null when it does not say. */
export function blockedKind(screen) {
  const text = stripAnsi(screen);
  const lines = text.split("\n");
  const tail = lines.slice(Math.max(0, lines.length - 25)).join("\n");
  for (const kind of ["menu", "permission", "question"]) {
    if ((BLOCKED_KIND_RULES[kind] || []).some((re) => re.test(tail))) return kind;
  }
  return null;
}

/**
 * User overrides, so a rule that rots can be fixed on the box it rots on.
 *
 * Shape mirrors the engine table: { "<engine>": { blocked: ["…"], … } }, with
 * patterns as strings because JSON has no regex literal. `common` is accepted
 * as an engine name to extend the shared set. Never throws — a malformed rules
 * file must not take down the roster.
 */
export function loadUserRules(file = path.join(herdDir(), "rules.json")) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return {}; }
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [engine, group] of Object.entries(raw)) {
    if (!group || typeof group !== "object") continue;
    const compiled = {};
    for (const state of ["blocked", "working", "idle"]) {
      const patterns = Array.isArray(group[state]) ? group[state] : [];
      compiled[state] = patterns.flatMap((p) => {
        try { return [new RegExp(p, "im")]; }
        catch { return []; } // one bad pattern loses that pattern, not the file
      });
    }
    out[engine] = compiled;
  }
  return out;
}

/** The states a user rules file is allowed to carry patterns for. */
const RULE_STATES = ["blocked", "working", "idle"];

/**
 * Everything wrong with the user's rules file, said out loud (PRD 0011 R3).
 *
 * loadUserRules() is silent by design — a malformed rules file must not take
 * down the roster, and it does not. The cost of that is a file which has been
 * quietly ignored since the day someone typo'd a bracket in it, with the herd
 * classifying from the built-in rules and nothing anywhere saying so. This is
 * where that gets to be loud, and `herd doctor` is the one caller.
 */
export function inspectUserRules(file = path.join(herdDir(), "rules.json")) {
  const empty = { file, present: false, ok: true, patterns: 0, problems: [] };
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) {
    return error.code === "ENOENT" ? empty
      : { ...empty, present: true, ok: false, problems: [{ where: file, error: String(error.message || error) }] };
  }

  let raw;
  try { raw = JSON.parse(text); }
  catch (error) {
    return { ...empty, present: true, ok: false, problems: [{ where: file, error: `not valid JSON — ${error.message}` }] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...empty, present: true, ok: false, problems: [{ where: file, error: 'the top level must be { "<engine>": { "blocked": ["…"] } }' }] };
  }

  const problems = [];
  let patterns = 0;
  for (const [engine, group] of Object.entries(raw)) {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      problems.push({ where: engine, error: "must be an object of state → patterns" });
      continue;
    }
    for (const key of Object.keys(group)) {
      if (!RULE_STATES.includes(key)) {
        problems.push({ where: `${engine}.${key}`, error: `not a state the classifier reads (${RULE_STATES.join(", ")})` });
      }
    }
    for (const state of RULE_STATES) {
      if (group[state] === undefined) continue;
      if (!Array.isArray(group[state])) {
        problems.push({ where: `${engine}.${state}`, error: "must be an array of pattern strings" });
        continue;
      }
      for (const pattern of group[state]) {
        try { new RegExp(pattern, "im"); patterns++; }
        catch (error) { problems.push({ where: `${engine}.${state}`, pattern: String(pattern), error: String(error.message || error) }); }
      }
    }
  }
  return { file, present: true, ok: problems.length === 0, patterns, problems };
}

/**
 * The rule set for one engine: user overrides, then its own, then the shared.
 *
 * TOOLS is consulted as well as ENGINES because `herd run -- gradient agent run
 * --dev` names its session after the binary, and the workflow CLIs are exactly
 * the long-running processes people put in the herd next to an agent (PRD 0011
 * R15). A tool's rules live in src/tools.mjs beside its install spec for the
 * same reason an engine's live beside its own.
 */
export function rulesFor(engine, { userRules = loadUserRules() } = {}) {
  const own = (Object.hasOwn(ENGINES, engine) ? ENGINES[engine]?.state : null)
    || (Object.hasOwn(TOOLS, engine) ? TOOLS[engine]?.state : null)
    || {};
  const user = userRules[engine] || {};
  const common = userRules.common || {};
  const merge = (state) => [
    ...(user[state] || []),
    ...(own[state] || []),
    ...(common[state] || []),
    ...(COMMON_RULES[state] || []),
  ];
  return { blocked: merge("blocked"), working: merge("working"), idle: merge("idle") };
}

/**
 * Classify a screen.
 *
 * Order is not arbitrary. `blocked` is checked first because it is the only
 * state that costs the user something to miss, and because a blocked engine's
 * screen frequently still carries the "esc to interrupt" hint from the work it
 * was doing a moment ago. `idle` last, and only on a positive match, so a quiet
 * screen nobody has written a rule for reports `unknown` instead of a
 * confident lie.
 */
export function classify(screen, rules) {
  const text = stripAnsi(screen);
  if (!text.trim()) return "unknown";
  // Only the bottom of the screen decides. An agent that printed a y/n prompt
  // twenty lines ago and moved on is not blocked, and scrollback is full of
  // sentences that look like prompts.
  const lines = text.split("\n");
  const tail = lines.slice(Math.max(0, lines.length - 25)).join("\n");
  for (const state of ["blocked", "working", "idle"]) {
    if ((rules[state] || []).some((re) => re.test(tail))) return state;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Tier 1: the hook report
// ---------------------------------------------------------------------------

/**
 * Record an authoritative state, written by an engine's own lifecycle hook via
 * `moshcode herd report`. `ttl` is in milliseconds and bounded: a hook that
 * claims authority forever would leave a crashed agent reading `working` until
 * someone noticed by hand.
 */
export function reportState(name, state, { ttl = HOOK_TTL_MS, now = Date.now() } = {}) {
  const parsed = parseState(state);
  if (!parsed) {
    return { ok: false, error: new Error(`unknown state ${JSON.stringify(state)} — one of ${STATES.join(", ")}${` (blocked takes :${BLOCKED_KINDS.join(", :")})`}`) };
  }
  try {
    fs.mkdirSync(statusDir(), { recursive: true, mode: 0o700 });
    const file = statusFile(name);
    const record = { state: parsed.state, at: now, ttl: Math.min(Number(ttl) || HOOK_TTL_MS, HOOK_TTL_MS) };
    if (parsed.kind) record.kind = parsed.kind;
    fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return { ok: true, ...parsed };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The live hook report for a session, or null when there is none worth trusting. */
export function hookReport(name, { now = Date.now() } = {}) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(statusFile(name), "utf8")); }
  catch { return null; }
  if (!raw || !STATES.includes(raw.state)) return null;
  const ttl = Math.min(Number(raw.ttl) || HOOK_TTL_MS, HOOK_TTL_MS);
  if (!Number.isFinite(raw.at) || now - raw.at > ttl) return null;
  const report = { state: raw.state, at: raw.at };
  if (raw.state === "blocked" && BLOCKED_KINDS.includes(raw.kind)) report.kind = raw.kind;
  return report;
}

export function clearReport(name) {
  try { fs.rmSync(statusFile(name), { force: true }); return true; }
  catch { return false; }
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/**
 * The state of one session, and where that answer came from.
 *
 * `authority` is returned alongside the state on purpose: when a rule rots, the
 * first useful question is "was anything even reading the screen?", and a
 * roster that cannot answer it sends people to read this file instead.
 */
export function sessionState(session, {
  now = Date.now(),
  userRules = loadUserRules(),
  read = capture,
  remote = remoteStatus,
  // The beats for the whole box, computed once by withState and handed down.
  // A lone sessionState call reads them itself, which costs one readdir per
  // fleet and is only ever paid by a caller asking about one session.
  beats = null,
} = {}) {
  const name = typeof session === "string" ? session : session.name;
  const meta = typeof session === "string" ? {} : session;

  // A remote member's state is the remote's claim and nothing more (PRD 0011
  // R11). It is reported with `authority: "remote"` so nobody mistakes a URL
  // that answered five minutes ago for something this box just verified.
  if (meta.kind === "remote") {
    const claim = remote(name, { now });
    return answer(claim?.state || "unknown", "remote");
  }

  if (meta.alive === false) return answer("gone", "runtime");

  // A finished process is done, and no screen rule gets a vote on that. This is
  // the one thing the runtime knows for certain, so it stays ahead of the
  // heartbeat: a beat written two minutes before the process exited would
  // otherwise report a dead run as working for the rest of its ttl.
  const exited = meta.exited ?? sessionExited(name);
  if (exited === true) return answer("done", "runtime");
  if (exited === null && meta.alive === undefined) return answer("gone", "runtime");

  // Tier 0: the run's own heartbeat (PRD 0019 R2). A beat that carries a state
  // is the run saying what it is doing, which no screen rule gets to overrule.
  // A beat with no state still proves the run is alive, and the answer falls
  // through to the hook and then the screen for what it is doing, labelled
  // `inferred` when it lands there, because liveness and activity are two
  // different facts and only one of them was reported.
  const beat = (beats || liveBeats({ now })).get?.(name) || null;
  if (beat && STATES.includes(beat.state)) {
    return beat.state === "blocked" && BLOCKED_KINDS.includes(beat.kind)
      ? answer(beat.state, "heartbeat", { blockedOn: beat.kind, run: beat.run })
      : answer(beat.state, "heartbeat", { run: beat.run });
  }

  const hook = hookReport(name, { now });
  if (hook) {
    const extra = beat?.run ? { run: beat.run } : {};
    return hook.kind
      ? answer(hook.state, "hook", { ...extra, blockedOn: hook.kind })
      : answer(hook.state, "hook", extra);
  }

  const withRun = beat?.run ? { run: beat.run } : {};
  const screen = read(name);
  if (!screen) return answer("unknown", "screen", withRun);
  const state = classify(screen, rulesFor(meta.engine, { userRules }));
  // `blockedOn` is only ever added when there is one to add: this object is
  // spread over every roster row, so an always-present `blockedOn: undefined`
  // would be a new key on every row for the benefit of none. It is also not
  // called `kind` — that name already belongs to the row, where it says whether
  // the member is a local pty or a URL.
  if (state !== "blocked") return answer(state, "screen", withRun);
  const kind = blockedKind(screen);
  return answer(state, "screen", kind ? { ...withRun, blockedOn: kind } : withRun);
}

/** listSessions() output, each row carrying its state. */
export function withState(sessions, options = {}) {
  const userRules = options.userRules ?? loadUserRules();
  // One scan of the fleet's beat files for the whole roster rather than one
  // per row. A box with forty sessions used to cost forty screen captures and
  // now costs those plus a single readdir.
  const beats = options.beats ?? liveBeats({ now: options.now ?? Date.now() });
  return sessions.map((s) => ({ ...s, ...sessionState(s, { ...options, userRules, beats }) }));
}
