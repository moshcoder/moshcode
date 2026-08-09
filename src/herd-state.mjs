// Semantic state for herd sessions (PRD 0009 R6–R8).
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
// Screen rules are the fallback, and they are the part that rots — engines
// change their prompts between releases and nothing tells us. Three things make
// that survivable: rules ship next to each engine's install spec in
// src/engines.mjs so they version together, `unknown` is always a safe answer
// and never blocks anything, and a user can add or override a pattern in
// ~/.moshcode/herd/rules.json without waiting for a release.
import fs from "node:fs";
import path from "node:path";

import { ENGINES } from "./engines.mjs";
import { capture, herdDir, sessionExited } from "./herd.mjs";

/** The vocabulary the roster, notifications, and `wait` all share. */
export const STATES = ["working", "blocked", "done", "idle", "unknown"];

/**
 * `gone` is deliberately not in STATES: it is not a state an agent is in, it is
 * the absence of one. It exists so the roster can show what a reboot took and
 * `moshcode restore` has something to rebuild from.
 */
export const ALL_STATES = [...STATES, "gone"];

/** How long a hook's report stays authoritative before the screen takes over. */
export const HOOK_TTL_MS = 15 * 60 * 1000;

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

/** The rule set for one engine: user overrides, then its own, then the shared. */
export function rulesFor(engine, { userRules = loadUserRules() } = {}) {
  const own = ENGINES[engine]?.state || {};
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
  if (!STATES.includes(state)) return { ok: false, error: new Error(`unknown state ${JSON.stringify(state)} — one of ${STATES.join(", ")}`) };
  try {
    fs.mkdirSync(statusDir(), { recursive: true, mode: 0o700 });
    const file = statusFile(name);
    fs.writeFileSync(file, JSON.stringify({ state, at: now, ttl: Math.min(Number(ttl) || HOOK_TTL_MS, HOOK_TTL_MS) }), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return { ok: true, state };
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
  return { state: raw.state, at: raw.at };
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
export function sessionState(session, { now = Date.now(), userRules = loadUserRules(), read = capture } = {}) {
  const name = typeof session === "string" ? session : session.name;
  const meta = typeof session === "string" ? {} : session;

  if (meta.alive === false) return { state: "gone", authority: "runtime" };

  // A finished process is done, and no screen rule gets a vote on that. This is
  // the one thing the runtime knows for certain.
  const exited = meta.exited ?? sessionExited(name);
  if (exited === true) return { state: "done", authority: "runtime" };
  if (exited === null && meta.alive === undefined) return { state: "gone", authority: "runtime" };

  const hook = hookReport(name, { now });
  if (hook) return { state: hook.state, authority: "hook" };

  const screen = read(name);
  if (!screen) return { state: "unknown", authority: "screen" };
  return { state: classify(screen, rulesFor(meta.engine, { userRules })), authority: "screen" };
}

/** listSessions() output, each row carrying its state. */
export function withState(sessions, options = {}) {
  const userRules = options.userRules ?? loadUserRules();
  return sessions.map((s) => ({ ...s, ...sessionState(s, { ...options, userRules }) }));
}
