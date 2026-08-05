import assert from "node:assert/strict";
import test from "node:test";

import { dnsCommand } from "../src/dns.mjs";

// `dns trust <name>` picks the name out of the argument list itself. The list
// can carry `--registry <url>` — the flag is documented for `dns` and is the
// natural one to pass to `trust`, whose whole job is checking the served key
// against the registry's published pin. The name must survive that flag.
//
// The certificate fetch is stubbed to fail, which makes trustName report the
// exact name it tried to read a cert for — so the first output line is a clean
// witness of which token was parsed as the name.
function runTrust(args) {
  const output = [];
  const runner = async () => ({ ok: false, stdout: "", stderr: "", code: 1 });
  return dnsCommand(args, (line) => output.push(String(line)), { runner })
    .then(() => output);
}

test("dns trust reads the name, not the value after --registry", async () => {
  const output = await runTrust(["trust", "--registry", "https://reg.example", "blue.eggs"]);
  assert.match(output[0], /blue\.eggs:443/);
  assert.doesNotMatch(output[0], /reg\.example/);
});

test("dns trust reads the name, not the value after --port", async () => {
  const output = await runTrust(["trust", "--port", "8443", "blue.eggs"]);
  assert.match(output[0], /blue\.eggs:443/);
});

// Control: the plain form has to keep behaving exactly the same, so the fix is
// visibly a no-op on the path that already worked.
test("dns trust with no flags still reads the name", async () => {
  const output = await runTrust(["trust", "blue.eggs"]);
  assert.match(output[0], /blue\.eggs:443/);
});
