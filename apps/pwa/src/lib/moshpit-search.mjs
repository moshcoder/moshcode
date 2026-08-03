// Turning what somebody typed into a filter over the namespace.
//
// Pure on purpose: this decides what `.def*` means, and that answer has to be
// the same for the live filter on /pit, the JSON API behind it, and the plain
// `?q=` page load that happens when the script never runs. A helper with no
// database in it is a helper all three can share.

/** A TLD is one label, so nothing longer than one can be a useful query. */
export const MAX_QUERY = 63;

/**
 * Read a filter out of raw input.
 *
 * Returns null for "no filter" — empty, or nothing but wildcards, which asks
 * for everything and is what the unfiltered page already shows.
 *
 * Two behaviours, and the difference is the `*`:
 *
 *   `eggs`   substring — matches eggs, bigeggs, eggsalad. This is what typing
 *            into a filter box means; anchoring it would show nothing until the
 *            last character landed.
 *   `def*`   glob, anchored at both ends — def, default, defer, but not undef.
 *
 * The leading dot people naturally type (`.eggs`) is not part of the name, so
 * it goes. Everything that cannot appear in a TLD goes with it, which is also
 * what makes the result safe to hand to LIKE: `%` and `_` are stripped here, so
 * no input can reach SQL still carrying a wildcard we did not put there.
 */
export function tldQuery(raw) {
  const cleaned = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9*-]/g, "")
    .slice(0, MAX_QUERY);

  if (!cleaned || /^\*+$/.test(cleaned)) return null;

  const glob = cleaned.includes("*");
  return {
    // What to echo back into the box: what they meant, minus the noise.
    query: cleaned,
    // A run of stars is one wildcard; `de**f` and `de*f` ask the same thing.
    like: glob ? cleaned.replace(/\*+/g, "%") : `%${cleaned}%`,
    glob,
    // An exact hit sorts first, so `.eggs` finds `.eggs` and not `.eggsalad`.
    exact: glob ? "" : cleaned,
  };
}

/**
 * The same filter, over whole names rather than endings.
 *
 * `blue.eggs` is one string to the person typing it and two columns in the
 * database, so the dot has to survive being cleaned — tldQuery strips it, which
 * would turn `blue.eggs` into the substring `blueeggs` and match nothing. The
 * DNS Records tab filters over domains, and a filter that cannot take the
 * domain as written is a filter people type into twice and then stop using.
 *
 * Matched against `label || '.' || tld`, so `eggs` finds every name under
 * `.eggs` and every name with eggs in it, and `blue.*` finds blue under all of
 * them.
 */
export function nameQuery(raw) {
  const cleaned = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.*-]/g, "")
    .replace(/^\.+/, "")
    // A name is two labels and a dot: 63 + 1 + 63.
    .slice(0, MAX_QUERY * 2 + 1);

  if (!cleaned || /^[.*]+$/.test(cleaned)) return null;

  const glob = cleaned.includes("*");
  return {
    query: cleaned,
    like: glob ? cleaned.replace(/\*+/g, "%") : `%${cleaned}%`,
    glob,
    exact: glob ? "" : cleaned,
  };
}
