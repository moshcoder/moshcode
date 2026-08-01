import { spawn } from "node:child_process";

/**
 * Opening a URL in the user's browser.
 *
 * auth.mjs and commands.mjs each carry a private copy of this; new callers get
 * this one rather than making a third. Folding those two in is a separate
 * change — they sit on the login path and are not worth disturbing here.
 */

/** Is there plausibly a browser to open? False on headless boxes, CI and SSH. */
export function canOpenBrowser() {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT) return false;
  if (process.platform === "darwin" || process.platform === "win32") return true;
  // Linux/BSD: only with a display server. Spawning xdg-open on a server does
  // nothing useful and can hang.
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Fire-and-forget open of a URL. Never throws; returns whether it was attempted. */
export function openBrowser(url, { spawnImpl = spawn } = {}) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    const child = spawnImpl(cmd, args, { stdio: "ignore", detached: true });
    child.on?.("error", () => {}); // no opener installed — stay quiet
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
