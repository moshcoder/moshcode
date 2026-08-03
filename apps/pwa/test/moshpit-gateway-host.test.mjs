// The Host header the gateway sends to an origin.
//
// A pointed name is virtual-hosted: the box behind `dev.profullstack.com` serves
// seo.rank, chovy.hacker and its own sites off one address, and the only thing
// telling those apart is the Host header. forwardableHeaders() has always set
// `host: name` for exactly that reason.
//
// It never arrived. `Host` is a forbidden header name in the fetch spec, so
// undici drops it silently and sends the URL's authority instead — the origin
// was asked for the *target*, so it answered with its default vhost. Where that
// default redirects to HTTPS, the gateway forwarded the 301 with no Location
// (only content-type is copied through), which is the "301 to nowhere" a pointed
// name showed instead of its site.
//
// Nothing about the old code looked wrong, which is why this test exercises the
// wire rather than the arguments: it asserts on what a real origin received.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { fetchOrigin, forwardableHeaders } from "../src/lib/moshpit-gateway.mjs";

// An origin that virtual-hosts, exactly like the box a Moshpit name points at:
// it serves the name only when asked for it by name, and otherwise redirects to
// HTTPS the way an unrelated default vhost does.
async function virtualHost() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.host);
    if (req.headers.host === "seo.rank") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h1>seo.rank</h1>");
      return;
    }
    res.writeHead(301, { location: "https://dev.profullstack.com/" });
    res.end("301 Moved Permanently");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, seen, port: server.address().port };
}

const call = (port, headers, extra = {}) => fetchOrigin({
  host: "127.0.0.1", port, path: "/", headers,
  timeoutMs: 5000, maxBytes: 1_000_000, ...extra,
});

test("the origin is asked for the Moshpit name, not the target", async () => {
  const { server, seen, port } = await virtualHost();
  try {
    const res = await call(port, forwardableHeaders({}, "seo.rank"));
    assert.equal(seen[0], "seo.rank", "the origin must see the name it virtual-hosts on");
    assert.equal(res.status, 200, "so it serves the site rather than its default vhost");
    assert.equal(res.body.toString(), "<h1>seo.rank</h1>");
  } finally { server.close(); }
});

test("fetch() would have sent the wrong Host — the bug this replaces", async () => {
  const { server, seen, port } = await virtualHost();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: forwardableHeaders({}, "seo.rank"),
      redirect: "manual",
    });
    assert.equal(seen[0], `127.0.0.1:${port}`, "fetch discards Host — this is the defect, pinned");
    assert.equal(res.status, 301, "so the origin answers with its default vhost");
  } finally { server.close(); }
});

test("headers worth forwarding survive, and cookies do not", async () => {
  const { server, port } = await virtualHost();
  try {
    const headers = forwardableHeaders(
      { accept: "text/html", "user-agent": "curl/8", cookie: "mc_sess=secret", authorization: "Bearer x" },
      "seo.rank",
    );
    assert.equal(headers.accept, "text/html");
    assert.equal(headers["user-agent"], "curl/8");
    assert.equal(headers.cookie, undefined, "a visitor's session must never reach a name's owner");
    assert.equal(headers.authorization, undefined);
    await call(port, headers);
  } finally { server.close(); }
});

test("a body over the cap is refused rather than buffered", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(4096));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await call(server.address().port, { host: "seo.rank" }, { maxBytes: 512 });
    assert.equal(res.truncated, true, "an oversized origin response must be flagged, not returned");
  } finally { server.close(); }
});

test("a silent origin times out as AbortError", async () => {
  const server = http.createServer(() => { /* never responds */ });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(
      () => call(server.address().port, { host: "seo.rank" }, { timeoutMs: 120 }),
      // The caller distinguishes "did not answer in time" from "unreachable" on
      // this name alone, so it is part of the contract.
      (e) => e.name === "AbortError",
    );
  } finally { server.close(); }
});
