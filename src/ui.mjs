// Metal terminal styling — poison acid-lime (#9EF01A) on near-black, the
// moshcoding palette. Truecolor ANSI with a NO_COLOR opt-out.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** moshcode's own version, read from package.json (best-effort). */
export function moshcodeVersion() {
  try {
    const pkg = fileURLToPath(new URL("../package.json", import.meta.url));
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version || null;
  } catch { return null; }
}

const useColor = process.env.NO_COLOR == null && process.stdout.isTTY === true;
const rgb = (r, g, b) => (s) => (useColor ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : String(s));
const wrap = (o, c) => (s) => (useColor ? `\x1b[${o}m${s}\x1b[${c}m` : String(s));

export const acid = rgb(158, 240, 26);
export const bone = rgb(238, 242, 232);
export const ash = rgb(139, 147, 138);
export const danger = rgb(255, 77, 61);
export const spotify = rgb(29, 185, 84);
export const dim = wrap(2, 22);

export const ok = (s) => acid("✓ ") + s;
export const err = (s) => danger("✗ ") + s;
export const info = (s) => ash("· ") + s;

export function banner() {
  const version = moshcodeVersion();
  const name = bone("moshcode") + (version ? ash(" v" + version) : "");
  return [
    acid("  ███╗   ███╗ ██████╗ ███████╗██╗  ██╗"),
    acid("  ████╗ ████║██╔═══██╗██╔════╝██║  ██║") + ash("   code hard,"),
    acid("  ██╔████╔██║██║   ██║███████╗███████║") + ash("   mosh harder"),
    acid("  ██║╚██╔╝██║██║   ██║╚════██║██╔══██║"),
    acid("  ██║ ╚═╝ ██║╚██████╔╝███████║██║  ██║") + dim("  ⚡ #moshcoding"),
    acid("  ╚═╝     ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝"),
    "",
    "  " + name + ash("  ·  a wall of distortion for your coding agents"),
    "  " + acid("https://moshcode.sh"),
  ].join("\n");
}

export function hr() {
  return ash("─".repeat(Math.min(process.stdout.columns || 60, 60)));
}
