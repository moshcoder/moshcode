/**
 * @fileoverview Tests for POST /api/auth/moshpit/verify.
 *
 * These cover the invariants that decide whether the proof is worth anything:
 * a challenge is spendable once, only on the name it was issued for, and a
 * registry outage is never read as "this name is not yours".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	verifyNameProof: vi.fn(),
	createClient: vi.fn(),
	createSupabaseServerClient: vi.fn(),
	deriveUniqueUsername: vi.fn(async () => 'chovy')
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase.js', () => ({
	createSupabaseServerClient: mocks.createSupabaseServerClient
}));
vi.mock('@/lib/auth/coinpay.js', () => ({ deriveUniqueUsername: mocks.deriveUniqueUsername }));
vi.mock('@/lib/auth/moshpit.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, verifyNameProof: mocks.verifyNameProof };
});

const NAME = 'chovy.hacker';
const JTI = 'challenge-1';

/** A live, unspent challenge for NAME. */
const liveChallenge = (over = {}) => ({
	jti: JTI,
	name: NAME,
	namespace: 'moshpit',
	nonce: 'the-nonce',
	consumed_at: null,
	expires_at: new Date(Date.now() + 60_000).toISOString(),
	...over
});

/**
 * A Supabase stub covering only the chains this route walks.
 * `burnRows` is what the atomic burn returns -- [] means someone else won it.
 */
function supabaseStub({ challenge = liveChallenge(), burnRows = [{ jti: JTI }] } = {}) {
	const table = (name) => ({
		select() {
			return this;
		},
		eq() {
			return this;
		},
		is() {
			return this;
		},
		ilike() {
			return this;
		},
		gte() {
			return this;
		},
		single: async () =>
			name === 'name_challenges'
				? { data: challenge, error: challenge ? null : { code: 'PGRST116' } }
				: { data: null, error: { code: 'PGRST116' } },
		update() {
			return {
				eq() {
					return this;
				},
				is() {
					return this;
				},
				select: async () => ({ data: burnRows, error: null })
			};
		},
		insert() {
			return this;
		},
		upsert: async () => ({ error: null }),
		delete() {
			return this;
		}
	});

	return {
		from: (name) => table(name),
		auth: {
			admin: {
				listUsers: async () => ({ data: { users: [] }, error: null }),
				createUser: async () => ({ data: { user: { id: 'auth-1' } }, error: null }),
				generateLink: async () => ({
					data: { properties: { hashed_token: 'tok' } },
					error: null
				})
			}
		}
	};
}

function verifyRequest(over = {}) {
	return new Request('https://example.com/api/auth/moshpit/verify', {
		method: 'POST',
		body: JSON.stringify({
			jti: JTI,
			name: NAME,
			certPem: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
			signature: 'c2ln',
			publicKey: 'ml-kem-public-key',
			...over
		})
	});
}

describe('moshpit/verify', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		mocks.verifyNameProof.mockResolvedValue({
			name: NAME,
			resolved: NAME,
			pin: 'a-pin',
			kind: 'tls'
		});
		mocks.createSupabaseServerClient.mockResolvedValue({
			auth: {
				verifyOtp: async () => ({
					data: { session: { access_token: 'a', refresh_token: 'r', expires_at: 1 } },
					error: null
				})
			}
		});
	});

	it('refuses an unknown challenge', async () => {
		mocks.createClient.mockReturnValue(supabaseStub({ challenge: null }));
		const { POST } = await import('./route.js');
		const res = await POST(verifyRequest());
		expect(res.status).toBe(400);
	});

	it('refuses a challenge that was already spent', async () => {
		mocks.createClient.mockReturnValue(
			supabaseStub({ challenge: liveChallenge({ consumed_at: new Date().toISOString() }) })
		);
		const { POST } = await import('./route.js');
		const res = await POST(verifyRequest());
		expect((await res.json()).error).toMatch(/already been used/i);
	});

	it('refuses an expired challenge', async () => {
		mocks.createClient.mockReturnValue(
			supabaseStub({ challenge: liveChallenge({ expires_at: new Date(Date.now() - 1000).toISOString() }) })
		);
		const { POST } = await import('./route.js');
		const res = await POST(verifyRequest());
		expect((await res.json()).error).toMatch(/expired/i);
	});

	it('will not let a nonce minted for one name be spent on another', async () => {
		mocks.createClient.mockReturnValue(supabaseStub({ challenge: liveChallenge({ name: 'other.hacker' }) }));
		const { POST } = await import('./route.js');
		const res = await POST(verifyRequest());
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/different name/i);
	});

	it('never verifies against a name supplied in the body', async () => {
		// The body says one thing, the stored challenge says another. The proof
		// must be checked against what we issued.
		mocks.createClient.mockReturnValue(supabaseStub());
		const { POST } = await import('./route.js');
		await POST(verifyRequest({ name: NAME }));
		expect(mocks.verifyNameProof).toHaveBeenCalledWith(
			expect.objectContaining({ name: NAME, nonce: 'the-nonce' })
		);
	});

	it('answers 503, not 400, when the registry is unreachable', async () => {
		// A refusal means "this name is not yours" and the client should stop.
		// An outage means try again. Collapsing them is how pinning gets defeated.
		const { NameProofError } = await import('@/lib/auth/moshpit.js');
		mocks.verifyNameProof.mockRejectedValue(
			new NameProofError('registry_unreachable', 'down', { definite: false })
		);
		mocks.createClient.mockReturnValue(supabaseStub());
		const { POST } = await import('./route.js');
		const res = await POST(verifyRequest());
		expect(res.status).toBe(503);
	});

	it('answers 400 when the key is not the one the registry publishes', async () => {
		const { NameProofError } = await import('@/lib/auth/moshpit.js');
		mocks.verifyNameProof.mockRejectedValue(new NameProofError('pin_mismatch', 'nope'));
		mocks.createClient.mockReturnValue(supabaseStub());
		const { POST } = await import('./route.js');
		const res = await POST(verifyRequest());
		expect(res.status).toBe(400);
		expect((await res.json()).code).toBe('pin_mismatch');
	});

	it('refuses when it loses the burn race', async () => {
		// Two requests carrying the same jti both pass verification; the update
		// returns a row to exactly one of them, and the loser must not provision.
		mocks.createClient.mockReturnValue(supabaseStub({ burnRows: [] }));
		const { POST } = await import('./route.js');
		const res = await POST(verifyRequest());
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/already been used/i);
	});

	it('does not spend the challenge when verification fails', async () => {
		const { NameProofError } = await import('@/lib/auth/moshpit.js');
		mocks.verifyNameProof.mockRejectedValue(new NameProofError('bad_signature', 'nope'));
		const stub = supabaseStub();
		const updates = vi.spyOn(stub, 'from');
		mocks.createClient.mockReturnValue(stub);
		const { POST } = await import('./route.js');
		await POST(verifyRequest());
		// Only the challenge lookup happened -- no burn, no provisioning.
		expect(updates.mock.calls.every(([t]) => t === 'name_challenges')).toBe(true);
	});

	it('requires a public key', async () => {
		mocks.createClient.mockReturnValue(supabaseStub());
		const { POST } = await import('./route.js');
		const res = await POST(verifyRequest({ publicKey: '   ' }));
		expect(res.status).toBe(400);
	});
});
