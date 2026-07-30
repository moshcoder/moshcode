// The MOTD ad is the one place third-party text reaches the terminal, so the
// sanitizer is what these tests actually care about.
import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeAd, fetchMotdAd } from "../src/ads.mjs";

const BOX = [
  "+-- CRAWLPROOF ADS ---------+",
  "|                          |",
  "| Your ad here             |",
  "|                          |",
  "+------ ads by crawlproof --+",
].join("\n");

test("ads: a normal box passes through intact", () => {
  assert.equal(sanitizeAd(BOX, 72), BOX);
});

test("ads: escape sequences are stripped, not printed", () => {
  // An advertiser headline carrying \x1b[2J would clear the screen; \x1b[8m
  // would hide everything the pit prints next.
  const hostile = "| [2J[8m Buy now |";
  const cleaned = sanitizeAd(hostile, 72);
  assert.ok(!cleaned.includes(""), "no ESC may survive");
  assert.equal(cleaned, "| [2J[8m Buy now |");
});

test("ads: control characters and non-ASCII are dropped", () => {
  const messy = "| café  \r deal |";
  const cleaned = sanitizeAd(messy, 72);
  assert.ok(!/[^\x20-\x7e\n]/.test(cleaned), "only printable ASCII may survive");
});

test("ads: a wildly over-wide response is rejected wholesale", () => {
  assert.equal(sanitizeAd("x".repeat(200), 72), null);
});

test("ads: empty or non-string input yields null, never a blank block", () => {
  assert.equal(sanitizeAd("", 72), null);
  assert.equal(sanitizeAd("   \n  \n", 72), null);
  assert.equal(sanitizeAd(null, 72), null);
  assert.equal(sanitizeAd(undefined, 72), null);
});

test("ads: MOSHCODE_NO_ADS opts out without touching the network", async () => {
  const before = process.env.MOSHCODE_NO_ADS;
  process.env.MOSHCODE_NO_ADS = "1";
  try {
    // A zero timeout would make a real request fail anyway; the point is that
    // this returns immediately, before any fetch is attempted.
    assert.equal(await fetchMotdAd({ timeoutMs: 0 }), null);
  } finally {
    if (before === undefined) delete process.env.MOSHCODE_NO_ADS;
    else process.env.MOSHCODE_NO_ADS = before;
  }
});

test("ads: an unreachable ad server resolves to null, never throws", async () => {
  const before = process.env.MOSHCODE_NO_ADS;
  delete process.env.MOSHCODE_NO_ADS;
  try {
    assert.equal(await fetchMotdAd({ timeoutMs: 1 }), null);
  } finally {
    if (before !== undefined) process.env.MOSHCODE_NO_ADS = before;
  }
});
