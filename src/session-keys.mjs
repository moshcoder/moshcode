// Also vendored in apps/pwa/src/lib/session-keys.mjs: the PWA deploys on its own.
export const BASE_KEY_NAMES = ["up", "down", "left", "right", "enter"];
export const EXTENDED_KEYS_FEATURE = "keys-v2";

export const KEY_BYTES = Object.assign(Object.create(null), {
  up: "\u001b[A", down: "\u001b[B", right: "\u001b[C", left: "\u001b[D", enter: "\r",
  escape: "\u001b", tab: "\t", backspace: "\u007f", delete: "\u001b[3~",
  home: "\u001b[H", end: "\u001b[F", pageup: "\u001b[5~", pagedown: "\u001b[6~",
  space: " ",
});

// Xterm modifier parameters: Shift = 2, Ctrl = 5, Ctrl+Shift = 6.
for (const [prefix, modifier] of [["shift+", 2], ["ctrl+", 5], ["ctrl+shift+", 6]]) {
  for (const [name, suffix] of Object.entries({ up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" })) {
    KEY_BYTES[prefix + name] = `\u001b[1;${modifier}${suffix}`;
  }
  for (const [name, code] of Object.entries({ delete: 3, pageup: 5, pagedown: 6 })) {
    KEY_BYTES[prefix + name] = `\u001b[${code};${modifier}~`;
  }
  // CSI-u keeps modified Enter distinct for engines with multiline prompts.
  for (const [name, code] of Object.entries({ enter: 13, tab: 9, escape: 27, backspace: 127 })) {
    KEY_BYTES[prefix + name] = `\u001b[${code};${modifier}u`;
  }
}
KEY_BYTES["shift+tab"] = "\u001b[Z";
KEY_BYTES["ctrl+backspace"] = "\u0008";
KEY_BYTES["shift+backspace"] = "\u007f";
KEY_BYTES["shift+space"] = " ";
KEY_BYTES["ctrl+space"] = KEY_BYTES["ctrl+shift+space"] = "\u0000";

for (const letter of "abcdefghijklmnopqrstuvwxyz") {
  KEY_BYTES[letter] = letter;
  KEY_BYTES["shift+" + letter] = letter.toUpperCase();
  KEY_BYTES["ctrl+" + letter] = KEY_BYTES["ctrl+shift+" + letter] = String.fromCharCode(letter.charCodeAt(0) - 96);
}

export const KEY_NAMES = Object.keys(KEY_BYTES);

export function readlineKey(name) {
  const parts = name.split("+");
  const key = parts.pop();
  return {
    name: key === "enter" ? "return" : key,
    ...(parts.includes("ctrl") ? { ctrl: true } : {}),
    ...(parts.includes("shift") ? { shift: true } : {}),
  };
}
