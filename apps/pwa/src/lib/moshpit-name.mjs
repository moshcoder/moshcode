// The Moshpit namespace rules — now @moshcoder/moshpit-name.
//
// These rules were written three times: here, in TronBrowser's TypeScript
// resolver, and in a hand port of that into its extension, with a test whose
// only job was asserting two of the copies agreed. They are one package now,
// and this file is the seam so the seven modules that import
// `./lib/moshpit-name.mjs` do not each have to know that.
//
// Re-exported rather than replaced by a rewrite of every import: the path is
// what those files depend on, and changing where a rule lives is not a reason
// to touch code that only uses it.
export * from "@moshcoder/moshpit-name";
