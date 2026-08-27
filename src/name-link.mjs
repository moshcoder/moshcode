// `moshcode name link <name>` — prove you hold a Moshpit name, so an app can
// use it as your identity.
//
// The registry already publishes, per name, the SHA-256 of the SubjectPublicKeyInfo
// that name's certificate must present (see src/pins.mjs). That pin is a
// name-to-key binding nobody else can forge, which makes it a credential: sign
// something with the pinned key and you have proved you hold the name.
//
// What this does NOT do is generate the app's encryption key. The pinned key is
// P-256 and it signs; a messenger's key is ML-KEM-1024 and it encrypts, and a
// KEM key cannot sign at all. They are two keys with two jobs, and the private
// half of the second one belongs on the device the person actually reads
// messages on — not here. So this emits a proof bundle and stops. The app posts
// it alongside a key it generated itself and never showed anyone.
//
// The bundle is single-use and short-lived: the challenge it answers is burned
// on redemption, so a copy of it is worth nothing once used.

import fs from "node:fs";
import crypto from "node:crypto";

/** Where an app that speaks this protocol lives, unless told otherwise. */
export const DEFAULT_APP = "https://qrypt.chat";

/** Where moshcode's own tooling writes a name's key and certificate. */
export const DEFAULT_KEY_DIR = "/etc/ssl/moshpit";

/**
 * A name is `<label>.<tld>`, lowercase.
 *
 * Empty segments are refused rather than collapsed. `chovy..hacker` folding
 * into `chovy.hacker` is harmless in a filename and is a way in when the string
 * is an identity.
 *
 * @param {unknown} input
 * @returns {string | null}
 */
export function normalizeName(input) {
  const clean = String(input ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!clean) return null;
  const parts = clean.split(".");
  if (parts.length !== 2 || parts.some((p) => !p)) return null;
  if (!parts.every((p) => /^[a-z0-9-]+$/.test(p) && !p.startsWith("-") && !p.endsWith("-"))) return null;
  return parts.join(".");
}

/**
 * Where a name's key and certificate live.
 *
 * Mirrors keyPaths() in src/pins.mjs, including that separators which could
 * climb out of the directory are dropped rather than escaped.
 *
 * @param {string} name
 * @param {string} [dir]
 */
export function keyPaths(name, dir = DEFAULT_KEY_DIR) {
  const safe = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (!safe) return null;
  return { key: `${dir}/${safe}.key`, cert: `${dir}/${safe}.crt` };
}

/**
 * Sign a challenge with a name's private key.
 *
 * DER, because that is what `crypto.verify` reads back with `dsaEncoding: 'der'`
 * on the other side. A P-1363 signature is the same numbers in a shape the
 * verifier rejects, and the failure looks identical to a wrong key.
 *
 * @param {{keyPem: string, nonce: string}} args
 * @returns {string} base64 signature
 */
export function signChallenge({ keyPem, nonce }) {
  const key = crypto.createPrivateKey(keyPem);
  return crypto
    .sign("sha256", Buffer.from(nonce, "utf8"), { key, dsaEncoding: "der" })
    .toString("base64");
}

/**
 * The pin a certificate's key hashes to — SHA-256 over the SPKI, base64.
 * Shown so the operator can eyeball it against what the registry publishes
 * before wondering why a proof was refused.
 *
 * @param {string} certPem
 */
export function pinOf(certPem) {
  const cert = new crypto.X509Certificate(certPem);
  const der = cert.publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("base64");
}

/**
 * Ask an app for a challenge to sign.
 *
 * @param {{app: string, name: string, fetchImpl?: typeof fetch}} args
 */
export async function fetchChallenge({ app, name, fetchImpl = fetch }) {
  const url = `${app.replace(/\/+$/, "")}/api/auth/moshpit/challenge`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    throw new Error(body?.error || `${app} answered ${res.status}`);
  }
  if (!body?.jti || !body?.nonce) {
    throw new Error(`${app} did not return a challenge`);
  }
  return body;
}

/**
 * Read a name's key and certificate off disk, with the failure a person can act on.
 *
 * The key is root-owned, so "permission denied" is the expected first
 * experience and deserves the fix rather than the errno.
 *
 * @param {{name: string, keyPath: string, certPath: string, readFile?: (p: string, e: string) => string}} args
 */
export function readNameKey({ name, keyPath, certPath, readFile = (p, e) => fs.readFileSync(p, e) }) {
  let keyPem;
  try {
    keyPem = readFile(keyPath, "utf8");
  } catch (error) {
    if (error.code === "EACCES") {
      throw new Error(`cannot read ${keyPath} — it is root-owned, so run this with sudo`);
    }
    if (error.code === "ENOENT") {
      throw new Error(`no key for ${name} at ${keyPath} — mint one before linking it`);
    }
    throw error;
  }

  let certPem;
  try {
    certPem = readFile(certPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`no certificate for ${name} at ${certPath}`);
    }
    throw error;
  }

  return { keyPem, certPem };
}

/**
 * Parse `name link <name> [--app url] [--dir path] [--json]`.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const flag = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
  };
  const positional = argv.filter((a, i) => {
    if (a.startsWith("--")) return false;
    // Skip a value that belongs to the flag before it.
    return !(i > 0 && argv[i - 1].startsWith("--") && argv[i - 1] !== "--json");
  });

  return {
    verb: positional[0] || "",
    name: positional[1] || "",
    app: flag("app", DEFAULT_APP),
    dir: flag("dir", DEFAULT_KEY_DIR),
    json: argv.includes("--json"),
  };
}

/**
 * `moshcode name link <name>` — fetch a challenge, sign it, print the bundle.
 *
 * @param {string[]} argv
 * @param {{out?: (s: string) => void, err?: (s: string) => void, fetchImpl?: typeof fetch,
 *          readFile?: (p: string, e: string) => string}} [io]
 * @returns {Promise<number>} exit code
 */
export async function nameCommand(argv, io = {}) {
  const out = io.out || ((s) => console.log(s));
  const err = io.err || ((s) => console.error(s));
  const { verb, name: raw, app, dir, json } = parseArgs(argv);

  if (verb !== "link") {
    err("usage: moshcode name link <name> [--app <url>] [--dir <path>] [--json]");
    return 1;
  }

  const name = normalizeName(raw);
  if (!name) {
    err(`not a Moshpit name: ${raw || "(none)"} — expected <label>.<tld>`);
    return 1;
  }

  const paths = keyPaths(name, dir);
  if (!paths) {
    err(`not a Moshpit name: ${raw}`);
    return 1;
  }

  let keyPem;
  let certPem;
  try {
    ({ keyPem, certPem } = readNameKey({
      name,
      keyPath: paths.key,
      certPath: paths.cert,
      readFile: io.readFile,
    }));
  } catch (error) {
    err(error.message);
    return 1;
  }

  let challenge;
  try {
    challenge = await fetchChallenge({ app, name, fetchImpl: io.fetchImpl });
  } catch (error) {
    err(`could not get a challenge from ${app}: ${error.message}`);
    return 1;
  }

  let signature;
  try {
    signature = signChallenge({ keyPem, nonce: challenge.nonce });
  } catch (error) {
    err(`could not sign with ${paths.key}: ${error.message}`);
    return 1;
  }

  const bundle = { jti: challenge.jti, name, certPem, signature };

  if (json) {
    out(JSON.stringify(bundle));
    return 0;
  }

  out(`Proved ${name} against ${app}`);
  out(`  pin      ${pinOf(certPem)}`);
  out(`  expires  ${challenge.expiresAt || "shortly"}`);
  out("");
  out("Paste this into the app to finish linking. It is single-use:");
  out("");
  out(JSON.stringify(bundle));
  return 0;
}
