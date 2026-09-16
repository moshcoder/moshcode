# The Moshpit certificate authority

No public CA will issue for a name outside the ICANN root, so `https://` on a
Moshpit name used to mean a self-signed leaf per origin and a client that
learned each name one at a time against the pin the registry publishes. The
registry is the one party that already knows who holds a name, which is what a
CA needs to know before it signs. So it signs.

Install the root once and every pit name is trusted: curl, Firefox, Chromium,
git, all of it. TronBrowser ships the root; `moshcode dns enable` installs it.

## Shape

| | who holds the key | signs | lives |
| --- | --- | --- | --- |
| root, `Moshpit Root CA` | nobody online: the vault | the issuer, once | 20 years |
| issuer, `Moshpit Issuing CA` | the registry service (`MOSHPIT_CA_KEY`) | leaves | 10 years |
| leaf, one per name | the origin | nothing (`CA:FALSE`) | 30 days, renewed by the origin |

Leaves carry `DNS:<name>` and `DNS:*.<name>`, `serverAuth`, and nothing else.
Short lives are what make revocation unnecessary: a compromised key is out of
the world within a month and is not renewed, and there is no CRL or OCSP to run
or to fail closed on.

## Who may ask

The rule pins use, `controlledName()`: the name's holder, or its tenant while
a lease runs. That is what makes resale safe. Whoever holds `.foo` cannot
obtain a certificate for `bar.foo` once it is somebody else's, and a tenant of
`blue.eggs` gets one while the holder does not. Ending owners never hold a
signing key; only the registry signs.

The subject is the name, never the CSR's. A request for `blue.eggs` cannot come
out naming `red.eggs` however the CSR is written. Names whose ending is a real
top-level domain are refused unconditionally, whatever the registry's tables
say, so a registry bug cannot mint `google.com`. Twenty-four issuances per name
per day, so a broken renewal loop is stopped rather than served.

Every leaf's key is also published as a `tls` pin, so a client that still
checks pins keeps working through the transition.

## API

```
GET  /api/moshpit/ca                       { enabled, root: { subject, fingerprint_sha256, url }, leaf_days }
GET  /api/moshpit/ca.crt                   the root, PEM: what a client installs
GET  /api/moshpit/ca-chain.crt             issuer then root, PEM: what an origin serves after its leaf
POST /api/moshpit/tlds/:tld/certs          { label, csr }  →  201 { name, serial, cert, chain, root, not_after, pin }
GET  /api/moshpit/tlds/:tld/certs?label=   what has been issued under a name
GET  /api/moshpit/certs/:serial            one issued certificate, PEM
```

`POST` takes the same bearer API key as every other `/api/moshpit` write. With
no CA configured the read endpoints answer `enabled: false` or 503 and nothing
else in the registry changes.

An origin, in shell:

```sh
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout blue.eggs.key -subj /CN=blue.eggs -out blue.eggs.csr
curl -sS -X POST https://pit.moshcode.sh/api/moshpit/tlds/eggs/certs \
  -H "authorization: Bearer $MOSHPIT_API_KEY" -H "content-type: application/json" \
  -d "$(jq -n --arg label blue --rawfile csr blue.eggs.csr '{label:$label, csr:$csr}')" \
  | jq -r .chain > blue.eggs.fullchain.crt
```

Point the server at `fullchain.crt` and the key, and renew on a timer before
day 30. `moshpit-proxy/scripts/setup-origin.sh` does all of this.

## Setting it up, once

```sh
node scripts/moshpit-ca-init.mjs --out ~/.moshpit-ca
```

writes `root.key`, `root.crt`, `issuing.key`, `issuing.crt` and `railway.env`.
The root key goes to the vault and nowhere else. The three lines in
`railway.env` are the service variables: `MOSHPIT_CA_CERT`, `MOSHPIT_CA_KEY`,
`MOSHPIT_CA_ROOT`, base64 of the PEM so they survive as single-line values.
`MOSHPIT_CA_LEAF_DAYS` (default 30) is optional. On start the service checks
that the key matches the certificate and that the issuer chains to the root,
and refuses to come up with the CA half-configured rather than sign wrongly.

Rotating the issuer is: sign a new issuing pair with the root (offline), set
the variables, restart. Leaves already out keep working until they renew,
because the chain they serve includes the issuer that signed them.

## Where clients get the root

- TronBrowser: bundled in the release, imported into the browser's trust
  store by the launcher on every start.
- `moshcode dns enable`: installed into the system store, replacing the
  per-machine local CA it used to generate for its proxy.
- Anything else: `curl https://pit.moshcode.sh/api/moshpit/ca.crt` and
  install it the way any private CA is installed. Phones take it through a
  profile (iOS) or Settings (Android); most Android apps ignore user-added
  roots by design, so browsers there work and third-party apps do not.

What no root program can give us: stock Chrome on a stranger's machine will
never trust `.hacker`, because public root programs only admit CAs for names
under the ICANN root. That limit belongs to the namespace, not to this CA.
