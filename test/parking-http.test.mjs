// The half of parking that answers.
//
// A parked name always resolved somewhere — but the address it pointed at was a
// platform that routes by Host header and returns "Application not found" for a
// name it has never heard of. `curl scrambled.eggs` resolved and then died one
// layer up. The bridge is already running locally for the name to resolve at
// all, so it serves the answer too.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createParkingServer, parkingRedirect } from "../src/parking-http.mjs";

/**
 * A raw request, because Host is a forbidden header for fetch() — undici
 * rewrites it from the URL, which is exactly the input under test here.
 */
function request(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const REGISTRY = "https://pit.example.test";

test("a name redirects to its page in the Pit", () => {
  assert.equal(parkingRedirect("scrambled.eggs", REGISTRY), `${REGISTRY}/n/scrambled.eggs`);
  // Browsers and curl both send the port when it is non-default.
  assert.equal(parkingRedirect("scrambled.eggs:8080", REGISTRY), `${REGISTRY}/n/scrambled.eggs`);
  assert.equal(parkingRedirect("Scrambled.EGGS", REGISTRY), `${REGISTRY}/n/scrambled.eggs`);
});

test("anything that is not a name lands at the Pit's front door", () => {
  for (const host of ["", null, undefined, "localhost", "127.0.0.1", "a.b.eggs"]) {
    assert.equal(parkingRedirect(host, REGISTRY), `${REGISTRY}/pit`, `for ${JSON.stringify(host)}`);
  }
});

test("a trailing slash on the registry does not double up", () => {
  assert.equal(parkingRedirect("scrambled.eggs", `${REGISTRY}/`), `${REGISTRY}/n/scrambled.eggs`);
});

test("the responder 302s whatever Host arrives", async () => {
  // Port 0: the OS picks a free one, so the test never needs privileges.
  const parking = await createParkingServer({ port: 0, registryBase: REGISTRY });
  try {
    const res = await request(parking.port, "/", "scrambled.eggs");

    assert.equal(res.status, 302);
    assert.equal(res.location, `${REGISTRY}/n/scrambled.eggs`);
    // `curl` without -L prints the body, so it has to say something useful.
    assert.match(res.body, /parked → https:\/\/pit\.example\.test\/n\/scrambled\.eggs/);
  } finally {
    await parking.close();
  }
});

test("302 rather than 301 — the owner can point the name later", async () => {
  const parking = await createParkingServer({ port: 0, registryBase: REGISTRY });
  try {
    const res = await request(parking.port, "/", "hawaiian.chicken");
    assert.equal(res.status, 302, "a cached permanent redirect would outlive the parking");
    assert.equal(res.location, `${REGISTRY}/n/hawaiian.chicken`);
  } finally {
    await parking.close();
  }
});

test("every path under the name redirects, not just the root", async () => {
  const parking = await createParkingServer({ port: 0, registryBase: REGISTRY });
  try {
    const res = await request(parking.port, "/some/deep/path", "scrambled.eggs");
    assert.equal(res.status, 302);
    assert.equal(res.location, `${REGISTRY}/n/scrambled.eggs`);
  } finally {
    await parking.close();
  }
});

test("a port that cannot be bound rejects, so the caller can decide", async () => {
  const first = await createParkingServer({ port: 0, registryBase: REGISTRY });
  try {
    await assert.rejects(
      () => createParkingServer({ port: first.port, registryBase: REGISTRY }),
      (err) => err.code === "EADDRINUSE",
    );
  } finally {
    await first.close();
  }
});
