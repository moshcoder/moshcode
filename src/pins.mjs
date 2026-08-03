// TLS for a Moshpit name, without anybody having to learn what a pin is.
//
// Names outside the DNS root cannot have CA-issued certificates: a CA validates
// control through the public hierarchy, and `.hacker` is not in it. So Moshpit
// verifies the other way round — the registry publishes the key a name's
// certificate must present, and clients check the certificate against that
// instead of against a chain of issuers.
//
// That is a good trade. A CA attests that somebody proved control to some
// issuer; a pin says this is exactly the key the registry has on record. There
// is no third party to mis-issue.
//
// It only works if the pin actually gets published, which is the part that was
// failing. Publishing meant running a script, reading a base64 hash out of it,
// and pasting that into a web form — three steps where the interesting one is
// invisible, so the honest outcome is that most names never get a pin at all
// and their TLS is unverifiable.
//
// The key is created here, so the pin is known here with certainty. Nothing is
// probed, nothing is trusted on first use, and the hash never has to be seen
// by a person.

import crypto from "node:crypto";

/** Pins hang off the ending, not the name — the registry has no per-name record. */
export function tldOf(name) {
  const clean = String(name ?? "").trim().toLowerCase().replace(/\.$/, "");
  const parts = clean.split(".").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : "";
}

/**
 * The pin for a public key: SHA-256 over the SubjectPublicKeyInfo, base64.
 *
 * Over the SPKI rather than the certificate, so re-issuing a certificate for
 * the same key — a longer expiry, an added name — does not invalidate every
 * client's pin. The key is the identity; the certificate is just its current
 * wrapper.
 */
export function spkiPin(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("base64");
}

/** The same, from a certificate rather than a bare key. */
export function pinFromCertificate(certPem) {
  return spkiPin(new crypto.X509Certificate(certPem).publicKey.export({ type: "spki", format: "pem" }));
}

/**
 * Where a TLD's key lives.
 *
 * One key per ending, not per name, because that is the granularity the
 * registry stores. Giving each name its own key would mean a new pin published
 * per site, and every name under the ending would then accept all of them —
 * strictly more keys able to impersonate each other, for no isolation gained.
 */
export function keyPaths(tld, dir = "/etc/ssl/moshpit") {
  const safe = String(tld ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!safe) return null;
  return { key: `${dir}/${safe}.key`, cert: `${dir}/${safe}.crt`, dir };
}

/**
 * The openssl invocation that mints a key and a self-signed certificate.
 *
 * P-256 to match what is already deployed, and a long expiry on purpose: the
 * pin is what makes this certificate trustworthy, and rotating it means
 * republishing the pin. An annual scramble to re-pin every name would be a
 * reliability problem invented to satisfy a CA convention that does not apply
 * here.
 */
export function certificateCommand({ name, tld, paths, days = 3650 }) {
  const subject = `/CN=${name}`;
  return {
    cmd: "openssl",
    args: [
      "req", "-x509", "-nodes",
      "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-keyout", paths.key, "-out", paths.cert,
      "-days", String(days), "-subj", subject,
      // Every name under the ending, since they share this key. Browsers and
      // pin-checking clients both read SAN, not CN.
      "-addext", `subjectAltName=DNS:${name},DNS:*.${tld}`,
    ],
  };
}

/**
 * Publish a pin to the registry.
 *
 * Additive rather than replacing, matching the API: rotation wants a window
 * where both keys are valid, so the new one can be published, deployed, and
 * only then the old one withdrawn. Replacing outright breaks every client
 * between the write and the deploy.
 *
 * A 409 means this exact pin is already published, which is success as far as
 * the caller is concerned — running `site --install` twice should not be an
 * error.
 */
export async function publishPin({
  tld,
  pin,
  kind = "tls",
  note = "moshcode site",
  registryBase = "https://pit.moshcode.sh",
  token,
  fetchImpl = fetch,
} = {}) {
  if (!tld) return { ok: false, error: "no ending to publish under" };
  if (!pin) return { ok: false, error: "no pin to publish" };
  if (!token) {
    return {
      ok: false,
      needsAuth: true,
      error: "not logged in — run `moshcode login`, or set MOSHCODE_API_KEY",
    };
  }

  const url = `${String(registryBase).replace(/\/+$/, "")}/api/moshpit/tlds/${encodeURIComponent(tld)}/pins`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ pin, kind, note }),
    });
  } catch (error) {
    return { ok: false, error: `registry unreachable: ${error.message}` };
  }

  if (response.status === 201) return { ok: true, published: true };
  // Already there — the desired state, reached earlier.
  if (response.status === 409) return { ok: true, published: false, already: true };
  if (response.status === 401) {
    return { ok: false, needsAuth: true, error: "the registry rejected the credentials" };
  }
  const body = await response.text().catch(() => "");
  return { ok: false, error: `registry said ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
}

/**
 * Whether this ending already publishes this pin.
 *
 * Checked before writing so a re-run is silent rather than a 409, and so the
 * common case — the key is already deployed and published — costs one GET and
 * no credentials at all.
 */
export async function pinPublished({
  tld,
  pin,
  registryBase = "https://pit.moshcode.sh",
  fetchImpl = fetch,
} = {}) {
  if (!tld || !pin) return false;
  const url = `${String(registryBase).replace(/\/+$/, "")}/api/moshpit/tlds/${encodeURIComponent(tld)}/pins`;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return false;
    const body = await response.json();
    return (body?.pins ?? []).some((entry) => (entry?.pin ?? entry) === pin);
  } catch {
    return false;
  }
}
