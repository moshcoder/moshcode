/**
 * @fileoverview Turning a proved name into an account and a session.
 *
 * Shared by both proof paths. A Moshpit name is proved by signing against a
 * published pin and a public-root domain by publishing a TXT record, but once
 * either has been proved the provisioning is identical -- and it is the half
 * with all the fiddly parts (identity domains, races, compensation), so it is
 * written once rather than twice.
 *
 * Additive only: does NOT touch the phone/SMS, CoinPay or anon flows.
 */

import { createClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase.js';
import { deriveUniqueUsername } from '@/lib/auth/coinpay.js';

/** Postgres unique-violation error code. */
const PG_UNIQUE_VIOLATION = '23505';
/** "no rows returned" from PostgREST .single(). */
const PG_NO_ROWS = 'PGRST116';

/** How long a binding stands before it has to be proved again. */
const RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

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

/**
 * @param {string} name
 * @param {string} namespace
 */
export const syntheticEmail = (name, namespace) => `${name}@${namespace}.${EMAIL_DOMAIN}`;

/** Raised when provisioning cannot complete. */
export class ProvisionError extends Error {
	/** @param {string} message @param {number} [status] */
	constructor(message, status = 500) {
		super(message);
		this.name = 'ProvisionError';
		this.status = status;
	}
}

/**
 * Build a service-role Supabase client (bypasses RLS). Mirrors verify-sms.
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
export function createServiceClient() {
	return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { autoRefreshToken: false, persistSession: false }
	});
}

/**
 * Find an existing Supabase auth user by email (paged scan of admin.listUsers).
 * @param {import('@supabase/supabase-js').SupabaseClient} serviceSupabase
 * @param {string} email
 */
export async function findAuthUserByEmail(serviceSupabase, email) {
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
 * Provision (or find) the account behind a proved name, record the binding, and
 * store the device's ML-KEM public key.
 *
 * @param {object} args
 * @param {import('@supabase/supabase-js').SupabaseClient} args.serviceSupabase
 * @param {string} args.name        the RESOLVED name to bind
 * @param {string} args.namespace   'moshpit' | 'dns'
 * @param {string} args.proof       'pin-signature' | 'dns-txt'
 * @param {string|null} [args.boundPin]  set for pin-signature, null for dns-txt
 * @param {string|null} [args.pinKind]   likewise
 * @param {string} args.mlkemKey
 * @param {string} [args.displayName]
 * @returns {Promise<{userRow: any, authUser: any, email: string}>}
 */
export async function provisionNameAccount({
	serviceSupabase,
	name,
	namespace,
	proof,
	boundPin = null,
	pinKind = null,
	mlkemKey,
	displayName
}) {
	const email = syntheticEmail(name, namespace);

	// --- Find-or-create the Supabase auth user ---
	let authUser = await findAuthUserByEmail(serviceSupabase, email);
	if (!authUser) {
		const { data: created, error: createAuthError } = await serviceSupabase.auth.admin.createUser({
			email,
			email_confirm: true,
			user_metadata: { provider: namespace === 'dns' ? 'dns-name' : 'moshpit', name, namespace }
		});
		if (createAuthError || !created?.user) {
			// Possible race: another request created it. Re-fetch once.
			authUser = await findAuthUserByEmail(serviceSupabase, email);
			if (!authUser) throw new ProvisionError('Could not provision an account');
		} else {
			authUser = created.user;
		}
	}

	// --- Find-or-create the public users row ---
	const { data: existingUser, error: lookupError } = await serviceSupabase
		.from('users')
		.select('*')
		.eq('auth_user_id', authUser.id)
		.single();
	if (lookupError && lookupError.code !== PG_NO_ROWS) {
		console.error('name-account: users lookup error', lookupError);
	}

	let userRow = existingUser || null;
	let createdUserRow = false;
	if (!userRow) {
		// The first label, not the whole name: deriveUniqueUsername sanitises to
		// [a-z0-9_], so `chovy.hacker` would lose its dot and read oddly.
		const label = name.split('.')[0];
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
				display_name: (typeof displayName === 'string' && displayName.trim()) || name,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString()
			})
			.select('*')
			.single();

		if (insertError && insertError.code !== PG_UNIQUE_VIOLATION) {
			console.error('name-account: user row insert failed', insertError);
			throw new ProvisionError('Could not provision an account');
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

	if (!userRow) throw new ProvisionError('Could not provision an account');

	/** Undo a row we created, so a half-provisioned account is not left behind. */
	const compensate = async () => {
		if (!createdUserRow) return;
		await serviceSupabase.from('users').delete().eq('id', userRow.id);
		await serviceSupabase.from('user_names').delete().eq('user_id', authUser.id);
	};

	// --- Record the binding ---
	//
	// A changed pin is a re-proof, not a silent rebind: bound_pin is written
	// here so a later mismatch is visible rather than absorbed.
	const { error: bindError } = await serviceSupabase.from('user_names').upsert(
		{
			user_id: authUser.id,
			name,
			namespace,
			proof,
			bound_pin: boundPin,
			pin_kind: pinKind,
			verified_at: new Date().toISOString(),
			recheck_at: new Date(Date.now() + RECHECK_MS).toISOString()
		},
		{ onConflict: 'user_id' }
	);

	if (bindError) {
		await compensate();
		console.error('name-account: binding failed', bindError);
		throw new ProvisionError('Could not record that name');
	}

	// --- Store the ML-KEM public key ---
	const { error: keyError } = await serviceSupabase
		.from('user_public_keys')
		.upsert(
			{ user_id: authUser.id, key_type: 'ML-KEM-1024', public_key: mlkemKey },
			{ onConflict: 'user_id,key_type' }
		);

	if (keyError) {
		await compensate();
		console.error('name-account: public key insert failed', keyError);
		throw new ProvisionError('Failed to store public key');
	}

	return { userRow, authUser, email };
}

/**
 * Establish a real Supabase session via the admin magic-link bridge.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} serviceSupabase
 * @param {string} email
 */
export async function mintSession(serviceSupabase, email) {
	const { data: linkData, error: linkError } = await serviceSupabase.auth.admin.generateLink({
		type: 'magiclink',
		email
	});
	if (linkError || !linkData?.properties?.hashed_token) {
		console.error('name-account: generateLink failed', linkError);
		throw new ProvisionError('Could not start a session');
	}

	const supabase = await createSupabaseServerClient();
	const { data: sessionData, error: verifyError } = await supabase.auth.verifyOtp({
		type: 'magiclink',
		token_hash: linkData.properties.hashed_token
	});
	if (verifyError || !sessionData?.session) {
		console.error('name-account: verifyOtp failed', verifyError);
		throw new ProvisionError('Could not start a session');
	}

	return {
		access_token: sessionData.session.access_token,
		refresh_token: sessionData.session.refresh_token,
		expires_at: sessionData.session.expires_at,
		expires_in: sessionData.session.expires_in,
		token_type: sessionData.session.token_type
	};
}

/**
 * Claim a challenge exactly once.
 *
 * The `is('consumed_at', null)` filter IS the burn: two requests racing the same
 * jti both reach here and exactly one gets a row back.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} serviceSupabase
 * @param {string} jti
 * @returns {Promise<boolean>} true if this caller won it
 */
export async function burnChallenge(serviceSupabase, jti) {
	const { data, error } = await serviceSupabase
		.from('name_challenges')
		.update({ consumed_at: new Date().toISOString() })
		.eq('jti', jti)
		.is('consumed_at', null)
		.select('jti');

	if (error) {
		console.error('name-account: burn failed', error);
		throw new ProvisionError('Could not verify that proof');
	}
	return Array.isArray(data) && data.length > 0;
}

/**
 * Load a challenge and say why it cannot be spent, if it cannot.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} serviceSupabase
 * @param {string} jti
 * @param {{name: string, namespace: string}} expected
 * @returns {Promise<{challenge: any} | {error: string}>}
 */
export async function loadSpendableChallenge(serviceSupabase, jti, expected) {
	const { data: challenge, error } = await serviceSupabase
		.from('name_challenges')
		.select('*')
		.eq('jti', jti)
		.single();

	if (error || !challenge) return { error: 'Unknown or expired challenge' };
	if (challenge.consumed_at) return { error: 'That challenge has already been used' };
	if (new Date(challenge.expires_at) < new Date()) return { error: 'That challenge has expired' };
	// The name is taken from the challenge we issued, never from the body: a
	// nonce minted for one name must not be spendable on another, or in another
	// namespace.
	if (challenge.name !== expected.name) {
		return { error: 'That challenge was issued for a different name' };
	}
	if (challenge.namespace !== expected.namespace) {
		return { error: 'That challenge was issued for a different namespace' };
	}
	return { challenge };
}
