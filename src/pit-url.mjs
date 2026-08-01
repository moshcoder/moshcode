export const DEFAULT_REGISTRY_BASE = "https://pit.moshcode.sh";

/**
 * The Pit's page for a name.
 *
 * Its own module because both halves of parking need it — the resolver, when it
 * explains where a name went, and the parking responder, when it sends a
 * browser there — and dns.mjs importing the responder that imports dns.mjs
 * would be a cycle.
 */
export function pitNameUrl(name, registryBase = DEFAULT_REGISTRY_BASE) {
  return `${String(registryBase).replace(/\/+$/, "")}/n/${encodeURIComponent(name)}`;
}
