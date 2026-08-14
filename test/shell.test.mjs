import assert from "node:assert/strict";
import test from "node:test";

import { NO_RC_ENV, shellInvocation, shellName, shellPath } from "../src/shell.mjs";

// A terminal is attached in the case that matters (the pit), so most of these
// pass tty: true explicitly rather than inheriting whatever ran the suite —
// `node --test` under CI has no tty and would otherwise flip every assertion.
const zsh = { env: { SHELL: "/usr/bin/zsh" }, platform: "linux", tty: true };

test("an interactive shell is what loads ~/.zshrc, so zsh gets -ic — with job control off", () => {
  const { shell, args, flags, interactive, jobControl } = shellInvocation("gh-prs-all", zsh);
  assert.equal(shell, "/usr/bin/zsh");
  // `+m` is not decoration. Without it the interactive shell takes the
  // terminal's process group and can fail to give it back, and the pit's next
  // write dies of SIGTTOU: "suspended (tty output)".
  assert.deepEqual(args, ["+m", "-ic", "gh-prs-all"]);
  assert.equal(flags, "+m -ic");
  assert.equal(interactive, true);
  assert.equal(jobControl, false);
});

test("bash gets it too — ~/.bashrc is skipped by a non-interactive shell the same way", () => {
  const { args, jobControl } = shellInvocation("ll", { ...zsh, env: { SHELL: "/bin/bash" } });
  // No `+m`: an interactive bash turns job control back on regardless, so
  // passing the flag would advertise a protection that is not there.
  assert.deepEqual(args, ["-ic", "ll"]);
  assert.equal(jobControl, true);
});

test("the command is one argument, so the shell does its own parsing", () => {
  // Re-splitting would turn `-m "two words"` into two arguments; the whole
  // point of handing $SHELL a string is that quoting survives.
  const { args } = shellInvocation('git commit -m "two words"', zsh);
  // Whatever the flags are, the command is always the single last argument.
  assert.equal(args.at(-1), 'git commit -m "two words"');
  assert.equal(args.filter((a) => !a.startsWith("-") && !a.startsWith("+")).length, 1);
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
