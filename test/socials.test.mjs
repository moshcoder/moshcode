import assert from "node:assert/strict";
import test from "node:test";

import { postSocial, resolveSocial, socialPostUrl, socialRoster } from "../src/socials.mjs";

test("social roster includes Bluesky and Nostr with aliases", () => {
  assert.deepEqual(socialRoster().map((social) => social.name), ["bluesky", "nostr"]);
  assert.equal(resolveSocial("bsky")?.name, "bluesky");
  assert.equal(resolveSocial("NOSTR")?.name, "nostr");
  assert.equal(resolveSocial("twitter"), null);
});

test("Bluesky posts use the official compose intent", () => {
  const url = new URL(socialPostUrl("bluesky", "hello & goodbye"));
  assert.equal(url.origin + url.pathname, "https://bsky.app/intent/compose");
  assert.equal(url.searchParams.get("text"), "hello & goodbye");
});

test("Nostr drafts stay in the URL fragment and honor a self-hosted app", () => {
  const url = new URL(socialPostUrl("nostr", "draft #1", {
    env: { MOSHCODE_API: "https://mosh.example/" },
  }));
  assert.equal(url.origin + url.pathname, "https://mosh.example/socials/nostr");
  assert.equal(url.search, "");
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("text"), "draft #1");
});

test("postSocial opens a prepared composer when a browser is available", () => {
  let opened = "";
  const result = postSocial(["bsky", "two", "words"], {
    canOpen: () => true,
    open: (url) => { opened = url; return true; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.social, "bluesky");
  assert.equal(result.message, "two words");
  assert.equal(result.opened, true);
  assert.equal(opened, result.url);
});

test("postSocial reports missing messages and unknown networks without opening", () => {
  let opens = 0;
  const options = { canOpen: () => true, open: () => { opens++; return true; } };
  assert.match(postSocial([], options).error, /usage: \/post/);
  assert.match(postSocial(["nostr"], options).error, /usage: \/post/);
  assert.match(postSocial(["twitter", "hello"], options).error, /unknown social/);
  assert.equal(opens, 0);
});
