// Tmux-backed tabs for the interactive mosh pit.
//
// The pit deliberately hands a provider CLI the whole terminal with inherited
// stdio. Keeping that contract matters: full-screen TUIs, mouse handling,
// colours, signals, and provider-specific shortcuts should remain native. A
// tab therefore cannot be an in-process readline view. It is another moshcode
// process in another tmux window, with tmux owning the terminal multiplexing.
import { spawn, spawnSync } from "node:child_process";

/** POSIX-shell quoting for tmux's single `shell-command` argument. */
export function tabShellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Command run in every tab. Always opens a fresh pit, never repeats argv. */
export function tabCommand({ execPath = process.execPath, entry = process.argv[1] } = {}) {
  if (!entry) throw new Error("can't locate the moshcode entrypoint");
  return `exec ${tabShellQuote(execPath)} ${tabShellQuote(entry)}`;
}

/**
 * Pure tmux command plan, split out so the safety-sensitive argv is testable
 * without opening real windows in the test runner.
 */
export function tabPlan({
  cwd = process.cwd(),
  command = tabCommand(),
  tmux = process.env.TMUX,
  pid = process.pid,
  stamp = Date.now(),
} = {}) {
  if (tmux) {
    return {
      dedicated: false,
      session: null,
      socket: null,
      required: [["new-window", "-c", cwd, "-n", "mosh", command]],
      optional: [],
      attach: null,
    };
  }

  // A private server gets the current environment at creation time. Reusing a
  // detached default server here could give provider CLIs stale PATH/API vars.
  const suffix = `${pid}-${stamp}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const socket = `moshcode-${suffix}`;
  const session = `moshcode-${suffix}`;
  const server = ["-L", socket];
  return {
    dedicated: true,
    session,
    socket,
    required: [
      [...server, "new-session", "-d", "-s", session, "-c", cwd, "-n", "mosh 1", command],
      // Do not use -d: selecting the new window avoids assuming whether the
      // user's tmux config starts window indexes at 0 or 1.
      [...server, "new-window", "-t", session, "-c", cwd, "-n", "mosh 2", command],
    ],
    // Presentation is best-effort: an older tmux should still open the tabs.
    optional: [
      [...server, "set-option", "-t", session, "status", "on"],
      [...server, "set-option", "-t", session, "status-position", "bottom"],
      [...server, "set-option", "-t", session, "status-right", " Ctrl-b n/p · /new "],
    ],
    attach: [...server, "attach-session", "-t", session],
  };
}

function resultError(result) {
  if (result?.error?.code === "ENOENT") return "tmux is not installed";
  if (result?.error) return result.error.message || String(result.error);
  const detail = String(result?.stderr || result?.stdout || "").trim();
  return detail || `tmux exited ${result?.status ?? "without a status"}`;
}

function runAttached(args, { spawner = spawn, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawner("tmux", args, { stdio: "inherit", env }); }
    catch (error) { resolve({ ok: false, error }); return; }
    child.on("error", (error) => resolve({ ok: false, error }));
    child.on("exit", (code, signal) => resolve({ ok: code === 0, code, signal }));
  });
}

/**
 * Open and switch to a new pit tab.
 *
 * Inside tmux this adds one window to the current session. Outside tmux it
 * starts a private two-window workspace and attaches to it; this is the only
 * way the already-running, non-tmux pit can gain a sibling without replacing
 * the provider-friendly inherited-stdio architecture.
 */
export async function openNewTab({
  cwd = process.cwd(),
  env = process.env,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  runner = spawnSync,
  spawner = spawn,
  execPath = process.execPath,
  entry = process.argv[1],
  pid = process.pid,
  stamp = Date.now(),
} = {}) {
  if (!isTTY) return { ok: false, error: new Error("/new needs an interactive terminal") };

  let command;
  try { command = tabCommand({ execPath, entry }); }
  catch (error) { return { ok: false, error }; }
  const plan = tabPlan({ cwd, command, tmux: env.TMUX, pid, stamp });

  for (const args of plan.required) {
    const result = runner("tmux", args, { encoding: "utf8", env });
    if (result?.status !== 0) {
      // Only a private server created by this call is eligible for cleanup.
      if (plan.dedicated) {
        runner("tmux", ["-L", plan.socket, "kill-server"], { stdio: "ignore", env });
      }
      return { ok: false, error: new Error(resultError(result)) };
    }
  }
  for (const args of plan.optional) runner("tmux", args, { stdio: "ignore", env });

  if (!plan.attach) return { ok: true, dedicated: false };
  const attached = await runAttached(plan.attach, { spawner, env });
  if (!attached.ok) {
    return { ok: false, error: attached.error || new Error(`tmux attach exited ${attached.code ?? attached.signal ?? "unknown"}`) };
  }
  return { ok: true, dedicated: true, session: plan.session, socket: plan.socket };
}
