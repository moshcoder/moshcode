// `moshcode pwd` / `/pwd` — where am I? Shows the current directory and, when
// inside a git repo, the repo root, branch, and origin. Zero-dependency: we
// read the .git dir directly instead of spawning git (moshcode stays lean and
// works even when git isn't on PATH).
import fs from "node:fs";
import path from "node:path";

// Resolve a `.git` entry (dir or worktree/submodule file `gitdir: <path>`) to
// its actual git directory, or null if it can't be read.
function resolveGitDir(dotgit, dir) {
  try {
    const st = fs.statSync(dotgit);
    if (st.isDirectory()) return dotgit;
    if (st.isFile()) {
      const m = /gitdir:\s*(.+)\s*/.exec(fs.readFileSync(dotgit, "utf8"));
      return m ? path.resolve(dir, m[1].trim()) : null;
    }
  } catch { /* fall through */ }
  return null;
}

// Walk up from `start` until we find a `.git` with a readable HEAD (a real
// repo). A bare `.git` dir with no HEAD — e.g. a stray /tmp/.git — is skipped,
// not mistaken for a repo. Returns { root, gitDir } or null at the fs root.
function findGit(start) {
  let dir = start;
  for (;;) {
    const dotgit = path.join(dir, ".git");
    if (fs.existsSync(dotgit)) {
      const gitDir = resolveGitDir(dotgit, dir);
      if (gitDir && fs.existsSync(path.join(gitDir, "HEAD"))) return { root: dir, gitDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached "/" (or a drive root)
    dir = parent;
  }
}

function readBranch(gitDir) {
  try {
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (m) return m[1];
    return head.slice(0, 12) + " (detached)"; // detached HEAD → short sha
  } catch {
    return null;
  }
}

function readOrigin(gitDir) {
  try {
    const cfg = fs.readFileSync(path.join(gitDir, "config"), "utf8");
    // Find the [remote "origin"] section's url. Fall back to the first remote.
    const origin = /\[remote "origin"\][^[]*?url\s*=\s*(.+)/s.exec(cfg);
    if (origin) return origin[1].split("\n")[0].trim();
    const any = /\[remote "[^"]+"\][^[]*?url\s*=\s*(.+)/s.exec(cfg);
    return any ? any[1].split("\n")[0].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve where we are. Returns { cwd, home, git }, where git is null outside a
 * repo, else { root, name, branch, origin }.
 */
export function locate(cwd = process.cwd()) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const found = findGit(cwd);
  if (!found || !found.gitDir) return { cwd, home, git: null };
  return {
    cwd,
    home,
    git: {
      root: found.root,
      name: path.basename(found.root),
      branch: readBranch(found.gitDir),
      origin: readOrigin(found.gitDir),
    },
  };
}

// Collapse $HOME to `~` for tidy display.
export function tilde(p, home) {
  if (!home || p === home) return home ? "~" : p;
  const relative = p.slice(home.length);
  return p.startsWith(home) && relative.startsWith(path.sep) ? "~" + relative : p;
}
