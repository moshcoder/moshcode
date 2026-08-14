// One answer to "how does the pit run a shell command".
//
// The pit is not a shell, so everything it runs on the user's behalf goes out
// through $SHELL: `!cmd`, `/shell`, a shell-valued alias from /alias, and
// moshscript's shell(). The obvious spelling is `$SHELL -c "<cmd>"`, and it is
// wrong in a way that costs an afternoon to find. `zsh -c` and `bash -c` are
// non-interactive shells, and a non-interactive shell does not read ~/.zshrc or
// ~/.bashrc — so the aliases and functions defined there are simply not there:
//
//   /alias set prs gh-prs-all     → zsh -c gh-prs-all
//                                 → zsh:1: command not found: gh-prs-all
//
// while the identical word works when typed at a prompt. That is a bug rather
// than a footnote, because naming a shell command is most of what /alias is
// for, and the shell commands people name are the ones they already named once
// in ~/.zsh_aliases. An alias that resolves at the prompt and not in the pit
// makes the pit look broken, and from the user's side it is.
//
// So we ask for an interactive shell. `-i` is the switch that makes bash and
// zsh read their rc file, and the rc file is where the user's shell actually
// lives. Anything already on PATH worked before and still works; what changes
// is that aliases and functions now resolve too.

/**
 * Shells whose startup file is read only when the shell is interactive.
 *
 * Deliberately just bash and zsh. fish sources config.fish however it was
 * started, so it needs nothing from us; plain sh/dash have no rc file to miss
 * and `-i` would only buy them job-control machinery; and a shell we have not
 * heard of is likelier to be harmed by an unexpected flag than helped by it.
 * Being wrong here means running a command in a shell that cannot see the
 * user's aliases, which is exactly where we started — so an unknown shell
 * lands on the old behaviour rather than on a guess.
 */
const RC_ON_INTERACTIVE = new Set(["bash", "zsh"]);

/** Set this to opt a session out of rc loading and get plain `-c` back. */
export const NO_RC_ENV = "MOSHCODE_SHELL_NO_RC";

/** Windows has no rc file in this sense; cmd.exe wants its own flag spelling. */
const CMD_FLAGS = ["/d", "/s", "/c"];

/** The shell the user runs, or the platform's fallback. */
export function shellPath(env = process.env, platform = process.platform) {
  if (platform === "win32") return env.COMSPEC || "cmd.exe";
  return env.SHELL || "/bin/sh";
}

/**
 * `zsh` from `/usr/bin/zsh`, `bash` from `C:\...\bash.exe`.
 *
 * Both separators by hand rather than path.basename, which is bound to the
 * platform the code is running on: it would leave a Windows path intact when
 * asked on Linux, and this function is also asked about the other platform —
 * shellInvocation takes `platform` as an option so the Windows branch can be
 * tested from anywhere.
 */
export function shellName(shell) {
  const tail = String(shell || "").split(/[\\/]/).pop() || "";
  return tail.replace(/\.exe$/i, "");
}

/**
 * How to spawn `rawCmd`, as { shell, args, flags, interactive }.
 *
 * `rawCmd` empty means "a shell to sit in" — no args at all, which is already
 * an interactive shell and already reads the rc file.
 *
 * `tty` is why this takes options rather than reading the world directly. An
 * interactive bash with no terminal attached prints
 *
 *   bash: cannot set terminal process group (…): Inappropriate ioctl for device
 *   bash: no job control in this shell
 *
 * on stderr before it runs a thing, which would turn every headless run — cron,
 * CI, `moshcode run script.mosh` in a pipeline — into noise around the output
 * someone is trying to read. With a terminal attached, both shells are silent.
 * So the rc file is loaded where a person is watching, which is the case that
 * wanted it, and a headless run keeps the old quiet behaviour. zsh alone would
 * not need the guard; the guard is not worth splitting per shell for.
 */
export function shellInvocation(rawCmd, {
  env = process.env,
  platform = process.platform,
  tty = Boolean(process.stdin?.isTTY && process.stdout?.isTTY),
} = {}) {
  const shell = shellPath(env, platform);
  const name = shellName(shell);
  if (!rawCmd) return { shell, args: [], flags: "", interactive: true, name };
  if (platform === "win32") {
    return { shell, args: [...CMD_FLAGS, rawCmd], flags: CMD_FLAGS.join(" "), interactive: false, name };
  }
  const interactive = tty && RC_ON_INTERACTIVE.has(name) && !env[NO_RC_ENV];
  const flags = interactive ? "-ic" : "-c";
  return { shell, args: [flags, rawCmd], flags, interactive, name };
}
