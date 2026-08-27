/**
 * @fileoverview POST /api/auth/moshpit/verify — prove a Moshpit name, get a session.
 *
 * Step two of "sign in with a name". The client returns the nonce we issued,
 * signed by the key the registry pins for that name, plus the certificate
 * carrying that key and its on-device ML-KEM-1024 public key.
 *
 * We check the signature, check the key against the published pins, burn the
 * challenge, then provision. The provisioning itself lives in
 * lib/auth/name-account.js, shared with the DNS TXT path.
 *
 * Additive only: does NOT touch the phone/SMS, CoinPay or anon flows.
 */

import { NextResponse } from 'next/server';
import { normalizeName, verifyNameProof, NameProofError } from '@/lib/auth/moshpit.js';
import {
	createServiceClient,
	loadSpendableChallenge,
	burnChallenge,
	provisionNameAccount,
	mintSession,
	ProvisionError
} from '@/lib/auth/name-account.js';

/**
 * POST /api/auth/moshpit/verify
 *
 * Body: { jti, name, certPem, signature, publicKey, displayName? }
 * Returns: { success, session, user }
 *
 * @param {import('next/server').NextRequest} request
 */
export async function POST(request) {
	let body;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: 'Invalid request format' }, { status: 400 });
	}

	const { jti, certPem, signature, publicKey, displayName } = body || {};
	const name = normalizeName(body?.name);

	if (!name) {
		return NextResponse.json({ error: 'Not a valid name — expected <label>.<tld>' }, { status: 400 });
	}
	if (typeof jti !== 'string' || !jti) {
		return NextResponse.json({ error: 'A challenge id is required' }, { status: 400 });
	}
	const mlkemKey = typeof publicKey === 'string' ? publicKey.trim() : '';
	if (!mlkemKey) {
		return NextResponse.json({ error: 'A public key is required' }, { status: 400 });
	}

	const serviceSupabase = createServiceClient();

	// --- a) Load the challenge ---
	const loaded = await loadSpendableChallenge(serviceSupabase, jti, {
		name,
		namespace: 'moshpit'
	});
	if ('error' in loaded) {
		return NextResponse.json({ error: loaded.error }, { status: 400 });
	}
	const { challenge } = loaded;

	// --- b) Check the proof BEFORE burning anything ---
	let proof;
	try {
		proof = await verifyNameProof({
			name: challenge.name,
			certPem,
			signatureB64: signature,
			nonce: challenge.nonce
		});
	} catch (error) {
		if (error instanceof NameProofError) {
			// An outage is not a refusal. 503 tells the client to retry rather
			// than to conclude the name is not theirs.
			return NextResponse.json(
				{ error: error.message, code: error.code },
				{ status: error.definite ? 400 : 503 }
			);
		}
		console.error('moshpit/verify: unexpected verification failure', error);
		return NextResponse.json({ error: 'Could not verify that proof' }, { status: 500 });
	}

	try {
		// --- c) Burn the challenge, atomically ---
		//
		// After verification (so a network blip does not spend a good challenge)
		// and before provisioning (so a slow insert cannot be raced).
		if (!(await burnChallenge(serviceSupabase, jti))) {
			return NextResponse.json({ error: 'That challenge has already been used' }, { status: 400 });
		}

		// Bound on the RESOLVED name. An aliased ending means `x.foo` and `x.bar`
		// are one name with one key, and binding the typed spelling would let it
		// become two accounts.
		const { userRow, email } = await provisionNameAccount({
			serviceSupabase,
			name: proof.resolved,
			namespace: 'moshpit',
			proof: 'pin-signature',
			boundPin: proof.pin,
			pinKind: proof.kind,
			mlkemKey,
			displayName
		});

		const session = await mintSession(serviceSupabase, email);

		return NextResponse.json({
			success: true,
			name: proof.resolved,
			namespace: 'moshpit',
			session,
			user: {
				id: userRow.id,
				username: userRow.username,
				display_name: userRow.display_name,
				account_type: userRow.account_type
			}
		});
	} catch (error) {
		if (error instanceof ProvisionError) {
			return NextResponse.json({ error: error.message }, { status: error.status });
		}
		console.error('moshpit/verify: unexpected failure', error);
		return NextResponse.json({ error: 'Could not verify that proof' }, { status: 500 });
	}
}
