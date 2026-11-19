// Pasting a block into the c0mpute agent. readline ends a line on every
// newline it reads, pasted or typed, so a 20-line paste used to run as 20
// turns (or queue as 20 messages while a turn ran). With bracketed paste on,
// the terminal wraps a paste in ESC[200~ … ESC[201~ and Node's keypress parser
// reports those as `paste-start` / `paste-end`; the lines readline ends inside
// a paste are held here and sent as one message with the next Enter, the way
// Claude Code does it.

export const PASTE_ON = "\x1b[?2004h";
export const PASTE_OFF = "\x1b[?2004l";

export function createPasteJoiner() {
  let pasting = false;
  let held = [];
  return {
    /** Feed every keypress name; only the paste markers matter. */
    key(name) {
      if (name === "paste-start") pasting = true;
      else if (name === "paste-end") pasting = false;
    },
    get pasting() { return pasting; },
    /** Lines held from a paste, waiting for Enter. */
    get held() { return held.length; },
    /**
     * A line readline just ended. null while it is part of a paste still
     * arriving (or a paste not yet sent); otherwise the whole message.
     */
    line(raw) {
      if (pasting) { held.push(raw); return null; }
      if (!held.length) return raw;
      const text = [...held, raw].join("\n").replace(/\n+$/, "");
      held = [];
      return text;
    },
    /** Ctrl+C at the prompt drops a held paste along with the line. */
    clear() { held = []; pasting = false; },
  };
}

/** One line for an echo: the first line, cut, plus how many more there are. */
export function oneLine(text, max = 100) {
  const lines = text.split("\n");
  const first = lines[0].length > max ? `${lines[0].slice(0, max)}…` : lines[0];
  const n = lines.length - 1;
  return n ? `${first} (+${n} line${n === 1 ? "" : "s"})` : first;
}
