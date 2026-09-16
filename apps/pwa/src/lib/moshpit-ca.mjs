// The Moshpit certificate authority.
//
// No public CA will ever issue for a name outside the ICANN root, so until now
// every Moshpit origin served a self-signed leaf and every client had to learn
// each name one at a time, against the pin the registry publishes. The registry
// is the one party that already knows who holds a name, which is exactly what a
// CA needs to know before it signs -- so it signs. A client that trusts the
// root once trusts every pit name, and the per-name imports go away.
//
// Shape:
//   root        offline; its key never touches this server. Signs the issuer.
//   issuer      the online intermediate: MOSHPIT_CA_CERT + MOSHPIT_CA_KEY.
//   leaf        one per name, short-lived (30 days by default), CA:FALSE,
//               SAN = the name and everything under it, renewed by the origin.
//
// Who may ask for a leaf is decided in moshpit-certs.mjs with the same rule
// pins use: the name's holder, or its tenant during a lease. This module only
// knows how to sign.
//
// Two refusals live here because they are properties of the certificate, not
// of the caller: a name whose ending is a real top-level domain is never
// signed (a registry bug must not be able to mint google.com), and the CSR's
// signature must verify (the requester holds the key they want certified).
import { webcrypto, createHash, randomBytes } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { config } from "../config.mjs";
import { isRealTld } from "./iana-tlds.mjs";

x509.cryptoProvider.set(webcrypto);

export const CA_ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const DAY = 24 * 60 * 60 * 1000;

/* ---- PEM helpers ---- */

/** Accept a PEM string, or base64 of one (Railway variables are single-line). */
function pemFromEnv(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (v.includes("-----BEGIN")) return v.replace(/\\n/g, "\n");
  try {
    const decoded = Buffer.from(v, "base64").toString("utf8");
    return decoded.includes("-----BEGIN") ? decoded : "";
  } catch {
    return "";
  }
}

function derFromPem(pem, label) {
  const blocks = x509.PemConverter.decode(pem);
  if (!blocks.length) throw new Error(`${label}: not PEM`);
  return blocks[0];
}

/** SHA-256 over the SubjectPublicKeyInfo, base64 -- the registry's pin format. */
export function pinOf(cert) {
  return createHash("sha256").update(Buffer.from(cert.publicKey.rawData)).digest("base64");
}

export function fingerprintOf(cert) {
  return createHash("sha256").update(Buffer.from(cert.rawData)).digest("hex").toUpperCase().match(/../g).join(":");
}

function serialNumber() {
  const b = randomBytes(16);
  b[0] &= 0x7f; // positive INTEGER
  return b.toString("hex");
}

/* ---- the CA in use ---- */

let current = null; // { issuer: X509Certificate, key: CryptoKey, root: X509Certificate, leafDays }
let loaded = false;

/**
 * Load the issuing CA from configuration. Missing configuration means the CA
 * is off: the endpoints answer 503 and nothing else changes.
 */
async function loadFromConfig() {
  loaded = true;
  const cfg = config.moshpitCa || {};
  const certPem = pemFromEnv(cfg.cert);
  const keyPem = pemFromEnv(cfg.key);
  const rootPem = pemFromEnv(cfg.root);
  if (!certPem || !keyPem || !rootPem) return null;
  return configureCa({ cert: certPem, key: keyPem, root: rootPem, leafDays: cfg.leafDays });
}

/**
 * Install an issuing CA explicitly (tests, or a future key rotation without a
 * restart). `key` is a PKCS#8 PEM; `cert` and `root` are certificate PEMs.
 */
export async function configureCa({ cert, key, root, leafDays = 30 }) {
  const issuer = new x509.X509Certificate(cert);
  const rootCert = new x509.X509Certificate(root);
  const keyDer = derFromPem(key, "MOSHPIT_CA_KEY");
  const privateKey = await webcrypto.subtle.importKey("pkcs8", keyDer, CA_ALG, true, ["sign"]);
  // The certificate must belong to the key, or every leaf signed here would
  // fail to chain and nobody would know why until a browser said so. WebCrypto
  // has no "public half of this private key", so go through JWK.
  const jwk = await webcrypto.subtle.exportKey("jwk", privateKey);
  delete jwk.d;
  jwk.key_ops = ["verify"];
  const publicKey = await webcrypto.subtle.importKey("jwk", jwk, CA_ALG, true, ["verify"]);
  const spkiOfKey = await webcrypto.subtle.exportKey("spki", publicKey);
  if (Buffer.compare(Buffer.from(spkiOfKey), Buffer.from(issuer.publicKey.rawData)) !== 0) {
    throw new Error("MOSHPIT_CA_KEY does not match MOSHPIT_CA_CERT");
  }
  if (!(await issuer.verify({ publicKey: await rootCert.publicKey.export() }))) {
    throw new Error("MOSHPIT_CA_CERT is not signed by MOSHPIT_CA_ROOT");
  }
  current = { issuer, key: privateKey, root: rootCert, leafDays: Math.max(1, Math.min(Number(leafDays) || 30, 398)) };
  loaded = true;
  return current;
}

export function resetCaForTests() {
  current = null;
  loaded = false;
}

async function ca() {
  if (!loaded) current = await loadFromConfig();
  return current;
}

export async function caEnabled() {
  return Boolean(await ca());
}

/** What a client needs to trust the namespace: the root, and the chain an origin serves. */
export async function caMaterial() {
  const c = await ca();
  if (!c) return null;
  return {
    root: c.root.toString("pem"),
    issuer: c.issuer.toString("pem"),
    chain: `${c.issuer.toString("pem")}\n${c.root.toString("pem")}\n`,
    rootSubject: c.root.subject,
    issuerSubject: c.issuer.subject,
    rootFingerprint: fingerprintOf(c.root),
    rootNotAfter: c.root.notAfter.getTime(),
    leafDays: c.leafDays,
  };
}

/* ---- issuing ---- */

/**
 * Sign a leaf for `label.tld` from a PEM CSR.
 *
 * Returns { cert, chain, serial, notBefore, notAfter, pin } or { error }.
 * The subject is taken from the name, never from the CSR: the caller has
 * already proved control of the name, and letting the CSR's own subject or SAN
 * through would let a holder of blue.eggs ask for a leaf naming red.eggs.
 */
export async function issueLeaf({ tld, label, csr: csrPem }) {
  const c = await ca();
  if (!c) return { error: "certificate authority is not configured", status: 503 };
  if (isRealTld(tld)) return { error: `.${tld} is a real top-level domain; the pit does not sign for it`, status: 400 };

  let csr;
  try {
    csr = new x509.Pkcs10CertificateRequest(String(csrPem || ""));
  } catch {
    return { error: "csr must be a PEM PKCS#10 certificate request", status: 400 };
  }
  if (!(await csr.verify())) return { error: "csr signature does not verify", status: 400 };

  const publicKey = await csr.publicKey.export();
  const alg = csr.publicKey.algorithm || {};
  const rsa = /rsa/i.test(alg.name || "");
  if (rsa && (alg.modulusLength || 0) < 2048) return { error: "RSA keys must be 2048 bits or more", status: 400 };
  if (!rsa && !/ec/i.test(alg.name || "")) return { error: `unsupported key type ${alg.name || "?"}`, status: 400 };

  const name = `${label}.${tld}`;
  const notBefore = new Date(Date.now() - 5 * 60 * 1000); // clock skew
  const notAfter = new Date(Date.now() + c.leafDays * DAY);
  const serial = serialNumber();

  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial,
    subject: `CN=${name}`,
    issuer: c.issuer.subject,
    notBefore,
    notAfter,
    signingAlgorithm: CA_ALG,
    publicKey,
    signingKey: c.key,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | (rsa ? x509.KeyUsageFlags.keyEncipherment : 0),
        true,
      ),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([
        { type: "dns", value: name },
        { type: "dns", value: `*.${name}` },
      ]),
      await x509.SubjectKeyIdentifierExtension.create(publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(c.issuer),
    ],
  });

  return {
    cert: cert.toString("pem"),
    chain: `${cert.toString("pem")}\n${c.issuer.toString("pem")}\n${c.root.toString("pem")}\n`,
    serial,
    notBefore: notBefore.getTime(),
    notAfter: notAfter.getTime(),
    pin: pinOf(cert),
  };
}

/* ---- creating a CA (scripts/moshpit-ca-init.mjs, and tests) ---- */

async function exportPem(key, kind) {
  const der = await webcrypto.subtle.exportKey(kind, key);
  return x509.PemConverter.encode(der, kind === "pkcs8" ? "PRIVATE KEY" : "PUBLIC KEY");
}

/**
 * A root and an issuing intermediate. Returns PEMs; the root key is meant to
 * go somewhere cold, the issuing pair into the server's environment.
 */
export async function generateCa({ rootName = "Moshpit Root CA", issuerName = "Moshpit Issuing CA", rootYears = 20, issuerYears = 10, now = new Date() } = {}) {
  const rootKeys = await webcrypto.subtle.generateKey(CA_ALG, true, ["sign", "verify"]);
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serialNumber(),
    name: `CN=${rootName}, O=Moshpit`,
    notBefore: now,
    notAfter: new Date(now.getTime() + rootYears * 365 * DAY),
    signingAlgorithm: CA_ALG,
    keys: rootKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(rootKeys.publicKey),
    ],
  });

  const issuerKeys = await webcrypto.subtle.generateKey(CA_ALG, true, ["sign", "verify"]);
  const issuer = await x509.X509CertificateGenerator.create({
    serialNumber: serialNumber(),
    subject: `CN=${issuerName}, O=Moshpit`,
    issuer: root.subject,
    notBefore: now,
    notAfter: new Date(now.getTime() + issuerYears * 365 * DAY),
    signingAlgorithm: CA_ALG,
    publicKey: issuerKeys.publicKey,
    signingKey: rootKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(issuerKeys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(root),
    ],
  });

  return {
    root: { cert: root.toString("pem"), key: await exportPem(rootKeys.privateKey, "pkcs8") },
    issuer: { cert: issuer.toString("pem"), key: await exportPem(issuerKeys.privateKey, "pkcs8") },
  };
}

/** A CSR for `name`, for the origin script's counterpart in tests. */
export async function generateCsr(name, keys = null) {
  const k = keys || await webcrypto.subtle.generateKey(CA_ALG, true, ["sign", "verify"]);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${name}`,
    keys: k,
    signingAlgorithm: CA_ALG,
  });
  return { csr: csr.toString("pem"), keys: k, key: await exportPem(k.privateKey, "pkcs8") };
}
