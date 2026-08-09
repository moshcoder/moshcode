// `moshcode herd tile` — every member on screen at once, in a tiled window.
//
// The clickable list was modal: you saw the herd OR a session, never both, and
// nothing on it could start or stop anything. This is the other shape — all
// members visible, click one to focus it, Ctrl-b z to blow it up, keys to start
// and stop without leaving.
//
// It is tmux doing the work, not us. `join-pane` moves a running pane out of
// its own session and into a shared window with its content and process intact;
// `select-layout tiled` arranges them; `break-pane` puts one back. Every pane
// stays a real terminal the whole time, which is the thing a hand-rolled
// side-by-side renderer cannot promise.
//
// This is why a member is identified by its pane title rather than its session
// (see paneIndex in herd.mjs): a tiled member's session no longer exists, and
// the roster, `read`, `prompt` and `wait` all have to keep working anyway.
import { spawn, spawnSync } from "node:child_process";

import { HERD_SOCKET, detectSubstrate, paneIndex, readManifest, tmux } from "./herd.mjs";
import { acid, ash, err, info, ok } from "./ui.mjs";

/** The window every tiled member is gathered into. */
export const TILE_SESSION = "tile";

/**
 * Keys bound inside the tiled window.
 *
 * Bound on moshcode's own server, which starts from no config, so this
 * overrides nobody's preference. They are deliberately shifted letters: tmux's
 * own lowercase bindings (z zoom, x kill, arrows, o next) still work, and this
 * only adds what tmux has no opinion about.
 */
export function tileBindings({ moshcode = "moshcode" } = {}) {
  return [
    // Start: a shell, or an agent, as a new tile in the same directory.
    ["S", `split-window -c "#{pane_current_path}" ; select-layout tiled`],
    ["A", `split-window -c "#{pane_current_path}" ${moshcode} agents claude ; select-layout tiled`],
    // Stop, without the confirm-before-kill prompt tmux puts on lowercase x —
    // this is a tile you are looking at, not a blind target.
    ["X", "kill-pane ; select-layout tiled"],
    // Send the focused member back to a session of its own.
    ["B", "break-pane"],
    // Re-tile after any manual resize.
    ["T", "select-layout tiled"],
  ];
}

const STATUS_LEFT = ` ${" "}#[bold]herd#[default] `;
const STATUS_RIGHT = " S:shell  A:agent  X:stop  B:pop out  z:zoom  T:re-tile ";

/**
 * Gather every live member into one tiled window and attach to it.
 *
 * Members already in the tile window are left alone, so running this twice is
 * not destructive and picks up anything started since.
 */
export async function herdTile(argv = [], { write = console.log, spawner = spawn, runner = spawnSync } = {}) {
  const substrate = detectSubstrate();
  if (substrate !== "tmux") {
    write(err("tiling needs tmux."));
    write(info(substrate === "pty"
      ? "the script(1) fallback has one pty per session and no way to lay them out together — `moshcode herd ui` still works."
      : "install tmux, or use `moshcode ps`."));
    return 1;
  }

  const wanted = argv.find((a) => !a.startsWith("-")) || null;
  const manifest = readManifest();
  const panes = paneIndex({ runner });
  const members = [...panes.entries()]
    .filter(([name]) => name in manifest.sessions)
    .filter(([name]) => !wanted || (manifest.sessions[name].herd || "main") === wanted);

  if (!members.length) {
    write(info("nothing to tile — start something with `moshcode herd shell` or `moshcode agents claude -d`."));
    return 0;
  }

  // The window everything lands in. Created from the first member rather than
  // as an empty shell, so the tile has no spare pane sitting in it doing
  // nothing. If it already exists we just join into it.
  const existing = tmux(["has-session", "-t", TILE_SESSION], { runner });
  if (!existing.ok) {
    const [firstName, first] = members[0];
    const made = tmux(["new-session", "-d", "-s", TILE_SESSION, "-n", "herd"], { runner });
    if (!made.ok) { write(err(made.stderr.trim() || "could not create the tile window")); return 1; }
    tmux(["join-pane", "-s", first.paneId, "-t", `${TILE_SESSION}:herd`], { runner });
    // new-session made a placeholder pane; the first member replaced nothing,
    // so drop the placeholder now that there is something real beside it.
    const inWindow = tmux(["list-panes", "-t", `${TILE_SESSION}:herd`, "-F", "#{pane_id}\t#{pane_title}"], { runner });
    for (const line of inWindow.stdout.split("\n")) {
      const [paneId, title] = line.split("\t");
      if (paneId && title !== firstName && !manifest.sessions[title]) {
        tmux(["kill-pane", "-t", paneId], { runner });
      }
    }
  }

  let joined = 0;
  for (const [, pane] of members) {
    if (pane.session === TILE_SESSION) continue; // already on the layout
    const r = tmux(["join-pane", "-s", pane.paneId, "-t", `${TILE_SESSION}:herd`], { runner });
    if (r.ok) joined++;
  }

  for (const [key, command] of tileBindings()) {
    tmux(["bind-key", "-T", "prefix", key, ...command.split(" ")], { runner });
  }
  tmux(["set-option", "-t", TILE_SESSION, "mouse", "on"], { runner });
  tmux(["set-option", "-t", TILE_SESSION, "pane-border-status", "top"], { runner });
  // The border carries the member's name, so a tiled screen is readable without
  // a legend anywhere else.
  tmux(["set-option", "-t", TILE_SESSION, "pane-border-format", " #{pane_title} "], { runner });
  tmux(["set-option", "-t", TILE_SESSION, "status-left-length", "20"], { runner });
  tmux(["set-option", "-t", TILE_SESSION, "status-right-length", "80"], { runner });
  tmux(["set-option", "-t", TILE_SESSION, "status-left", STATUS_LEFT], { runner });
  tmux(["set-option", "-t", TILE_SESSION, "status-right", STATUS_RIGHT], { runner });
  tmux(["select-layout", "-t", `${TILE_SESSION}:herd`, "tiled"], { runner });

  write(ok(`tiling ${members.length} member${members.length === 1 ? "" : "s"}${joined ? "" : " (already laid out)"} — Ctrl-b d to leave them running`));

  return new Promise((resolve) => {
    let child;
    try { child = spawner("tmux", ["-L", HERD_SOCKET, "attach-session", "-t", TILE_SESSION], { stdio: "inherit" }); }
    catch (error) { write(err(String(error.message || error))); resolve(1); return; }
    child.on("error", (error) => { write(err(String(error.message || error))); resolve(1); });
    child.on("exit", () => {
      write(info(`detached — everything is still running. ${acid("moshcode ps")} · ${acid("moshcode herd tile")}`));
      resolve(0);
    });
  });
}

/**
 * Put every tiled member back into a session of its own.
 *
 * The inverse of tiling, and worth having explicitly: a layout is a view, and
 * anyone who wants their sessions back should not have to know that
 * `break-pane` is the word for it.
 */
export function herdUntile(argv = [], { write = console.log, runner = spawnSync } = {}) {
  if (detectSubstrate() !== "tmux") { write(err("tiling needs tmux.")); return 1; }
  const manifest = readManifest();
  const tiled = [...paneIndex({ runner }).entries()]
    .filter(([name, pane]) => pane.session === TILE_SESSION && name in manifest.sessions);
  if (!tiled.length) { write(info("nothing is tiled.")); return 0; }

  // `break-pane` moves a pane into a new *window*, always in a session that
  // already exists — its `-t` is a destination window, not a name to create.
  // Getting a pane into a session of its own is therefore the same dance as
  // tiling, run backwards: make the session, join the pane into it, then drop
  // the placeholder pane the new session was born with.
  let restored = 0;
  for (const [name, pane] of tiled) {
    const made = tmux(["new-session", "-d", "-s", name, "-n", name], { runner });
    if (!made.ok) { write(err(`${name}: ${made.stderr.trim() || "could not recreate its session"}`)); continue; }
    const placeholder = tmux(["list-panes", "-t", name, "-F", "#{pane_id}"], { runner }).stdout.trim();
    const joined = tmux(["join-pane", "-s", pane.paneId, "-t", `${name}:${name}`], { runner });
    if (!joined.ok) { write(err(`${name}: ${joined.stderr.trim() || "could not move it back"}`)); continue; }
    if (placeholder) tmux(["kill-pane", "-t", placeholder], { runner });
    restored++;
  }
  // Nothing is left in it, and an empty tile window on the roster is confusing.
  tmux(["kill-session", "-t", TILE_SESSION], { runner });
  write(ok(`${restored} member${restored === 1 ? "" : "s"} back in their own sessions.`));
  write(info(`${ash("attach one with")} ${acid("moshcode attach <name>")}`));
  return 0;
}
