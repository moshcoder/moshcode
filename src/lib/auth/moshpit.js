/**
 * @fileoverview "Sign in with a name" — proving a Moshpit name belongs to you.
 *
 * No CA will vouch for `chovy.hacker`, so Moshpit inverts certificate
 * validation: the registry publishes the SHA-256 of the SubjectPublicKeyInfo a
 * name's certificate must present, and clients compare against that instead of
 * a chain of issuers. We reuse that binding as an identity proof — hold the key
 * the registry vouches for, and you hold the name.
 *
 * The private key never reaches us. The client signs a nonce we issued; we
 * check the signature against the certificate it sent, and the certificate
 * against the pins the registry publishes.
 *
 * Additive only: does NOT touch the phone/SMS, CoinPay or anon-invite paths.
 */

import crypto from 'node:crypto';

/** Where the registry lives. */
export const DEFAULT_REGISTRY_BASE = 'https://pit.moshcode.sh';

/** A pin is SHA-256 over an SPKI, base64 — 32 bytes, so always 44 chars. */
const PIN_LENGTH = 44;

/** How long a challenge is good for. Long enough to sign, short enough to matter. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Raised when a proof is refused. `definite` separates "the registry says no"
 * from "the registry did not answer".
 *
 * The pins endpoint documents 400/404 as cacheable definite answers and
 * anything else as an outage, and warns that a client treating them alike
 * either fails closed forever or fails open once. The second is how pinning
 * gets quietly defeated, so the distinction is carried rather than flattened.
 */
export class NameProofError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 * @param {{definite?: boolean}} [opts]
	 */
	constructor(code, message, { definite = true } = {}) {
		super(message);
		this.name = 'NameProofError';
		this.code = code;
		this.definite = definite;
	}
}

/**
 * Normalize a name the way the registry does: lowercase, no trailing dot.
 * @param {unknown} input
 * @returns {string | null} `label.tld`, or null if it is not one.
 */
export function normalizeName(input) {
	const clean = String(input ?? '')
		.trim()
		.toLowerCase()
		.replace(/\.$/, '');
	if (!clean) return null;
	// Deliberately NOT filtering empty segments out. Collapsing `chovy..hacker`
	// to `chovy.hacker` would map two different strings onto one identity, which
	// for a filename is harmless and for an account is a way in.
	const parts = clean.split('.');
	if (parts.length !== 2 || parts.some((p) => !p)) return null;
	if (!parts.every((p) => /^[a-z0-9-]+$/.test(p) && !p.startsWith('-') && !p.endsWith('-'))) {
		return null;
	}
	return parts.join('.');
}

/**
 * The pin for a public key: SHA-256 over the SubjectPublicKeyInfo, base64.
 *
 * Over the SPKI rather than the certificate, so re-issuing a certificate for
 * the same key does not invalidate the pin. Must stay byte-identical to
 * moshcode's spkiPin() or every comparison silently fails.
 *
 * @param {crypto.KeyObject} publicKey
 * @returns {string}
 */
export function spkiPin(publicKey) {
	const der = publicKey.export({ type: 'spki', format: 'der' });
	return crypto.createHash('sha256').update(der).digest('base64');
}

/**
 * Ask the registry what this name is, and whether the pit has any say over it.
 *
 * Reads `prefer`, not `registered`. `registered` only means the ENDING is
 * claimed, and real ICANN endings (.io .dev .app .ai .sh .co) are claimed
 * inside the pit — so treating it as "this is a Moshpit name" is how a resolver
 * starts hijacking domains that already work. `prefer` is the field that says
 * what a client should actually do.
 *
 * @param {string} name
 * @param {{registryBase?: string, fetchImpl?: typeof fetch}} [opts]
 */
export async function resolveName(name, { registryBase = DEFAULT_REGISTRY_BASE, fetchImpl = fetch } = {}) {
	const url = `${registryBase.replace(/\/+$/, '')}/api/moshpit/resolve?name=${encodeURIComponent(name)}`;

	let res;
	try {
		res = await fetchImpl(url);
	} catch (error) {
		throw new NameProofError('registry_unreachable', `registry did not answer: ${error.message}`, {
			definite: false
		});
	}

	if (res.status === 400) {
		throw new NameProofError('not_a_name', 'not a Moshpit name — expected <label>.<tld>');
	}
	if (!res.ok) {
		throw new NameProofError('registry_error', `registry answered ${res.status}`, { definite: false });
	}

	const json = await res.json();

	// Clearnet wins by default: the name already works in the legacy root, so a
	// Moshpit proof for it would be an impersonation of whoever holds the real
	// domain. That path is the registrar TXT flow, not this one.
	if (json?.prefer === 'clearnet') {
		throw new NameProofError(
			'prefer_clearnet',
			'this name belongs to the public DNS root — prove it with a DNS TXT record instead'
		);
	}
	if (!json?.name_registered) {
		throw new NameProofError('name_unregistered', 'nobody holds this name');
	}

	// An aliased ending resolves elsewhere, and pins are stored against the
	// ending it resolves TO. Binding the resolved name keeps `x.foo` and
	// `x.bar` (where .foo aliases .bar) from becoming two accounts for one key.
	return { name: json.name, resolved: json.resolved || json.name };
}

/**
 * The pins the registry publishes for a name.
 * @param {string} name
 * @param {{kind?: string, registryBase?: string, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<string[]>}
 */
export async function publishedPins(
	name,
	{ kind = 'tls', registryBase = DEFAULT_REGISTRY_BASE, fetchImpl = fetch } = {}
) {
	const base = registryBase.replace(/\/+$/, '');
	const url = `${base}/api/moshpit/pins?name=${encodeURIComponent(name)}&kind=${encodeURIComponent(kind)}`;

	let res;
	try {
		res = await fetchImpl(url);
	} catch (error) {
		throw new NameProofError('registry_unreachable', `registry did not answer: ${error.message}`, {
			definite: false
		});
	}

	// 400 and 404 are answers, not failures — refuse and stop. Anything else is
	// an outage, and retrying beats binding an identity on a shrug.
	if (res.status === 400) throw new NameProofError('not_a_name', 'not a Moshpit name');
	if (res.status === 404) {
		throw new NameProofError('no_pin', 'the registry publishes no key for this name');
	}
	if (!res.ok) {
		throw new NameProofError('registry_error', `registry answered ${res.status}`, { definite: false });
	}

	const json = await res.json();
	const pins = Array.isArray(json?.pins) ? json.pins.filter((p) => typeof p === 'string') : [];
	if (!pins.length) throw new NameProofError('no_pin', 'the registry publishes no key for this name');
	return pins;
}

/**
 * Does this certificate assert exactly this name, and nothing else?
 *
 * Browsers and pin-checking clients read SAN, not CN, and moshcode mints these
 * with `subjectAltName=DNS:<name>` and deliberately nothing more — a wildcard
 * over the ending would let one buyer's certificate speak for every other name
 * under it. So an extra SAN entry is a refusal, not a detail to tolerate.
 *
 * @param {crypto.X509Certificate} cert
 * @param {string} name
 */
export function certAssertsName(cert, name) {
	const san = String(cert.subjectAltName ?? '').trim();
	if (!san) return false;
	const entries = san.split(',').map((s) => s.trim()).filter(Boolean);
	return entries.length === 1 && entries[0].toLowerCase() === `dns:${name}`;
}

/**
 * Verify a signed challenge against the key the registry vouches for.
 *
 * Order matters: cheap structural checks first, the network call last, so a
 * malformed proof never costs the registry a request.
 *
 * @param {object} args
 * @param {string} args.name              the name being claimed
 * @param {string} args.certPem           the certificate the client presented
 * @param {string} args.signatureB64      signature over the nonce, DER-encoded
 * @param {string} args.nonce             the nonce we issued
 * @param {string} [args.kind]            pin kind: 'tls' (P-256) or 'mtp' (ML-DSA-65)
 * @param {string} [args.registryBase]
 * @param {typeof fetch} [args.fetchImpl]
 * @param {Date} [args.now]
 * @returns {Promise<{name: string, resolved: string, pin: string, kind: string}>}
 */
export async function verifyNameProof({
	name: rawName,
	certPem,
	signatureB64,
	nonce,
	kind = 'tls',
	registryBase = DEFAULT_REGISTRY_BASE,
	fetchImpl = fetch,
	now = new Date()
}) {
	const name = normalizeName(rawName);
	if (!name) throw new NameProofError('not_a_name', 'not a Moshpit name — expected <label>.<tld>');
	if (typeof certPem !== 'string' || !certPem.includes('BEGIN CERTIFICATE')) {
		throw new NameProofError('bad_certificate', 'a PEM certificate is required');
	}
	if (typeof signatureB64 !== 'string' || !signatureB64) {
		throw new NameProofError('bad_signature', 'a signature is required');
	}
	if (typeof nonce !== 'string' || !nonce) {
		throw new NameProofError('bad_nonce', 'a nonce is required');
	}

	let cert;
	try {
		cert = new crypto.X509Certificate(certPem);
	} catch (error) {
		throw new NameProofError('bad_certificate', `could not parse the certificate: ${error.message}`);
	}

	if (!certAssertsName(cert, name)) {
		throw new NameProofError(
			'name_mismatch',
			'the certificate does not assert exactly this name'
		);
	}

	// A pinned certificate is minted with a long expiry on purpose, so one that
	// has already lapsed is a real signal rather than routine churn.
	const notAfter = new Date(cert.validTo);
	const notBefore = new Date(cert.validFrom);
	if (Number.isFinite(notAfter.getTime()) && notAfter < now) {
		throw new NameProofError('certificate_expired', 'the certificate has expired');
	}
	if (Number.isFinite(notBefore.getTime()) && notBefore > now) {
		throw new NameProofError('certificate_not_yet_valid', 'the certificate is not valid yet');
	}

	let signature;
	try {
		signature = Buffer.from(signatureB64, 'base64');
	} catch {
		throw new NameProofError('bad_signature', 'the signature is not base64');
	}
	if (!signature.length) throw new NameProofError('bad_signature', 'the signature is empty');

	// The signature is checked BEFORE the registry is asked. Proving possession
	// of the presented key is local and free; the pin lookup is the expensive
	// half and there is no reason to spend it on a proof that already fails.
	const signed = crypto.verify(
		'sha256',
		Buffer.from(nonce, 'utf8'),
		{ key: cert.publicKey, dsaEncoding: 'der' },
		signature
	);
	if (!signed) {
		throw new NameProofError('bad_signature', 'the signature does not match the certificate');
	}

	const resolution = await resolveName(name, { registryBase, fetchImpl });
	const pins = await publishedPins(resolution.resolved, { kind, registryBase, fetchImpl });

	const pin = spkiPin(cert.publicKey);
	if (pin.length !== PIN_LENGTH) {
		throw new NameProofError('bad_certificate', 'the certificate key does not hash to a pin');
	}

	// Any published pin matches, not just the first: the registry lists the old
	// pin alongside the new one during a rotation, precisely so a key can change
	// without a flag day.
	if (!pins.includes(pin)) {
		throw new NameProofError(
			'pin_mismatch',
			'the presented key is not among the keys the registry publishes for this name'
		);
	}

	return { name: resolution.name, resolved: resolution.resolved, pin, kind };
}
