// Where each engine keeps its session log, how to open one, and what was said.
//
// PRD 0018 R1 says `src/cost.mjs` already parses every engine's transcript and
// that a handoff can reuse that reader. Half of that is true, and the half that
// is not is the reason this file exists.
//
// What cost.mjs actually reads is usage, and it discards the conversation on
// purpose at every step. Its Claude reader skips every record that is not an
// `assistant` turn or a `pr-link`, so user turns are never seen, and it never
// looks inside `message.content`. Its Codex reader opens only the head of a
// rollout (for `session_meta`) and the tail (for the cumulative `token_count`),
// so the middle of the file, which IS the conversation, is never loaded. Its
// opencode reader takes `tokens` and `cost` off each message row and never
// joins the `part` table the text lives in. Its qwen reader is pointed at a
// usage log that holds no message text at all.
//
// So the accumulation loops there cannot be refactored into this. What IS
// reusable, and is reused, is the path discovery and the file plumbing below:
// where Claude Code slugs a project directory, how Codex nests rollouts by
// date, which file opencode's database is, and the small readers that turn a
// live file into lines without loading a hundred megabytes. Those are pure and
// engine-agnostic, they were written once in cost.mjs, and they now live here
// with cost.mjs importing them back. One module knows where every engine
// writes, which is a far better place to absorb the next format change than
// two that half agree.
//
// READING CONVERSATION IS NARROWER THAN READING USAGE. A token count is a
// number in a file and most engines write one somewhere. The words are a
// different matter, and only four engines here record them in a shape moshcode
// has verified. `READERS` is therefore a shorter list than `COST_READERS`, and
// `UNREADABLE` names the rest with the reason, because "moshcode cannot read
// kimi transcripts" and "kimi had nothing to say" are different sentences and
// only one of them is true.
//
// AND IT REFUSES RATHER THAN GUESSES. A cost report that misreads a transcript
// prints a wrong dollar figure. A handoff that misreads one hands the next
// engine a corrupted account of what was decided and then acts on it. Every
// reader here returns messages it actually parsed, and an empty result is an
// error the caller must surface, never an empty conversation.
import fs from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

const home = () => homedir();

// ---------------------------------------------------------------------------
// File plumbing, shared with cost.mjs
// ---------------------------------------------------------------------------

export function safeStat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

export function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/**
 * The last `bytes` of a file as whole lines.
 *
 * Codex writes one cumulative `token_count` event per turn, so the answer is
 * always near the end of a rollout that can be tens of megabytes. Reading the
 * tail keeps a cost report cheap enough to put in front of `moshcode ps`.
 */
export function tailLines(file, bytes = 256 * 1024) {
  const stat = safeStat(file);
  if (!stat) return [];
  const start = Math.max(0, stat.size - bytes);
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(bytes, stat.size));
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    // A read that began mid-file almost certainly began mid-line; that first
    // fragment is not parseable JSON and must not be handed on as if it were.
    return (start > 0 ? text.slice(text.indexOf("\n") + 1) : text).split("\n");
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}

/** The first `bytes` of a file as whole lines (the trailing fragment dropped). */
export function headLines(file, bytes = 512 * 1024) {
  const stat = safeStat(file);
  if (!stat) return [];
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(bytes, stat.size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    if (stat.size > buf.length) lines.pop();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}

export const parseJson = (line) => {
  try { return JSON.parse(line); } catch { return null; }
};

export const stamp = (value) => {
  const t = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
};

/** Paths compare after resolution, so `~/src/api` and `~/src/api/` are one place. */
export const samePath = (a, b) => {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(String(p)).replace(/\/+$/, "");
  return norm(a) === norm(b);
};

// ---------------------------------------------------------------------------
// Where each engine writes
// ---------------------------------------------------------------------------

/**
 * Claude Code names a project directory after the working directory with every
 * character that isn't a letter or digit replaced by a dash, so `/home/a/.x`
 * becomes `-home-a--x`. Both spellings are produced here because the exact
 * character class has changed across releases and an unreadable transcript is
 * indistinguishable from a free session. Guessing one slug and finding nothing
 * would silently report $0.
 */
export function claudeProjectSlugs(cwd) {
  const p = path.resolve(String(cwd || ""));
  return [...new Set([p.replace(/[^A-Za-z0-9]/g, "-"), p.replace(/[/.]/g, "-")])];
}

export const claudeProjectsDir = () => path.join(home(), ".claude", "projects");

/**
 * Every transcript under a project directory, the sessions and what their
 * subagents wrote. A session is `<id>.jsonl` beside a directory `<id>/`, and
 * that directory holds `subagents/<agent>.jsonl` plus, for a workflow,
 * `subagents/workflows/<run>/<agent>.jsonl`. The depth cap is that shape and
 * one to spare, so an unexpected tree cannot turn a cost report into a crawl.
 */
export function claudeTranscripts(dir) {
  const out = [];
  const walk = (d, depth) => {
    for (const entry of listDir(d)) {
      const p = path.join(d, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(p);
      else if (entry.isDirectory() && depth < 5) walk(p, depth + 1);
    }
  };
  walk(dir, 0);
  return out;
}

export const codexSessionsDir = () => path.join(home(), ".codex", "sessions");

export const OPENCODE_DBS = {
  opencode: () => path.join(home(), ".local", "share", "opencode", "opencode.db"),
  // A fork that kept the schema and the file name, under its own data dir.
  privacycode: () => path.join(home(), ".local", "share", "privacycode", "opencode.db"),
};

/**
 * Open a live SQLite database without disturbing it.
 *
 * Read-only is the first attempt and usually works. When the database is in WAL
 * mode and its shared-memory file is missing, SQLite cannot open it read-only
 * at all, so the fallback copies the three files somewhere private and reads
 * the copy. Never write to the original: opencode may be running on it.
 */
export async function openReadonly(file) {
  if (!safeStat(file)) return null;
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { return null; } // no built-in sqlite on this runtime; opencode is simply not reported
  try {
    return { db: new DatabaseSync(file, { readOnly: true }), cleanup: () => {} };
  } catch { /* fall through to the copy */ }
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(tmpdir(), "moshcode-cost-"));
    for (const suffix of ["", "-wal", "-shm"]) {
      if (safeStat(file + suffix)) fs.copyFileSync(file + suffix, path.join(dir, path.basename(file) + suffix));
    }
    const db = new DatabaseSync(path.join(dir, path.basename(file)));
    return { db, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } };
  } catch {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Conversation: what was said, and what it touched
// ---------------------------------------------------------------------------

/**
 * Engines whose session log records tokens and not words, and why.
 *
 * A reason rather than a silence, for the same reason `UNCOSTED_ENGINES` is a
 * list rather than a gap: "this engine writes no transcript moshcode can read"
 * is a fact a person can act on, and an engine simply missing from a table
 * reads as an oversight.
 */
export const UNREADABLE = {
  // The six moshcode has no transcript knowledge of at all. They are the same
  // six `cost.mjs` lists as uncosted, which is not a coincidence: nobody has
  // yet found where they write a session down, so neither reader can be built.
  gemini: "moshcode knows of no Gemini CLI session log to read",
  kimi: "moshcode knows of no Kimi Code session log to read",
  deepseek: "moshcode knows of no DeepSeek Code session log to read",
  mimocode: "moshcode knows of no MiMo Code session log to read",
  omp: "moshcode knows of no omp session log to read",
  openagents: "OpenAgents launches other engines and holds no conversation of its own",
  // The two that do write something readable, and are still refused. Both
  // refusals are about fidelity rather than about the file being missing, and
  // both are the obvious next readers for anyone extending this.
  qwen: "qwen's chats live under ~/.qwen/projects/<slug>/chats and moshcode has no verified reader for that shape",
  aider: "aider's chat history is rendered prose, with no marker that separates a turn from its output",
};

/** How long a single carried message may be. A transcript is context, not an archive. */
const MAX_TEXT = 8000;

const clip = (text) => {
  const t = String(text || "").replace(/\r\n/g, "\n").trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n… (clipped)` : t;
};

/**
 * Text that an engine injected into the conversation on the user's behalf.
 *
 * Every engine here opens a session by writing a machine-generated block into
 * the user's first turn: Claude Code's `<system-reminder>`, Codex's
 * `<environment_context>` and `<user_instructions>`. Carrying those across is
 * worse than dropping them: the receiving engine writes its own, and the pair
 * then disagree about the date, the shell and the working directory.
 */
const INJECTED = /^\s*<(system-reminder|environment_context|user_instructions|command-message|command-name|local-command)\b/i;

const isInjected = (text) => INJECTED.test(String(text || ""));

/** The tools every engine spells differently and that all mean "this file changed". */
const WRITE_TOOLS = /^(edit|write|multiedit|notebookedit|str_replace|apply_patch|create_file|update_file)$/i;

/**
 * One message, in the shape the portable transcript carries.
 *
 * `at` is milliseconds or null: engines stamp their logs differently and a
 * missing timestamp is not a reason to drop what was said.
 */
const message = (role, text, at) => ({ role, text: clip(text), at: at ?? null });

// --------------------------------------------------------------- Claude Code

/** Claude Code's stand-in model id for a turn it produced without an API call. */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * The text of a Claude Code message, and the files its tool calls wrote.
 *
 * `content` is a string on a typed prompt and an array of blocks on everything
 * else. Only `text` blocks are conversation: `thinking` is the model talking to
 * itself and does not survive a move to another model, `tool_use` is the engine
 * acting, and `tool_result` is the transcript replaying what the tool said.
 * Tool calls are still read, for their paths. That is the change summary the
 * PRD asks a handoff to carry instead of the edits themselves.
 */
function claudeParts(content, changes) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const text = [];
  for (const block of content) {
    if (block?.type === "text" && block.text) text.push(String(block.text));
    else if (block?.type === "tool_use") {
      const file = block.input?.file_path || block.input?.path || block.input?.notebook_path;
      if (file && WRITE_TOOLS.test(String(block.name || ""))) changes.add(String(file));
    }
  }
  return text.join("\n\n");
}

function readClaude(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }

  const messages = [];
  const changes = new Set();
  let id = path.basename(file, ".jsonl");
  let cwd = "";
  let start = null;
  let end = null;

  for (const line of text.split("\n")) {
    if (!line || line.charCodeAt(0) !== 123) continue; // fast reject: not "{"
    const entry = parseJson(line);
    if (!entry) continue;
    // A sidechain is a subagent's own conversation. It is folded into the
    // parent's transcript for costing, where it is the same bill, but it is a
    // different conversation and handing it on as the user's own would read as
    // the user having said things they never typed.
    if (entry.isSidechain) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.sessionId) id = entry.sessionId;
    if (entry.cwd) cwd = entry.cwd;
    const at = stamp(entry.timestamp);
    if (at != null) { start = start == null ? at : Math.min(start, at); end = end == null ? at : Math.max(end, at); }
    if (entry.message?.model === SYNTHETIC_MODEL) continue;
    // `isMeta` marks a turn the engine wrote into the user's seat: a slash
    // command's expansion, a hook's output. It is not what the person said.
    if (entry.isMeta) continue;
    const body = claudeParts(entry.message?.content, changes);
    if (!body.trim() || isInjected(body)) continue;
    messages.push(message(entry.type, body, at));
  }

  return { id, cwd, start, end, messages, changes: [...changes] };
}

function claudeSessions({ cwd } = {}) {
  const root = claudeProjectsDir();
  const dirs = cwd
    ? claudeProjectSlugs(cwd).map((slug) => path.join(root, slug)).filter((d) => safeStat(d)?.isDirectory())
    : listDir(root).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));

  // The project directory is what Claude Code groups a session under, and it is
  // the only index there is. A session that entered a git worktree mid-run
  // records the worktree as its cwd while staying filed under the directory it
  // started in, so the recorded cwd is reported rather than used to drop the
  // session: cost.mjs can afford to skip such a run and count $0, and a handoff
  // cannot afford to say "no session here" about the one you were just in.
  const out = [];
  for (const dir of dirs) {
    for (const file of claudeTranscripts(dir)) {
      // A subagent's transcript lives under `<session>/subagents/`. It is part
      // of the session's bill and not a session anyone can hand off, so only
      // the top-level files are offered here.
      if (path.dirname(file) !== dir) continue;
      const stat = safeStat(file);
      if (!stat) continue;
      out.push({ engine: "claude", id: path.basename(file, ".jsonl"), file, cwd: cwd || "", at: stat.mtimeMs });
    }
  }
  return out;
}

// --------------------------------------------------------------------- Codex

/**
 * The text of one Codex response item, and the files its tool calls wrote.
 *
 * Codex's rollout is a log of the API items themselves: a `message` carries
 * `content` blocks of `input_text` (what went up) or `output_text` (what came
 * back), and a role of user, assistant or developer. `developer` is the system
 * prompt and never conversation.
 */
function codexText(payload) {
  const content = payload?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "input_text" || b?.type === "output_text" || b?.type === "text")
    .map((b) => String(b.text || ""))
    .join("\n\n");
}

/** Codex names a file in the arguments of its edit calls, which are JSON strings. */
function codexChanged(payload, changes) {
  const name = String(payload?.name || "");
  if (!WRITE_TOOLS.test(name) && !/patch|write|edit/i.test(name)) return;
  const args = parseJson(payload?.arguments ?? payload?.input ?? "");
  const file = args?.path || args?.file_path;
  if (file) changes.add(String(file));
}

function readCodex(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }

  const messages = [];
  const changes = new Set();
  let id = path.basename(file, ".jsonl").replace(/^rollout-[\dT-]*/, "");
  let cwd = "";
  let start = null;
  let end = null;

  for (const line of text.split("\n")) {
    if (!line || line.charCodeAt(0) !== 123) continue;
    const entry = parseJson(line);
    if (!entry) continue;
    if (entry.type === "session_meta") {
      const meta = entry.payload || {};
      id = meta.session_id || meta.id || id;
      cwd = meta.cwd || cwd;
      start = stamp(meta.timestamp) ?? stamp(entry.timestamp) ?? start;
      continue;
    }
    if (entry.type !== "response_item") continue;
    const payload = entry.payload || {};
    const at = stamp(entry.timestamp);
    if (at != null) { start = start == null ? at : Math.min(start, at); end = end == null ? at : Math.max(end, at); }
    if (payload.type !== "message") { codexChanged(payload, changes); continue; }
    const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : null;
    if (!role) continue;
    const body = codexText(payload);
    if (!body.trim() || isInjected(body)) continue;
    messages.push(message(role, body, at));
  }

  return { id, cwd, start, end, messages, changes: [...changes] };
}

function codexSessions({ cwd } = {}) {
  const root = codexSessionsDir();
  const out = [];
  // The tree is YYYY/MM/DD, so a rollout is found by walking three levels and
  // never by opening anything.
  for (const y of listDir(root)) {
    if (!y.isDirectory()) continue;
    for (const m of listDir(path.join(root, y.name))) {
      if (!m.isDirectory()) continue;
      for (const d of listDir(path.join(root, y.name, m.name))) {
        if (!d.isDirectory()) continue;
        const dir = path.join(root, y.name, m.name, d.name);
        for (const f of listDir(dir)) {
          if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
          const file = path.join(dir, f.name);
          const stat = safeStat(file);
          if (!stat) continue;
          // The rollout records its own cwd in the first few lines, which is
          // the only honest filter: the path is nowhere in the file name.
          let id = null;
          let where = "";
          for (const line of headLines(file, 64 * 1024)) {
            const entry = parseJson(line);
            if (entry?.type !== "session_meta") continue;
            id = entry.payload?.session_id || entry.payload?.id || null;
            where = entry.payload?.cwd || "";
            break;
          }
          if (cwd && where && !samePath(where, cwd)) continue;
          out.push({ engine: "codex", id: id || path.basename(file, ".jsonl"), file, cwd: where, at: stat.mtimeMs });
        }
      }
    }
  }
  return out;
}

// -------------------------------------------------------- opencode/privacycode

/**
 * opencode splits a message from its content: `message` holds the role and the
 * directory, `part` holds the blocks, one row each. A text part is what was
 * said; a tool part carries the call and its state, and the file it wrote is
 * inside that state rather than in a column of its own.
 */
function opencodePartText(data, changes) {
  if (data?.type === "text" && data.text) return String(data.text);
  if (data?.type === "tool") {
    const input = data.state?.input || {};
    const file = input.filePath || input.file_path || input.path;
    if (file && WRITE_TOOLS.test(String(data.tool || ""))) changes.add(String(file));
  }
  return "";
}

async function opencodeSessions(engine, { cwd } = {}) {
  const handle = await openReadonly(OPENCODE_DBS[engine]());
  if (!handle) return [];
  const { db, cleanup } = handle;
  const out = [];
  try {
    const rows = db.prepare(
      "select session_id, max(time_created) as at, min(data) as data from message group by session_id order by at desc",
    ).all();
    for (const row of rows) {
      const data = parseJson(row.data);
      const where = data?.path?.cwd || "";
      if (cwd && where && !samePath(where, cwd)) continue;
      out.push({ engine, id: row.session_id, file: null, cwd: where, at: Number(row.at) || null });
    }
  } catch {
    // A schema that moved under us reports no sessions for this engine; the
    // caller then refuses the handoff, which is the right end for a read we
    // cannot trust.
  } finally {
    try { db.close(); } catch { /* already closed */ }
    cleanup();
  }
  return out;
}

async function readOpencode(engine, id) {
  const handle = await openReadonly(OPENCODE_DBS[engine]());
  if (!handle) return null;
  const { db, cleanup } = handle;
  const messages = [];
  const changes = new Set();
  let cwd = "";
  let start = null;
  let end = null;
  try {
    const rows = db.prepare(
      "select m.id as id, m.time_created as at, m.data as message, p.data as part"
      + " from message m left join part p on p.message_id = m.id"
      + " where m.session_id = ? order by m.time_created, p.time_created",
    ).all(id);
    let current = null;
    for (const row of rows) {
      const data = parseJson(row.message);
      if (!data) continue;
      if (data.path?.cwd) cwd = data.path.cwd;
      const at = Number(row.at) || null;
      if (at) { start = start == null ? at : Math.min(start, at); end = end == null ? at : Math.max(end, at); }
      const body = opencodePartText(parseJson(row.part), changes);
      if (!body.trim()) continue;
      const role = data.role === "assistant" ? "assistant" : "user";
      // Parts are rows, so one message arrives as several. They are joined back
      // into the turn they belong to rather than emitted as separate turns.
      if (current && current.id === row.id) current.text.push(body);
      else { current = { id: row.id, role, at, text: [body] }; messages.push(current); }
    }
  } catch {
    cleanup();
    try { db.close(); } catch { /* already closed */ }
    return null;
  }
  try { db.close(); } catch { /* already closed */ }
  cleanup();
  return {
    id,
    cwd,
    start,
    end,
    messages: messages
      .map((m) => message(m.role, m.text.join("\n\n"), m.at))
      .filter((m) => m.text && !isInjected(m.text)),
    changes: [...changes],
  };
}

// ---------------------------------------------------------------------------
// The readers
// ---------------------------------------------------------------------------

/**
 * Engines whose conversation moshcode can read, and how.
 *
 * `sessions` lists what is on disk for a directory, newest first; `read` turns
 * one of them into messages. Both may be async because opencode's is a database
 * and the other two are files.
 */
export const READERS = {
  claude: {
    sessions: (opts) => claudeSessions(opts),
    read: (session) => readClaude(session.file),
  },
  codex: {
    sessions: (opts) => codexSessions(opts),
    read: (session) => readCodex(session.file),
  },
  opencode: {
    sessions: (opts) => opencodeSessions("opencode", opts),
    read: (session) => readOpencode("opencode", session.id),
  },
  privacycode: {
    sessions: (opts) => opencodeSessions("privacycode", opts),
    read: (session) => readOpencode("privacycode", session.id),
  },
};

/** Can this engine's conversation be read at all? */
export const isReadable = (engine) => Object.hasOwn(READERS, engine);

/**
 * Every session of one engine, newest first, optionally narrowed to a directory.
 *
 * An engine with no reader returns nothing rather than throwing: the caller
 * decides whether that is a refusal or just an empty column.
 */
export async function listSessions(engine, { cwd = null } = {}) {
  if (!isReadable(engine)) return [];
  const rows = await READERS[engine].sessions({ cwd });
  return rows.filter((r) => r.id).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/**
 * One session's conversation, or a thrown refusal.
 *
 * `id` picks a session, by its full id or by a unique prefix of one; without
 * it the most recently touched session for the directory wins, which is what
 * "hand over what I was just doing" means. Every failure here is loud: an
 * engine with no reader, a directory with no sessions, a prefix that matches
 * nothing, and the one that matters, a transcript that was found and parsed
 * to nothing. That last case is a format that moved under us, and continuing
 * would hand the next engine an empty conversation as though it were a short
 * one.
 */
export async function readSession(engine, { id = null, cwd = null } = {}) {
  if (!isReadable(engine)) {
    throw new Error(UNREADABLE[engine] || `moshcode cannot read ${engine} transcripts`);
  }
  const sessions = await listSessions(engine, { cwd });
  if (!sessions.length) {
    throw new Error(cwd
      ? `no ${engine} session recorded for ${cwd}`
      : `no ${engine} session on this machine`);
  }
  let picked = sessions[0];
  if (id) {
    const matches = sessions.filter((s) => s.id === id || s.id.startsWith(id));
    if (!matches.length) throw new Error(`no ${engine} session matches "${id}"`);
    if (matches.length > 1 && !matches.some((s) => s.id === id)) {
      throw new Error(`"${id}" matches ${matches.length} ${engine} sessions. give more of the id`);
    }
    picked = matches.find((s) => s.id === id) || matches[0];
  }

  const read = await READERS[engine].read(picked);
  if (!read) throw new Error(`could not read the ${engine} session ${picked.id}`);
  if (!read.messages.length) {
    throw new Error(
      `${engine} session ${picked.id} parsed to no messages. its transcript format has moved, `
      + "so moshcode is refusing rather than handing on an empty conversation",
    );
  }
  return {
    engine,
    id: read.id || picked.id,
    cwd: read.cwd || picked.cwd || cwd || "",
    file: picked.file,
    start: read.start,
    end: read.end,
    messages: read.messages,
    changes: read.changes,
  };
}
