import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { locate, tilde } from "../src/pwd.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

test("tilde shortens the home directory itself", () => {
  const home = path.join("C:", "Users", "mosh");

  assert.equal(tilde(home, home), "~");
});

test("tilde shortens paths inside home", () => {
  const home = path.join("C:", "Users", "mosh");
  const project = path.join(home, "repo");

  assert.equal(tilde(project, home), `~${path.sep}repo`);
});

test("tilde does not shorten sibling paths with the same prefix", () => {
  const home = path.join("C:", "Users", "mosh");
  const sibling = path.join("C:", "Users", "mosh-other", "repo");

  assert.equal(tilde(sibling, home), sibling);
});

// Build a main repo plus one linked worktree the way git lays them out on disk,
// without needing git on PATH: the worktree's `.git` is a file pointing at
// .git/worktrees/<name>, which carries its own HEAD and a `commondir` back to
// the main git dir that holds the shared config.
function fakeWorktree(root, { commondir }) {
  const mainGit = path.join(root, "main", ".git");
  const linkedGit = path.join(mainGit, "worktrees", "feature");
  fs.mkdirSync(linkedGit, { recursive: true });
  fs.writeFileSync(path.join(mainGit, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(
    path.join(mainGit, "config"),
    '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/moshcoder/moshcode.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
  );
  fs.writeFileSync(path.join(linkedGit, "HEAD"), "ref: refs/heads/feature\n");
  fs.writeFileSync(path.join(linkedGit, "commondir"), `${commondir}\n`);

  const worktree = path.join(root, "feature");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${linkedGit}\n`);
  return worktree;
}

test("locate reports origin from inside a linked worktree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-worktree-"));
  try {
    // git writes commondir relative to the worktree's own git dir.
    const worktree = fakeWorktree(root, { commondir: path.join("..", "..") });
    const { git } = locate(worktree);

    assert.equal(git.branch, "feature");
    assert.equal(git.origin, "https://github.com/moshcoder/moshcode.git");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("locate follows an absolute commondir too", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-worktree-"));
  try {
    const worktree = fakeWorktree(root, { commondir: path.join(root, "main", ".git") });
    const { git } = locate(worktree);

    assert.equal(git.origin, "https://github.com/moshcoder/moshcode.git");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pwd --json prints only the machine-readable location and git context", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-pwd-json-"));
  try {
    const worktree = fakeWorktree(root, { commondir: path.join("..", "..") });
    const result = spawnSync(process.execPath, [BIN, "pwd", "--json"], {
      cwd: worktree,
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      cwd: worktree,
      git: {
        root: worktree,
        name: "feature",
        branch: "feature",
        origin: "https://github.com/moshcoder/moshcode.git",
      },
    });
    assert.doesNotMatch(result.stdout, /"home"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
