/**
 * @fileoverview POST /api/auth/moshpit/verify — prove a name, get a session.
 *
 * Step two of "sign in with a name". The client returns the nonce we issued,
 * signed by the key the registry pins for that name, plus the certificate
 * carrying that key and its on-device ML-KEM-1024 public key.
 *
 * We check the signature, check the key against the published pins, burn the
 * challenge, then provision exactly the way the CoinPay callback does: a
 * Supabase auth user, a public `users` row with `phone_number NULL`, and a real
 * session via the admin magic-link bridge.
 *
 * Additive only: does NOT touch the phone/SMS, CoinPay or anon flows.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase.js';
import { deriveUniqueUsername } from '@/lib/auth/coinpay.js';
import { normalizeName, verifyNameProof, NameProofError } from '@/lib/auth/moshpit.js';

/** Postgres unique-violation error code. */
const PG_UNIQUE_VIOLATION = '23505';
/** "no rows returned" from PostgREST .single(). */
const PG_NO_ROWS = 'PGRST116';

/**
 * Where synthetic addresses live.
 *
 * The magic-link bridge is addressed by email and a name has none, so one is
 * minted per identity. It is namespaced because a Moshpit name and a DNS name
 * can spell the same string and MUST NOT collapse into one auth user --
 * `stripe.dev` proved in the pit is a different identity from `stripe.dev`
 * proved in the public root, and merging them is the impersonation this whole
 * design exists to prevent.
 */
const EMAIL_DOMAIN = process.env.NAME_IDENTITY_EMAIL_DOMAIN || 'names.qrypt.chat';

/** @param {string} name @param {string} namespace */
const syntheticEmail = (name, namespace) => `${name}@${namespace}.${EMAIL_DOMAIN}`;

/**
 * Build a service-role Supabase client (bypasses RLS). Mirrors verify-sms.
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
function createServiceClient() {
	return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { autoRefreshToken: false, persistSession: false }
	});
}

/**
 * Find an existing Supabase auth user by email (paged scan of admin.listUsers).
 * @param {import('@supabase/supabase-js').SupabaseClient} serviceSupabase
 * @param {string} email
 */
async function findAuthUserByEmail(serviceSupabase, email) {
	const target = email.toLowerCase();
	const perPage = 200;
	for (let page = 1; page <= 50; page++) {
		const { data, error } = await serviceSupabase.auth.admin.listUsers({ page, perPage });
		if (error) throw error;
		const match = (data?.users || []).find((u) => (u.email || '').toLowerCase() === target);
		if (match) return match;
		if (!data?.users || data.users.length < perPage) break;
	}
	return null;
}

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
	const { data: challenge, error: challengeError } = await serviceSupabase
		.from('name_challenges')
		.select('*')
		.eq('jti', jti)
		.single();

	if (challengeError || !challenge) {
		return NextResponse.json({ error: 'Unknown or expired challenge' }, { status: 400 });
	}
	if (challenge.consumed_at) {
		return NextResponse.json({ error: 'That challenge has already been used' }, { status: 400 });
	}
	if (new Date(challenge.expires_at) < new Date()) {
		return NextResponse.json({ error: 'That challenge has expired' }, { status: 400 });
	}
	// The name is taken from the challenge we issued, never from the body: a
	// nonce minted for one name must not be spendable on another.
	if (challenge.name !== name) {
		return NextResponse.json({ error: 'That challenge was issued for a different name' }, { status: 400 });
	}

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

	// --- c) Burn the challenge, atomically ---
	//
	// The `is('consumed_at', null)` filter is the burn: two requests racing the
	// same jti both reach here, and exactly one gets a row back. Done after
	// verification (so a network blip does not spend a good challenge) and
	// before provisioning (so a slow insert cannot be raced).
	const { data: burned, error: burnError } = await serviceSupabase
		.from('name_challenges')
		.update({ consumed_at: new Date().toISOString() })
		.eq('jti', jti)
		.is('consumed_at', null)
		.select('jti');

	if (burnError) {
		console.error('moshpit/verify: burn failed', burnError);
		return NextResponse.json({ error: 'Could not verify that proof' }, { status: 500 });
	}
	if (!burned || burned.length === 0) {
		return NextResponse.json({ error: 'That challenge has already been used' }, { status: 400 });
	}

	const namespace = challenge.namespace;
	// Bound on the RESOLVED name. An aliased ending means `x.foo` and `x.bar`
	// are one name with one key, and binding the typed spelling would let it
	// become two accounts.
	const boundName = proof.resolved;
	const email = syntheticEmail(boundName, namespace);

	try {
		// --- d) Find-or-create the Supabase auth user ---
		let authUser = await findAuthUserByEmail(serviceSupabase, email);
		if (!authUser) {
			const { data: created, error: createAuthError } = await serviceSupabase.auth.admin.createUser({
				email,
				email_confirm: true,
				user_metadata: { provider: 'moshpit', moshpit_name: boundName, namespace }
			});
			if (createAuthError || !created?.user) {
				// Possible race: another request created it. Re-fetch once.
				authUser = await findAuthUserByEmail(serviceSupabase, email);
				if (!authUser) {
					console.error('moshpit/verify: failed to create auth user', createAuthError);
					return NextResponse.json({ error: 'Could not provision an account' }, { status: 500 });
				}
			} else {
				authUser = created.user;
			}
		}

		// --- e) Find-or-create the public users row ---
		const { data: existingUser, error: lookupError } = await serviceSupabase
			.from('users')
			.select('*')
			.eq('auth_user_id', authUser.id)
			.single();
		if (lookupError && lookupError.code !== PG_NO_ROWS) {
			console.error('moshpit/verify: users lookup error', lookupError);
		}

		let userRow = existingUser || null;
		let createdUserRow = false;
		if (!userRow) {
			// The label, not the whole name: deriveUniqueUsername sanitises to
			// [a-z0-9_], so `chovy.hacker` would lose its dot and read oddly.
			const label = boundName.split('.')[0];
			const username = await deriveUniqueUsername({ name: label, email }, async (candidate) => {
				const { data } = await serviceSupabase
					.from('users')
					.select('id')
					.ilike('username', candidate)
					.single();
				return !!data;
			});

			const { data: inserted, error: insertError } = await serviceSupabase
				.from('users')
				.insert({
					auth_user_id: authUser.id,
					phone_number: null,
					account_type: 'name',
					username,
					display_name: (typeof displayName === 'string' && displayName.trim()) || boundName,
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString()
				})
				.select('*')
				.single();

			if (insertError && insertError.code !== PG_UNIQUE_VIOLATION) {
				console.error('moshpit/verify: user row insert failed', insertError);
				return NextResponse.json({ error: 'Could not provision an account' }, { status: 500 });
			}
			userRow = inserted || null;
			createdUserRow = !!inserted;
			if (!userRow) {
				const { data: refetched } = await serviceSupabase
					.from('users')
					.select('*')
					.eq('auth_user_id', authUser.id)
					.single();
				userRow = refetched || null;
			}
		}

		if (!userRow) {
			return NextResponse.json({ error: 'Could not provision an account' }, { status: 500 });
		}

		// --- f) Record the binding ---
		//
		// A changed pin is a re-proof, not a silent rebind: bound_pin is written
		// here so a later mismatch is visible rather than absorbed.
		const { error: bindError } = await serviceSupabase.from('user_names').upsert(
			{
				user_id: authUser.id,
				name: boundName,
				namespace,
				proof: 'pin-signature',
				bound_pin: proof.pin,
				pin_kind: proof.kind,
				verified_at: new Date().toISOString(),
				recheck_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
			},
			{ onConflict: 'user_id' }
		);

		if (bindError) {
			if (createdUserRow) {
				await serviceSupabase.from('users').delete().eq('id', userRow.id);
			}
			console.error('moshpit/verify: name binding failed', bindError);
			return NextResponse.json({ error: 'Could not record that name' }, { status: 500 });
		}

		// --- g) Store the ML-KEM public key ---
		const { error: keyError } = await serviceSupabase
			.from('user_public_keys')
			.upsert(
				{ user_id: authUser.id, key_type: 'ML-KEM-1024', public_key: mlkemKey },
				{ onConflict: 'user_id,key_type' }
			);

		if (keyError) {
			// Compensate, the way register-anon does.
			if (createdUserRow) {
				await serviceSupabase.from('users').delete().eq('id', userRow.id);
				await serviceSupabase.from('user_names').delete().eq('user_id', authUser.id);
			}
			console.error('moshpit/verify: public key insert failed', keyError);
			return NextResponse.json({ error: 'Failed to store public key' }, { status: 500 });
		}

		// --- h) Establish a real session via the admin magic-link bridge ---
		const { data: linkData, error: linkError } = await serviceSupabase.auth.admin.generateLink({
			type: 'magiclink',
			email
		});
		if (linkError || !linkData?.properties?.hashed_token) {
			console.error('moshpit/verify: generateLink failed', linkError);
			return NextResponse.json({ error: 'Could not start a session' }, { status: 500 });
		}

		const supabase = await createSupabaseServerClient();
		const { data: sessionData, error: verifyError } = await supabase.auth.verifyOtp({
			type: 'magiclink',
			token_hash: linkData.properties.hashed_token
		});
		if (verifyError || !sessionData?.session) {
			console.error('moshpit/verify: verifyOtp failed', verifyError);
			return NextResponse.json({ error: 'Could not start a session' }, { status: 500 });
		}

		return NextResponse.json({
			success: true,
			name: boundName,
			namespace,
			session: {
				access_token: sessionData.session.access_token,
				refresh_token: sessionData.session.refresh_token,
				expires_at: sessionData.session.expires_at,
				expires_in: sessionData.session.expires_in,
				token_type: sessionData.session.token_type
			},
			user: {
				id: userRow.id,
				username: userRow.username,
				display_name: userRow.display_name,
				account_type: userRow.account_type
			}
		});
	} catch (error) {
		console.error('moshpit/verify: unexpected failure', error);
		return NextResponse.json({ error: 'Could not verify that proof' }, { status: 500 });
	}
}
