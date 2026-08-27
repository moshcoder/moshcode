/**
 * @fileoverview Tests for POST /api/auth/dns/verify.
 *
 * The invariants that matter here are the same as the Moshpit path's, plus one
 * of its own: a lookup that ran before DNS propagated must not spend the
 * challenge, because "I just added the record" is the honest case.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	verifyDnsProof: vi.fn(),
	createClient: vi.fn(),
	createSupabaseServerClient: vi.fn(),
	deriveUniqueUsername: vi.fn(async () => 'example')
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase.js', () => ({
	createSupabaseServerClient: mocks.createSupabaseServerClient
}));
vi.mock('@/lib/auth/coinpay.js', () => ({ deriveUniqueUsername: mocks.deriveUniqueUsername }));
vi.mock('@/lib/auth/dns-name.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, verifyDnsProof: mocks.verifyDnsProof };
});

const NAME = 'example.com';
const JTI = 'challenge-1';

const liveChallenge = (over = {}) => ({
	jti: JTI,
	name: NAME,
	namespace: 'dns',
	nonce: 'the-nonce',
	consumed_at: null,
	expires_at: new Date(Date.now() + 60_000).toISOString(),
	...over
});

function supabaseStub({ challenge = liveChallenge(), burnRows = [{ jti: JTI }], onUpsert } = {}) {
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
			return {
				select: () => ({
					single: async () => ({
						data: { id: 'user-1', username: 'example', display_name: NAME, account_type: 'name' },
						error: null
					})
				})
			};
		},
		upsert: async (row) => {
			onUpsert?.(name, row);
			return { error: null };
		},
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
				generateLink: async () => ({ data: { properties: { hashed_token: 'tok' } }, error: null })
			}
		}
	};
}

function dnsRequest(over = {}) {
	return new Request('https://example.com/api/auth/dns/verify', {
		method: 'POST',
		body: JSON.stringify({ jti: JTI, name: NAME, publicKey: 'ml-kem-public-key', ...over })
	});
}

describe('dns/verify', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		mocks.verifyDnsProof.mockResolvedValue({
			name: NAME,
			record: `_qryptchat-challenge.${NAME}`,
			resolver: 'https://cloudflare-dns.com/dns-query'
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

	it('signs in a domain whose record carries the challenge', async () => {
		mocks.createClient.mockReturnValue(supabaseStub());
		const { POST } = await import('./route.js');
		const res = await POST(dnsRequest());
		const bodyJson = await res.json();
		expect(res.status).toBe(200);
		expect(bodyJson).toMatchObject({ success: true, name: NAME, namespace: 'dns' });
	});

	it('binds with no pin, because this path has no key', async () => {
		// The schema refuses a dns-txt binding that claims a pin, so a regression
		// here would surface as a constraint violation in prod rather than here.
		const rows = [];
		mocks.createClient.mockReturnValue(
			supabaseStub({ onUpsert: (table, row) => rows.push([table, row]) })
		);
		const { POST } = await import('./route.js');
		await POST(dnsRequest());
		const [, binding] = rows.find(([t]) => t === 'user_names');
		expect(binding).toMatchObject({ namespace: 'dns', proof: 'dns-txt', bound_pin: null, pin_kind: null });
	});

	it('will not spend the challenge when the record has not propagated', async () => {
		// "I just added it" is the honest case and must stay retryable.
		const { DnsProofError } = await import('@/lib/auth/dns-name.js');
		mocks.verifyDnsProof.mockRejectedValue(new DnsProofError('record_not_found', 'not there yet'));
		const stub = supabaseStub();
		const touched = vi.spyOn(stub, 'from');
		mocks.createClient.mockReturnValue(stub);
		const { POST } = await import('./route.js');
		const res = await POST(dnsRequest());
		expect(res.status).toBe(400);
		expect(touched.mock.calls.every(([t]) => t === 'name_challenges')).toBe(true);
	});

	it('answers 503 when no public resolver could be reached', async () => {
		const { DnsProofError } = await import('@/lib/auth/dns-name.js');
		mocks.verifyDnsProof.mockRejectedValue(
			new DnsProofError('resolvers_unreachable', 'down', { definite: false })
		);
		mocks.createClient.mockReturnValue(supabaseStub());
		const { POST } = await import('./route.js');
		expect((await POST(dnsRequest())).status).toBe(503);
	});

	it('refuses a challenge minted in the Moshpit namespace', async () => {
		// Otherwise a name proved cheaply in one namespace could be spent in the
		// other, which is the impersonation the namespace column exists to stop.
		mocks.createClient.mockReturnValue(
			supabaseStub({ challenge: liveChallenge({ namespace: 'moshpit' }) })
		);
		const { POST } = await import('./route.js');
		const res = await POST(dnsRequest());
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/different namespace/i);
	});

	it('refuses when it loses the burn race', async () => {
		mocks.createClient.mockReturnValue(supabaseStub({ burnRows: [] }));
		const { POST } = await import('./route.js');
		const res = await POST(dnsRequest());
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/already been used/i);
	});

	it('accepts a domain with more than two labels', async () => {
		mocks.createClient.mockReturnValue(
			supabaseStub({ challenge: liveChallenge({ name: 'example.co.uk' }) })
		);
		mocks.verifyDnsProof.mockResolvedValue({ name: 'example.co.uk', record: 'x', resolver: 'y' });
		const { POST } = await import('./route.js');
		const res = await POST(dnsRequest({ name: 'example.co.uk' }));
		expect(res.status).toBe(200);
	});

	it('refuses a bare address', async () => {
		mocks.createClient.mockReturnValue(supabaseStub());
		const { POST } = await import('./route.js');
		expect((await POST(dnsRequest({ name: '192.168.1.1' }))).status).toBe(400);
	});
});
