/**
 * @fileoverview POST /api/auth/dns/verify — prove an ordinary domain, get a session.
 *
 * The commodity half of "sign in with a name". There is no key to sign with in
 * the public root, so the proof is the one thing only the holder can do:
 * publish the challenge under the domain. The record to create travels with the
 * challenge (see the challenge route), so nothing has to describe it twice.
 *
 * Weaker than the Moshpit path on purpose, and worth being clear about: whoever
 * controls DNS controls the identity, so a registrar seizure or a lapsed
 * renewal is an account takeover. `recheck_at` is what limits the window.
 *
 * Additive only: does NOT touch the phone/SMS, CoinPay, anon or Moshpit flows.
 */

import { NextResponse } from 'next/server';
import { normalizeDnsName, verifyDnsProof, DnsProofError } from '@/lib/auth/dns-name.js';
import {
	createServiceClient,
	loadSpendableChallenge,
	burnChallenge,
	provisionNameAccount,
	mintSession,
	ProvisionError
} from '@/lib/auth/name-account.js';

/**
 * POST /api/auth/dns/verify
 *
 * Body: { jti, name, publicKey, displayName? }
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

	const { jti, publicKey, displayName } = body || {};
	const name = normalizeDnsName(body?.name);

	if (!name) {
		return NextResponse.json({ error: 'Not a valid domain name' }, { status: 400 });
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
	const loaded = await loadSpendableChallenge(serviceSupabase, jti, { name, namespace: 'dns' });
	if ('error' in loaded) {
		return NextResponse.json({ error: loaded.error }, { status: 400 });
	}
	const { challenge } = loaded;

	// --- b) Look for the record BEFORE burning anything ---
	//
	// Publishing DNS is slow and people will retry while it propagates. Spending
	// the challenge on a lookup that simply ran too early would make the honest
	// case -- "I just added it" -- the one that fails.
	try {
		await verifyDnsProof({ name: challenge.name, nonce: challenge.nonce });
	} catch (error) {
		if (error instanceof DnsProofError) {
			return NextResponse.json(
				{ error: error.message, code: error.code },
				{ status: error.definite ? 400 : 503 }
			);
		}
		console.error('dns/verify: unexpected verification failure', error);
		return NextResponse.json({ error: 'Could not verify that proof' }, { status: 500 });
	}

	try {
		// --- c) Burn the challenge, atomically ---
		if (!(await burnChallenge(serviceSupabase, jti))) {
			return NextResponse.json({ error: 'That challenge has already been used' }, { status: 400 });
		}

		// No pin and no pin kind: there is no key in this path, and the schema
		// refuses a binding that claims otherwise.
		const { userRow, email } = await provisionNameAccount({
			serviceSupabase,
			name,
			namespace: 'dns',
			proof: 'dns-txt',
			boundPin: null,
			pinKind: null,
			mlkemKey,
			displayName
		});

		const session = await mintSession(serviceSupabase, email);

		return NextResponse.json({
			success: true,
			name,
			namespace: 'dns',
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
		console.error('dns/verify: unexpected failure', error);
		return NextResponse.json({ error: 'Could not verify that proof' }, { status: 500 });
	}
}
