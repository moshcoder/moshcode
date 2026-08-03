// Starting stacks for services published at a Moshpit name.
//
// Hosting at a Moshpit ending is four files and one non-obvious fact — that
// the machine serving the name never resolves it, and every visitor's machine
// must. People get that wrong in the same way every time, so the fix is a
// template that already has it right rather than a paragraph they read after
// the site did not come up.
//
// A template is a directory of files and nothing else. Nothing here runs,
// evaluates, or sources anything out of one, including the bundled ones: the
// whole point of `install <url>` is that the URL is a stranger's, and a
// template that could execute on install would be a remote code execution
// feature wearing a scaffold's clothes. Files are copied, and the reader
// decides what to run.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where the templates that ship with moshcode live. */
export const BUNDLED_DIR = path.join(HERE, "..", "examples", "templates");

/** The manifest is metadata about the copy, not part of it. */
const MANIFEST = "template.json";

/* ------------------------------------------------------------------ listing */

/** The bundled templates, each with whatever its manifest says about it. */
export async function listTemplates(dir = BUNDLED_DIR) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let description = "";
    try {
      const raw = await fs.readFile(path.join(dir, entry.name, MANIFEST), "utf8");
      const parsed = JSON.parse(raw);
      description = typeof parsed?.description === "string" ? parsed.description : "";
    } catch {
      // A directory without a readable manifest is still a template. Listing it
      // without a description beats hiding it because its metadata is wrong.
    }
    found.push({ name: entry.name, description });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/* ----------------------------------------------------------------- sourcing */

/**
 * What kind of thing is this, and can we fetch it?
 *
 * Deliberately conservative about what counts as a bundled name: anything with
 * a slash, a colon, or a dot is treated as remote, so a name can never be
 * coaxed into reading a path outside the bundled directory.
 */
export function classifySource(spec) {
  const raw = String(spec ?? "").trim();
  if (!raw) return { kind: "none" };

  if (/^git@|\.git$|^git\+/i.test(raw)) return { kind: "git", url: raw.replace(/^git\+/i, "") };
  if (/^https?:\/\//i.test(raw)) {
    return /\.(tar\.gz|tgz)$/i.test(raw) ? { kind: "tarball", url: raw } : { kind: "git", url: raw };
  }
  if (/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(raw)) {
    // owner/repo, the shorthand everyone types.
    return { kind: "git", url: `https://github.com/${raw}.git` };
  }
  if (/^[a-z0-9][a-z0-9-]*$/i.test(raw)) return { kind: "bundled", name: raw };
  return { kind: "unusable", spec: raw };
}

/**
 * Is this archive member safe to write?
 *
 * An absolute path or one that climbs out of the extraction directory writes
 * wherever the attacker chose — `/etc/systemd/system/anything.service` is a
 * root shell on the next boot. tar itself refuses most of these, but the check
 * is cheap and this is not a place to rely on someone else's default.
 */
export function safeEntry(entry) {
  const name = String(entry ?? "");
  if (!name || name.startsWith("/") || /^[a-z]:/i.test(name)) return false;
  if (name.split(/[/\\]/).some((part) => part === "..")) return false;
  return true;
}

/* ----------------------------------------------------------------- copying */

/** Every file under `dir`, relative to it. */
async function walk(dir, base = dir) {
  const files = [];
  const unsafe = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { files, unsafe };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(base, full);
    if (entry.isSymbolicLink()) {
      unsafe.push(relative);
    } else if (entry.isDirectory()) {
      const nested = await walk(full, base);
      files.push(...nested.files);
      unsafe.push(...nested.unsafe);
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      unsafe.push(relative);
    }
  }
  return { files, unsafe };
}

/**
 * What installing would write, and what it would land on top of.
 *
 * Separated from the writing so a conflict can be reported before anything has
 * been changed. Half-installing a template over someone's Caddyfile and then
 * stopping is worse than not starting.
 */
export async function installPlan(from, into) {
  const walked = await walk(from);
  const files = walked.files.filter((f) => path.basename(f) !== MANIFEST);
  const conflicts = [];
  for (const file of files) {
    try {
      await fs.access(path.join(into, file));
      conflicts.push(file);
    } catch {
      /* absent, which is what we want */
    }
  }
  return { files: files.sort(), conflicts: conflicts.sort(), unsafe: walked.unsafe.sort() };
}

/** Copy the planned files. Directories are created as needed. */
export async function applyInstall(from, into, files) {
  for (const file of files) {
    const stat = await fs.lstat(path.join(from, file));
    if (!stat.isFile()) throw new Error(`template entry is not a regular file: ${file}`);
  }
  for (const file of files) {
    const target = path.join(into, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(from, file), target);
  }
}

/* -------------------------------------------------------------- fetching */

function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore" });
    let stdout = "";
    if (capture) child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => resolve({ ok: false, code: null, stdout }));
    child.on("close", (code) => resolve({ ok: code === 0, code, stdout }));
  });
}

/**
 * Put a remote template on disk and return the directory holding it.
 *
 * Both paths shell out rather than reimplementing git or tar. The cost is a
 * dependency on tools that are already on any machine that could plausibly
 * deploy a service; the alternative is a tar parser in a CLI that does not
 * otherwise need one.
 */
export async function fetchRemote(
  source,
  { tmpRoot = os.tmpdir(), fetchImpl = fetch, runImpl = run } = {},
) {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "moshcode-template-"));

  if (source.kind === "git") {
    const cloned = await runImpl("git", ["clone", "--depth", "1", "--quiet", source.url, dir]);
    if (!cloned.ok) return { ok: false, error: `could not clone ${source.url}`, dir, cleanupDir: dir };
    // The clone's own history is not part of the template.
    await fs.rm(path.join(dir, ".git"), { recursive: true, force: true });
    return { ok: true, dir, cleanupDir: dir };
  }

  if (source.kind === "tarball") {
    const archive = path.join(dir, "template.tar.gz");
    let body;
    try {
      const res = await fetchImpl(source.url);
      if (!res.ok) return { ok: false, error: `${source.url} answered ${res.status}`, dir, cleanupDir: dir };
      body = Buffer.from(await res.arrayBuffer());
    } catch {
      return { ok: false, error: `could not fetch ${source.url}`, dir, cleanupDir: dir };
    }
    await fs.writeFile(archive, body);

    // Read the manifest of members before unpacking, not after. Checking the
    // extracted tree would be theatre: by then tar has already written
    // wherever the entry said, and /etc/systemd/system/anything.service is a
    // root shell on the next boot.
    const listed = await runImpl("tar", ["-tzf", archive], { capture: true });
    if (!listed.ok) return { ok: false, error: "could not read the archive", dir, cleanupDir: dir };
    const unsafe = listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean).find((e) => !safeEntry(e));
    if (unsafe) return { ok: false, error: `archive writes outside the target: ${unsafe}`, dir, cleanupDir: dir };

    const out = path.join(dir, "unpacked");
    await fs.mkdir(out, { recursive: true });
    const extracted = await runImpl("tar", [
      "-xzf", archive, "-C", out,
      "--strip-components=1",
      "--no-same-owner", "--no-same-permissions",
    ]);
    if (!extracted.ok) return { ok: false, error: "could not unpack the archive", dir, cleanupDir: dir };
    return { ok: true, dir: out, cleanupDir: dir };
  }

  return { ok: false, error: "not a template source", dir, cleanupDir: dir };
}

/* ------------------------------------------------------------------- verb */

const USAGE = `moshcode template — starting stacks for Moshpit-hosted services

  moshcode template list                    the templates that ship with moshcode
  moshcode template install <name>          copy a bundled one into this directory
  moshcode template install <url>           copy one from a git repo or a .tar.gz
  moshcode template install <owner/repo>    the GitHub shorthand

  --into <dir>   write somewhere other than the current directory
  --force        overwrite files that are already there
  --dry-run      show every create/overwrite without writing anything

Nothing in a template is executed on install — the files are copied and what to
run is yours to decide. Read them before you do.`;

/**
 * Split `install` arguments into the source, the destination, and the flags.
 *
 * Written as a scan rather than an indexOf-per-flag because `--into` consumes
 * the token after it: a filter that only drops things starting with `--` would
 * happily treat that directory as the template name.
 */
export function parseInstallArgs(args = []) {
  let spec = null;
  let into = null;
  let force = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--force") { force = true; continue; }
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (arg === "--into") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        return { spec, into, force, dryRun, error: "--into requires a directory" };
      }
      into = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--into=")) {
      into = arg.slice("--into=".length) || null;
      if (!into) return { spec, into, force, dryRun, error: "--into requires a directory" };
      continue;
    }
    if (arg.startsWith("-")) {
      return { spec, into, force, dryRun, error: `unknown option ${JSON.stringify(arg)}` };
    }
    if (spec === null) spec = arg;
  }
  return { spec, into, force, dryRun };
}

export async function templateCommand(
  args = [],
  out = console.log,
  { fetchRemoteImpl = fetchRemote, cwd = process.cwd() } = {},
) {
  const [sub, ...rest] = args;

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    out(USAGE);
    return 0;
  }

  if (sub === "list") {
    const templates = await listTemplates();
    if (!templates.length) {
      out("no templates bundled with this install");
      return 0;
    }
    const width = Math.max(...templates.map((t) => t.name.length));
    for (const { name, description } of templates) {
      out(`  ${name.padEnd(width)}  ${description}`);
    }
    out("");
    out("install one with: moshcode template install <name>");
    return 0;
  }

  if (sub !== "install") {
    out(`moshcode template: unknown subcommand ${JSON.stringify(sub)}`);
    out(USAGE);
    return 1;
  }

  const parsed = parseInstallArgs(rest);
  if (parsed.error) {
    out(`moshcode template install: ${parsed.error}`);
    return 1;
  }
  const { spec, into: intoArg, force, dryRun } = parsed;
  const source = classifySource(spec);
  if (source.kind === "none") {
    out("moshcode template install: name a template, a git URL, or a .tar.gz");
    return 1;
  }
  if (source.kind === "unusable") {
    out(`moshcode template install: ${JSON.stringify(source.spec)} is not a template name or a URL`);
    return 1;
  }

  const into = path.resolve(cwd, intoArg || ".");

  let from = null;
  let cleanup = null;
  if (source.kind === "bundled") {
    from = path.join(BUNDLED_DIR, source.name);
    try {
      await fs.access(from);
    } catch {
      out(`moshcode template install: no bundled template named ${JSON.stringify(source.name)}`);
      out("see what there is with: moshcode template list");
      return 1;
    }
  } else {
    out(`fetching ${source.url} …`);
    const fetched = await fetchRemoteImpl(source);
    if (!fetched.ok) {
      await fs.rm(fetched.cleanupDir || fetched.dir, { recursive: true, force: true }).catch(() => {});
      out(`moshcode template install: ${fetched.error}`);
      return 1;
    }
    from = fetched.dir;
    cleanup = fetched.cleanupDir || fetched.dir;
  }

  try {
    const { files, conflicts, unsafe } = await installPlan(from, into);
    if (unsafe.length) {
      out(`moshcode template install: links and special files are not allowed (${unsafe.length} found):`);
      for (const file of unsafe.slice(0, 10)) out(`  ${file}`);
      if (unsafe.length > 10) out(`  … and ${unsafe.length - 10} more`);
      out("nothing was written. Replace them with ordinary files and try again.");
      return 1;
    }
    if (!files.length) {
      out("moshcode template install: that template has no files in it");
      return 1;
    }
    if (dryRun) {
      const conflictSet = new Set(conflicts);
      for (const file of files) out(`  ${conflictSet.has(file) ? "overwrite" : "create"}  ${file}`);
      out("");
      if (conflicts.length && !force) {
        out(`${conflicts.length} existing file${conflicts.length === 1 ? "" : "s"} would block this install.`);
        out("Nothing was written. Re-run with --force --dry-run to preview overwrites.");
        return 1;
      }
      out(`${files.length} file${files.length === 1 ? "" : "s"} would be written to ${into}`);
      out("dry run; nothing was written");
      return 0;
    }
    if (conflicts.length && !force) {
      out(`moshcode template install: ${conflicts.length} file${conflicts.length === 1 ? "" : "s"} already exist here:`);
      for (const file of conflicts.slice(0, 10)) out(`  ${file}`);
      if (conflicts.length > 10) out(`  … and ${conflicts.length - 10} more`);
      out("nothing was written. Re-run with --force to overwrite, or --into <dir>.");
      return 1;
    }

    await applyInstall(from, into, files);
    for (const file of files) out(`  ${file}`);
    out("");
    out(`${files.length} file${files.length === 1 ? "" : "s"} written to ${into}`);
    out("read them before running anything — start with README.md");
    return 0;
  } finally {
    if (cleanup) await fs.rm(cleanup, { recursive: true, force: true }).catch(() => {});
  }
}
