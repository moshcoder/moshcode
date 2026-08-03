// DNS over HTTPS for Moshpit names (RFC 8484).
//
// The same resolver, in an envelope browsers and phones already speak. That is
// the whole reason it exists: a browser with Secure DNS enabled never asks the
// system resolver, so a machine running the bridge perfectly still fails to
// open a Moshpit name — `curl` resolves it and the browser does not. Pointing
// that browser at a DoH endpoint which knows both namespaces resolves the name
// *through* DoH instead of being defeated by it.
//
// It also reaches what the bridge cannot: phones, routers, and anyone else's
// machine. No daemon, no root, one URL in a settings field.
//
// The privacy trade is real and does not disappear by being encrypted. DoH
// hides lookups from the network and hands them, in full, to whoever runs the
// endpoint. That is a move of trust, not a removal of it, and it is why this
// keeps no per-query record of who asked what.

import {
  addressAnswer, answerRecords, buildChainResponse, buildRecordResponse, buildResponse,
  capResponse, clientKey, createBanList, resolveChain,
  createRateLimiter, forwardQuery, isOurs, answerPolicy, parseQuery, refusalReason,
  RECORD_TYPES, TYPE_A, TYPE_AAAA, DEFAULT_TTL, UDP_SAFE_BYTES,
} from "./dns.mjs";

/** What RFC 8484 says both directions are. */
export const DNS_MESSAGE = "application/dns-message";

/** Answers are cacheable for as long as the record is, and no longer. */
const MAX_QUERY_BYTES = 4096;

/**
 * Decode the DNS message out of a DoH request.
 *
 * GET carries it base64url in `?dns=`, POST carries it as the body. Both are
 * required by the spec and clients differ: browsers mostly POST, some resolvers
 * and every curl example use GET.
 */
export function decodeRequest({ method = "GET", url = "/", body = null } = {}) {
  if (method === "POST") {
    if (!body?.length) return { ok: false, status: 400, error: "empty body" };
    if (body.length > MAX_QUERY_BYTES) return { ok: false, status: 413, error: "query too large" };
    return { ok: true, message: Buffer.from(body) };
  }
  if (method !== "GET") return { ok: false, status: 405, error: "use GET or POST" };

  const at = String(url).indexOf("?");
  const params = new URLSearchParams(at >= 0 ? String(url).slice(at + 1) : "");
  const encoded = params.get("dns");
  if (!encoded) return { ok: false, status: 400, error: "missing ?dns=" };
  try {
    const message = Buffer.from(encoded, "base64url");
    if (!message.length) return { ok: false, status: 400, error: "empty query" };
    if (message.length > MAX_QUERY_BYTES) return { ok: false, status: 413, error: "query too large" };
    return { ok: true, message };
  } catch {
    return { ok: false, status: 400, error: "?dns= is not base64url" };
  }
}

/**
 * How long a caching client may keep this answer.
 *
 * Bounded by the record's own TTL, which is short on purpose: a Moshpit name's
 * target changes the moment its owner repoints it, and a stale answer is the
 * one failure nobody can debug from the outside.
 */
export function cacheControl(ttl = DEFAULT_TTL) {
  return `max-age=${Math.max(0, Math.floor(ttl))}`;
}

/** A REFUSED (rcode 5) answer echoing the question. */
export function refusedMessage(query, message) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  // QR=1, AA=1, RD echoed, rcode 5.
  header.writeUInt16BE(0x8400 | (query.recursionDesired ? 0x0100 : 0) | 5, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, message.subarray(12, query.questionEnd)]);
}

/**
 * A DoH resolver over the existing bridge logic.
 *
 * Returns a handler taking a plain request shape and giving back a plain
 * response shape, so it can be mounted on any server and tested without one.
 */
export function createDohHandler({
  registryBase,
  fetchImpl,
  upstreams = [],
  tldSet = null,
  parkingAddress = null,
  ttl = DEFAULT_TTL,
  rateLimit = null,
  ban = null,
  maxResponseBytes = 0,
  forwardTimeoutMs = 3000,
  onQuery = () => {},
} = {}) {
  const limiter = rateLimit ? createRateLimiter(rateLimit) : null;
  const bans = ban ? createBanList(ban) : null;

  return async function handle({ method = "GET", url = "/", body = null, address = "" } = {}) {
    const decoded = decodeRequest({ method, url, body });
    if (!decoded.ok) {
      return { status: decoded.status, headers: { "content-type": "text/plain" }, body: decoded.error };
    }

    const query = parseQuery(decoded.message);
    if (!query) {
      return { status: 400, headers: { "content-type": "text/plain" }, body: "not a DNS query" };
    }

    // Grouped by /64 for v6, as on the UDP side: a single address is free to
    // change, so per-address limits are defeated by incrementing it.
    const source = clientKey(address);
    const refused = () => ({
      status: 200,
      headers: { "content-type": DNS_MESSAGE, "cache-control": "no-store" },
      // A DNS-level REFUSED rather than an HTTP error: clients understand the
      // former and retry elsewhere, where an HTTP 429 is frequently just an
      // exception in a stack that expected a DNS message.
      //
      // Built here rather than through buildResponse, which only speaks the
      // answer/NODATA/NXDOMAIN vocabulary. NXDOMAIN would be a lie with a
      // cost: it says the name does not exist, which a resolver may cache and
      // apply to every other type, so a rate-limited client would go on
      // failing after the limit lifted.
      body: refusedMessage(query, decoded.message),
    });

    if (refusalReason(query) || bans?.banned(source)) return refused();
    if (limiter && !limiter.allow(source)) {
      bans?.strike(source);
      return refused();
    }

    // Not ours: relay to an upstream exactly as the UDP path does.
    if (!isOurs(query.name, tldSet)) {
      if (!upstreams.length) return refused();
      let relayed = null;
      for (const upstream of upstreams) {
        relayed = await forwardQuery(decoded.message, upstream, { timeoutMs: forwardTimeoutMs });
        if (relayed) break;
      }
      onQuery({ name: query.name, type: query.type, forwarded: true });
      if (!relayed) {
        return { status: 502, headers: { "content-type": "text/plain" }, body: "upstream did not answer" };
      }
      return {
        status: 200,
        headers: { "content-type": DNS_MESSAGE, "cache-control": cacheControl(ttl) },
        body: maxResponseBytes ? capResponse(relayed, query, maxResponseBytes) : relayed,
      };
    }

    // CNAME, MX and TXT come from the record set; addresses still come from
    // `target`. Same split as the UDP path, and it has to stay the same split:
    // a name that resolves over the bridge and not over DoH is the failure mode
    // this endpoint exists to remove.
    const wanted = RECORD_TYPES.get(query.type);
    if (wanted) {
      const found = await answerRecords(query.name, { registryBase, fetchImpl, type: wanted })
        .catch(() => ({ exists: false, records: [] }));
      onQuery({ name: query.name, type: query.type, records: found.records.length });
      return {
        status: 200,
        headers: { "content-type": DNS_MESSAGE, "cache-control": cacheControl(ttl) },
        body: buildRecordResponse(query, decoded.message, found.records, {
          ttl, exists: found.exists, limit: maxResponseBytes || UDP_SAFE_BYTES,
        }),
      };
    }

    const wantsAddress = query.type === TYPE_A || query.type === TYPE_AAAA;
    if (!wantsAddress) {
      const policy = await answerPolicy(query.name, {
        registryBase, fetchImpl, parkingAddress, wantsAddress: false,
      }).catch(() => ({ exists: false, address: null }));
      onQuery({ name: query.name, type: query.type, address: null });
      return {
        status: 200,
        headers: { "content-type": DNS_MESSAGE, "cache-control": cacheControl(ttl) },
        body: buildResponse(query, decoded.message, null, ttl, policy.exists),
      };
    }

    // The same plan the UDP path follows, for the same reason the split above
    // has to stay a split: a published record or a hostname target must resolve
    // identically here, or this endpoint reintroduces the gap it exists to close.
    const plan = await addressAnswer(query.name, {
      registryBase, fetchImpl, parkingAddress, wantsV6: query.type === TYPE_AAAA,
    }).catch(() => ({ exists: false, kind: "nxdomain", records: [], address: null, cname: null }));

    const answer = async () => {
      if (plan.kind === "records") {
        return buildRecordResponse(query, decoded.message, plan.records, {
          ttl, exists: plan.exists, limit: maxResponseBytes || UDP_SAFE_BYTES,
        });
      }
      if (plan.kind === "chain") {
        const addresses = await resolveChain(plan.cname, {
          upstreams, wantsV6: query.type === TYPE_AAAA, timeoutMs: forwardTimeoutMs,
        });
        return buildChainResponse(query, decoded.message, { cname: plan.cname, addresses, ttl });
      }
      return buildResponse(query, decoded.message, plan.address, ttl, plan.exists);
    };

    const encoded = await answer();
    onQuery({ name: query.name, type: query.type, address: plan.address || plan.cname || null });
    return {
      status: 200,
      headers: { "content-type": DNS_MESSAGE, "cache-control": cacheControl(ttl) },
      body: encoded,
    };
  };
}
