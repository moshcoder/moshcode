// Automatic settings sync — the unattended `/load` then `/save`.
//
// PRD 0010 ruled background sync out, and the reason it gave was the right
// reason for the mechanism it had in mind: "a daemon that pushes silently is a
// daemon that overwrites silently." What makes this one allowed is that it is
// not permitted to overwrite anything. It never passes `--force`, and both
// verbs already refuse rather than guess — `/load` stops when a settings file
// changed locally since the last sync, `/save` stops on the 409 when another
// machine saved first. So the worst an unattended tick can do is decline and
// leave the decision exactly where it was: with the person at the prompt.
//
// The order is `/load` then `/save`, and that order is the whole design:
//
//   - `/load` first means this machine is at the account's revision before it
//     pushes, so the ordinary two-machine case settles itself and nobody is
//     ever shown a conflict they would only have resolved by loading anyway.
//   - When `/load` declines because there are unsaved local edits, the `/save`
//     that follows pushes exactly those edits — which is the resolution the
//     manual conflict message already recommends ("`/save` to keep them").
//
// Quiet is a feature. A tick that changed nothing prints nothing, because a
// line every five minutes saying "still fine" trains you to stop reading the
// pit. Three things do print: settings that arrived from another machine (your
// aliases just changed under you and you are owed that sentence), a revision
// this machine pushed, and the two states that need a human — a conflict, and
// credentials the app rejected. Network failures stay silent; a laptop on a
// train would otherwise narrate every tunnel.
import os from "node:os";
import { loadCreds } from "./auth.mjs";
import { loadCommand, saveCommand } from "./settings-sync.mjs";

/** Five minutes. Long enough that a tick is never in the way of typing. */
export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * A floor, not a suggestion. `MOSHCODE_AUTOSYNC_MS=1` would turn the account
 * into a write loop, so anything under this is treated as the minimum rather
 * than refused — an env var is not the place to learn you typed milliseconds
 * where you meant minutes.
 */
export const MIN_INTERVAL_MS = 30 * 1000;

/**
 * Off switch, in the shape the rest of the codebase already uses for one:
 * presence disables, exactly like MOSHCODE_NO_MIRROR and MOSHCODE_NO_ADS.
 */
export function autoSyncEnabled(env = process.env) {
  return !env.MOSHCODE_NO_AUTOSYNC;
}

/** `Number(x) || default`, the MOSHCODE_AD_COLS idiom, with a floor. */
export function autoSyncInterval(env = process.env) {
  const raw = Number(env.MOSHCODE_AUTOSYNC_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, raw);
}

/**
 * Run one verb and read its answer as data rather than as prose.
 *
 * Both commands take `--json` and emit a single object through their `write`
 * sink, which is the only reason this can be quiet: it can tell "loaded four
 * files" from "already at revision 9" without matching on English.
 */
async function runJson(command, argv, deps) {
  const chunks = [];
  const code = await command([...argv, "--json"], {
    ...deps,
    write: (line) => chunks.push(String(line)),
  });
  let body = null;
  try { body = JSON.parse(chunks.join("\n")); } catch { /* not our business */ }
  return { code, body, status: body?.status ?? null };
}

/**
 * One tick: load, then save.
 *
 * Returns what happened, so the caller decides what is worth a line and the
 * tests can assert on the sequence without reading output.
 */
export async function syncOnce({
  load = loadCommand,
  save = saveCommand,
  creds = loadCreds(),
  write = () => {},
  ...deps
} = {}) {
  // Logged out is not an error and must never print. A pit that has never seen
  // `/login` would otherwise nag about an account its owner has not asked for,
  // every five minutes, forever.
  if (!creds?.token) return { skipped: "not_logged_in" };

  const loaded = await runJson(load, [], { ...deps, creds });

  // `local_changes` is the expected, healthy half of this: you edited an alias
  // and have not saved it. `/load` correctly declined to replace it, and the
  // `/save` below is what carries it up. Anything else that failed is a reason
  // to stop rather than push on top of a machine we could not read.
  const loadBlocked = loaded.status === "expired";
  if (loadBlocked) {
    write("the app rejected this machine's credentials — run `/login` again");
    return { load: loaded.status, save: null };
  }

  if (loaded.status === "loaded") {
    const count = Array.isArray(loaded.body?.files) ? loaded.body.files.length : 0;
    const from = loaded.body?.from;
    write(`settings synced${from ? ` from ${from}` : ""} — ${count} file${count === 1 ? "" : "s"} changed (revision ${loaded.body?.revision ?? "?"})`);
  }

  const saved = await runJson(save, [], { ...deps, creds });

  if (saved.status === "saved") {
    write(`settings saved — revision ${saved.body?.revision ?? "?"}`);
  } else if (saved.status === "conflict") {
    // The one case an unattended tick cannot resolve: this machine loaded, and
    // the account moved again between the load and the save. Say so once and
    // stop; `--force` is a decision, not a retry.
    write(`another machine saved first — \`/load\` to take theirs, or \`/save --force\` to keep this machine's`);
  } else if (saved.status === "expired") {
    write("the app rejected this machine's credentials — run `/login` again");
  }

  return { load: loaded.status, save: saved.status };
}

/**
 * Start the timer. Returns the function that stops it.
 *
 * The caller must call that on the way out: `tui()` is re-entered after an
 * engine session (bin/moshcode.mjs `backToPit`), so a timer left running would
 * be joined by another on the next entry, and by a third after that.
 */
export function startAutoSync({
  intervalMs = autoSyncInterval(),
  enabled = autoSyncEnabled(),
  write = (line) => console.log(`  ${line}`),
  timers = { setInterval, clearInterval },
  ...deps
} = {}) {
  if (!enabled) return () => {};

  // A tick that is still running when the next one fires would race two writes
  // to the same files, so ticks are single-flight rather than queued: a sync
  // this machine skipped is one it does five minutes later, unchanged.
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await syncOnce({ write, ...deps }); }
    catch { /* a background sync never takes the pit down with it */ }
    finally { running = false; }
  };

  // Deliberately no tick at startup. The pit is most likely to be typed into in
  // the second after it opens, and that is the worst moment to rewrite the
  // aliases under it — the first sync can wait five minutes.
  const handle = timers.setInterval(tick, intervalMs);

  // Never hold the process open for the sake of a sync. `pty.mjs` sets the
  // precedent: a piped `moshcode` that has run out of stdin should exit now,
  // not at the end of the interval.
  handle?.unref?.();

  return () => {
    stopped = true;
    try { timers.clearInterval(handle); } catch { /* already gone */ }
  };
}

/** Exported for the tests; the pit has no reason to care. */
export const _internals = { runJson, hostname: os.hostname };
