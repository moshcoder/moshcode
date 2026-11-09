// Secret redaction for text that leaves the session it was written in.
//
// A coding conversation is full of things pasted to get unstuck: a curl with a
// bearer token, an .env dumped to show a misconfiguration, a connection string.
// Inside the engine's own log that is the operator's business. Once a handoff
// renders it into a file another engine reads, and especially once that engine
// is a network of peers (c0mpute), it is a leak. So everything a handoff
// carries goes through here first, and there is no flag to turn it off.
//
// The patterns are shapes, not a list of every provider: a known prefix with
// enough entropy behind it, a private key block, a JWT, credentials in a URL,
// and NAME=value where the name says it is a secret. A false positive costs a
// placeholder in a transcript. A false negative costs a rotated key.

const MARK = (kind) => `[redacted:${kind}]`;

/**
 * Ordered: the multi-line and structured shapes first, so a private key block
 * is replaced whole before the token patterns could nibble at its body.
 */
export const PATTERNS = [
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g],
  ["url-credentials", /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, (_m, scheme, user) => `${scheme}${user}:${MARK("password")}@`],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["aws-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["google-key", /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ["stripe-key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["c0mpute-key", /\b(?:ik_live_|c0k_|ifc_)[A-Za-z0-9_-]{12,}/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{30,}/g],
  ["bearer", /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/g, (_m, word) => `${word} ${MARK("token")}`],
  // NAME=value, NAME: value, "NAME": "value" where NAME says secret. The value
  // must look like a value (8+ chars, no spaces) so prose about "the API key
  // field" is left alone.
  ["assignment",
    /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CLIENT_?SECRET)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s"'`,;]{8,})/gi,
    (_m, name, sep) => `${name}${sep}${MARK("secret")}`],
];

/**
 * Redact one string. Returns the new text and how many secrets of each kind
 * were removed, so a caller can say "3 secrets redacted" without ever printing
 * one.
 */
export function redact(text, { patterns = PATTERNS } = {}) {
  let out = String(text ?? "");
  const hits = {};
  for (const [kind, re, replace] of patterns) {
    out = out.replace(re, (...args) => {
      const match = args[0];
      if (match.includes("[redacted:")) return match;
      hits[kind] = (hits[kind] || 0) + 1;
      return replace ? replace(...args) : MARK(kind);
    });
  }
  return { text: out, hits };
}

/** Add one hits map into another, in place. */
export function addHits(into, hits) {
  for (const [k, n] of Object.entries(hits || {})) into[k] = (into[k] || 0) + n;
  return into;
}

/** Total number of redactions in a hits map. */
export const countHits = (hits) => Object.values(hits || {}).reduce((a, b) => a + b, 0);
