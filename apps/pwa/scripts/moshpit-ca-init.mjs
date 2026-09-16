#!/usr/bin/env node
// Create the Moshpit certificate authority: a root, and the issuing
// intermediate the registry signs with. Run once, offline, by a person.
//
//   node scripts/moshpit-ca-init.mjs --out ~/.moshpit-ca
//
// Writes, mode 0600, into --out (which must not already hold a root.key):
//   root.key      keep cold: the vault, never a server. Signs issuers only.
//   root.crt      what every client installs. Public. Shipped with TronBrowser
//                 and installed by `moshcode dns enable`.
//   issuing.key   the registry's signing key: MOSHPIT_CA_KEY on the service.
//   issuing.crt   its certificate:            MOSHPIT_CA_CERT
//   root.crt      also the service's           MOSHPIT_CA_ROOT
//   railway.env   the three service variables, base64 one-liners, ready to paste
//
// Nothing here talks to the network and nothing prints a private key.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateCa } from "../src/lib/moshpit-ca.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const out = path.resolve(flag("--out", "moshpit-ca"));
const rootName = flag("--root-name", "Moshpit Root CA");
const issuerName = flag("--issuer-name", "Moshpit Issuing CA");

if (existsSync(path.join(out, "root.key"))) {
  console.error(`${out}/root.key already exists — refusing to overwrite a root. Use another --out.`);
  process.exit(1);
}
mkdirSync(out, { recursive: true, mode: 0o700 });

const ca = await generateCa({ rootName, issuerName });
const put = (name, body) => writeFileSync(path.join(out, name), body, { mode: 0o600 });
put("root.key", ca.root.key);
put("root.crt", ca.root.cert);
put("issuing.key", ca.issuer.key);
put("issuing.crt", ca.issuer.cert);
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
put("railway.env", [
  `MOSHPIT_CA_CERT=${b64(ca.issuer.cert)}`,
  `MOSHPIT_CA_KEY=${b64(ca.issuer.key)}`,
  `MOSHPIT_CA_ROOT=${b64(ca.root.cert)}`,
  "",
].join("\n"));

console.log(`Moshpit CA written to ${out}/`);
console.log(`  root.key     -> the vault. Never a server, never an environment variable.`);
console.log(`  root.crt     -> public; TronBrowser bundles it, moshcode dns enable installs it.`);
console.log(`  issuing.*    -> the registry service: MOSHPIT_CA_CERT / MOSHPIT_CA_KEY / MOSHPIT_CA_ROOT`);
console.log(`  railway.env  -> the three variables as single-line base64, paste into the service.`);
