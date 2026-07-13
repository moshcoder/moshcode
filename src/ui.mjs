// Metal terminal styling — poison acid-lime (#9EF01A) on near-black, the
// moshcoding palette. Truecolor ANSI with a NO_COLOR opt-out.
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
  return [
    acid("  ███╗   ███╗ ██████╗ ███████╗██╗  ██╗"),
    acid("  ████╗ ████║██╔═══██╗██╔════╝██║  ██║") + ash("   code hard,"),
    acid("  ██╔████╔██║██║   ██║███████╗███████║") + ash("   mosh harder"),
    acid("  ██║╚██╔╝██║██║   ██║╚════██║██╔══██║"),
    acid("  ██║ ╚═╝ ██║╚██████╔╝███████║██║  ██║") + dim("  ⚡ #moshcoding"),
    acid("  ╚═╝     ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝"),
    "",
    "  " + bone("moshcode") + ash("  ·  a wall of distortion for your coding agents"),
    "  " + acid("https://moshcoding.com"),
  ].join("\n");
}

export function hr() {
  return ash("─".repeat(Math.min(process.stdout.columns || 60, 60)));
}
