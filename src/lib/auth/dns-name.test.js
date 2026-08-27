/**
 * @fileoverview Tests for proving an ordinary domain by TXT record.
 */

import { describe, it, expect } from 'vitest';
import {
	normalizeDnsName,
	normalizeTxtValue,
	challengeRecordName,
	challengeRecord,
	verifyDnsProof,
	PUBLIC_RESOLVERS,
	CHALLENGE_LABEL
} from './dns-name.js';

const NONCE = '2f8a1c9e4b7d6033a5e1c8b2d94f7061';

/** A DoH resolver that answers with the given TXT values. */
const resolverWith = (values, status = 0) => async () => ({
	ok: true,
	status: 200,
	json: async () => ({
		Status: status,
		Answer: values.map((v) => ({ type: 16, data: v }))
	})
});

describe('normalizeDnsName', () => {
	it('accepts more than two labels, unlike a Moshpit name', () => {
		expect(normalizeDnsName('example.co.uk')).toBe('example.co.uk');
		expect(normalizeDnsName('Mail.Example.COM.')).toBe('mail.example.com');
	});

	it('refuses empty labels rather than collapsing them', () => {
		// Same rule as the Moshpit side: two spellings must not become one identity.
		expect(normalizeDnsName('example..com')).toBeNull();
	});

	it('refuses a bare address', () => {
		// Whoever holds the address today would otherwise answer for it.
		expect(normalizeDnsName('192.168.1.1')).toBeNull();
	});

	it('refuses a single label and over-long names', () => {
		expect(normalizeDnsName('localhost')).toBeNull();
		expect(normalizeDnsName(`${'a'.repeat(64)}.com`)).toBeNull();
		expect(normalizeDnsName(`${'a'.repeat(250)}.com`)).toBeNull();
	});
});

describe('normalizeTxtValue', () => {
	it('unquotes a single string', () => {
		expect(normalizeTxtValue('"hello"')).toBe('hello');
	});

	it('joins the character-strings a long TXT is split into', () => {
		// A TXT value over 255 bytes arrives as several quoted parts. Comparing
		// without joining means such a value can never match.
		expect(normalizeTxtValue('"part-one" "part-two"')).toBe('part-onepart-two');
	});

	it('leaves an unquoted value alone', () => {
		expect(normalizeTxtValue('bare-value')).toBe('bare-value');
	});
});

describe('challengeRecord', () => {
	it('publishes under a dedicated label, not the apex', () => {
		expect(challengeRecordName('example.com')).toBe(`${CHALLENGE_LABEL}.example.com`);
	});

	it('describes the record a person has to create', () => {
		expect(challengeRecord('example.com', NONCE)).toEqual({
			type: 'TXT',
			name: `${CHALLENGE_LABEL}.example.com`,
			value: NONCE
		});
	});
});

describe('verifyDnsProof', () => {
	it('accepts the nonce published at the challenge record', async () => {
		const out = await verifyDnsProof({
			name: 'example.com',
			nonce: NONCE,
			fetchImpl: resolverWith([`"${NONCE}"`])
		});
		expect(out).toMatchObject({ name: 'example.com', record: `${CHALLENGE_LABEL}.example.com` });
	});

	it('accepts it alongside unrelated TXT records', async () => {
		const out = await verifyDnsProof({
			name: 'example.com',
			nonce: NONCE,
			fetchImpl: resolverWith(['"v=spf1 -all"', `"${NONCE}"`])
		});
		expect(out.name).toBe('example.com');
	});

	it('refuses when the record carries a different value', async () => {
		await expect(
			verifyDnsProof({ name: 'example.com', nonce: NONCE, fetchImpl: resolverWith(['"something-else"']) })
		).rejects.toMatchObject({ code: 'record_not_found', definite: true });
	});

	it('refuses on NXDOMAIN, which is an answer', async () => {
		await expect(
			verifyDnsProof({ name: 'example.com', nonce: NONCE, fetchImpl: resolverWith([], 3) })
		).rejects.toMatchObject({ code: 'record_not_found', definite: true });
	});

	it('treats SERVFAIL as an outage, not as absence', async () => {
		// Reading a non-answer as "no record" would refuse a good proof for the
		// duration of somebody else's outage.
		await expect(
			verifyDnsProof({ name: 'example.com', nonce: NONCE, fetchImpl: resolverWith([], 2) })
		).rejects.toMatchObject({ code: 'resolvers_unreachable', definite: false });
	});

	it('falls through to the second resolver when the first is down', async () => {
		let call = 0;
		const flaky = async (url) => {
			call += 1;
			if (call === 1) throw new Error('connection reset');
			return resolverWith([`"${NONCE}"`])(url);
		};
		const out = await verifyDnsProof({ name: 'example.com', nonce: NONCE, fetchImpl: flaky });
		expect(out.resolver).toBe(PUBLIC_RESOLVERS[1]);
	});

	it('reports an outage when every resolver fails', async () => {
		const down = async () => {
			throw new Error('connection reset');
		};
		await expect(
			verifyDnsProof({ name: 'example.com', nonce: NONCE, fetchImpl: down })
		).rejects.toMatchObject({ definite: false });
	});

	it('never asks the system resolver', async () => {
		// The machine may run the Moshpit bridge, which answers for its own
		// endings. Only public resolvers can speak for the public root.
		const seen = [];
		const spy = async (url) => {
			seen.push(String(url));
			return resolverWith([`"${NONCE}"`])(url);
		};
		await verifyDnsProof({ name: 'example.com', nonce: NONCE, fetchImpl: spy });
		expect(seen.every((u) => PUBLIC_RESOLVERS.some((r) => u.startsWith(r)))).toBe(true);
	});

	it('refuses a name that is not a domain before resolving anything', async () => {
		let called = 0;
		const counting = async (url) => {
			called += 1;
			return resolverWith([])(url);
		};
		await expect(
			verifyDnsProof({ name: 'not-a-domain', nonce: NONCE, fetchImpl: counting })
		).rejects.toMatchObject({ code: 'not_a_domain' });
		expect(called).toBe(0);
	});
});
