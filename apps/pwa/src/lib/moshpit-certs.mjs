// Issuing certificates for names: the part of the CA that knows about people.
//
// moshpit-ca.mjs signs; this decides who may ask. The rule is the one pins
// already use, controlledName(): the name's holder, or its tenant while a lease
// runs. That is what makes the resale case safe -- whoever holds `.foo` cannot
// obtain a certificate for `bar.foo` once it is somebody else's -- and it is
// why the CA lives in the registry rather than with ending owners.
//
// Every leaf is also published as a pin, so a client that still checks pins
// keeps working through the switch, and the two records never disagree.
import { all, get, run } from "../db.mjs";
import { addPin, controlledName, logAction, normalizeLabel, normalizeTld } from "../moshpit.mjs";
import { issueLeaf } from "./moshpit-ca.mjs";

const CERT_COLS = `serial, tld, label, pin, cert, user_id, not_before, not_after, issued_at`;
const DAY = 24 * 60 * 60 * 1000;

/** Issuances allowed per name per day. A renewal loop gone wrong, not a user, is what this catches. */
export const MAX_CERTS_PER_DAY = 24;

/**
 * Sign a certificate for `label.tld` on behalf of `userId`.
 *
 * Returns { ok: true, name, serial, cert, chain, notBefore, notAfter, pin }
 * or { ok: false, error, status }.
 */
export async function issueNameCertificate({ tld: tldInput, label: labelInput, userId, csr, now = Date.now() }) {
  const owned = await controlledName(tldInput, labelInput, userId, now);
  if (!owned.ok) return { ok: false, error: owned.error, status: 403 };
  const { tld, label } = owned;

  const recent = await get(
    `SELECT COUNT(*) AS n FROM moshpit_name_certs WHERE tld = ? AND label = ? AND issued_at > ?`,
    [tld, label, now - DAY],
  );
  if ((recent?.n ?? 0) >= MAX_CERTS_PER_DAY) {
    return { ok: false, error: `${label}.${tld} has been issued ${MAX_CERTS_PER_DAY} certificates in the last day; try again later`, status: 429 };
  }

  const leaf = await issueLeaf({ tld, label, csr });
  if (leaf.error) return { ok: false, error: leaf.error, status: leaf.status || 400 };

  await run(
    `INSERT INTO moshpit_name_certs (${CERT_COLS}) VALUES (?,?,?,?,?,?,?,?,?)`,
    [leaf.serial, tld, label, leaf.pin, leaf.cert, userId, leaf.notBefore, leaf.notAfter, now],
  );
  // The pin is the same key the certificate carries; publishing it keeps every
  // pin-checking client (moshcode dns trust, the pit helper) in step. A pin that
  // is already there is fine; one already published as a different kind is not
  // ours to fix here, and the certificate is still valid without it.
  const pinned = await addPin({ tld, label, pin: leaf.pin, kind: "tls", note: "moshpit-ca", userId });
  await logAction(tld, userId, `cert:issue:${label}:${leaf.serial.slice(0, 8)}`);

  return {
    ok: true,
    name: `${label}.${tld}`,
    serial: leaf.serial,
    cert: leaf.cert,
    chain: leaf.chain,
    notBefore: leaf.notBefore,
    notAfter: leaf.notAfter,
    pin: leaf.pin,
    pinPublished: Boolean(pinned.ok),
  };
}

/** What has been issued under a name, newest first. Public: certificates are. */
export async function listNameCertificates(tldInput, labelInput, { limit = 50, now = Date.now() } = {}) {
  const tld = normalizeTld(tldInput);
  const label = normalizeLabel(labelInput);
  if (!tld || !label) return [];
  const rows = await all(
    `SELECT serial, pin, not_before, not_after, issued_at FROM moshpit_name_certs
      WHERE tld = ? AND label = ? ORDER BY issued_at DESC LIMIT ?`,
    [tld, label, limit],
  );
  return rows.map((r) => ({ ...r, expired: r.not_after <= now }));
}

/** One issued certificate by serial, with its PEM. */
export async function getNameCertificate(serial) {
  return get(`SELECT ${CERT_COLS} FROM moshpit_name_certs WHERE serial = ?`, [String(serial || "")]);
}
