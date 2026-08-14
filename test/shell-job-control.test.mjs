// The regression this exists for: v0.52.0 started running pit commands in an
// interactive shell to pick up the user's aliases, and an interactive shell
// brings job control with it. A shell with job control makes itself a process
// group leader and takes the terminal; when it exits it can leave the terminal
// belonging to a process group that is gone. The pit's next write then takes
// SIGTTOU and the pit stops dead:
//
//   · shell exited (code 0). back in the pit.
//   [1]  + 3034615 suspended (tty output)  moshcode
//
// The unit tests in shell.test.mjs pin the flags. This one asks the real shell
// whether the flags worked, because "+m is in argv" and "job control is off" are
// different claims and only the second one matters.
//
// Job control can only be observed under a pty — without one the option is off
// no matter what is asked for, so a plain spawn would pass vacuously.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { shellInvocation } from "../src/shell.mjs";

const have = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;

/**
 * Run `probe` through the invocation moshcode would use for `shellPath`, inside a
 * pty, and return its output.
 *
 * `script -qec` is the portable-enough way to get a controlling terminal from a
 * test. The probe is passed as the command, so what is under test is the exact
 * flag list shellInvocation produced.
 */
function underPty(shellPath, probe) {
  const { shell, args } = shellInvocation(probe, {
    env: { SHELL: shellPath }, platform: "linux", tty: true,
  });
  // The command is the last argument; the flags are everything before it.
  const flags = args.slice(0, -1).join(" ");
  const r = spawnSync("script", ["-qec", `${shell} ${flags} '${probe}'`, "/dev/null"], {
    encoding: "utf8", timeout: 20000,
  });
  return { flags, out: `${r.stdout || ""}${r.stderr || ""}`.replace(/\r/g, "") };
}

const zshMissing = !have("zsh") || !have("script");

test("zsh runs pit commands with job control off, so the pit keeps the terminal", { skip: zshMissing && "needs zsh and script(1)" }, () => {
  const probe = "if [[ -o monitor ]]; then print JOBCONTROL=on; else print JOBCONTROL=off; fi";
  const { flags, out } = underPty("/usr/bin/zsh", probe);

  assert.match(flags, /\+m/, "expected +m in the flags");
  const reading = /JOBCONTROL=(on|off)/.exec(out);
  assert.ok(reading, `could not read job control state from: ${JSON.stringify(out)}`);
  // on → the pit can be suspended by its own shell command. This is the assertion
  // that v0.52.0 would have failed.
  assert.equal(reading[1], "off", `job control is ${reading[1]} with flags "${flags}"`);
});

test("and it still reads ~/.zshrc — the whole point of being interactive", { skip: zshMissing && "needs zsh and script(1)" }, () => {
  // A shell that loaded no rc file has no aliases to find, so asking whether an
  // interactive-only option is set is the same question without needing a
  // fixture in the developer's home directory.
  const probe = "if [[ -o interactive ]]; then print INTERACTIVE=yes; else print INTERACTIVE=no; fi";
  const { out } = underPty("/usr/bin/zsh", probe);

  assert.match(out, /INTERACTIVE=yes/, `expected an interactive shell, got: ${JSON.stringify(out)}`);
});
