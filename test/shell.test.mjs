import assert from "node:assert/strict";
import test from "node:test";

import { NO_RC_ENV, shellInvocation, shellName, shellPath } from "../src/shell.mjs";

// A terminal is attached in the case that matters (the pit), so most of these
// pass tty: true explicitly rather than inheriting whatever ran the suite —
// `node --test` under CI has no tty and would otherwise flip every assertion.
const zsh = { env: { SHELL: "/usr/bin/zsh" }, platform: "linux", tty: true };

test("an interactive shell is what loads ~/.zshrc, so zsh gets -ic", () => {
  const { shell, args, flags, interactive } = shellInvocation("gh-prs-all", zsh);
  assert.equal(shell, "/usr/bin/zsh");
  assert.deepEqual(args, ["-ic", "gh-prs-all"]);
  assert.equal(flags, "-ic");
  assert.equal(interactive, true);
});

test("bash gets it too — ~/.bashrc is skipped by a non-interactive shell the same way", () => {
  const { args } = shellInvocation("ll", { ...zsh, env: { SHELL: "/bin/bash" } });
  assert.deepEqual(args, ["-ic", "ll"]);
});

test("the command is one argument, so the shell does its own parsing", () => {
  // Re-splitting would turn `-m "two words"` into two arguments; the whole
  // point of handing $SHELL a string is that quoting survives.
  const { args } = shellInvocation('git commit -m "two words"', zsh);
  assert.equal(args.length, 2);
  assert.equal(args[1], 'git commit -m "two words"');
});

test("no command means a shell to sit in — no flags at all", () => {
  const { args, flags, interactive } = shellInvocation("", zsh);
  assert.deepEqual(args, []);
  assert.equal(flags, "");
  // A bare `zsh` already reads the rc file; there is nothing to ask for.
  assert.equal(interactive, true);
});

test("a headless run stays non-interactive, because bash -i with no tty prints job-control noise", () => {
  const { args, interactive } = shellInvocation("npm test", { ...zsh, tty: false });
  assert.deepEqual(args, ["-c", "npm test"]);
  assert.equal(interactive, false);
});

test("only stdin and stdout both being a tty counts", () => {
  // `moshcode run script.mosh > out.log` has a tty on stdin and not on stdout,
  // and the noise would land in out.log.
  const { interactive } = shellInvocation("npm test", { ...zsh, tty: false });
  assert.equal(interactive, false);
});

test(`${NO_RC_ENV} buys back the old plain -c`, () => {
  const env = { SHELL: "/usr/bin/zsh", [NO_RC_ENV]: "1" };
  const { args, interactive } = shellInvocation("gh-prs-all", { ...zsh, env });
  assert.deepEqual(args, ["-c", "gh-prs-all"]);
  assert.equal(interactive, false);
});

test("a shell we do not know keeps the old behaviour rather than getting a guessed flag", () => {
  for (const sh of ["/bin/sh", "/usr/bin/fish", "/bin/dash", "/usr/bin/nu"]) {
    const { args, interactive } = shellInvocation("echo hi", { ...zsh, env: { SHELL: sh } });
    assert.deepEqual(args, ["-c", "echo hi"], sh);
    assert.equal(interactive, false, sh);
  }
});

test("cmd.exe has no rc file and its own flag spelling", () => {
  const { shell, args, interactive } = shellInvocation("dir", {
    env: { COMSPEC: "C:\\Windows\\system32\\cmd.exe" }, platform: "win32", tty: true,
  });
  assert.equal(shell, "C:\\Windows\\system32\\cmd.exe");
  assert.deepEqual(args, ["/d", "/s", "/c", "dir"]);
  assert.equal(interactive, false);
});

test("shellPath falls back per platform", () => {
  assert.equal(shellPath({}, "linux"), "/bin/sh");
  assert.equal(shellPath({}, "win32"), "cmd.exe");
  assert.equal(shellPath({ SHELL: "/usr/bin/zsh" }, "linux"), "/usr/bin/zsh");
});

test("shellName is what the echoed line shows", () => {
  assert.equal(shellName("/usr/bin/zsh"), "zsh");
  assert.equal(shellName("C:\\Program Files\\Git\\bin\\bash.exe"), "bash");
  assert.equal(shellName(""), "");
});
