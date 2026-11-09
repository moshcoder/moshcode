// Pointing a Moshpit name at a site on the c0mpute network.
//
// Pure: no database, no request. The registry stores a c0mpute site id on a
// name; this decides what that means to a resolver and to the CA.
//
// Why the name resolves to an edge rather than to c0mpute gateways directly:
// a gateway serves plain HTTP on :7777 and holds no Moshpit certificate, so a
// browser asking for https://blog.eggs would get a refused connection or a
// certificate for some other name. The edge is the one thing on the path that
// terminates TLS, with a leaf the registry signs for the name, and it fetches
// /s/<site_id>/ from whichever c0mpute gateways are healthy. Nothing on the
// c0mpute side changes and no c0mpute server is on the path: any gateway can
// serve any site, and the edge fails over between them.

/** A c0mpute site id: 20 lowercase hex characters (blake3 of owner + name). */
export const C0MPUTE_SITE_RE = /^[0-9a-f]{20}$/;

/**
 * A site id as stored, `""` for "clear it", or null when it is not one.
 *
 * Accepts the forms people paste: the bare id, `site=<id>` (the TXT record
 * c0mpute documents for custom domains) and a gateway URL ending in
 * `/s/<id>/`, because all three are what `c0mpute hosting publish` prints.
 */
export function normalizeC0mputeSite(input) {
  if (input === null || input === undefined) return "";
  const raw = String(input).trim().toLowerCase();
  if (!raw || raw === "off" || raw === "none") return "";
  const fromUrl = raw.match(/\/s\/([0-9a-f]{20})(?:\/|$)/);
  const bare = fromUrl ? fromUrl[1] : raw.replace(/^site=/, "");
  return C0MPUTE_SITE_RE.test(bare) ? bare : null;
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The edge hostname names with a c0mpute site resolve to, or null when none is
 * configured (`MOSHPIT_C0MPUTE_EDGE`).
 *
 * A hostname, not an address, for the reason the registry refuses IPv4
 * targets: several edges behind one name is how this gets redundancy, and a
 * hostname is the only thing a resolver can follow to all of them.
 */
export function c0mputeEdgeHost(env = process.env) {
  const host = String(env.MOSHPIT_C0MPUTE_EDGE || "").trim().toLowerCase().replace(/\.+$/, "");
  return HOSTNAME.test(host) ? host : null;
}

/**
 * The accounts allowed to ask the CA for a certificate on a name that points at
 * c0mpute (`MOSHPIT_C0MPUTE_EDGE_USERS`, comma- or space-separated user ids).
 *
 * Unset means none, and then only the holder can get a certificate, exactly as
 * before this existed.
 */
export function c0mputeEdgeUsers(env = process.env) {
  return new Set(String(env.MOSHPIT_C0MPUTE_EDGE_USERS || "").split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean));
}

/**
 * What a resolver should be told a name points at.
 *
 * A c0mpute site wins over a stored target when an edge is configured: setting
 * it is the more deliberate act (and setting a target clears it again). With no
 * edge configured the site cannot be served, so the stored target stands and
 * nothing changes for anyone.
 */
export function effectiveC0mputeTarget({ target = null, site = null } = {}, env = process.env) {
  const edge = c0mputeEdgeHost(env);
  if (site && C0MPUTE_SITE_RE.test(site) && edge) return edge;
  return target ?? null;
}
