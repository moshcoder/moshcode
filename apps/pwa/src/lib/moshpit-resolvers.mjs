// The public Moshpit resolvers, as advertised on /pit/dns.
//
// Read from the environment rather than hardcoded: the addresses are
// operational facts that change when a box moves, and a page that keeps
// telling people to use an address that moved is worse than one that says
// nothing at all.
//
// Addresses are validated here for the same reason. This list goes onto a page
// where strangers copy it into their network settings, so a typo in an env var
// has to disappear rather than be rendered as an instruction to point their
// DNS somewhere that is not an address.

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function isIpAddress(value) {
  const raw = String(value ?? "").trim();
  if (IPV4.test(raw)) return raw.split(".").every((octet) => Number(octet) <= 255);
  // Loose on IPv6 by design: this only has to reject things that are plainly
  // not addresses, not re-implement the grammar.
  return /^[0-9a-f:]+$/i.test(raw) && raw.includes(":") && !raw.includes(":::");
}

/**
 * Parse `dns1.pit.moshcode.sh=203.0.113.7, dns2.pit.moshcode.sh=203.0.113.8`.
 *
 * The name is optional — an address on its own is a complete instruction,
 * since what a person types into their network settings is an address. A
 * resolver's own hostname cannot be looked up until they already have a
 * working resolver, so the name is only there to say which box they are
 * pointing at.
 */
export function parseResolvers(spec) {
  return String(spec ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.lastIndexOf("=");
      const name = at > 0 ? entry.slice(0, at).trim() : "";
      const address = (at > 0 ? entry.slice(at + 1) : entry).trim();
      return { name: name || null, address };
    })
    .filter((resolver) => isIpAddress(resolver.address));
}

/** What /pit/dns knows about the published resolvers. */
export function resolverConfig(env = process.env) {
  const resolvers = parseResolvers(env.MOSHPIT_DNS_RESOLVERS);
  const doh = String(env.MOSHPIT_DOH_URL ?? "").trim();
  return {
    resolvers,
    // Plain HTTP would be advertised to a browser as "secure DNS".
    doh: /^https:\/\/\S+$/.test(doh) ? doh : null,
    published: resolvers.length > 0,
  };
}
