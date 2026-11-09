// `moshcode name c0mpute <name> <site_id>` — serve a Moshpit name from the
// c0mpute network.
//
// c0mpute keeps static sites alive peer to peer: `c0mpute hosting publish`
// prints a 20-hex site id, three hosting nodes hold copies, and every c0mpute
// gateway serves it at /s/<site_id>/. This tells the registry that a name you
// hold is that site. The registry then resolves the name to the c0mpute edge,
// which holds a Moshpit certificate for it and fetches the site from whichever
// gateways are healthy, so https://<name> works in any browser that trusts the
// Moshpit root, with no server of yours anywhere.
//
// Nothing here touches this machine's DNS. It is one write to the registry.

import { DEFAULT_REGISTRY_BASE } from "./pit-url.mjs";
import { loadCreds } from "./auth.mjs";
import { normalizeName } from "./name-link.mjs";

/** A site id as the registry stores it, `""` to clear, or null when it is not one. */
export function normalizeSiteId(input) {
  const raw = String(input ?? "").trim().toLowerCase();
  if (!raw || raw === "off" || raw === "none") return "";
  const fromUrl = raw.match(/\/s\/([0-9a-f]{20})(?:\/|$)/);
  const bare = fromUrl ? fromUrl[1] : raw.replace(/^site=/, "");
  return /^[0-9a-f]{20}$/.test(bare) ? bare : null;
}

/**
 * Tell the registry `name` is c0mpute site `site` ("" clears it).
 *
 * Returns { ok, site, edge, served } or { ok: false, error, needsAuth? }.
 */
export async function setC0mputeSite({
  name,
  site,
  registryBase = DEFAULT_REGISTRY_BASE,
  token,
  fetchImpl = fetch,
} = {}) {
  if (!token) {
    return { ok: false, needsAuth: true, error: "not logged in — run `moshcode login`, or set MOSHCODE_API_KEY" };
  }
  const [label, tld] = name.split(".");
  const url = `${String(registryBase).replace(/\/+$/, "")}/api/moshpit/tlds/${encodeURIComponent(tld)}/names/c0mpute`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ label, site }),
    });
  } catch (error) {
    return { ok: false, error: `registry unreachable: ${error.message}` };
  }
  if (response.status === 401) return { ok: false, needsAuth: true, error: "the registry rejected the credentials" };
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, error: body?.error ? String(body.error) : `registry said ${response.status}` };
  }
  return { ok: true, site: body?.c0mpute ?? null, edge: body?.edge ?? null, served: Boolean(body?.served) };
}

/**
 * `moshcode name c0mpute <name> <site_id|off> [--registry <url>] [--json]`.
 *
 * @param {string[]} argv  the words after `c0mpute`
 * @returns {Promise<number>} exit code
 */
export async function nameC0mputeCommand(argv, io = {}) {
  const out = io.out || ((s) => console.log(s));
  const err = io.err || ((s) => console.error(s));
  const at = argv.indexOf("--registry");
  const registryBase = at >= 0 && argv[at + 1] ? argv[at + 1] : (io.env?.MOSHPIT_REGISTRY_BASE || DEFAULT_REGISTRY_BASE);
  const json = argv.includes("--json");
  const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--registry"));
  const [rawName, rawSite] = positional;

  const usage = "usage: moshcode name c0mpute <name> <site_id|off> [--json]";
  const name = normalizeName(rawName);
  if (!name) {
    err(rawName ? `not a Moshpit name: ${rawName} — expected <label>.<tld>` : usage);
    return 1;
  }
  if (rawSite === undefined) {
    err(usage);
    return 1;
  }
  const site = normalizeSiteId(rawSite);
  if (site === null) {
    err(`not a c0mpute site id: ${rawSite} — 20 hex characters, as printed by \`c0mpute hosting publish\``);
    return 1;
  }

  const result = await setC0mputeSite({
    name,
    site,
    registryBase,
    token: io.token ?? ((io.env || process.env).MOSHCODE_API_KEY || loadCreds()?.token || ""),
    fetchImpl: io.fetchImpl,
  });
  if (!result.ok) {
    err(result.error);
    return 1;
  }
  if (json) {
    out(JSON.stringify({ name, c0mpute: result.site, edge: result.edge, served: result.served }));
    return 0;
  }
  if (!result.site) {
    out(`${name} no longer points at a c0mpute site.`);
    return 0;
  }
  out(`${name} → c0mpute site ${result.site}`);
  out(result.served
    ? `  served by the c0mpute edge (${result.edge}): https://${name}/`
    : "  stored; the registry has no c0mpute edge configured yet, so nothing serves it until one is");
  return 0;
}
