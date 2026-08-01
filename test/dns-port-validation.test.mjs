import test from "node:test";
import assert from "node:assert/strict";

import { dnsCommand, parseDnsPort } from "../src/dns.mjs";

test("DNS ports accept only decimal integers in the TCP range", () => {
  assert.equal(parseDnsPort("1"), 1);
  assert.equal(parseDnsPort(" 5354 "), 5354);
  assert.equal(parseDnsPort(65535), 65535);
  assert.equal(parseDnsPort("1e3"), null);
  assert.equal(parseDnsPort("65536"), null);
});

test("dns install rejects invalid resolver ports before fetching TLDs", async () => {
  for (const value of [undefined, "", "abc", "0", "1.5", "1e3", "65536", "9007199254740992"]) {
    const args = ["install", "--port"];
    if (value !== undefined) args.push(value);
    const lines = [];

    assert.equal(await dnsCommand(args, (line) => lines.push(String(line))), 1);
    assert.match(lines.join("\n"), /--port needs a decimal integer from 1 to 65535/);
  }
});

test("dns start rejects invalid parking HTTP ports before opening sockets", async () => {
  for (const value of [undefined, "", "abc", "0", "1.5", "1e3", "65536", "Infinity"]) {
    const args = ["start", "--parking-port"];
    if (value !== undefined) args.push(value);
    const lines = [];

    assert.equal(await dnsCommand(args, (line) => lines.push(String(line))), 1);
    assert.match(lines.join("\n"), /--parking-port needs a decimal integer from 1 to 65535/);
  }
});
