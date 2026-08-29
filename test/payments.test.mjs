// Choosing a rail, and the promise that no secret is stored while doing it.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GATEWAYS, defaultGateway, gatewayState, paymentsCommand, resolveGateway } from "../src/payments.mjs";
import { businessFile, loadBusiness } from "../src/business-store.mjs";

function sandbox(t) {
  const previous = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "moshcode-payments-"));
  t.after(() => { process.env.HOME = previous; });
  const lines = [];
  return { lines, write: (l) => lines.push(String(l)), said: () => lines.join("\n") };
}

test("every gateway declares how it connects and what it settles in", () => {
  for (const [key, gateway] of Object.entries(GATEWAYS)) {
    assert.ok(["cli", "oauth", "wallet"].includes(gateway.kind), `${key} has no kind`);
    assert.ok(gateway.currencies?.length, `${key} settles in nothing`);
    if (gateway.kind === "cli") assert.ok(gateway.bin && gateway.connect, `${key} is a CLI with no login`);
    if (gateway.kind === "oauth") assert.ok(gateway.dashboard && gateway.keys?.length, `${key} has nowhere to get keys`);
  }
  assert.equal(resolveGateway("COINPAY")[0], "coinpay");
  assert.equal(resolveGateway("venmo"), null);
});

test("a wallet needs both halves before it is a rail", (t) => {
  const io = sandbox(t);
  assert.equal(paymentsCommand(["connect", "wallet", "--address", "5wal"], io), 1, "an address with no chain is not enough");
  assert.equal(paymentsCommand(["connect", "wallet", "--chain", "solana"], io), 1);
  assert.equal(paymentsCommand(["connect", "wallet", "--chain", "solana", "--address", "5wal"], io), 0);
  assert.deepEqual(loadBusiness().payments.gateways.wallet.address, "5wal");
  assert.match(io.said(), /no chargeback/, "the trade-off is said out loud");
});

test("the first rail connected becomes the default", (t) => {
  const io = sandbox(t);
  paymentsCommand(["connect", "wallet", "--chain", "solana", "--address", "5wal"], io);
  assert.equal(defaultGateway(loadBusiness()), "wallet");
  assert.equal(gatewayState("wallet").isDefault, true);
});

test("an OAuth gateway records where the keys live, never the keys", (t) => {
  const io = sandbox(t);
  assert.equal(paymentsCommand(["connect", "paypal", "--vault", "profullstack--prod"], io), 0);
  const record = loadBusiness().payments.gateways.paypal;
  assert.equal(record.vault, "profullstack--prod");
  assert.deepEqual(record.keys, GATEWAYS.paypal.keys);
  // The file on disk must contain the key *names* and nothing that looks like
  // a value — this is the whole reason the vault exists.
  const onDisk = readFileSync(businessFile(), "utf8");
  assert.match(onDisk, /PAYPAL_CLIENT_SECRET/);
  assert.equal(/secret"\s*:\s*"[^"]+"/i.test(onDisk), false, "no secret value was written");
  assert.match(io.said(), /vault, not in a dotfile/);
});

test("default only points at something connected, and disconnect clears it", (t) => {
  const io = sandbox(t);
  assert.equal(paymentsCommand(["default", "stripe"], io), 1, "cannot default to a rail nobody connected");
  paymentsCommand(["connect", "wallet", "--chain", "solana", "--address", "5wal"], io);
  paymentsCommand(["connect", "paypal", "--vault", "v"], io);
  assert.equal(paymentsCommand(["default", "paypal"], io), 0);
  assert.equal(loadBusiness().payments.default, "paypal");
  assert.equal(paymentsCommand(["disconnect", "paypal"], io), 0);
  assert.equal(loadBusiness().payments.default, undefined, "the default left with the rail");
  assert.equal(paymentsCommand(["disconnect", "paypal"], io), 1, "disconnecting twice is not silent success");
});

test("a CLI gateway is only connected once somebody has chosen it", (t) => {
  const io = sandbox(t);
  const before = gatewayState("coinpay");
  assert.equal(before.connected, false, "an installed binary is not a decision");
  // Injected so the test never runs anybody's login.
  const run = () => ({ status: 0 });
  const code = paymentsCommand(["connect", "coinpay"], { ...io, run });
  if (before.installed) {
    assert.equal(code, 0);
    assert.equal(gatewayState("coinpay").connected, true);
    assert.match(io.said(), /holds the credential, not moshcode/);
  } else {
    assert.equal(code, 1, "no binary, no connection");
    assert.match(io.said(), /not on PATH/);
  }
});

test("a failed login records nothing", (t) => {
  const io = sandbox(t);
  if (!gatewayState("coinpay").installed) return;
  paymentsCommand(["connect", "coinpay"], { ...io, run: () => ({ status: 1 }) });
  assert.equal(loadBusiness().payments.gateways?.coinpay, undefined);
  assert.match(io.said(), /nothing recorded/);
});
