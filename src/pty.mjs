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
import {
  closeSync, constants, existsSync, mkdtempSync, openSync,
  readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { activeChildSink } from "./mirror.mjs";

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
 * The same thing for a shell *line* rather than an argv, which the input path
 * needs: it prefixes the child with `stty` and `tty` so the session sizes
 * itself and says where it landed, and those only exist as shell.
 */
export function ptyShellSpec(command, transcript, flavor) {
  if (!command || !transcript) return null;
  if (flavor === "util-linux") return { cmd: "script", args: ["-q", "-e", "-f", "-c", command, transcript] };
  if (flavor === "bsd") return { cmd: "script", args: ["-q", "-F", transcript, "sh", "-c", command] };
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
export function followFile(file, onChunk, { intervalMs = 100, startOffset = 0 } = {}) {
  let fd = null;
  // Callers that already have the earlier bytes — the herd's `attach` has just
  // printed the tail of the transcript for context — pass the offset they got
  // to, so following a session that has been running for hours costs the new
  // bytes rather than a full replay of everything it ever printed.
  let offset = Number(startOffset) || 0;
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

/**
 * Wrap a spawn spec so a copy of everything the child prints reaches `onOutput`
 * while the child still owns the real terminal.
 *
 * The whole capture dance in one place — temp transcript, the flavour-specific
 * `script` argv, the follower, the banner strip, the cleanup — because every
 * launcher in the pit needs it, and each one growing its own copy is how a
 * shell command ended up invisible in the mirror while `/agents claude` was
 * captured: both spawn `inherit`, and only one of them had been taught this.
 *
 * `onOutput` defaults to whatever the live mirror is (src/mirror.mjs), so a
 * launcher gets capture without having to know the mirror exists — the reverse
 * of how this started, where each launcher had to be taught separately and only
 * two ever were. Pass `null` to opt a launch out.
 *
 * Returns `{ cmd, args, stdio, write, stop }`. With nothing watching, or on a
 * box with no `script(1)` we can drive, `cmd`/`args` come back exactly as
 * passed in, `stdio` is "inherit" and `write` returns false — the caller spawns
 * what it always spawned. `stop()` must be called once the child exits: it
 * drains the tail of the transcript (the last lines of a command are usually
 * the ones you were waiting for) and removes the temp dir.
 *
 * `input: true` additionally makes the child's stdin something we can type
 * into, so the session page can drive it — see captureWithInput.
 */
export function captureSpec(
  { cmd, args = [] },
  onOutput = activeChildSink(),
  { flavor = scriptFlavor(), input = false, stdin = process.stdin, stdout = process.stdout } = {},
) {
  const plain = { cmd, args, stdio: "inherit", write: () => false, stop: () => {} };
  if (!ptyEnabled(onOutput, flavor)) return plain;
  if (input) {
    const withInput = captureWithInput({ cmd, args }, onOutput, { flavor, stdin, stdout });
    if (withInput) return withInput;
    // No fifo, no local tty, nothing we could drive — fall through to the
    // output-only capture rather than dropping capture altogether.
  }
  let workDir = null;
  try {
    workDir = mkdtempSync(path.join(tmpdir(), "moshcode-pty-"));
    const transcript = path.join(workDir, "transcript");
    writeFileSync(transcript, "");
    const wrapped = ptySpec(cmd, args, transcript, flavor);
    if (!wrapped) throw new Error("no script(1) spec for this flavour");
    let first = true;
    const stopFollow = followFile(transcript, (chunk) => {
      const clean = stripScriptBanner(chunk, first);
      first = false;
      if (clean) onOutput(clean);
    });
    const dir = workDir;
    return {
      cmd: wrapped.cmd,
      args: wrapped.args,
      stdio: "inherit",
      write: () => false,
      stop() {
        try { stopFollow(); } catch { /* nothing left to drain */ }
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
      },
    };
  } catch {
    // Capture is a nicety; never let it stop a command from running.
    if (workDir) { try { rmSync(workDir, { recursive: true, force: true }); } catch { /* temp dir */ } }
    return plain;
  }
}

// ---------------------------------------------------------------------------
// Typing into the child
// ---------------------------------------------------------------------------

/** A terminal geometry we can hand a child, with a sane floor. */
function geometry(stdout) {
  return { cols: Number(stdout?.columns) || 80, rows: Number(stdout?.rows) || 24 };
}

// Application cursor keys (DECCKM). A program that turns this on is saying "send
// me ESC O B for down, not ESC [ B", and a terminal obliges — which is why the
// distinction never comes up for the person at the keyboard, and why it bites
// the moment we start synthesising keys ourselves. `less` is the plain
// demonstration: fed the CSI form while it has DECCKM set, it does not scroll,
// it prints "ESC[B" on its own prompt line as if you had typed the characters.
//
// The mode is not something we can ask about, but it is announced: the child
// writes the escape on its way into full-screen mode, and every byte it writes
// is already passing under our nose on the way to the mirror.
const DECCKM = /\u001b\[\?1([hl])/g;

/** Track a DECCKM change announced in `text`; returns the mode after it. */
export function cursorKeyMode(text, current = false) {
  const seen = [...String(text).matchAll(DECCKM)].pop();
  return seen ? seen[1] === "h" : current;
}

/**
 * Rewrite CSI cursor keys as SS3, for a child that asked for application mode.
 *
 * Only the four cursor keys move: everything else, including a literal ESC and
 * anything the person at the keyboard typed, is left exactly as it arrived.
 */
export function toApplicationCursor(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i + 2 < out.length; i += 1) {
    // ESC [ A|B|C|D  ->  ESC O A|B|C|D
    if (out[i] === 0x1b && out[i + 1] === 0x5b && out[i + 2] >= 0x41 && out[i + 2] <= 0x44) {
      out[i + 1] = 0x4f;
    }
  }
  return out;
}

/**
 * The same capture, but with a stdin the mirror can write to.
 *
 * `inherit` hands the child the tty's own file descriptors, which is why a key
 * pressed on the session page could never reach it: there is no fd in this
 * process between the browser and the program, so the best the mirror could do
 * was synthesise a `data` event on its own `process.stdin` — which the pit's
 * readline hears and a child does not (see pressKey in src/mirror.mjs). To type
 * into an engine we have to own its stdin, and a fifo is the one way to do that
 * with nothing but the base system: `script(1)` reads it and copies it to the
 * pty master, exactly as it would a terminal.
 *
 * Owning stdin costs two things back, and both are paid here rather than
 * written off as limitations:
 *
 *  - Size. `script` takes the pty's geometry from its own stdin, and a fifo has
 *    none, so the child would start on a 0x0 terminal — which full-screen
 *    engines do not survive. Nothing outside a pty can ioctl its master, but
 *    `stty` inside it can, so the session sizes itself on the way in.
 *  - Resize. For the same reason `script` can no longer forward SIGWINCH. The
 *    child records its pty path on the way in, which is enough to resize it
 *    from out here with `stty -F` when the real window changes, so dragging a
 *    window edge still reaches the engine.
 *
 * The person at the keyboard has to keep working throughout, so local stdin is
 * relayed byte-for-byte into the same fifo. That means raw mode: this tty has
 * to stop echoing and stop buffering lines, because the pty on the other end is
 * now the one doing both.
 *
 * Returns null when this box can't do it (no `mkfifo`, no local tty), which
 * leaves the caller on the output-only path it had before.
 */
export function captureWithInput({ cmd, args = [] }, onOutput, { flavor, stdin, stdout } = {}) {
  // Without a local terminal there is nothing to relay and raw mode is
  // meaningless, so capture alone is the honest thing to offer.
  if (!stdin?.isTTY || typeof stdin.setRawMode !== "function") return null;

  let workDir = null;
  let fd = null;
  try {
    workDir = mkdtempSync(path.join(tmpdir(), "moshcode-pty-"));
    const transcript = path.join(workDir, "transcript");
    const fifo = path.join(workDir, "input");
    const ptsFile = path.join(workDir, "pts");
    writeFileSync(transcript, "");

    // node has no mkfifo, so this is the one call out to the system — and a box
    // without it simply does not get the input path.
    const made = spawnSync("mkfifo", [fifo]);
    if (made.error || made.status !== 0) throw new Error("no mkfifo on this box");

    const { cols, rows } = geometry(stdout);
    const command = [
      `tty > ${shQuote(ptsFile)} 2>/dev/null`,
      `stty rows ${rows} cols ${cols} 2>/dev/null`,
      // exec, so the engine *is* the process script is waiting on: its signals
      // and its exit status pass straight through rather than via a shell.
      `exec ${[cmd, ...args].map(shQuote).join(" ")}`,
    ].join("; ");
    const wrapped = ptyShellSpec(command, transcript, flavor);
    if (!wrapped) throw new Error("no script(1) spec for this flavour");

    // O_RDWR, not O_WRONLY: opening a fifo write-only blocks until a reader
    // arrives, and the reader here is a child we have not spawned yet. Holding
    // both ends also keeps the child from seeing EOF between writes.
    fd = openSync(fifo, constants.O_RDWR);

    let first = true;
    // Which form of cursor key this child is asking for, learned from the same
    // stream that goes to the mirror. Tracked on the raw chunk rather than the
    // banner-stripped one: the mode switch is a control sequence, and nothing
    // about the banner is in its way.
    let appCursor = false;
    const stopFollow = followFile(transcript, (chunk) => {
      appCursor = cursorKeyMode(chunk, appCursor);
      const clean = stripScriptBanner(chunk, first);
      first = false;
      if (clean) onOutput(clean);
    });

    let stopped = false;
    /** Put bytes in front of the child, from the web or from the keyboard. */
    const write = (data) => {
      if (stopped || fd === null) return false;
      const raw = typeof data === "string" ? Buffer.from(data, "latin1") : Buffer.from(data);
      try { writeSync(fd, appCursor ? toApplicationCursor(raw) : raw); return true; }
      catch { return false; }
    };

    // Raw, because the pty on the far end is now the one echoing and the one
    // splitting lines. Leaving this tty cooked would double every character and
    // hold Enter back until the child had already redrawn without it.
    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (buf) => { write(buf); };
    stdin.on("data", onData);

    // The child's own tty, once its prelude has written it down. Read lazily:
    // at the moment we spawn, that file does not exist yet.
    let pts = null;
    const childTty = () => {
      if (pts) return pts;
      try { pts = readFileSync(ptsFile, "utf8").trim() || null; } catch { pts = null; }
      return pts;
    };
    let resizeTimer = null;
    const onResize = () => {
      clearTimeout(resizeTimer);
      // Dragging an edge fires this continuously; settle for one ioctl per drag.
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        const tty = childTty();
        if (!tty || stopped) return;
        const size = geometry(stdout);
        // -F on util-linux, -f on BSD/macOS — the same disagreement as the
        // script(1) flags above, and getting it wrong here is a usage error on
        // every resize rather than anything visible.
        const on = flavor === "bsd" ? "-f" : "-F";
        try { spawnSync("stty", [on, tty, "rows", String(size.rows), "cols", String(size.cols)]); }
        catch { /* the child owns it; a resize we lose is cosmetic */ }
      }, 120);
      resizeTimer.unref?.();
    };
    stdout?.on?.("resize", onResize);

    const dir = workDir;
    return {
      cmd: wrapped.cmd,
      args: wrapped.args,
      // The fifo is the child's stdin; its output still goes straight to the
      // real terminal, so the engine draws at full speed exactly as before.
      stdio: [fd, "inherit", "inherit"],
      write,
      stop() {
        if (stopped) return;
        stopped = true;
        clearTimeout(resizeTimer);
        stdout?.off?.("resize", onResize);
        stdin.off("data", onData);
        // Hand the terminal back the way we found it. Getting this wrong leaves
        // the pit with no echo, which reads as a hung shell.
        try { stdin.setRawMode(wasRaw); } catch { /* not a tty any more */ }
        stdin.pause();
        try { stopFollow(); } catch { /* nothing left to drain */ }
        if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } fd = null; }
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
      },
    };
  } catch {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
    if (workDir) { try { rmSync(workDir, { recursive: true, force: true }); } catch { /* temp dir */ } }
    return null;
  }
}
