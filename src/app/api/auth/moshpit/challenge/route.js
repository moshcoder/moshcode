/**
 * @fileoverview POST /api/auth/moshpit/challenge — issue a nonce to sign.
 *
 * Step one of "sign in with a name". We hand out a random nonce and a jti; the
 * client signs the nonce with the key the registry has pinned for that name and
 * posts both back to /verify.
 *
 * Open to ANYONE, like the CoinPay and anon paths — holding the name is the
 * credential, so there is nothing to authenticate before issuing a challenge.
 *
 * Additive only: does NOT touch the phone/SMS, CoinPay or anon flows.
 */

import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { normalizeName, CHALLENGE_TTL_MS } from '@/lib/auth/moshpit.js';
import { normalizeDnsName, challengeRecord } from '@/lib/auth/dns-name.js';

/** Namespaces a name can be proved in. */
const NAMESPACES = ['moshpit', 'dns'];

/**
 * The two namespaces do not agree on what a name looks like.
 *
 * A Moshpit name is exactly `<label>.<tld>`; a public-root domain can be
 * `example.co.uk` or `mail.example.com`. Normalizing both with the stricter
 * rule would reject most real domains, and normalizing both with the looser one
 * would let `a.b.c` be minted as a Moshpit name that can never resolve.
 *
 * @param {unknown} input
 * @param {string} namespace
 * @returns {string | null}
 */
function normalizeFor(input, namespace) {
	return namespace === 'dns' ? normalizeDnsName(input) : normalizeName(input);
}

/** How many challenges one name may ask for per window. */
const MAX_PER_WINDOW = 5;
const WINDOW_MS = 60 * 1000;

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
 * POST /api/auth/moshpit/challenge
 *
 * Body: { name, namespace? }
 * Returns: { jti, nonce, expiresAt, name, namespace }
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

	// The namespace is read first, because it decides what counts as a name.
	const namespace = typeof body?.namespace === 'string' ? body.namespace : 'moshpit';
	if (!NAMESPACES.includes(namespace)) {
		return NextResponse.json(
			{ error: `namespace must be one of ${NAMESPACES.join(', ')}` },
			{ status: 400 }
		);
	}

	const name = normalizeFor(body?.name, namespace);
	if (!name) {
		return NextResponse.json(
			{
				error:
					namespace === 'dns'
						? 'Not a valid domain name'
						: 'Not a valid name — expected <label>.<tld>'
			},
			{ status: 400 }
		);
	}

	const serviceSupabase = createServiceClient();

	// Throttle on the table rather than in memory: this runs on serverless, so a
	// per-instance counter would reset on every cold start and bound nothing.
	const since = new Date(Date.now() - WINDOW_MS).toISOString();
	const { count, error: countError } = await serviceSupabase
		.from('name_challenges')
		.select('jti', { count: 'exact', head: true })
		.eq('name', name)
		.gte('issued_at', since);

	if (countError) {
		console.error('moshpit/challenge: throttle count failed', countError);
		return NextResponse.json({ error: 'Could not issue a challenge' }, { status: 500 });
	}
	if ((count ?? 0) >= MAX_PER_WINDOW) {
		return NextResponse.json(
			{ error: 'Too many challenges for this name — try again shortly' },
			{ status: 429 }
		);
	}

	const jti = crypto.randomUUID();
	const nonce = crypto.randomBytes(32).toString('hex');
	const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();

	const { error: insertError } = await serviceSupabase.from('name_challenges').insert({
		jti,
		name,
		namespace,
		nonce,
		expires_at: expiresAt
	});

	if (insertError) {
		console.error('moshpit/challenge: insert failed', insertError);
		return NextResponse.json({ error: 'Could not issue a challenge' }, { status: 500 });
	}

	// A DNS proof needs the person to go and publish something, so the record to
	// create travels with the challenge rather than being described in prose
	// somewhere else that can drift from what is actually checked.
	const publish = namespace === 'dns' ? challengeRecord(name, nonce) : undefined;

	return NextResponse.json({ jti, nonce, expiresAt, name, namespace, ...(publish ? { publish } : {}) });
}
