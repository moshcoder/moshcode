// `moshcode export users [--clean]` and `/export users`: the operator's list of
// signed-up accounts, from app.moshcode.sh's /api/admin/users/export.
//
// The app decides who may have it (ADMIN_EMAILS there); this side only asks
// with the logged-in account's key, so a non-operator gets the app's 403 and
// nothing else. `--clean` hands the CSV to cli-tools' `email-cleaner` and keeps
// the rows it calls valid. There is no silent fallback: an export that says it
// was cleaned and was not is worse than one that fails.
//
// Addresses never reach the screen from the pit. The CLI writes CSV to stdout
// only when asked to (no -o, not in the pit), so it can be piped; every human
// line (counts, where the file went) goes to stderr.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadCreds } from "./auth.mjs";

/** Column order of the export, matching the app's EXPORT_COLUMNS. */
export const EXPORT_COLUMNS = ["email", "display_name", "created_at", "id", "signup_method"];

/** email-cleaner's own flags that `--clean` passes through untouched. */
export const CLEANER_FLAGS = [
  "--allow-role", "--allow-disposable", "--allow-duplicates", "--allow-unlikely",
  "--allow-no-website", "--no-dns", "--fix-typos",
];

const USAGE = "usage: export users [--clean [cleaner flags]] [--format csv|json] [-o file]";
const DEFAULT_API = "https://app.moshcode.sh";

/* ------------------------------------------------------------------ parsing */

export function parseExportArgs(argv = []) {
  const opts = { subject: null, clean: false, format: "csv", output: null, cleanerFlags: [], error: null };
  const fail = (msg) => ({ ...opts, error: msg });
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "--clean") opts.clean = true;
    else if (a === "--format" || a.startsWith("--format=")) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      if (!["csv", "json"].includes(String(v || "").toLowerCase())) return fail(`--format takes csv or json. ${USAGE}`);
      opts.format = String(v).toLowerCase();
    } else if (a === "-o" || a === "--output" || a.startsWith("--output=")) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      if (!v || String(v).startsWith("-")) return fail(`${a} needs a file name. ${USAGE}`);
      opts.output = String(v);
    } else if (CLEANER_FLAGS.includes(a)) {
      if (!opts.clean) return fail(`${a} is an email-cleaner flag, so it goes after --clean. ${USAGE}`);
      if (!opts.cleanerFlags.includes(a)) opts.cleanerFlags.push(a);
    } else if (a.startsWith("-")) return fail(`unknown option ${a}. ${USAGE}`);
    else if (!opts.subject) opts.subject = a.toLowerCase();
    else return fail(`unexpected argument ${a}. ${USAGE}`);
  }
  if (!opts.subject) return fail(USAGE);
  if (opts.subject !== "users") return fail(`nothing called "${opts.subject}" to export; only users. ${USAGE}`);
  return opts;
}

/* --------------------------------------------------------------------- CSV */

export function csvField(value, { neutralize = false } = {}) {
  let s = value === null || value === undefined ? "" : String(value);
  if (neutralize && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns = EXPORT_COLUMNS) {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvField(row[c], { neutralize: c === "display_name" })).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/* ----------------------------------------------------------- email-cleaner */

/** The first executable called `name` on `PATH`, or null. */
export function findOnPath(name, envPath = process.env.PATH || "") {
  for (const dir of String(envPath).split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch { /* keep looking */ }
  }
  return null;
}

const lower = (s) => String(s ?? "").trim().toLowerCase();

/**
 * Pair email-cleaner's verdicts with the rows that went in.
 *
 * The cleaner reports `input` (what it read), `email` (what it made of it,
 * which `--fix-typos` may have corrected) and sometimes `row`. Matching is by
 * the address first, because that is unambiguous whatever `row` counts from,
 * and then by `row` read as a data row, a line number, or a zero-based index,
 * accepted only when that row's address agrees. A verdict that matches no row
 * still comes out, carrying just its address, rather than vanishing.
 */
export function matchCleaned(rows, result) {
  const byEmail = new Map(rows.map((r, i) => [lower(r.email), i]));
  const used = new Set();
  const locate = (entry) => {
    for (const key of [lower(entry.input), lower(entry.email)]) {
      const i = byEmail.get(key);
      if (i !== undefined && !used.has(i)) return i;
    }
    const inputText = lower(entry.input);
    const n = Number(entry.row);
    if (Number.isInteger(n)) {
      for (const i of [n - 1, n - 2, n]) {
        const r = rows[i];
        if (!r || used.has(i)) continue;
        const e = lower(r.email);
        if (e && (e === lower(entry.email) || e === inputText || inputText.split(/[,;\s"]+/).includes(e))) return i;
      }
    }
    for (const [i, r] of rows.entries()) {
      if (!used.has(i) && inputText && inputText.split(/[,;\s"]+/).includes(lower(r.email))) return i;
    }
    return -1;
  };
  const take = (entry) => {
    const i = locate(entry);
    if (i >= 0) used.add(i);
    return i >= 0 ? rows[i] : null;
  };

  const kept = [];
  for (const entry of result.valid || []) {
    const row = take(entry);
    const email = String(entry.email || row?.email || "").trim();
    kept.push(row ? { ...row, email } : { email, display_name: entry.name ?? "", created_at: "", id: "", signup_method: "" });
  }
  const rejected = [];
  for (const entry of result.invalid || []) {
    const row = take(entry);
    const reasons = Array.isArray(entry.reasons) ? entry.reasons.map(String) : [];
    rejected.push({
      ...(row || { email: String(entry.email || entry.input || ""), display_name: "", created_at: "", id: "", signup_method: "" }),
      reasons: reasons.join(";"),
      suggestion: entry.suggestion ?? "",
      _reasons: reasons,
    });
  }
  const unaccounted = rows.length - used.size;
  return { kept, rejected, unaccounted: unaccounted > 0 ? unaccounted : 0 };
}

/** Run email-cleaner over `csv`. `{ ok, result }` or `{ ok: false, error }`. */
export function runCleaner(bin, csv, flags = [], { spawnImpl = spawnSync, env = process.env } = {}) {
  const res = spawnImpl(bin, ["-", "--format", "json", "--report", ...flags], {
    input: csv, encoding: "utf8", env, maxBuffer: 512 * 1024 * 1024,
  });
  if (res.error) return { ok: false, error: `could not run email-cleaner: ${res.error.message}` };
  let result = null;
  try { result = JSON.parse(res.stdout || ""); } catch { result = null; }
  if (!result || !Array.isArray(result.valid) || !Array.isArray(result.invalid)) {
    const why = String(res.stderr || "").trim().split("\n")[0] || `exit ${res.status ?? res.signal}`;
    return { ok: false, error: `email-cleaner did not return its JSON report (${why})` };
  }
  return { ok: true, result };
}

/* -------------------------------------------------------------------- files */

/** Copy `file` to `<name>.bak-NNN<ext>` beside it, if it exists. Returns the copy's path. */
export function backupBeside(file) {
  if (!fs.existsSync(file)) return null;
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  let n = 1;
  let backup;
  do { backup = `${stem}.bak-${String(n).padStart(3, "0")}${ext}`; n += 1; } while (fs.existsSync(backup));
  fs.copyFileSync(file, backup);
  return backup;
}

/** Write `text` to `file` readable by its owner only, backing up what was there. */
export function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = backupBeside(file);
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return backup;
}

/** `users.csv` to `users.rejected.csv`. */
export function rejectedPath(file) {
  const ext = path.extname(file);
  return `${ext ? file.slice(0, -ext.length) : file}.rejected.csv`;
}

function defaultFile(home, format, now) {
  const stamp = now.toISOString().replace(/\.\d+Z$/, "").replace(/[:T]/g, (c) => (c === "T" ? "-" : ""));
  return path.join(home, ".moshcode", "exports", `users-${stamp}.${format}`);
}

/* ------------------------------------------------------------------ command */

function tally(rejected) {
  const byReason = {};
  for (const r of rejected) {
    const reasons = r._reasons.length ? r._reasons : ["unspecified"];
    for (const reason of reasons) byReason[reason] = (byReason[reason] || 0) + 1;
  }
  return byReason;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Returns an exit code. `pit` means the session UI: output always goes to a
 * file (default ~/.moshcode/exports/users-<time>.<format>), never the screen.
 */
export async function exportCommand(argv = [], {
  creds = loadCreds(),
  fetchImpl = fetch,
  env = process.env,
  write = (line) => console.error(line),
  stdout = (text) => process.stdout.write(text),
  spawnImpl = spawnSync,
  home = os.homedir(),
  cwd = process.cwd(),
  now = new Date(),
  pit = false,
} = {}) {
  const opts = parseExportArgs(argv);
  if (opts.error) { write(opts.error); return 1; }

  let cleaner = null;
  if (opts.clean) {
    cleaner = findOnPath("email-cleaner", env.PATH || "");
    if (!cleaner) {
      write("--clean needs email-cleaner, which is not on PATH: install cli-tools (`moshcode install cli-tools`) and run this again");
      return 1;
    }
  }
  if (!creds?.token) {
    write("not logged in: run `moshcode login` (or /login) with an operator account first");
    return 1;
  }

  const api = (env.MOSHCODE_API || creds.api || DEFAULT_API).replace(/\/+$/, "");
  let res;
  try {
    res = await fetchImpl(`${api}/api/admin/users/export?format=json`, {
      headers: { authorization: `Bearer ${creds.token}`, accept: "application/json" },
    });
  } catch (error) {
    write(`could not reach ${api}: ${error?.message || error}`);
    return 1;
  }
  if (res.status === 401) { write("the app rejected this machine's credentials: run `moshcode login` again"); return 1; }
  if (res.status === 403) { write(`${api} says this account is not an operator (ADMIN_EMAILS on the app decides)`); return 1; }
  if (!res.ok) { write(`the export failed: ${api} returned ${res.status}`); return 1; }
  let body;
  try { body = await res.json(); } catch { write("the app's answer was not JSON"); return 1; }
  const rows = Array.isArray(body?.users) ? body.users : [];
  const counts = body?.counts || {};

  let kept = rows;
  let rejected = [];
  let unaccounted = 0;
  if (opts.clean) {
    const ran = runCleaner(cleaner, toCsv(rows), opts.cleanerFlags, { spawnImpl, env });
    if (!ran.ok) { write(ran.error); return 1; }
    ({ kept, rejected, unaccounted } = matchCleaned(rows, ran.result));
  }

  const payload = opts.format === "json"
    ? `${JSON.stringify({ columns: EXPORT_COLUMNS, users: kept, counts, ...(opts.clean ? { rejected: rejected.map(({ _reasons, ...r }) => r) } : {}) }, null, 2)}\n`
    : toCsv(kept);

  const file = opts.output ? path.resolve(cwd, opts.output) : (pit ? defaultFile(home, opts.format, now) : null);
  const notes = [];
  if (file) {
    const backup = writePrivate(file, payload);
    if (backup) notes.push(`backed up the previous ${path.basename(file)} to ${backup}`);
  } else {
    stdout(payload);
  }

  let rejectedFile = null;
  if (opts.clean && file) {
    rejectedFile = rejectedPath(file);
    const backup = writePrivate(rejectedFile, toCsv(rejected, [...EXPORT_COLUMNS, "reasons", "suggestion"]));
    if (backup) notes.push(`backed up the previous ${path.basename(rejectedFile)} to ${backup}`);
  }

  // The summary. Counts and paths only: never an address.
  const without = counts.without_email_by_method || {};
  const methods = ["password", "passkey", "coinpay", "unknown"].filter((m) => without[m]).map((m) => `${without[m]} ${m}`);
  write(`exported ${plural(rows.length, "user")} with an email`
    + ` (${counts.without_email ?? 0} without one${methods.length ? `: ${methods.join(", ")}` : ""}; ${counts.total ?? rows.length} accounts in all)`);
  if (opts.clean) {
    const reasons = Object.entries(tally(rejected)).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`);
    write(`cleaned: total ${rows.length}, kept ${kept.length}, rejected ${rejected.length}${reasons.length ? ` (${reasons.join(", ")})` : ""}`);
    if (unaccounted) write(`email-cleaner gave no verdict on ${plural(unaccounted, "row")}; they are in neither file`);
  }
  if (file) write(`wrote ${file} (owner-only, 0600)`);
  if (rejectedFile) write(`rejected rows, with reasons: ${rejectedFile}`);
  for (const note of notes) write(note);
  return 0;
}
