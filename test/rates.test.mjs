// The rate grammar, and the arithmetic that hangs off it.
//
// These are the tests that stop an invoice being wrong. Every case here is a
// sentence somebody said out loud about money — "a hundred an hour per agent,
// capped at four" — and the assertion is that the machine read it the way they
// meant it.
import assert from "node:assert/strict";
import test from "node:test";

import { chargeFor, describeRate, formatMoney, formatRate, isFiat, parseRate, splitSettlement } from "../src/rates.mjs";

test("the price is read from either end, with or without a symbol", () => {
  assert.deepEqual(parseRate("$100/hour").amount, 100);
  assert.equal(parseRate("$100/hour").currency, "USD");
  assert.equal(parseRate("100 USD/hour").currency, "USD");
  assert.equal(parseRate("0.5 SOL/day").amount, 0.5);
  assert.equal(parseRate("0.5 SOL/day").currency, "SOL");
  assert.equal(parseRate("250 USDC/task").currency, "USDC");
  assert.equal(parseRate("€80/hour").currency, "EUR");
  // Thousands separators survive: rates get pasted out of contracts.
  assert.equal(parseRate("$5,000/project").amount, 5000);
});

test("everything after the price is recognised by what it says, not where it sits", () => {
  const a = parseRate("$100/hour/agent/upto:4");
  const b = parseRate("$100/agent/hour/upto:4");
  assert.deepEqual(a, b, "order after the price must not matter");
  assert.equal(a.per, "hour");
  assert.equal(a.unit, "agent");
  assert.equal(a.cap, 4);
});

test("the spellings people actually type all land", () => {
  assert.equal(parseRate("$100/hr/seat").per, "hour");
  assert.equal(parseRate("$100/hours/agents").unit, "agent");
  assert.equal(parseRate("$100/mo/team").per, "month");
  assert.equal(parseRate("$100/hour/dev").unit, "person");
  assert.equal(parseRate("$100/hour/agent/max:2").cap, 2);
  assert.equal(parseRate("$100/hour/agent/cap:2").cap, 2);
  // A yearly figure is stored monthly, because that is the period an invoice
  // covers — the number is divided rather than the word being rejected.
  assert.equal(parseRate("$120000/year").amount, 10000);
});

test("a rate that cannot be read says which word it choked on", () => {
  assert.throws(() => parseRate("$100/fortnight"), /fortnight/);
  assert.throws(() => parseRate("free"), /can't read a price/);
  assert.throws(() => parseRate(""), /\$100\/hour\/agent/);
  // A cap with nothing to cap is the error that matters most: it reads as a
  // discount and silently is not one.
  assert.throws(() => parseRate("$100/hour/upto:4"), /caps a unit/);
  assert.throws(() => parseRate("$100/hour/agent/upto:0"), /whole number/);
});

test("a rate round-trips through its own formatting", () => {
  for (const spec of ["$100/hour/agent/upto:4", "0.5 SOL/day", "250 USDC/task", "$100/hour/seat/min:1"]) {
    const once = parseRate(spec);
    assert.deepEqual(parseRate(formatRate(once)), once, spec);
  }
});

test("money is written the way its currency is written", () => {
  assert.equal(formatMoney(1250, "USD"), "$1,250.00");
  assert.equal(formatMoney(1250, "USDC"), "1250 USDC");
  assert.equal(formatMoney(0.5, "SOL"), "0.5 SOL");
  // No padding on crypto: 0.10000000 BTC hides the number in zeros.
  assert.equal(formatMoney(0.1, "BTC"), "0.1 BTC");
  assert.equal(isFiat("USDC"), false);
  assert.equal(isFiat("gbp"), true);
});

test("the cap is applied, and it is the whole point of the cap", () => {
  const rate = parseRate("$100/hour/agent/upto:4");
  assert.equal(chargeFor({ seconds: 3600, agents: 1 }, rate).amount, 100);
  assert.equal(chargeFor({ seconds: 3600, agents: 4 }, rate).amount, 400);
  // Six agents cost what four cost. That is the promise that got signed.
  assert.equal(chargeFor({ seconds: 3600, agents: 6 }, rate).amount, 400);
  assert.equal(chargeFor({ seconds: 3600, agents: 6 }, rate).units, 4);
});

test("periods convert, and a floor rounds up before the multiply", () => {
  const daily = parseRate("$800/day/agent");
  // A day is eight hours, so four hours is half a day.
  assert.equal(chargeFor({ seconds: 4 * 3600, agents: 1 }, daily).amount, 400);
  const floored = parseRate("$100/hour/min:1");
  assert.equal(chargeFor({ seconds: 15 * 60 }, floored).amount, 100, "a 15-minute call bills an hour");
  assert.equal(chargeFor({ seconds: 15 * 60 }, floored).hours, 0.25, "the tracked time is still the truth");
});

test("a flat project fee is not earned per entry", () => {
  const project = parseRate("$5000/project");
  const charge = chargeFor({ seconds: 3600 }, project);
  assert.equal(charge.flat, true);
  // Null, not zero: zero would bill nothing for a delivered project and look
  // like an answer. The invoice adds the fee once instead.
  assert.equal(charge.amount, null);
});

test("settlement preferences are split off the argv and left alone", () => {
  const { argv, settlement } = splitSettlement(["acme", "$100/hour", "--prefer", "sol,usdc", "--accept", "fiat"]);
  assert.deepEqual(argv, ["acme", "$100/hour"]);
  assert.deepEqual(settlement.prefer, ["SOL", "USDC"], "tickers upper-case");
  assert.deepEqual(settlement.accept, ["fiat"], "categories stay as written");
});

test("describeRate says the cap out loud", () => {
  const said = describeRate({ ...parseRate("$100/hour/agent/upto:4"), prefer: ["SOL"], accept: ["fiat"] });
  assert.match(said, /at most 4 agents/);
  assert.match(said, /prefers SOL/);
  assert.match(said, /fiat accepted/);
});
