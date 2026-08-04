import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { tradeArgs, tradeUsage } from "../src/trade.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

test("trade translates market lookup shortcuts to Alpaca argv", () => {
  assert.deepEqual(tradeArgs(["ticker", "aapl"]), {
    args: ["asset", "get", "--symbol-or-asset-id", "AAPL"],
  });
  assert.deepEqual(tradeArgs(["quote", "msft", "--feed", "iex"]), {
    args: ["data", "latest-quote", "--symbol", "MSFT", "--feed", "iex"],
  });
  assert.deepEqual(tradeArgs(["analysis", "nvda"]), {
    args: ["data", "snapshot", "--symbol", "NVDA"],
  });
});

test("buy and sell preview by default and submit only when explicit", () => {
  assert.deepEqual(tradeArgs(["buy", "aapl", "2"]), {
    args: ["order", "submit", "--symbol", "AAPL", "--side", "buy", "--qty", "2", "--type", "market", "--dry-run"],
    preview: true,
  });
  assert.deepEqual(tradeArgs(["sell", "tsla", "0.5", "--type", "limit", "--limit-price", "300", "--submit"]), {
    args: ["order", "submit", "--symbol", "TSLA", "--side", "sell", "--qty", "0.5", "--type", "limit", "--limit-price", "300"],
    preview: false,
  });
  assert.equal(tradeArgs(["buy", "AAPL", "zero"]).error, "trade buy quantity must be a positive number");
});

test("buy and sell accept native qty/notional forms without allowing both", () => {
  assert.deepEqual(tradeArgs(["buy", "aapl", "--notional", "100"]), {
    args: ["order", "submit", "--symbol", "AAPL", "--side", "buy", "--type", "market", "--notional", "100", "--dry-run"],
    preview: true,
  });
  assert.deepEqual(tradeArgs(["sell", "aapl", "--qty=0.25", "--submit"]), {
    args: ["order", "submit", "--symbol", "AAPL", "--side", "sell", "--type", "market", "--qty=0.25"],
    preview: false,
  });
  assert.match(tradeArgs(["buy", "AAPL"]).error, /quantity or --notional/);
  assert.match(tradeArgs(["buy", "AAPL", "1", "--notional", "100"]).error, /accepts one of/);
  assert.match(tradeArgs(["buy", "AAPL", "--notional", "0"]).error, /notional amount must be a positive/);
  assert.match(tradeArgs(["buy", "AAPL", "--notional"]).error, /requires a positive number/);
});

test("portfolio, watchlist, account, login, and raw shortcuts preserve native args", () => {
  assert.deepEqual(tradeArgs(["watch"]), { args: ["watchlist", "list"] });
  assert.deepEqual(tradeArgs(["watch", "add", "--watchlist-id", "w", "--symbol", "AAPL"]), {
    args: ["watchlist", "add", "--watchlist-id", "w", "--symbol", "AAPL"],
  });
  assert.deepEqual(tradeArgs(["positions"]), { args: ["position", "list"] });
  assert.deepEqual(tradeArgs(["orders", "cancel-all"]), { args: ["order", "cancel-all"] });
  assert.deepEqual(tradeArgs(["account"]), { args: ["account", "get"] });
  assert.deepEqual(tradeArgs(["login", "--api-key"]), { args: ["profile", "login", "--api-key"] });
  assert.deepEqual(tradeArgs(["raw", "data", "news", "--symbol", "AAPL"]), {
    args: ["data", "news", "--symbol", "AAPL"],
  });
  assert.equal(tradeArgs([]).usage, true);
  assert.match(tradeUsage(), /--submit/);
});

test("moshcode trade invokes Alpaca with translated argv and preserves output", () => {
  const binDir = mkdtempSync(path.join(tmpdir(), "moshcode-trade-"));
  const alpaca = path.join(binDir, "alpaca");
  writeFileSync(alpaca, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
  chmodSync(alpaca, 0o755);

  const result = spawnSync(process.execPath, [BIN, "trade", "buy", "AAPL", "3"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "order", "submit", "--symbol", "AAPL", "--side", "buy", "--qty", "3", "--type", "market", "--dry-run",
  ]);
});

const REAL_ALPACA = path.join(homedir(), "go", "bin", process.platform === "win32" ? "alpaca.exe" : "alpaca");

test("installed Alpaca accepts the facade's real lookup and order argv", {
  skip: !existsSync(REAL_ALPACA) && "Alpaca CLI is not installed in the default Go bin directory",
}, () => {
  const env = {
    ...process.env,
    // Non-secret placeholders satisfy Alpaca's local auth gate. Every order
    // keeps the facade-injected --dry-run, so this test performs no API call.
    ALPACA_API_KEY: "PK_MOSHCODE_TEST",
    ALPACA_SECRET_KEY: "MOSHCODE_TEST_ONLY",
  };
  const run = (...args) => spawnSync(process.execPath, [BIN, "trade", ...args], { encoding: "utf8", env });

  for (const args of [["ticker", "AAPL", "--schema"], ["quote", "AAPL", "--schema"]]) {
    const result = run(...args);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr || result.stdout}`);
  }

  for (const args of [["buy", "AAPL", "1"], ["buy", "AAPL", "--notional", "100"]]) {
    const result = run(...args);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr || result.stdout}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.symbol, "AAPL");
    assert.equal(body.side, "buy");
    assert.equal(body.type, "market");
  }
});
