// Hangman. Type a letter; the gallows does the rest.
import { acid, amber, ash, bone, danger, dim } from "./ui.mjs";

/** Six wrong guesses, and the gallows is finished. */
export const GALLOWS = [
  ["  ┌────┐", "  │     ", "  │     ", "  │     ", "  │     ", " ═╧══════"],
  ["  ┌────┐", "  │    ○", "  │     ", "  │     ", "  │     ", " ═╧══════"],
  ["  ┌────┐", "  │    ○", "  │    │", "  │     ", "  │     ", " ═╧══════"],
  ["  ┌────┐", "  │    ○", "  │   ╱│", "  │     ", "  │     ", " ═╧══════"],
  ["  ┌────┐", "  │    ○", "  │   ╱│╲", "  │     ", "  │     ", " ═╧══════"],
  ["  ┌────┐", "  │    ○", "  │   ╱│╲", "  │    │", "  │   ╱ ", " ═╧══════"],
  ["  ┌────┐", "  │    ☹", "  │   ╱│╲", "  │    │", "  │   ╱ ╲", " ═╧══════"],
];

export const MISSES_ALLOWED = GALLOWS.length - 1;

/** Words a moshcoder might actually shout. Nothing needing a hyphen. */
export const WORDS = [
  "moshcode", "distortion", "compiler", "kernel", "segfault", "refactor",
  "closure", "promise", "daemon", "binary", "pointer", "monorepo", "terminal",
  "runtime", "abstraction", "recursion", "interface", "payload", "protocol",
  "semaphore", "mutex", "stacktrace", "breakpoint", "heuristic", "idempotent",
  "bytecode", "checksum", "firewall", "namespace", "regression", "sandbox",
  "throughput", "waveform", "amplifier", "feedback", "headbang", "overdrive",
  "fretboard", "downbeat", "crowdsurf", "backline", "encryption", "quantum",
];

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** The word with everything unguessed still hidden. */
export function mask(state) {
  return state.word.split("").map((c) => (state.guessed.has(c) ? c.toUpperCase() : "_"));
}

/**
 * Apply one letter. Repeats are free — guessing `e` twice costs nothing but
 * also tells you nothing, which is the same deal every hangman has ever run.
 */
export function guess(state, letter) {
  const c = String(letter).toLowerCase();
  if (!LETTERS.includes(c) || state.guessed.has(c) || state.missed.includes(c)) return state;
  if (state.word.includes(c)) {
    state.guessed.add(c);
    if (state.word.split("").every((ch) => state.guessed.has(ch))) state.over = "got it 🤘";
    return state;
  }
  state.missed.push(c);
  if (state.missed.length >= MISSES_ALLOWED) state.over = `hanged — it was ${state.word.toUpperCase()}`;
  return state;
}

export const HANGMAN = {
  key: "hangman",
  aliases: ["hang", "gallows"],
  title: "HANGMAN",
  blurb: "six wrong letters and you are done for",
  keys: "a–z guess · r new word once it is over · q quit",
  // Every letter has to reach the game: `h` is a guess, not the vim left it is
  // in the games that read arrows, and `r` only restarts once the word is done.
  // Without both, `refactor` was a word you could not spell at it.
  vim: false,
  restartable: false,

  create({ rng = Math.random } = {}) {
    return {
      word: WORDS[Math.floor(rng() * WORDS.length) % WORDS.length],
      guessed: new Set(),
      missed: [],
      over: null,
    };
  },

  onKey(state, pressed) {
    if (pressed.length !== 1) return state;
    return guess(state, pressed);
  },

  status(state) {
    if (state.over) return state.over;
    const left = MISSES_ALLOWED - state.missed.length;
    return `${left} wrong ${left === 1 ? "guess" : "guesses"} left`;
  },

  render(state) {
    const art = GALLOWS[Math.min(state.missed.length, MISSES_ALLOWED)];
    const shown = state.over && state.over.startsWith("hanged")
      ? state.word.split("").map((c) => c.toUpperCase())
      : mask(state);
    const word = shown.map((c) => (c === "_" ? ash("_") : acid(c))).join(" ");
    const missed = state.missed.length
      ? `${ash("missed ")}${danger(state.missed.join(" ").toUpperCase())}`
      : dim("no wrong letters yet");
    return [
      ...art.map((line) => bone(line)),
      "",
      `  ${word}`,
      "",
      `  ${missed}`,
      `  ${amber("✳".repeat(MISSES_ALLOWED - state.missed.length))}${dim("✳".repeat(state.missed.length))}`,
    ];
  },
};
