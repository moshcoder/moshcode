/**
 * @fileoverview "Sign in with a domain" — proving an ordinary DNS name.
 *
 * The Moshpit path works because we operate the registry and can check a
 * signature against a key we publish. For a name in the public root there is no
 * such key, so the proof is the one thing only the holder can do: publish a
 * record under it.
 *
 * This is the commodity half of the design and it is deliberately last. It is
 * also the half with the weaker guarantee — control of DNS is control of the
 * identity, so a registrar seizure or a lapsed renewal is an account takeover.
 * That is inherent to the mechanism, not a gap in this code.
 *
 * Additive only: does NOT touch the phone/SMS, CoinPay, anon or Moshpit flows.
 */

/**
 * Where the challenge is published.
 *
 * Under a dedicated label rather than the apex: publishing at the apex means
 * handing us a record that sits alongside SPF and DMARC, and a person clearing
 * it out later has to know which stray TXT was load-bearing.
 */
export const CHALLENGE_LABEL = '_qryptchat-challenge';

/**
 * Public resolvers, tried in order.
 *
 * NOT the system resolver, and that is the whole point. Any box running the
 * Moshpit DNS bridge answers for its own endings locally, so asking the machine
 * we happen to be on whether a name exists in the public root is asking the
 * wrong authority — it is exactly the confusion that made `moshcode.sh` redirect
 * into the pit. The public root has to be checked against something that only
 * knows the public root.
 */
export const PUBLIC_RESOLVERS = [
	'https://cloudflare-dns.com/dns-query',
	'https://dns.google/resolve'
];

/** How long we will wait on a resolver before treating it as an outage. */
const RESOLVER_TIMEOUT_MS = 5000;

/**
 * Raised when a domain proof is refused. `definite` separates "the record is
 * not there" from "we could not look".
 */
export class DnsProofError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 * @param {{definite?: boolean}} [opts]
	 */
	constructor(code, message, { definite = true } = {}) {
		super(message);
		this.name = 'DnsProofError';
		this.code = code;
		this.definite = definite;
	}
}

/**
 * Normalize a public-root domain.
 *
 * Unlike a Moshpit name this is NOT restricted to two labels: `example.co.uk`
 * and `mail.example.com` are both real domains. Empty labels are refused rather
 * than collapsed, for the same reason as everywhere else in this design — two
 * spellings must never become one identity.
 *
 * @param {unknown} input
 * @returns {string | null}
 */
export function normalizeDnsName(input) {
	const clean = String(input ?? '')
		.trim()
		.toLowerCase()
		.replace(/\.$/, '');
	if (!clean || clean.length > 253) return null;

	const labels = clean.split('.');
	if (labels.length < 2) return null;
	if (labels.some((l) => !l || l.length > 63)) return null;
	if (!labels.every((l) => /^[a-z0-9-]+$/.test(l) && !l.startsWith('-') && !l.endsWith('-'))) {
		return null;
	}
	// A bare IP is not a domain, and treating one as an identity would let
	// whoever holds the address today answer for it.
	if (/^\d+(\.\d+)*$/.test(clean)) return null;
	return clean;
}

/**
 * The fully-qualified name a challenge is published at.
 * @param {string} name
 */
export function challengeRecordName(name) {
	return `${CHALLENGE_LABEL}.${name}`;
}

/**
 * What to tell someone to publish.
 * @param {string} name
 * @param {string} nonce
 */
export function challengeRecord(name, nonce) {
	return { type: 'TXT', name: challengeRecordName(name), value: nonce };
}

/**
 * Strip the quoting a DoH resolver puts around TXT strings, and join the
 * character-strings a long TXT value is split into.
 *
 * A TXT record is a sequence of length-prefixed strings, and resolvers render
 * that as `"part one" "part two"`. Comparing without joining means a value that
 * happens to cross the 255-byte boundary never matches, which would be a bug
 * nobody could reproduce with a short nonce.
 *
 * @param {string} raw
 */
export function normalizeTxtValue(raw) {
	const text = String(raw ?? '').trim();
	const quoted = text.match(/"(?:[^"\\]|\\.)*"/g);
	if (!quoted) return text.replace(/^"|"$/g, '');
	return quoted.map((part) => part.slice(1, -1).replace(/\\"/g, '"')).join('');
}

/**
 * Ask one public resolver for the TXT records at a name.
 *
 * @param {string} resolver
 * @param {string} recordName
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<string[]>}
 */
async function txtFrom(resolver, recordName, fetchImpl) {
	const url = `${resolver}?name=${encodeURIComponent(recordName)}&type=TXT`;
	const res = await fetchImpl(url, {
		headers: { accept: 'application/dns-json' },
		signal: AbortSignal.timeout(RESOLVER_TIMEOUT_MS)
	});
	if (!res.ok) throw new Error(`resolver answered ${res.status}`);

	const json = await res.json();

	// SERVFAIL and friends are not "no record" -- they are "no answer", and a
	// caller that reads them as absence refuses a proof that may be perfectly
	// good. Only NOERROR (0) and NXDOMAIN (3) are answers.
	const status = json?.Status;
	if (status !== 0 && status !== 3) {
		throw new Error(`resolver returned status ${status}`);
	}

	return (Array.isArray(json?.Answer) ? json.Answer : [])
		.filter((a) => a?.type === 16)
		.map((a) => normalizeTxtValue(a.data));
}

/**
 * Is the nonce published under this domain?
 *
 * Agreement is not required across resolvers -- one authoritative answer is the
 * answer. But every resolver failing is an outage, not a refusal, and says so.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {string} args.nonce
 * @param {string[]} [args.resolvers]
 * @param {typeof fetch} [args.fetchImpl]
 * @returns {Promise<{name: string, record: string, resolver: string}>}
 */
export async function verifyDnsProof({
	name: rawName,
	nonce,
	resolvers = PUBLIC_RESOLVERS,
	fetchImpl = fetch
}) {
	const name = normalizeDnsName(rawName);
	if (!name) throw new DnsProofError('not_a_domain', 'not a valid domain name');
	if (typeof nonce !== 'string' || !nonce) {
		throw new DnsProofError('bad_nonce', 'a nonce is required');
	}

	const recordName = challengeRecordName(name);
	const failures = [];
	let sawAnswer = false;

	for (const resolver of resolvers) {
		let values;
		try {
			// Sequential on purpose: the first resolver that answers ends it, and
			// fanning out would query every public resolver for every attempt.
			values = await txtFrom(resolver, recordName, fetchImpl);
		} catch (error) {
			failures.push(`${resolver}: ${error.message}`);
			continue;
		}

		sawAnswer = true;
		if (values.includes(nonce)) {
			return { name, record: recordName, resolver };
		}
	}

	// Every resolver refused to answer. That is not evidence the record is
	// missing, and answering "not yours" here would refuse a valid proof for
	// the duration of someone else's outage.
	if (!sawAnswer) {
		throw new DnsProofError(
			'resolvers_unreachable',
			`could not reach a public resolver (${failures.join('; ')})`,
			{ definite: false }
		);
	}

	throw new DnsProofError(
		'record_not_found',
		`no TXT record at ${recordName} carries this challenge — publish it and try again`
	);
}
