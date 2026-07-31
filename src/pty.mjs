// PTY capture for the session mirror.
//
// Children are launched with `stdio: "inherit"` so they own the real terminal —
// which is why an engine or tool feels native, and also why the mirror never
// saw a byte of their output: those writes go to the tty's file descriptors and
// never pass through this process (see src/mirror.mjs).
//
// To see them we have to be in the middle, but a plain pipe is not an option:
// every one of these programs checks isTTY and degrades (no colour, no prompts,
// no full-screen UI) the moment it is talking to a pipe. So we run the child
// under a real pseudo-terminal and read a copy of the stream from the side.
//
// node-pty would be the obvious tool and is deliberately not used: it is a
// native module, and moshcode installs by untarring a release and running node
// (see install.sh) — there is no compiler in that path. `script(1)` allocates
// the same pseudo-terminal using nothing but the base system.
//
// Capability detection is required, not optional: util-linux and BSD/macOS
// `script` disagree on both flag names and argument order, and anything we
// cannot positively identify falls back to today's plain `inherit`.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * POSIX single-quote escaping, for argv that has to survive being flattened
 * into the single command string util-linux `script -c` accepts. A bare
 * interpolation here would let an argument like `it's` break the command, or
 * worse, run something else.
 */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Which `script(1)` this machine has: "util-linux", "bsd", or null when there
 * is none we can drive. util-linux answers `--version`; BSD's has no version
 * flag and exits non-zero on it, so darwin is identified by platform.
 */
export function scriptFlavor({ platform = process.platform, runner = spawnSync } = {}) {
  let out = "";
  try {
    const r = runner("script", ["--version"], { encoding: "utf8" });
    if (r?.error) return null;
    out = `${r?.stdout || ""}${r?.stderr || ""}`;
  } catch {
    return null;
  }
  if (/util-linux/i.test(out)) return "util-linux";
  // BSD script printed a usage error rather than a version — that is still a
  // usable script, but only on darwin do we know the flag set for certain.
  if (platform === "darwin") return "bsd";
  return null;
}

/**
 * The spawn spec that runs `cmd args…` under a pseudo-terminal while recording
 * a copy of everything to `transcript`. Returns null for an unknown flavour.
 *
 * -q / -Q suppress script's own "Script started/done" banner, so the transcript
 * holds the child's bytes and nothing else. -f / -F flush on every write, which
 * is what makes this realtime rather than a post-mortem log. util-linux -e
 * makes script exit with the child's status, which callers rely on.
 */
export function ptySpec(cmd, args = [], transcript, flavor) {
  if (!cmd || !transcript) return null;
  if (flavor === "util-linux") {
    const line = [cmd, ...args].map(shQuote).join(" ");
    return { cmd: "script", args: ["-q", "-e", "-f", "-c", line, transcript] };
  }
  if (flavor === "bsd") {
    // BSD takes the transcript first and then a real argv, so no quoting.
    return { cmd: "script", args: ["-q", "-F", transcript, cmd, ...args] };
  }
  return null;
}

/**
 * Follow a transcript as it is written, handing each new slice to `onChunk`.
 *
 * Polls the size rather than using fs.watch: watch is unreliable across
 * platforms and filesystems for a file being appended to by another process,
 * and the mirror already batches on a 150ms timer, so a short poll costs
 * nothing in perceived latency. Returns a stop() that drains whatever landed
 * after the last tick before closing — the tail of a session is usually the
 * part you care about.
 *
 * Bytes are decoded through a StringDecoder rather than per-slice toString:
 * a slice boundary lands wherever the poll happened to catch the file, which
 * is regularly in the middle of a multi-byte character. Engines draw their
 * full-screen UI out of box-drawing characters (three UTF-8 bytes each), so
 * decoding each slice independently turns them into U+FFFD in the mirror. The
 * decoder holds the incomplete tail back until the rest of it arrives.
 */
export function followFile(file, onChunk, { intervalMs = 100 } = {}) {
  let fd = null;
  let offset = 0;
  let stopped = false;
  let decoder = new StringDecoder("utf8");

  const readNew = () => {
    try {
      if (fd === null) {
        if (!existsSync(file)) return;
        fd = openSync(file, "r");
      }
      const { size } = statSync(file);
      // A transcript only grows; a smaller size means it was rotated or
      // replaced, so resync rather than read garbage from the middle. Any
      // half-character held back belongs to the old file, so drop it too.
      if (size < offset) {
        offset = 0;
        decoder = new StringDecoder("utf8");
      }
      while (offset < size) {
        const buf = Buffer.allocUnsafe(Math.min(65536, size - offset));
        const read = readSync(fd, buf, 0, buf.length, offset);
        if (read <= 0) break;
        offset += read;
        const text = decoder.write(buf.subarray(0, read));
        if (text) onChunk(text);
      }
    } catch {
      /* the child owns this file; a transient read error is not our problem */
    }
  };

  const timer = setInterval(readNew, intervalMs);
  timer.unref?.(); // never hold the process open for the sake of the mirror

  return function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    readNew(); // final drain
    // Nothing more is coming, so a character still held back really is
    // truncated. Emit it rather than swallowing the last bytes of a session.
    const tail = decoder.end();
    if (tail) onChunk(tail);
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already gone */ }
      fd = null;
    }
  };
}

// `script -q` silences the "Script started/done" notices on the terminal but
// still writes them into the transcript, so without this the mirror opens every
// engine session with a line of script(1) bookkeeping — including the fully
// quoted command line — and closes it with an exit-code footer. Both are
// anchored (header at the very start, footer at the very end), so this never
// touches output that merely happens to contain the words.
const HEADER = /^Script started on [^\n]*\n/;
const FOOTER = /\r?\nScript done on [^\n]*\n?$/;

/**
 * Remove script(1)'s own bookkeeping from a transcript slice. `first` marks the
 * opening slice, the only place a header can legitimately appear.
 */
export function stripScriptBanner(text, first = false) {
  const withoutHeader = first ? String(text).replace(HEADER, "") : String(text);
  return withoutHeader.replace(FOOTER, "");
}

/**
 * Should we capture this launch? Only when someone is actually watching (a
 * mirror sink is attached) and the box has a script(1) we understand. Users who
 * are not mirroring keep the exact `inherit` path they have today, so the
 * blast radius of this feature is limited to mirrored sessions.
 * MOSHCODE_MIRROR_PTY=0 forces it off.
 */
export function ptyEnabled(sink, flavor = scriptFlavor()) {
  if (typeof sink !== "function") return false;
  if (process.env.MOSHCODE_MIRROR_PTY === "0") return false;
  return Boolean(flavor);
}
