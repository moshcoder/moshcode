/**
 * @fileoverview Tests for "sign in with a name".
 *
 * The fixture is a real P-256 certificate minted exactly the way moshcode's
 * certificateCommand() mints them (prime256v1, SAN of the name and nothing
 * else, 10-year expiry). Only the CERTIFICATE and a signature it produced are
 * committed -- never the private key, which is both unnecessary here and the
 * kind of thing a secret scanner is right to fail a build over.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
	normalizeName,
	spkiPin,
	certAssertsName,
	resolveName,
	publishedPins,
	verifyNameProof,
	NameProofError
} from './moshpit.js';

const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBnDCCAUKgAwIBAgIUECAPRhGjmqRGHtwFGmgtpmk/Gz8wCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMY2hvdnkuaGFja2VyMB4XDTI2MDgyNzE3MDMzM1oXDTM2MDgy
NDE3MDMzM1owFzEVMBMGA1UEAwwMY2hvdnkuaGFja2VyMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAES1ALtfaSbX+tjKkCTJykMvVo0ylZ3pK0A83l82tqtBK+orbN
PotE59L6emTnDDzLZDVMpuenC23/nNpl5sLpDqNsMGowHQYDVR0OBBYEFJh+jCCl
r0GoDrHZrTo8eV2au6gKMB8GA1UdIwQYMBaAFJh+jCClr0GoDrHZrTo8eV2au6gK
MA8GA1UdEwEB/wQFMAMBAf8wFwYDVR0RBBAwDoIMY2hvdnkuaGFja2VyMAoGCCqG
SM49BAMCA0gAMEUCIQCMI9TBYP44s78ckz0aYxxRSc1GrI8rmXKWMCtnkjJkiwIg
JNcWr37DtUR0T4raXxFx3F/xXe78zBcR6E8U5MTQ7Gs=
-----END CERTIFICATE-----`;

/** A signature by the matching private key over exactly this nonce. */
const NONCE = '2f8a1c9e4b7d6033a5e1c8b2d94f7061';
const SIGNATURE = 'MEUCIFGFpCiU8dDZO1QWStcbpjtKZgGVLfinnBPSiOcGUt0yAiEAhM9xfKP8L9RgPtIB7aM9neZ0dMp1GFIar/Qbq5Msa/8=';

/** The pin openssl computes for this certificate's key. Interop canary. */
const PIN = 'jovtOp+qXpKizq5DiSaU5IxPaiFReZLHTqoZnAEnv3U=';

const NAME = 'chovy.hacker';

/** A registry that answers the happy path. */
function registry({ pins = [PIN], prefer = 'fallback', nameRegistered = true, resolved = NAME } = {}) {
	return async (url) => {
		if (String(url).includes('/api/moshpit/resolve')) {
			return {
				ok: true,
				status: 200,
				json: async () => ({ name: NAME, resolved, name_registered: nameRegistered, prefer })
			};
		}
		return { ok: true, status: 200, json: async () => ({ pins }) };
	};
}

const proof = (over = {}) => ({
	name: NAME,
	certPem: CERT_PEM,
	signatureB64: SIGNATURE,
	nonce: NONCE,
	fetchImpl: registry(),
	...over
});

describe('normalizeName', () => {
	it('lowercases and drops a trailing dot', () => {
		expect(normalizeName('Chovy.Hacker.')).toBe('chovy.hacker');
	});

	it('refuses anything that is not exactly label.tld', () => {
		for (const bad of ['', 'hacker', 'a.b.c', 'chovy..hacker', '-x.hacker', 'x.hacker-']) {
			expect(normalizeName(bad)).toBeNull();
		}
	});
});

describe('spkiPin', () => {
	it('matches what openssl computes over the SPKI', () => {
		// If this ever drifts, every comparison against the registry silently
		// fails and nothing says why -- so it is asserted against a constant
		// produced by openssl rather than by this code.
		const cert = new crypto.X509Certificate(CERT_PEM);
		expect(spkiPin(cert.publicKey)).toBe(PIN);
	});
});

describe('certAssertsName', () => {
	it('accepts a SAN of exactly this name', () => {
		expect(certAssertsName(new crypto.X509Certificate(CERT_PEM), NAME)).toBe(true);
	});

	it('rejects a different name', () => {
		expect(certAssertsName(new crypto.X509Certificate(CERT_PEM), 'other.hacker')).toBe(false);
	});
});

describe('resolveName', () => {
	it('refuses a name the public root already answers for', async () => {
		// Real endings are claimed inside the pit, so without this an attacker
		// who mints stripe.dev there is indistinguishable from the company.
		await expect(resolveName(NAME, { fetchImpl: registry({ prefer: 'clearnet' }) })).rejects.toMatchObject({
			code: 'prefer_clearnet'
		});
	});

	it('refuses a name nobody holds', async () => {
		await expect(
			resolveName(NAME, { fetchImpl: registry({ nameRegistered: false }) })
		).rejects.toMatchObject({ code: 'name_unregistered' });
	});

	it('carries the resolved name through an alias', async () => {
		const out = await resolveName(NAME, { fetchImpl: registry({ resolved: 'chovy.eggs' }) });
		expect(out.resolved).toBe('chovy.eggs');
	});

	it('marks an outage as not definite', async () => {
		const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
		await expect(resolveName(NAME, { fetchImpl: down })).rejects.toMatchObject({ definite: false });
	});
});

describe('publishedPins', () => {
	it('treats 404 as a definite refusal', async () => {
		const missing = async () => ({ ok: false, status: 404, json: async () => ({ pins: [] }) });
		await expect(publishedPins(NAME, { fetchImpl: missing })).rejects.toMatchObject({
			code: 'no_pin',
			definite: true
		});
	});

	it('treats a 5xx as an outage, not an answer', async () => {
		// The difference matters: a client that flattens them either fails
		// closed forever or fails open once, and the second defeats pinning.
		const down = async () => ({ ok: false, status: 502, json: async () => ({}) });
		await expect(publishedPins(NAME, { fetchImpl: down })).rejects.toMatchObject({ definite: false });
	});
});

describe('verifyNameProof', () => {
	it('accepts a signature by the pinned key', async () => {
		const out = await verifyNameProof(proof());
		expect(out).toMatchObject({ name: NAME, resolved: NAME, pin: PIN, kind: 'tls' });
	});

	it('accepts when the pin is one of several during a rotation', async () => {
		const out = await verifyNameProof(proof({ fetchImpl: registry({ pins: ['OLDPIN', PIN] }) }));
		expect(out.pin).toBe(PIN);
	});

	it('rejects a signature over a different nonce', async () => {
		await expect(verifyNameProof(proof({ nonce: 'not-the-nonce' }))).rejects.toMatchObject({
			code: 'bad_signature'
		});
	});

	it('rejects a key the registry does not publish', async () => {
		await expect(
			verifyNameProof(proof({ fetchImpl: registry({ pins: ['someone-elses-pin'] }) }))
		).rejects.toMatchObject({ code: 'pin_mismatch' });
	});

	it('rejects a certificate that asserts a different name', async () => {
		await expect(verifyNameProof(proof({ name: 'other.hacker' }))).rejects.toMatchObject({
			code: 'name_mismatch'
		});
	});

	it('rejects an expired certificate', async () => {
		await expect(verifyNameProof(proof({ now: new Date('2099-01-01') }))).rejects.toMatchObject({
			code: 'certificate_expired'
		});
	});

	it('rejects a malformed certificate', async () => {
		await expect(verifyNameProof(proof({ certPem: 'not a certificate' }))).rejects.toMatchObject({
			code: 'bad_certificate'
		});
	});

	it('refuses before spending a registry request on a bad signature', async () => {
		// Ordering is deliberate: proving possession is local and free.
		let called = 0;
		const counting = async (url) => {
			called += 1;
			return registry()(url);
		};
		await expect(
			verifyNameProof(proof({ nonce: 'wrong', fetchImpl: counting }))
		).rejects.toBeInstanceOf(NameProofError);
		expect(called).toBe(0);
	});
});
